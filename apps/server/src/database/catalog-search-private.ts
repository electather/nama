import { eq, sql } from "drizzle-orm";

import { canonicalCredit } from "./catalog-artwork-schema.ts";
import { canonicalItem } from "./catalog-item-schema.ts";
import type { CatalogTransaction } from "./catalog-persistence-model-private.ts";

const refreshSearchProjection = (
  transaction: CatalogTransaction,
  canonicalItemId: string,
): Promise<unknown> =>
  transaction
    .update(canonicalItem)
    .set({
      searchVector: sql`setweight(to_tsvector('simple', coalesce(${canonicalItem.title}, '')), 'A')
        || setweight(to_tsvector('simple', coalesce(${canonicalItem.originalTitle}, '')), 'B')
        || setweight(
          to_tsvector(
            'simple',
            coalesce(
              (
                select string_agg(${canonicalCredit.name}, ' ' order by ${canonicalCredit.displayOrder})
                from ${canonicalCredit}
                where ${canonicalCredit.canonicalItemId} = ${canonicalItem.id}
                  and ${canonicalCredit.role} = 'actor'
              ),
              ''
            )
          ),
          'C'
        )
        || setweight(to_tsvector('simple', array_to_string(${canonicalItem.genres}, ' ')), 'D')`,
    })
    .where(eq(canonicalItem.id, canonicalItemId));

export { refreshSearchProjection };
