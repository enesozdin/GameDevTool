/**
 * Table ⇄ CSV, engine-neutral. The first column is the row name, then one column per
 * table column, named by its identifier. Cells become neutral values first:
 *
 *   int / float / string   as is
 *   bool                   boolean
 *   enum / reference       option name / row name of the referenced row
 *   list                   array of those
 *   stacks                 array of { item, count, chance? } or { tag, count } (tag inputs)
 *   curve                  array of { x, y }
 *   text                   localizable text (format decides: source, or key + source)
 *
 * and a CsvFormat (csv-formats.ts) writes them as text: `generic` (JSON cells, default)
 * or `unreal` (DataTable text format). Import accepts the same values back, maps columns
 * by header name (case-insensitive), keeps the ids of rows whose name already exists
 * (stable ids → small diffs) and reports every cell it could not read.
 */
import { parseCsv, writeCsv, type CsvError } from "../csv.ts";
import type { IdGenerator } from "../ids.ts";
import type { Id } from "../model/primitives.ts";
import { IdentifierSchema, LocKeySchema } from "../model/primitives.ts";
import type { Project } from "../model/project.ts";
import { TABLE_LIMITS, type CellValue, type Column, type ColumnType, type Curve, type Row, type Stack, TagSchema, isTagStack, type ScalarType, type TableAsset } from "../model/table.ts";
import { err, ok, type Result } from "../result.ts";
import { GENERIC_CSV, type CsvFormat, type CsvStructured } from "./csv-formats.ts";

export interface TableCsvOptions {
  readonly format?: CsvFormat;
  /** "," for CSV, "\t" for TSV (spreadsheet copy/paste). */
  readonly delimiter?: string;
}

/** Row names of every table, for writing and reading references. */
export interface RowNames {
  name(rowId: Id): string | undefined;
  /** Row id in `table` with this name (case-insensitive). */
  find(table: Id, name: string): Id | undefined;
  /** Rows of `table` in table order (a fresh array). */
  rowsOf(table: Id): { id: Id; name: string }[];
}

export function rowNames(project: Project): RowNames {
  const byId = new Map<Id, string>();
  const byTable = new Map<Id, Map<string, Id>>();
  const tables = new Map<Id, TableAsset>();
  for (const asset of project.assets) {
    if (asset.kind !== "table") continue;
    tables.set(asset.id, asset);
    const names = new Map<string, Id>();
    for (const row of asset.rows) {
      byId.set(row.id, row.name);
      if (!names.has(row.name.toLowerCase())) names.set(row.name.toLowerCase(), row.id);
    }
    byTable.set(asset.id, names);
  }
  return {
    name: (id) => byId.get(id),
    find: (table, name) => byTable.get(table)?.get(name.toLowerCase()),
    rowsOf: (table) => (tables.get(table)?.rows ?? []).map((r) => ({ id: r.id, name: r.name })),
  };
}

// ---------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------

export function exportTableCsv(project: Project, table: TableAsset, options: TableCsvOptions = {}): string {
  const format = options.format ?? GENERIC_CSV;
  const names = rowNames(project);
  const rows: string[][] = [[format.rowNameHeader, ...table.columns.map((c) => c.name)]];
  for (const row of table.rows) {
    rows.push([row.name, ...table.columns.map((c) => formatCell(c.type, row.cells[c.id], names, table.name, format))]);
  }
  return writeCsv(rows, options.delimiter ?? ",");
}

export function formatCell(type: ColumnType, value: CellValue | undefined, names: RowNames, namespace: string, format: CsvFormat): string {
  if (value === undefined || value === null) return "";
  if (type.kind === "text") {
    return typeof value === "object" && !Array.isArray(value) && "key" in value ? format.formatText(namespace, value.key, value.source) : "";
  }
  const neutral = toNeutral(type, value, names, format);
  if (neutral === undefined) return "";
  if (typeof neutral === "boolean") return format.formatBool(neutral);
  if (typeof neutral === "number") return Number.isFinite(neutral) ? String(neutral) : "";
  if (typeof neutral === "string") return neutral;
  return format.formatStructured(neutral);
}

/** The neutral value of a (non-text) cell; undefined if the cell does not fit its type. */
export function toNeutral(type: ColumnType, value: Exclude<CellValue, null>, names: RowNames, format: CsvFormat): CsvStructured | undefined {
  const f = format.fieldName;
  switch (type.kind) {
    case "text":
      return typeof value === "object" && !Array.isArray(value) && "source" in value ? value.source : undefined;
    case "curve":
      if (typeof value !== "object" || Array.isArray(value) || !("keys" in value)) return undefined;
      return value.keys.map((k) => ({ [f("x")]: k.x, [f("y")]: k.y }));
    case "stacks":
      if (!Array.isArray(value)) return undefined;
      return value
        .filter((s): s is Stack => s !== null && typeof s === "object")
        .map((s) => {
          if (isTagStack(s)) return { [f("tag")]: s.tag, [f("count")]: s.count };
          const record: Record<string, CsvStructured> = { [f("item")]: names.name(s.item) ?? s.item, [f("count")]: s.count };
          if (s.chance !== undefined) record[f("chance")] = s.chance;
          return record;
        });
    case "list":
      if (!Array.isArray(value)) return undefined;
      return value.flatMap((v) => (v === null || typeof v === "object" ? [] : [scalarToNeutral(type.item, v, names)]));
    default:
      return typeof value === "object" ? undefined : scalarToNeutral(type, value, names);
  }
}

function scalarToNeutral(type: ScalarType, value: string | number | boolean, names: RowNames): CsvStructured {
  switch (type.kind) {
    case "enum":
      return type.options.find((o) => o.id === value)?.name ?? String(value);
    case "reference":
      return names.name(String(value)) ?? String(value);
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------

export type CsvImportIssue =
  | { readonly code: "invalid-row-name"; readonly line: number; readonly value: string }
  | { readonly code: "duplicate-row-name"; readonly line: number; readonly value: string }
  | { readonly code: "invalid-value"; readonly line: number; readonly column: string; readonly value: string }
  | { readonly code: "unknown-header"; readonly column: string };

export type CsvImportError = CsvError | { readonly code: "empty" } | { readonly code: "too-many-rows"; readonly limit: number };

export interface CsvImport {
  readonly rows: Row[];
  readonly issues: CsvImportIssue[];
  /** Existing rows not present in the CSV (removed by the import). */
  readonly removed: number;
}

/**
 * Reads CSV into rows for `table`. The first column is always the row name, whatever its
 * header. Text cells keep their localization key when the row already had one; new ones
 * get a key from `newId`.
 */
export function importTableCsv(project: Project, table: TableAsset, text: string, newId: IdGenerator, options: TableCsvOptions = {}): Result<CsvImport, CsvImportError> {
  const format = options.format ?? GENERIC_CSV;
  const parsed = parseCsv(text, options.delimiter ?? ",");
  if (!parsed.ok) return parsed;
  const [header, ...records] = parsed.value;
  if (header === undefined) return err({ code: "empty" });
  if (records.length > TABLE_LIMITS.rowsPerTable) return err({ code: "too-many-rows", limit: TABLE_LIMITS.rowsPerTable });

  const issues: CsvImportIssue[] = [];
  const byName = new Map<string, Column>();
  for (const c of table.columns) byName.set(c.name.toLowerCase(), c);
  const mapping: (Column | undefined)[] = header.map((h, i) => {
    if (i === 0) return undefined;
    const column = byName.get(h.trim().toLowerCase());
    if (column === undefined && h.trim() !== "") issues.push({ code: "unknown-header", column: h });
    return column;
  });

  const names = rowNames(project);
  const existing = new Map<string, Row>();
  for (const row of table.rows) existing.set(row.name.toLowerCase(), row);
  const seen = new Set<string>();
  const rows: Row[] = [];

  records.forEach((record, r) => {
    const line = r + 2;
    if (record.length === 1 && record[0] === "") return; // blank line
    const name = (record[0] ?? "").trim();
    if (!IdentifierSchema.safeParse(name).success) {
      issues.push({ code: "invalid-row-name", line, value: name });
      return;
    }
    if (seen.has(name.toLowerCase())) {
      issues.push({ code: "duplicate-row-name", line, value: name });
      return;
    }
    seen.add(name.toLowerCase());
    const previous = existing.get(name.toLowerCase());
    const cells: Record<Id, CellValue> = {};
    // Columns missing from the CSV keep their values.
    if (previous !== undefined) {
      for (const c of table.columns) {
        if (!mapping.includes(c) && previous.cells[c.id] !== undefined) cells[c.id] = previous.cells[c.id]!;
      }
    }
    mapping.forEach((column, i) => {
      if (column === undefined) return;
      const raw = record[i] ?? "";
      if (raw.trim() === "") return;
      const value = parseCell(column.type, raw, names, format, previous?.cells[column.id], newId);
      if (value === undefined) issues.push({ code: "invalid-value", line, column: column.name, value: raw });
      else cells[column.id] = value;
    });
    rows.push({ id: previous?.id ?? newId(), name, cells });
  });

  return ok({ rows, issues, removed: table.rows.filter((row) => !seen.has(row.name.toLowerCase())).length });
}

/** Numbers may arrive as JSON numbers or as text (CSV cells, Unreal bare tokens). */
function asNumber(v: CsvStructured | undefined, int: boolean): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const t = v.trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return undefined;
    n = Number(t);
  } else return undefined;
  if (!Number.isFinite(n) || (int && !Number.isSafeInteger(n))) return undefined;
  return n;
}

function asBool(v: CsvStructured | undefined): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return undefined;
}

function scalarFromNeutral(type: ScalarType, v: CsvStructured | undefined, names: RowNames): string | number | boolean | undefined {
  switch (type.kind) {
    case "int":
      return asNumber(v, true);
    case "float":
      return asNumber(v, false);
    case "bool":
      return asBool(v);
    case "string":
      return typeof v === "string" && v.length <= TABLE_LIMITS.stringCell ? v : typeof v === "number" ? String(v) : undefined;
    case "enum": {
      if (typeof v !== "string") return undefined;
      const t = v.trim().toLowerCase();
      return type.options.find((o) => o.name.toLowerCase() === t)?.id;
    }
    case "reference":
      return typeof v === "string" ? names.find(type.table, v.trim()) : undefined;
  }
}

function isRecord(v: CsvStructured | undefined): v is { readonly [key: string]: CsvStructured } {
  return v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** Case-insensitive field lookup, so "Item", "item" and "ITEM" all work. */
function field(record: { readonly [key: string]: CsvStructured }, name: string): CsvStructured | undefined {
  for (const key of Object.keys(record)) if (key.toLowerCase() === name) return record[key];
  return undefined;
}

function parseCell(type: ColumnType, raw: string, names: RowNames, format: CsvFormat, previous: CellValue | undefined, newId: IdGenerator): CellValue | undefined {
  const prevObject = previous !== null && previous !== undefined && typeof previous === "object" && !Array.isArray(previous) ? previous : undefined;
  switch (type.kind) {
    case "text": {
      const text = format.parseText(raw);
      if (text === null) return undefined;
      const key = text.key ?? (prevObject !== undefined && "key" in prevObject ? prevObject.key : newId());
      if (!LocKeySchema.safeParse(key).success || text.source.length > TABLE_LIMITS.stringCell) return undefined;
      const context = prevObject !== undefined && "key" in prevObject && prevObject.key === key ? prevObject.context : undefined;
      return context === undefined ? { key, source: text.source } : { key, source: text.source, context };
    }
    case "curve": {
      const v = format.parseStructured(raw);
      if (!Array.isArray(v) || v.length > TABLE_LIMITS.curveKeys) return undefined;
      const keys: Curve["keys"] = [];
      for (const item of v as CsvStructured[]) {
        if (!isRecord(item)) return undefined;
        const x = asNumber(field(item, "x"), false);
        const y = asNumber(field(item, "y"), false);
        if (x === undefined || y === undefined) return undefined;
        keys.push({ x, y });
      }
      return { interp: prevObject !== undefined && "interp" in prevObject ? prevObject.interp : "linear", keys };
    }
    case "stacks": {
      const v = format.parseStructured(raw);
      if (!Array.isArray(v) || v.length > TABLE_LIMITS.stacks) return undefined;
      const out: Stack[] = [];
      for (const item of v as CsvStructured[]) {
        if (!isRecord(item)) return undefined;
        const name = field(item, "item");
        const countValue = field(item, "count");
        const count = countValue === undefined ? 1 : asNumber(countValue, false);
        // A tag input: { tag, count }. An empty Item next to it (engine round trip) is ignored.
        const tagValue = field(item, "tag");
        const tag = typeof tagValue === "string" ? tagValue.trim() : "";
        if (tag !== "" && (name === undefined || (typeof name === "string" && name.trim() === ""))) {
          if (!TagSchema.safeParse(tag).success || count === undefined || !(count > 0 && count <= 1e12)) return undefined;
          out.push({ tag, count });
          continue;
        }
        const itemId = typeof name === "string" ? names.find(type.table, name.trim()) : undefined;
        const chanceValue = field(item, "chance");
        const chance = chanceValue === undefined ? undefined : asNumber(chanceValue, false);
        if (itemId === undefined || count === undefined || !(count > 0 && count <= 1e12)) return undefined;
        if (chanceValue !== undefined && (chance === undefined || !(chance > 0 && chance <= 1))) return undefined;
        out.push(chance === undefined || chance === 1 ? { item: itemId, count } : { item: itemId, count, chance });
      }
      return out;
    }
    case "list": {
      const v = format.parseStructured(raw);
      if (!Array.isArray(v) || v.length > (type.maxItems ?? TABLE_LIMITS.listItems)) return undefined;
      const out: (string | number | boolean)[] = [];
      for (const item of v as CsvStructured[]) {
        const value = scalarFromNeutral(type.item, item, names);
        if (value === undefined) return undefined;
        out.push(value);
      }
      return out;
    }
    default:
      return scalarFromNeutral(type, raw, names);
  }
}
