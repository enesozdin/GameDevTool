import * as z from "zod/mini";
import { ULID_PATTERN } from "../ids.ts";

/** Stable id of anything that can be referenced or renamed (assets, rows, columns, ...). */
export const IdSchema = z.string().check(z.regex(ULID_PATTERN));
export type Id = z.infer<typeof IdSchema>;

/** Free-form display name. */
export const NameSchema = z.string().check(z.minLength(1), z.maxLength(200));

/**
 * Machine name used by expressions and engine exports (variable names, column names,
 * Unreal DataTable row names / USTRUCT fields). ASCII identifier, max 64 chars.
 * Uniqueness is checked case-insensitively (Unreal FNames are case-insensitive).
 */
export const IdentifierSchema = z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/));

export const DescriptionSchema = z.string().check(z.maxLength(10_000));

/** BCP 47 language tag subset, e.g. "en", "tr", "pt-BR", "zh-Hans". */
export const LocaleSchema = z.string().check(z.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/));

/** Stable localization key. Generated once (from a ULID) and never changed on edits. */
export const LocKeySchema = z.string().check(z.regex(/^[A-Za-z0-9_.-]{1,128}$/));

/** Player-facing text: the source-language string plus its stable localization key. */
export const LocalizableTextSchema = z.object({
  key: LocKeySchema,
  source: z.string().check(z.maxLength(100_000)),
  /** Note for translators / VO. */
  context: z.optional(z.string().check(z.maxLength(2_000))),
});
export type LocalizableText = z.infer<typeof LocalizableTextSchema>;

/** A named choice inside an enum column or enum variable. Values store the option id. */
export const EnumOptionSchema = z.object({
  id: IdSchema,
  name: IdentifierSchema,
});
export type EnumOption = z.infer<typeof EnumOptionSchema>;

export const EnumOptionsSchema = z.array(EnumOptionSchema).check(z.minLength(1), z.maxLength(1_000));
