import * as z from "zod/mini";
import type { IdGenerator } from "../ids.ts";
import { DocumentAssetSchema } from "./document.ts";
import {
  DescriptionSchema,
  EnumOptionsSchema,
  IdentifierSchema,
  IdSchema,
  LocaleSchema,
  NameSchema,
} from "./primitives.ts";
import { ProductionGraphAssetSchema } from "./production-graph.ts";
import { TableAssetSchema } from "./table.ts";

export const PROJECT_FORMAT = "gamedevtool.project";
export const CURRENT_SCHEMA_VERSION = 1;
export const MAX_ASSETS = 10_000;

// ---------------------------------------------------------------------------------------
// Project variables: flags, counters, quest states. Shared by dialogue, quest and
// simulation tools and addressed by `name` in the expression language.
// ---------------------------------------------------------------------------------------

const variableBase = {
  id: IdSchema,
  name: IdentifierSchema,
  description: z.optional(DescriptionSchema),
};

export const VariableSchema = z.discriminatedUnion("type", [
  z.object({ ...variableBase, type: z.literal("bool"), default: z.boolean() }),
  z.object({ ...variableBase, type: z.literal("int"), default: z.int() }),
  z.object({ ...variableBase, type: z.literal("float"), default: z.number() }),
  z.object({ ...variableBase, type: z.literal("string"), default: z.string().check(z.maxLength(10_000)) }),
  /** Quest states and other named states. `default` is an option id. */
  z.object({ ...variableBase, type: z.literal("enum"), options: EnumOptionsSchema, default: IdSchema }),
]);
export type Variable = z.infer<typeof VariableSchema>;

/** Speaker / character list shared by dialogue and quest tools. */
export const CharacterSchema = z.object({
  id: IdSchema,
  name: NameSchema,
  description: z.optional(DescriptionSchema),
});
export type Character = z.infer<typeof CharacterSchema>;

export const SettingsSchema = z.object({
  /** Language of all `source` strings. */
  sourceLocale: LocaleSchema,
  /** Display unit for production rates. Time is always stored in seconds (SI). */
  rateUnit: z.enum(["second", "minute", "hour"]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const ManifestSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  /** Bumped on every breaking schema change; older files are migrated on load. */
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: IdSchema,
  name: NameSchema,
  settings: SettingsSchema,
  variables: z.array(VariableSchema).check(z.maxLength(10_000)),
  characters: z.array(CharacterSchema).check(z.maxLength(10_000)),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Asset kinds. Loot table / economy model (Phase 3) and dialogue/quest graph (Phase 5)
 * are added in their phases. Adding a kind is backward compatible and needs no migration.
 */
export const AssetSchema = z.discriminatedUnion("kind", [DocumentAssetSchema, TableAssetSchema, ProductionGraphAssetSchema]);
export type Asset = z.infer<typeof AssetSchema>;
export type AssetKind = Asset["kind"];

export const ProjectSchema = z.object({
  manifest: ManifestSchema,
  assets: z.array(AssetSchema).check(z.maxLength(MAX_ASSETS)),
});
export type Project = z.infer<typeof ProjectSchema>;

export function createEmptyProject(name: string, newId: IdGenerator): Project {
  return {
    manifest: {
      format: PROJECT_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: newId(),
      name,
      settings: { sourceLocale: "en", rateUnit: "minute" },
      variables: [],
      characters: [],
    },
    assets: [],
  };
}
