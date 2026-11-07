/**
 * Writes the published JSON Schema of the project file, generated from the zod schemas
 * so it cannot drift. `--check` fails instead of writing when the file is out of date
 * (used by tests/CI).
 *
 * Usage: node scripts/generate-schema.ts [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/mini";
import { stableStringify } from "../src/core/json.ts";
import { CURRENT_SCHEMA_VERSION, ProjectSchema } from "../src/core/model/project.ts";

export function projectJsonSchema(): string {
  const schema = z.toJSONSchema(ProjectSchema, { target: "draft-2020-12", io: "input" });
  return stableStringify({
    ...schema,
    title: `GameDevTool project file (.json), schema version ${CURRENT_SCHEMA_VERSION}`,
  });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const schemaFile = path.join(root, "schema", `project.v${CURRENT_SCHEMA_VERSION}.schema.json`);

if (import.meta.main) {
  const text = projectJsonSchema();
  if (process.argv.includes("--check")) {
    const current = await readFile(schemaFile, "utf8").catch(() => "");
    if (current !== text) {
      console.error(`${path.relative(root, schemaFile)} is out of date. Run: npm run schema`);
      process.exit(1);
    }
  } else {
    await writeFile(schemaFile, text);
    console.log(`Wrote ${path.relative(root, schemaFile)}`);
  }
}
