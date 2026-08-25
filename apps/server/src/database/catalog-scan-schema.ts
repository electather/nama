import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { CatalogScanStatus } from "./catalog-scan-types-private.ts";
import { providerInstance } from "./provider-schema.ts";

const ZERO = 0;

const providerCatalogScanState = pgTable(
  "provider_catalog_scan_state",
  {
    capturedProviderRevision: text("captured_provider_revision").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    consecutiveFailureCount: integer("consecutive_failure_count").default(ZERO).notNull(),
    coreRunId: text("core_run_id").notNull(),
    lastAcceptedContinuation: text("last_accepted_continuation"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    providerInstanceId: text("provider_instance_id")
      .primaryKey()
      .references(() => providerInstance.id, { onDelete: "cascade" }),
    safeFailureReason: text("safe_failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").$type<CatalogScanStatus>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "provider_catalog_scan_state_revision_check",
      sql`char_length(${table.capturedProviderRevision}) between 1 and 256`,
    ),
    check(
      "provider_catalog_scan_state_run_check",
      sql`char_length(${table.coreRunId}) between 1 and 256`,
    ),
    check(
      "provider_catalog_scan_state_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'paused')`,
    ),
    check(
      "provider_catalog_scan_state_continuation_check",
      sql`${table.lastAcceptedContinuation} is null or char_length(${table.lastAcceptedContinuation}) between 1 and 4096`,
    ),
    check(
      "provider_catalog_scan_state_failure_count_check",
      sql`${table.consecutiveFailureCount} >= 0`,
    ),
    check(
      "provider_catalog_scan_state_failure_check",
      sql`${table.safeFailureReason} is null or char_length(${table.safeFailureReason}) between 1 and 256`,
    ),
    check(
      "provider_catalog_scan_state_completion_check",
      sql`(${table.status} = 'running' and ${table.completedAt} is null and ${table.safeFailureReason} is null)
          or (${table.status} = 'succeeded' and ${table.completedAt} is not null and ${table.safeFailureReason} is null and ${table.nextRetryAt} is null)
          or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.safeFailureReason} is not null)
          or (${table.status} = 'paused' and ${table.completedAt} is not null)`,
    ),
    check(
      "provider_catalog_scan_state_timestamps_check",
      sql`${table.updatedAt} >= ${table.startedAt} and (${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt})`,
    ),
    index("provider_catalog_scan_state_retry_index").on(table.nextRetryAt),
  ],
);

export { providerCatalogScanState };
