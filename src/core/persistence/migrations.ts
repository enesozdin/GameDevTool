import { isJsonObject, type JsonObject } from "../json.ts";
import { CURRENT_SCHEMA_VERSION } from "../model/project.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * Upgrades raw project JSON from `from` to `from + 1`. Migrations work on plain JSON
 * (before the zod parse), so each one only needs to know the shape of its own two
 * versions. They may mutate the input: it is freshly parsed and owned by the loader.
 * The runner bumps `manifest.schemaVersion`.
 *
 * Every migration needs a fixture file of its source version in tests/fixtures.
 */
export interface Migration {
  readonly from: number;
  readonly migrate: (project: JsonObject) => JsonObject;
}

/** Ordered by `from`. Empty until schema version 2 exists. */
export const MIGRATIONS: readonly Migration[] = [];

export type MigrationError =
  | { readonly code: "not-a-project" }
  | { readonly code: "unsupported-version"; readonly version: number; readonly supported: number }
  | { readonly code: "missing-migration"; readonly from: number }
  | { readonly code: "migration-failed"; readonly from: number; readonly message: string };

export interface Migrated {
  readonly project: JsonObject;
  /** Version the file had before migrating (equal to the target if nothing ran). */
  readonly fromVersion: number;
}

export function readSchemaVersion(raw: unknown): number | undefined {
  if (!isJsonObject(raw) || !isJsonObject(raw["manifest"])) return undefined;
  const version = raw["manifest"]["schemaVersion"];
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

export function migrateProject(
  raw: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
  target: number = CURRENT_SCHEMA_VERSION,
): Result<Migrated, MigrationError> {
  const fromVersion = readSchemaVersion(raw);
  if (fromVersion === undefined || !isJsonObject(raw)) return err({ code: "not-a-project" });
  // A newer file cannot be read safely: loading would silently drop its new fields.
  if (fromVersion > target) return err({ code: "unsupported-version", version: fromVersion, supported: target });

  let project: JsonObject = raw;
  for (let version = fromVersion; version < target; version++) {
    const step = migrations.find((m) => m.from === version);
    if (step === undefined) return err({ code: "missing-migration", from: version });
    try {
      project = step.migrate(project);
    } catch (e) {
      return err({ code: "migration-failed", from: version, message: e instanceof Error ? e.message : String(e) });
    }
    const manifest = project["manifest"];
    if (!isJsonObject(manifest)) return err({ code: "migration-failed", from: version, message: "manifest missing after migration" });
    manifest["schemaVersion"] = version + 1;
  }
  return ok({ project, fromVersion });
}
