import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { insertBatches } from "./catalog-batches-private.ts";
import {
  canonicalHierarchy,
  canonicalItem,
  libraryEntry,
  providerItemMapping,
  providerItemParentReference,
} from "./catalog-item-schema.ts";
import type {
  CatalogItemObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import { mediaSource } from "./catalog-source-schema.ts";

const EMPTY_LENGTH = 0;

const validHierarchy = (row: {
  readonly childKind: string;
  readonly expectedParentKind: string;
  readonly parentKind: string;
  readonly relationship: string;
}): boolean => {
  if (row.parentKind !== row.expectedParentKind) {
    return false;
  }
  if (row.relationship === "show") {
    return row.parentKind === "show" && (row.childKind === "episode" || row.childKind === "season");
  }
  return (
    row.relationship === "season" && row.parentKind === "season" && row.childKind === "episode"
  );
};

const affectedChildReferences = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
): Promise<readonly string[]> => {
  const dependentRows = await transaction
    .select({ childItemReference: providerItemParentReference.childItemReference })
    .from(providerItemParentReference)
    .where(
      and(
        eq(providerItemParentReference.providerInstanceId, input.providerInstanceId),
        eq(providerItemParentReference.parentItemReference, input.itemReference),
      ),
    );
  return [...new Set([input.itemReference, ...dependentRows.map((row) => row.childItemReference)])];
};

interface ResolvedHierarchyRow {
  readonly childItemId: string;
  readonly childKind: string;
  readonly expectedParentKind: string;
  readonly parentItemId: string;
  readonly parentKind: string;
  readonly relationship: string;
}

const resolveHierarchyRows = (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  affectedReferences: readonly string[],
) => {
  const childMapping = alias(providerItemMapping, "hierarchy_child_mapping");
  const parentMapping = alias(providerItemMapping, "hierarchy_parent_mapping");
  const childItem = alias(canonicalItem, "hierarchy_child_item");
  const parentItem = alias(canonicalItem, "hierarchy_parent_item");
  return transaction
    .select({
      childItemId: childMapping.canonicalItemId,
      childKind: childItem.kind,
      expectedParentKind: providerItemParentReference.expectedParentKind,
      parentItemId: parentMapping.canonicalItemId,
      parentKind: parentItem.kind,
      relationship: providerItemParentReference.relationship,
    })
    .from(providerItemParentReference)
    .innerJoin(
      childMapping,
      and(
        eq(childMapping.providerInstanceId, providerItemParentReference.providerInstanceId),
        eq(childMapping.itemReference, providerItemParentReference.childItemReference),
      ),
    )
    .innerJoin(
      parentMapping,
      and(
        eq(parentMapping.providerInstanceId, providerItemParentReference.providerInstanceId),
        eq(parentMapping.itemReference, providerItemParentReference.parentItemReference),
      ),
    )
    .innerJoin(childItem, eq(childItem.id, childMapping.canonicalItemId))
    .innerJoin(parentItem, eq(parentItem.id, parentMapping.canonicalItemId))
    .where(
      and(
        eq(providerItemParentReference.providerInstanceId, input.providerInstanceId),
        inArray(providerItemParentReference.childItemReference, affectedReferences),
      ),
    );
};

const persistHierarchyRows = async (
  transaction: CatalogTransaction,
  resolved: readonly ResolvedHierarchyRow[],
): Promise<void> => {
  const hierarchyRows = resolved
    .filter((row) => validHierarchy(row))
    .map((row) => ({
      childItemId: row.childItemId,
      childKind: row.childKind,
      parentItemId: row.parentItemId,
      parentKind: row.parentKind,
      relationship: row.relationship,
    }));
  await insertBatches(hierarchyRows, (batch) =>
    transaction
      .insert(canonicalHierarchy)
      .values(batch)
      .onConflictDoUpdate({
        set: {
          childKind: sql`excluded.child_kind`,
          parentItemId: sql`excluded.parent_item_id`,
          parentKind: sql`excluded.parent_kind`,
        },
        target: [canonicalHierarchy.childItemId, canonicalHierarchy.relationship],
      }),
  );
};

const canonicalIdsForReferences = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  affectedReferences: readonly string[],
): Promise<readonly string[]> => {
  const affectedMappings = await transaction
    .select({ canonicalItemId: providerItemMapping.canonicalItemId })
    .from(providerItemMapping)
    .where(
      and(
        eq(providerItemMapping.providerInstanceId, input.providerInstanceId),
        inArray(providerItemMapping.itemReference, affectedReferences),
      ),
    );
  return [...new Set(affectedMappings.map((mapping) => mapping.canonicalItemId))];
};

const repairHierarchy = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  canonicalItemId: string,
): Promise<readonly string[]> => {
  await transaction
    .delete(canonicalHierarchy)
    .where(eq(canonicalHierarchy.childItemId, canonicalItemId));
  const affectedReferences = await affectedChildReferences(transaction, input);
  const resolved = await resolveHierarchyRows(transaction, input, affectedReferences);
  await persistHierarchyRows(transaction, resolved);
  return canonicalIdsForReferences(transaction, input, affectedReferences);
};

const libraryEligibility = sql`
  exists (
    select 1 from ${mediaSource}
    where ${mediaSource.canonicalItemId} = ${canonicalItem.id}
  )
  and (
    ${canonicalItem.kind} in ('movie', 'show')
    or (${canonicalItem.kind} = 'season' and exists (
      select 1 from ${canonicalHierarchy}
      where ${canonicalHierarchy.childItemId} = ${canonicalItem.id}
        and ${canonicalHierarchy.relationship} = 'show'
    ))
    or (${canonicalItem.kind} = 'episode' and exists (
      select 1 from ${canonicalHierarchy}
      where ${canonicalHierarchy.childItemId} = ${canonicalItem.id}
        and ${canonicalHierarchy.relationship} = 'show'
    ) and exists (
      select 1 from ${canonicalHierarchy}
      where ${canonicalHierarchy.childItemId} = ${canonicalItem.id}
        and ${canonicalHierarchy.relationship} = 'season'
    ))
  )
`;

const deleteUnpublishableEntries = async (
  transaction: CatalogTransaction,
  canonicalItemIdsJson: string,
): Promise<void> => {
  await transaction.execute(sql`
    delete from ${libraryEntry}
    using ${canonicalItem}
    where ${libraryEntry.canonicalItemId} = ${canonicalItem.id}
      and ${canonicalItem.id} in (
        select value::uuid from jsonb_array_elements_text(${canonicalItemIdsJson}::jsonb)
      )
      and not (${libraryEligibility})
  `);
};

const publishEligibleEntries = async (
  transaction: CatalogTransaction,
  canonicalItemIdsJson: string,
): Promise<void> => {
  await transaction.execute(sql`
    insert into ${libraryEntry} (canonical_item_id)
    select ${canonicalItem.id}
    from ${canonicalItem}
    where ${canonicalItem.id} in (
      select value::uuid from jsonb_array_elements_text(${canonicalItemIdsJson}::jsonb)
    )
      and (${libraryEligibility})
    on conflict (canonical_item_id) do nothing
  `);
};

const reconcileLibraryEntries = async (
  transaction: CatalogTransaction,
  canonicalItemIds: readonly string[],
): Promise<void> => {
  if (canonicalItemIds.length === EMPTY_LENGTH) {
    return;
  }
  const canonicalItemIdsJson = JSON.stringify(canonicalItemIds);
  await deleteUnpublishableEntries(transaction, canonicalItemIdsJson);
  await publishEligibleEntries(transaction, canonicalItemIdsJson);
};
const catalogItemIdsOwnedByProvider = async (
  transaction: CatalogTransaction,
  providerInstanceId: string,
): Promise<readonly string[]> => {
  const affectedRows = await transaction
    .selectDistinct({ canonicalItemId: mediaSource.canonicalItemId })
    .from(mediaSource)
    .where(eq(mediaSource.providerInstanceId, providerInstanceId));
  return affectedRows.map((row) => row.canonicalItemId);
};

const removeOrphanedLibraryEntries = async (
  transaction: CatalogTransaction,
  affectedItemIds: readonly string[],
): Promise<void> => {
  if (affectedItemIds.length === EMPTY_LENGTH) {
    return;
  }
  const affectedItemIdsJson = JSON.stringify(affectedItemIds);
  await transaction.execute(sql`
    delete from ${libraryEntry} as entry
    where entry.canonical_item_id in (
      select value::uuid from jsonb_array_elements_text(${affectedItemIdsJson}::jsonb)
    )
      and not exists (
        select 1 from ${mediaSource} as source
        where source.canonical_item_id = entry.canonical_item_id
      )
  `);
};
export {
  catalogItemIdsOwnedByProvider,
  removeOrphanedLibraryEntries,
  repairHierarchy,
  reconcileLibraryEntries,
};
