import { DEFAULT_JSON_LIMITS, isJsonObject, parseUntrustedJson, stableStringify, type JsonLimits, type JsonParseError, type JsonValue } from "../json.ts";
import { PROJECT_FORMAT, ProjectSchema, type Project } from "../model/project.ts";
import { validateProject } from "../model/validate.ts";
import { err, ok, type Issue, type Result } from "../result.ts";
import { migrateProject, MIGRATIONS, type Migration, type MigrationError } from "./migrations.ts";

export type LoadError =
  | JsonParseError
  | MigrationError
  /** The file is a project folder's manifest (FOLDER_MANIFEST_FILE), not a project file. */
  | { readonly code: "folder-manifest" }
  /** The file does not match the schema. `issues` lists the first problems found. */
  | { readonly code: "schema"; readonly issues: readonly Issue[] };

export interface LoadedProject {
  readonly project: Project;
  /** Semantic findings (broken references, duplicates, ...). The project still opens. */
  readonly issues: readonly Issue[];
  /** Set when the file was upgraded from an older schema version. */
  readonly migratedFrom?: number;
}

export interface LoadOptions {
  readonly limits?: JsonLimits;
  readonly migrations?: readonly Migration[];
}

const MAX_SCHEMA_ISSUES = 100;

/**
 * Loads a project file (`.json`, or legacy `.gdtproj`). The text is untrusted: it is parsed
 * with size/depth limits and forbidden-key checks, migrated, then validated by the schema
 * (which also strips unknown keys). Nothing in the file is ever executed.
 */
export function loadProject(text: string, options: LoadOptions = {}): Result<LoadedProject, LoadError> {
  const parsed = parseUntrustedJson(text, options.limits ?? DEFAULT_JSON_LIMITS);
  if (!parsed.ok) return parsed;
  // Both are .json files: say which one this is instead of "not a project".
  const raw = parsed.value;
  if (isJsonObject(raw) && raw["format"] === PROJECT_FORMAT && !("manifest" in raw)) return err({ code: "folder-manifest" });
  return loadProjectJson(raw, options.migrations);
}

/**
 * The part of loading after parsing: migrate, schema-check (strips unknown keys), validate.
 * `raw` must come from parseUntrustedJson (limits and forbidden keys already enforced) and
 * is owned by this call: migrations may mutate it.
 */
export function loadProjectJson(raw: JsonValue, migrations: readonly Migration[] = MIGRATIONS): Result<LoadedProject, LoadError> {
  const migrated = migrateProject(raw, migrations);
  if (!migrated.ok) return migrated;

  const result = ProjectSchema.safeParse(migrated.value.project);
  if (!result.success) {
    const issues: Issue[] = result.error.issues.slice(0, MAX_SCHEMA_ISSUES).map((issue) => ({
      severity: "error",
      code: `schema/${issue.code}`,
      path: issue.path.map((p) => (typeof p === "number" ? p : String(p))),
    }));
    return err({ code: "schema", issues });
  }

  const project = result.data;
  const loaded: LoadedProject = { project, issues: validateProject(project) };
  return ok(migrated.value.fromVersion === project.manifest.schemaVersion ? loaded : { ...loaded, migratedFrom: migrated.value.fromVersion });
}

/** Serializes a project deterministically (see stableStringify). */
export function saveProject(project: Project): string {
  return stableStringify(project);
}
