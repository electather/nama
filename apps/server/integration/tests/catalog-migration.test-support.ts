import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Effect } from "effect";

import { productionMigrations, withPool } from "./database.test-support.ts";

const FIRST_INDEX = 0;
const NEXT_INDEX_OFFSET = 1;
const JSON_INDENT_SPACES = 2;
const NOT_FOUND_INDEX = -1;
const LAST_PROVIDER_MIGRATION_TAG = "0001_orange_terrax";

interface MigrationJournalEntry {
  readonly breakpoints: boolean;
  readonly idx: number;
  readonly tag: string;
  readonly version: string;
  readonly when: number;
}
interface MigrationJournal {
  readonly dialect: string;
  readonly entries: readonly MigrationJournalEntry[];
  readonly version: string;
}

const parseMigrationJournalEntry = (entry: unknown): MigrationJournalEntry => {
  if (typeof entry !== "object" || !entry) {
    throw new TypeError("production migration entry is not an object");
  }
  const breakpoints: unknown = Reflect.get(entry, "breakpoints");
  const idx: unknown = Reflect.get(entry, "idx");
  const tag: unknown = Reflect.get(entry, "tag");
  const version: unknown = Reflect.get(entry, "version");
  const when: unknown = Reflect.get(entry, "when");
  if (
    typeof breakpoints !== "boolean" ||
    typeof idx !== "number" ||
    typeof tag !== "string" ||
    typeof version !== "string" ||
    typeof when !== "number"
  ) {
    throw new TypeError("production migration entry has an invalid shape");
  }
  return { breakpoints, idx, tag, version, when };
};

const parseMigrationJournal = (encoded: string): MigrationJournal => {
  const value: unknown = JSON.parse(encoded);
  if (typeof value !== "object" || !value) {
    throw new TypeError("production migration journal is not an object");
  }
  const dialect: unknown = Reflect.get(value, "dialect");
  const version: unknown = Reflect.get(value, "version");
  const entries: unknown = Reflect.get(value, "entries");
  if (typeof dialect !== "string" || typeof version !== "string" || !Array.isArray(entries)) {
    throw new TypeError("production migration journal has an invalid shape");
  }
  const normalizedEntries = entries.map((entry: unknown) => parseMigrationJournalEntry(entry));
  return { dialect, entries: normalizedEntries, version };
};

const copyProviderMigrations = async (
  folder: string,
  entries: MigrationJournal["entries"],
): Promise<void> => {
  await Promise.all(
    entries.map((entry) =>
      cp(join(productionMigrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`)),
    ),
  );
};

const providerMigrationEntries = (journal: MigrationJournal): MigrationJournal["entries"] => {
  const providerMigrationIndex = journal.entries.findIndex(
    (entry) => entry.tag === LAST_PROVIDER_MIGRATION_TAG,
  );
  if (providerMigrationIndex === NOT_FOUND_INDEX) {
    throw new Error("current provider migration journal is unavailable");
  }
  return journal.entries.slice(FIRST_INDEX, providerMigrationIndex + NEXT_INDEX_OFFSET);
};

const createCurrentProviderMigrationFolder = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "nama-provider-migrations-"));
  const metaFolder = join(folder, "meta");
  await mkdir(metaFolder);
  const encoded = await readFile(join(productionMigrations, "meta", "_journal.json"), "utf8");
  const journal = parseMigrationJournal(encoded);
  const priorEntries = providerMigrationEntries(journal);
  await copyProviderMigrations(folder, priorEntries);
  await writeFile(
    join(metaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries: priorEntries }, undefined, JSON_INDENT_SPACES)}\n`,
  );
  return folder;
};

const makeCurrentProviderMigrationFolder = () =>
  Effect.acquireRelease(Effect.promise(createCurrentProviderMigrationFolder), (folder) =>
    Effect.promise(() => rm(folder, { force: true, recursive: true })),
  );

const applyMigrationFolder = (databaseUrl: string, migrationsFolder: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() => migrate(drizzle(pool), { migrationsFolder })),
  );

const listProductionMigrationTags = () =>
  Effect.promise(async () => {
    const files = await readdir(productionMigrations);
    return files.filter((file) => file.endsWith(".sql")).toSorted();
  });

export { applyMigrationFolder, listProductionMigrationTags, makeCurrentProviderMigrationFolder };
