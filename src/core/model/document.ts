import * as z from "zod/mini";
import { DescriptionSchema, IdSchema, NameSchema } from "./primitives.ts";

/** A GDD page. Pages form a tree through `parent` (another document asset). */
export const DocumentAssetSchema = z.object({
  id: IdSchema,
  kind: z.literal("document"),
  name: NameSchema,
  description: z.optional(DescriptionSchema),
  parent: z.optional(IdSchema),
  /** Markdown source. Rendered from tokens to React elements, never to HTML strings. */
  markdown: z.string().check(z.maxLength(2 * 1024 * 1024)),
});
export type DocumentAsset = z.infer<typeof DocumentAssetSchema>;
