import * as z from "zod/mini";
import {
  DescriptionSchema,
  EnumOptionsSchema,
  IdentifierSchema,
  IdSchema,
  LocalizableTextSchema,
  NameSchema,
} from "./primitives.ts";

export const TABLE_LIMITS = {
  columnsPerTable: 512,
  rowsPerTable: 200_000,
  listItems: 10_000,
  curveKeys: 10_000,
  stringCell: 100_000,
} as const;

// ---------------------------------------------------------------------------------------
// Column types. `kind` selects the type; the other fields are its constraints.
// Scalar types can also be the item type of a list column.
// ---------------------------------------------------------------------------------------

const IntType = z.object({
  kind: z.literal("int"),
  min: z.optional(z.int()),
  max: z.optional(z.int()),
  unique: z.optional(z.boolean()),
});

const FloatType = z.object({
  kind: z.literal("float"),
  min: z.optional(z.number()),
  max: z.optional(z.number()),
});

const StringType = z.object({
  kind: z.literal("string"),
  maxLength: z.optional(z.int().check(z.gte(1), z.lte(TABLE_LIMITS.stringCell))),
  unique: z.optional(z.boolean()),
});

const BoolType = z.object({ kind: z.literal("bool") });

const EnumType = z.object({
  kind: z.literal("enum"),
  options: EnumOptionsSchema,
});

/** Points to a row of another table asset. Cells store the row id. */
const ReferenceType = z.object({
  kind: z.literal("reference"),
  table: IdSchema,
});

export const ScalarTypeSchema = z.discriminatedUnion("kind", [IntType, FloatType, StringType, BoolType, EnumType, ReferenceType]);
export type ScalarType = z.infer<typeof ScalarTypeSchema>;

/** Localizable player-facing text (cells store LocalizableText). */
const TextType = z.object({ kind: z.literal("text") });

/** Inline curve (cells store a Curve), exported in Unreal CurveTable layout. */
const CurveType = z.object({ kind: z.literal("curve") });

const ListType = z.object({
  kind: z.literal("list"),
  item: ScalarTypeSchema,
  maxItems: z.optional(z.int().check(z.gte(1), z.lte(TABLE_LIMITS.listItems))),
});

export const ColumnTypeSchema = z.discriminatedUnion("kind", [
  IntType,
  FloatType,
  StringType,
  BoolType,
  EnumType,
  ReferenceType,
  TextType,
  CurveType,
  ListType,
]);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;
export type ColumnKind = ColumnType["kind"];

export const ColumnSchema = z.object({
  id: IdSchema,
  /** Field name in exports (CSV header, USTRUCT member). */
  name: IdentifierSchema,
  description: z.optional(DescriptionSchema),
  required: z.optional(z.boolean()),
  type: ColumnTypeSchema,
});
export type Column = z.infer<typeof ColumnSchema>;

// ---------------------------------------------------------------------------------------
// Cell values. Structure only; whether a value matches its column is checked in
// validate.ts, because that depends on the column definition.
// ---------------------------------------------------------------------------------------

export const CurveSchema = z.object({
  interp: z.enum(["constant", "linear", "cubic"]),
  /** Sorted by x, x values unique (checked in validate.ts). */
  keys: z.array(z.object({ x: z.number(), y: z.number() })).check(z.maxLength(TABLE_LIMITS.curveKeys)),
});
export type Curve = z.infer<typeof CurveSchema>;

const ScalarCellSchema = z.union([z.null(), z.boolean(), z.number(), z.string().check(z.maxLength(TABLE_LIMITS.stringCell))]);

export const CellValueSchema = z.union([
  ScalarCellSchema,
  LocalizableTextSchema,
  CurveSchema,
  z.array(ScalarCellSchema).check(z.maxLength(TABLE_LIMITS.listItems)),
]);
export type CellValue = z.infer<typeof CellValueSchema>;

export const RowSchema = z.object({
  id: IdSchema,
  /** Row name in exports (first CSV column, Unreal DataTable row name). */
  name: IdentifierSchema,
  /** Keyed by column id. A missing key means "empty". */
  cells: z.record(IdSchema, CellValueSchema),
});
export type Row = z.infer<typeof RowSchema>;

export const TableAssetSchema = z.object({
  id: IdSchema,
  kind: z.literal("table"),
  name: NameSchema,
  description: z.optional(DescriptionSchema),
  columns: z.array(ColumnSchema).check(z.maxLength(TABLE_LIMITS.columnsPerTable)),
  rows: z.array(RowSchema).check(z.maxLength(TABLE_LIMITS.rowsPerTable)),
});
export type TableAsset = z.infer<typeof TableAssetSchema>;
