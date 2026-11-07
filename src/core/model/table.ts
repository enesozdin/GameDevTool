import * as z from "zod/mini";
import {
  DescriptionSchema,
  EnumOptionsSchema,
  IdentifierSchema,
  IdSchema,
  LocalizableTextSchema,
  NameSchema,
} from "./primitives.ts";
import { EXPR_LIMITS } from "../expr/syntax.ts";

export const TABLE_LIMITS = {
  columnsPerTable: 512,
  rowsPerTable: 200_000,
  listItems: 10_000,
  curveKeys: 10_000,
  stringCell: 100_000,
  stacks: 256,
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

/**
 * Item amounts, e.g. recipe inputs/outputs or a build cost. Cells store Stack[] (item
 * stacks; recipe inputs may also hold tag stacks);
 * `table` is the items table the stacks point into. Exported in Unreal struct-array text
 * format: ((Item="IronOre",Count=2),(Item="Coal",Count=1)).
 */
const StacksType = z.object({
  kind: z.literal("stacks"),
  table: IdSchema,
});

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
  StacksType,
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
  /**
   * Column formula (expression language, src/core/formulas.ts). Cells of a formula column
   * are computed from it and not stored. Only int, float, string and bool columns.
   */
  formula: z.optional(z.string().check(z.maxLength(EXPR_LIMITS.length))),
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

export const ItemStackSchema = z.object({
  /** Row id in the column's items table. */
  item: IdSchema,
  count: z.number().check(z.gt(0), z.lte(1e12)),
  /** Probability per cycle that this output is produced (by-products, rare drops). Default 1. */
  chance: z.optional(z.number().check(z.gt(0), z.lte(1))),
});
export type ItemStack = z.infer<typeof ItemStackSchema>;

/**
 * Item tag as used by tag stacks: an identifier, matched case-insensitively against the
 * items table's tags column (e.g. "Fuel").
 */
export const TAG_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const TagSchema = z.string().check(z.regex(TAG_PATTERN));

/**
 * "Any item with this tag" in a recipe input, e.g. `{ "tag": "Fuel", "count": 1 }`. Only
 * allowed in the inputs column of a recipes table (validate.ts); connections still carry
 * one concrete item.
 */
export const TagStackSchema = z.object({
  tag: TagSchema,
  count: z.number().check(z.gt(0), z.lte(1e12)),
});
export type TagStack = z.infer<typeof TagStackSchema>;

/** One entry of a stacks cell. */
export type Stack = ItemStack | TagStack;

export function isTagStack(stack: Stack): stack is TagStack {
  return "tag" in stack;
}

const ScalarCellSchema = z.union([z.null(), z.boolean(), z.number(), z.string().check(z.maxLength(TABLE_LIMITS.stringCell))]);

export const CellValueSchema = z.union([
  ScalarCellSchema,
  LocalizableTextSchema,
  CurveSchema,
  z.array(ScalarCellSchema).check(z.maxLength(TABLE_LIMITS.listItems)),
  z.array(z.union([ItemStackSchema, TagStackSchema])).check(z.maxLength(TABLE_LIMITS.stacks)),
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

/**
 * Built-in table roles used by the Production Chain Editor (ISA-95 terms in brackets).
 * A role maps meanings to column ids, so designers can rename columns and add their own
 * without breaking the tool. validate.ts checks that each mapped column exists and has a
 * suitable type.
 */
export const TableRoleSchema = z.discriminatedUnion("kind", [
  /** Material Definitions. Row name = item name. `tags`: list-of-string column (e.g. "Fuel"). */
  z.object({ kind: z.literal("items"), tags: z.optional(IdSchema) }),
  /** Process Segments. */
  z.object({
    kind: z.literal("recipes"),
    /** stacks column */
    inputs: IdSchema,
    /** stacks column */
    outputs: IdSchema,
    /** int/float column: cycle time in seconds */
    time: IdSchema,
    /** reference column into a machines table */
    machine: z.optional(IdSchema),
    /** string column: unlock condition (expression language) */
    gate: z.optional(IdSchema),
  }),
  /** Equipment Classes. */
  z.object({
    kind: z.literal("machines"),
    /** int/float column: speed multiplier (1 = recipe time as written) */
    speed: IdSchema,
    /** int/float column: energy use */
    power: z.optional(IdSchema),
    /** stacks column */
    buildCost: z.optional(IdSchema),
  }),
]);
export type TableRole = z.infer<typeof TableRoleSchema>;
export type TableRoleKind = TableRole["kind"];

export const TableAssetSchema = z.object({
  id: IdSchema,
  kind: z.literal("table"),
  name: NameSchema,
  description: z.optional(DescriptionSchema),
  role: z.optional(TableRoleSchema),
  columns: z.array(ColumnSchema).check(z.maxLength(TABLE_LIMITS.columnsPerTable)),
  rows: z.array(RowSchema).check(z.maxLength(TABLE_LIMITS.rowsPerTable)),
});
export type TableAsset = z.infer<typeof TableAssetSchema>;

/** Whether the table's role (items, recipes, machines) uses this column. */
export function isRoleColumn(table: TableAsset, columnId: string): boolean {
  if (table.role === undefined) return false;
  for (const [key, value] of Object.entries(table.role)) if (key !== "kind" && value === columnId) return true;
  return false;
}
