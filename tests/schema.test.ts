import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { projectJsonSchema, schemaFile } from "../scripts/generate-schema.ts";

it("published JSON Schema matches the zod schemas (run `npm run schema` to update)", async () => {
  assert.equal(await readFile(schemaFile, "utf8"), projectJsonSchema());
});
