import { sql } from "drizzle-orm";

import type { CatalogDatabase } from "./catalog-persistence-model-private.ts";
import { providerCatalogScanState } from "./catalog-scan-schema.ts";
import { providerInstance } from "./provider-schema.ts";

const FIRST_ROW_INDEX = 0;

interface CatalogReadiness {
  readonly hasCompletedImport: boolean;
  readonly hasEnabledProvider: boolean;
  readonly nextRetryAt?: Date;
}

const loadReadiness = async (database: CatalogDatabase): Promise<CatalogReadiness> => {
  const rows = await database
    .select({
      hasCompletedImport: sql<boolean>`exists (
        select 1
        from ${providerCatalogScanState} as completed_scan
        where completed_scan.status = 'succeeded'
      )`,
      hasEnabledProvider: sql<boolean>`exists (
        select 1 from ${providerInstance} as enabled_provider
        where enabled_provider.enabled
      )`,
      nextRetryAt: sql<string | null>`(
        select min(incomplete_scan.next_retry_at)::text
        from ${providerCatalogScanState} as incomplete_scan
        inner join ${providerInstance} as incomplete_provider
          on incomplete_provider.id = incomplete_scan.provider_instance_id
        where incomplete_provider.enabled
          and incomplete_scan.status <> 'succeeded'
      )`,
    })
    .from(sql`(values (1)) as singleton(value)`);
  const readiness = rows.at(FIRST_ROW_INDEX);
  if (readiness === undefined) {
    throw new Error("catalog readiness projection is missing");
  }
  const base = {
    hasCompletedImport: readiness.hasCompletedImport,
    hasEnabledProvider: readiness.hasEnabledProvider,
  };
  if (readiness.nextRetryAt === null) {
    return base;
  }
  return { ...base, nextRetryAt: new Date(readiness.nextRetryAt) };
};

export { loadReadiness };
export type { CatalogReadiness };
