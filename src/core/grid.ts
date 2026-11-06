/**
 * Spreadsheet operations on a table grid: copy, paste, fill down, clear and bulk edit of a
 * rectangular range. Each edit is one Change, so a paste of thousands of cells is one undo
 * step and copies each container once (applyPatches tracks what it already copied).
 *
 * Grid coordinates: `row` is the row index in the table; `col` 0 is the row name and
 * `col` c ≥ 1 is `table.columns[c - 1]`. Clipboard text is TSV in the in-app cell syntax
 * (cell-text.ts), the format Excel and Google Sheets copy and paste.
 */
import { cellToText, textToCell } from "./cell-text.ts";
import { parseCsv, writeCsv, type CsvError } from "./csv.ts";
import type { RowNames } from "./export/table-csv.ts";
import type { Change, Patch } from "./history.ts";
import type { IdGenerator } from "./ids.ts";
import type { Id } from "./model/primitives.ts";
import type { Project } from "./model/project.ts";
import { TABLE_LIMITS, type CellValue, type Column, type Row, type TableAsset } from "./model/table.ts";
import { err, ok, type Result } from "./result.ts";
import { isValidIdentifier } from "./table-edits.ts";

export interface GridPos {
  readonly row: number;
  readonly col: number;
}

/** Inclusive, normalized (row0 ≤ row1, col0 ≤ col1). */
export interface GridRange {
  readonly row0: number;
  readonly col0: number;
  readonly row1: number;
  readonly col1: number;
}

/** Largest clipboard text a paste reads (UTF-16 code units). */
export const MAX_PASTE_CHARS = 32 * 1024 * 1024;
/** Most cells one paste may write. */
export const MAX_PASTE_CELLS = 2_000_000;

/** Number of grid columns: the name column plus the table's columns. */
export function gridColumnCount(table: TableAsset): number {
  return table.columns.length + 1;
}

/** The range spanned by two corners, clamped to the table. null for an empty table. */
export function rangeOf(table: TableAsset, a: GridPos, b: GridPos = a): GridRange | null {
  const rows = table.rows.length;
  if (rows === 0) return null;
  const cols = gridColumnCount(table);
  const r = (n: number) => Math.min(Math.max(n, 0), rows - 1);
  const c = (n: number) => Math.min(Math.max(n, 0), cols - 1);
  return {
    row0: r(Math.min(a.row, b.row)),
    row1: r(Math.max(a.row, b.row)),
    col0: c(Math.min(a.col, b.col)),
    col1: c(Math.max(a.col, b.col)),
  };
}

export function rangeSize(range: GridRange): { rows: number; cols: number } {
  return { rows: range.row1 - range.row0 + 1, cols: range.col1 - range.col0 + 1 };
}

function tableIndex(project: Project, tableId: Id): number {
  const index = project.assets.findIndex((a) => a.id === tableId);
  return project.assets[index]?.kind === "table" ? index : -1;
}

/** Curves have their own editor; text paste and bulk edit leave them alone. */
function acceptsText(column: Column): boolean {
  return column.type.kind !== "curve";
}

function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  return typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b);
}

/** Collects cell writes and builds the Change; skips writes that change nothing. */
class CellWriter {
  readonly patches: Patch[] = [];
  private readonly assetIndex: number;
  private readonly table: TableAsset;
  constructor(assetIndex: number, table: TableAsset) {
    this.assetIndex = assetIndex;
    this.table = table;
  }

  set(rowIndex: number, column: Column, value: CellValue | undefined): void {
    const next = value === null ? undefined : value;
    if (sameValue(this.table.rows[rowIndex]!.cells[column.id], next)) return;
    this.patches.push({ op: "set", path: ["assets", this.assetIndex, "rows", rowIndex, "cells", column.id], value: next });
  }

  change(label: string): Change | null {
    return this.patches.length === 0 ? null : { label, patches: this.patches };
  }
}

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------

/** The range as TSV in the in-app cell syntax. */
export function copyRange(table: TableAsset, range: GridRange, names: RowNames): string {
  const out: string[][] = [];
  for (let r = range.row0; r <= range.row1; r++) {
    const row = table.rows[r];
    if (row === undefined) break;
    const fields: string[] = [];
    for (let c = range.col0; c <= range.col1; c++) {
      if (c === 0) fields.push(row.name);
      else {
        const column = table.columns[c - 1];
        if (column !== undefined) fields.push(cellToText(column.type, row.cells[column.id], names));
      }
    }
    out.push(fields);
  }
  return writeCsv(out, "\t");
}

// ---------------------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------------------

export interface PasteResult {
  readonly change: Change | null;
  /** The range that was written to (for the new selection). */
  readonly range: GridRange;
  /** Rows appended because the paste reached past the last row. */
  readonly addedRows: number;
  /** Cells whose text did not parse for their column, or row names that were invalid or taken. */
  readonly invalid: number;
  /** Clipboard cells dropped: past the last column, past the row limit, or curve cells. */
  readonly dropped: number;
}

export type PasteError = CsvError | { readonly code: "too-many-cells"; readonly limit: number } | { readonly code: "table-missing" };

/**
 * Pastes TSV text at the top-left of `target`. A block smaller than `target` is repeated
 * when the target is a whole multiple of it (one copied value fills a whole selection, as in
 * spreadsheets). Rows past the end are appended, named from the name column when it is
 * pasted, otherwise "Row", "Row_2", …. Columns past the last column are dropped.
 * Cells that do not parse are left unchanged and counted.
 */
export function pasteText(
  project: Project,
  tableId: Id,
  target: GridRange,
  text: string,
  names: RowNames,
  newId: IdGenerator,
): Result<PasteResult, PasteError> {
  const assetIndex = tableIndex(project, tableId);
  if (assetIndex < 0) return err({ code: "table-missing" });
  const table = project.assets[assetIndex] as TableAsset;
  // Pasting below the last row appends right after it, never leaving a gap.
  if (target.row0 > table.rows.length) {
    const shift = target.row0 - table.rows.length;
    target = { ...target, row0: target.row0 - shift, row1: target.row1 - shift };
  }
  const parsed = parseCsv(text, "\t", { maxChars: MAX_PASTE_CHARS, maxCells: MAX_PASTE_CELLS });
  if (!parsed.ok) return parsed;
  const block = parsed.value;
  const blockRows = block.length;
  const blockCols = block.reduce((m, r) => Math.max(m, r.length), 0);
  if (blockRows === 0 || blockCols === 0) {
    return ok({ change: null, range: target, addedRows: 0, invalid: 0, dropped: 0 });
  }

  const { rows: targetRows, cols: targetCols } = rangeSize(target);
  const tile = targetRows >= blockRows && targetCols >= blockCols && targetRows % blockRows === 0 && targetCols % blockCols === 0;
  const outRows = tile ? targetRows : blockRows;
  const outCols = tile ? targetCols : blockCols;
  if (outRows * outCols > MAX_PASTE_CELLS) return err({ code: "too-many-cells", limit: MAX_PASTE_CELLS });

  const gridCols = gridColumnCount(table);
  const lastCol = Math.min(target.col0 + outCols, gridCols) - 1;
  const lastRow = Math.min(target.row0 + outRows, TABLE_LIMITS.rowsPerTable) - 1;
  let dropped = (outCols - (lastCol - target.col0 + 1)) * outRows + (outRows - (lastRow - target.row0 + 1)) * (lastCol - target.col0 + 1);
  let invalid = 0;
  const fieldAt = (r: number, c: number): string | undefined => block[(r - target.row0) % blockRows]![(c - target.col0) % blockCols];

  const patches: Patch[] = [];
  const writer = new CellWriter(assetIndex, table);
  const rowsPath = ["assets", assetIndex, "rows"] as const;

  // Row names: renames of existing rows, then names for appended rows. Names stay unique
  // (case-insensitive) across the whole table after the paste.
  const taken = new Map<string, number>(); // lower-case name → row index that owns it
  table.rows.forEach((row, i) => taken.set(row.name.toLowerCase(), i));
  const finalNames: string[] = [];
  for (let r = target.row0; r <= lastRow; r++) {
    const existing = table.rows[r];
    const field = target.col0 === 0 ? fieldAt(r, 0)?.trim() : undefined;
    let name = existing?.name;
    if (field !== undefined && field !== "" && field !== existing?.name) {
      const owner = taken.get(field.toLowerCase());
      if (isValidIdentifier(field) && (owner === undefined || owner === r)) {
        if (existing !== undefined) taken.delete(existing.name.toLowerCase());
        taken.set(field.toLowerCase(), r);
        name = field;
      } else invalid++;
    }
    if (name === undefined) {
      name = freeName(taken, "Row");
      taken.set(name.toLowerCase(), r);
    }
    finalNames.push(name);
  }

  const appended: Row[] = [];
  for (let r = target.row0; r <= lastRow; r++) {
    const name = finalNames[r - target.row0]!;
    const existing = table.rows[r];
    const cells: Record<Id, CellValue> = {};
    for (let c = Math.max(target.col0, 1); c <= lastCol; c++) {
      const column = table.columns[c - 1]!;
      const field = fieldAt(r, c);
      if (field === undefined) continue;
      if (!acceptsText(column)) {
        dropped++;
        continue;
      }
      const previous = existing?.cells[column.id];
      const value = textToCell(column.type, field, names, previous, newId);
      if (value === undefined) {
        invalid++;
        continue;
      }
      if (existing !== undefined) writer.set(r, column, value);
      else if (value !== null) cells[column.id] = value;
    }
    if (existing === undefined) appended.push({ id: newId(), name, cells });
    else if (name !== existing.name) patches.push({ op: "set", path: [...rowsPath, r, "name"], value: name });
  }

  appended.forEach((row, i) => patches.push({ op: "insert", path: rowsPath, index: table.rows.length + i, value: row }));
  patches.push(...writer.patches);
  const range: GridRange = { row0: target.row0, col0: target.col0, row1: lastRow, col1: lastCol };
  return ok({
    change: patches.length === 0 ? null : { label: "paste-cells", patches },
    range,
    addedRows: appended.length,
    invalid,
    dropped,
  });
}

function freeName(taken: ReadonlyMap<string, number>, base: string): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base}_${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// ---------------------------------------------------------------------------------------
// Fill down, clear, bulk edit
// ---------------------------------------------------------------------------------------

/**
 * Copies the top row of the range into the rows below it (Ctrl+D). Localizable text keeps
 * each target cell's own key (or gets a new one), so keys stay unique. Row names are not
 * filled, since they must be unique.
 */
export function fillDown(project: Project, tableId: Id, range: GridRange, newId: IdGenerator): Change | null {
  const assetIndex = tableIndex(project, tableId);
  if (assetIndex < 0) return null;
  const table = project.assets[assetIndex] as TableAsset;
  const source = table.rows[range.row0];
  if (source === undefined) return null;
  const writer = new CellWriter(assetIndex, table);
  for (let c = Math.max(range.col0, 1); c <= range.col1; c++) {
    const column = table.columns[c - 1];
    if (column === undefined) break;
    const value = source.cells[column.id];
    for (let r = range.row0 + 1; r <= range.row1 && r < table.rows.length; r++) {
      if (column.type.kind === "text" && value !== null && typeof value === "object" && !Array.isArray(value) && "source" in value) {
        const own = table.rows[r]!.cells[column.id];
        const key = own !== null && typeof own === "object" && !Array.isArray(own) && "key" in own ? own.key : newId();
        writer.set(r, column, { key, source: value.source });
      } else writer.set(r, column, value);
    }
  }
  return writer.change("fill-down");
}

/** Empties every cell in the range (Delete). Row names are kept. */
export function clearRange(project: Project, tableId: Id, range: GridRange): Change | null {
  const assetIndex = tableIndex(project, tableId);
  if (assetIndex < 0) return null;
  const table = project.assets[assetIndex] as TableAsset;
  const writer = new CellWriter(assetIndex, table);
  for (let c = Math.max(range.col0, 1); c <= range.col1; c++) {
    const column = table.columns[c - 1];
    if (column === undefined) break;
    for (let r = range.row0; r <= range.row1 && r < table.rows.length; r++) writer.set(r, column, undefined);
  }
  return writer.change("clear-cells");
}

/**
 * Writes one typed text into every cell of the range (Ctrl+Enter), parsed per column.
 * Row names and curve cells are skipped; cells whose column cannot read the text are
 * left unchanged and counted.
 */
export function setRangeText(
  project: Project,
  tableId: Id,
  range: GridRange,
  text: string,
  names: RowNames,
  newId: IdGenerator,
): { change: Change | null; invalid: number } {
  const assetIndex = tableIndex(project, tableId);
  if (assetIndex < 0) return { change: null, invalid: 0 };
  const table = project.assets[assetIndex] as TableAsset;
  const writer = new CellWriter(assetIndex, table);
  let invalid = 0;
  for (let c = Math.max(range.col0, 1); c <= range.col1; c++) {
    const column = table.columns[c - 1];
    if (column === undefined) break;
    if (!acceptsText(column)) continue;
    for (let r = range.row0; r <= range.row1 && r < table.rows.length; r++) {
      const value = textToCell(column.type, text, names, table.rows[r]!.cells[column.id], newId);
      if (value === undefined) invalid++;
      else writer.set(r, column, value);
    }
  }
  return { change: writer.change("bulk-edit"), invalid };
}
