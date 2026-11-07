/**
 * Spreadsheet operations on a rectangle of table cells: copy as TSV, paste, fill down,
 * clear, set Yes/No. Each returns one Change, so a paste or a bulk edit is one undo step.
 *
 * Grid coordinates: `row` indexes table.rows; column 0 is the row name and column c ≥ 1
 * is table.columns[c - 1].
 */
import { cellToText, textToCell } from "./cell-text.ts";
import { parseCsv, writeCsv } from "./csv.ts";
import type { RowNames } from "./export/table-csv.ts";
import type { Change, Patch } from "./history.ts";
import type { IdGenerator } from "./ids.ts";
import type { Id } from "./model/primitives.ts";
import type { Project } from "./model/project.ts";
import { TABLE_LIMITS, type CellValue, type Column, type Row, type TableAsset } from "./model/table.ts";
import { err, ok, type Result } from "./result.ts";
import { findTable, isValidIdentifier, sameCellValue, suffixedName } from "./table-edits.ts";

export interface GridPoint {
  readonly row: number;
  readonly col: number;
}

/** Inclusive bounds. */
export interface GridRange {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** Most cells one paste, fill or clear may write (keeps a single undo step bounded). */
export const MAX_GRID_WRITE_CELLS = 1_000_000;

/** Row name given to rows a paste appends when it brings no names of its own. */
export const NEW_ROW_NAME = "NewRow";

export function gridRange(a: GridPoint, b: GridPoint): GridRange {
  return { top: Math.min(a.row, b.row), left: Math.min(a.col, b.col), bottom: Math.max(a.row, b.row), right: Math.max(a.col, b.col) };
}

/** The range clamped to the table; null when nothing of it is left. */
export function clampRange(table: TableAsset, range: GridRange): GridRange | null {
  const r: GridRange = {
    top: Math.max(0, range.top),
    left: Math.max(0, range.left),
    bottom: Math.min(table.rows.length - 1, range.bottom),
    right: Math.min(table.columns.length, range.right),
  };
  return r.top > r.bottom || r.left > r.right ? null : r;
}

export function rangeCellCount(range: GridRange): number {
  return (range.bottom - range.top + 1) * (range.right - range.left + 1);
}

/** Columns whose cells can be written as text (curves have their own editor). */
export function isTextEditable(column: Column): boolean {
  return column.type.kind !== "curve";
}

// ---------------------------------------------------------------------------------------
// Clipboard text
// ---------------------------------------------------------------------------------------

/**
 * The range as tab-separated text, the format Excel, Google Sheets and Unreal paste.
 * Refused above MAX_GRID_WRITE_CELLS, which bounds the text built on the main thread.
 */
export function copyRange(table: TableAsset, range: GridRange, names: RowNames): Result<string, GridWriteError> {
  const r = clampRange(table, range);
  if (r === null) return ok("");
  if (rangeCellCount(r) > MAX_GRID_WRITE_CELLS) return err({ code: "too-many-cells", limit: MAX_GRID_WRITE_CELLS });
  const out: string[][] = [];
  for (let i = r.top; i <= r.bottom; i++) {
    const row = table.rows[i]!;
    const fields: string[] = [];
    for (let c = r.left; c <= r.right; c++) {
      if (c === 0) fields.push(row.name);
      else {
        const column = table.columns[c - 1]!;
        fields.push(cellToText(column.type, row.cells[column.id], names));
      }
    }
    out.push(fields);
  }
  const text = writeCsv(out, "\t");
  // One filled cell: no trailing newline, so pasting it into a text field adds no line
  // break. Otherwise the newline stays: it keeps empty cells at the end of the block
  // (a column ending in empty cells would otherwise paste back one row short).
  return ok(out.length === 1 && out[0]!.length === 1 && out[0]![0] !== "" ? text.slice(0, -1) : text);
}

/**
 * Clipboard text → rows of fields. Spreadsheets quote fields that contain tabs or line
 * breaks; text from elsewhere may have a stray quote, so a parse failure falls back to a
 * plain split. Never returns an empty grid.
 */
export function parseClipboardText(text: string): string[][] {
  const parsed = parseCsv(text, "\t", { maxChars: 64 * 1024 * 1024, maxCells: MAX_GRID_WRITE_CELLS + 1 });
  if (parsed.ok && parsed.value.length > 0) return parsed.value;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

export interface GridWrite {
  /** null when nothing changes. */
  readonly change: Change | null;
  /** Fields that could not be read for their column (left unchanged). */
  readonly invalid: number;
  /** Fields that had no place: past the last column, past the row limit, curve columns. */
  readonly skipped: number;
  readonly addedRows: number;
}

export type GridWriteError = { readonly code: "too-many-cells"; readonly limit: number };

/** Tracks row names while a paste renames rows, so names stay unique (case-insensitive). */
class RowNameSet {
  private readonly counts = new Map<string, number>();
  /** Next suffix to try per base name, so handing out n names costs O(n), not O(n²). */
  private readonly nextSuffix = new Map<string, number>();
  constructor(rows: readonly Row[]) {
    for (const row of rows) this.add(row.name);
  }
  add(name: string): void {
    const key = name.toLowerCase();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  remove(name: string): void {
    const key = name.toLowerCase();
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n <= 0) this.counts.delete(key);
    else this.counts.set(key, n);
  }
  /** `base`, or `base_2`, `base_3`, … if taken (shortened to stay a valid identifier). Does not add it. */
  free(base: string): string {
    const key = base.toLowerCase();
    if (!this.counts.has(key)) return base;
    for (let i = this.nextSuffix.get(key) ?? 2; ; i++) {
      const name = suffixedName(base, i);
      if (!this.counts.has(name.toLowerCase())) {
        this.nextSuffix.set(key, i + 1);
        return name;
      }
    }
  }
}

/**
 * Pastes clipboard fields into the table, like a spreadsheet:
 * - one field fills the whole selection;
 * - a block whose size divides the selection is repeated over it;
 * - otherwise the block is placed at the selection's top-left corner. Rows past the end
 *   are appended (up to the table's row limit); fields past the last column are skipped.
 *
 * Fields are read with the in-app text syntax (cell-text.ts). Invalid fields leave their
 * cell unchanged and are counted. Pasted row names are made unique by adding `_2`, `_3`, ….
 */
export function pasteGrid(project: Project, tableId: Id, range: GridRange, fields: readonly (readonly string[])[], names: RowNames, newId: IdGenerator): Result<GridWrite, GridWriteError> {
  const at = findTable(project, tableId);
  if (at === null || fields.length === 0) return ok({ change: null, invalid: 0, skipped: 0, addedRows: 0 });
  const { table, index: ai } = at;
  // Pasting may append rows, but only directly after the last one.
  if (range.top > table.rows.length) return ok({ change: null, invalid: 0, skipped: 0, addedRows: 0 });
  const height = fields.length;
  const width = fields.reduce((w, f) => Math.max(w, f.length), 0);
  if (width === 0) return ok({ change: null, invalid: 0, skipped: 0, addedRows: 0 });

  const selHeight = range.bottom - range.top + 1;
  const selWidth = range.right - range.left + 1;
  const repeat = (height === 1 && width === 1) || (selHeight % height === 0 && selWidth % width === 0 && selHeight * selWidth > height * width);
  const targetHeight = repeat ? selHeight : height;
  const targetWidth = repeat ? selWidth : width;
  if (targetHeight * targetWidth > MAX_GRID_WRITE_CELLS) return err({ code: "too-many-cells", limit: MAX_GRID_WRITE_CELLS });

  const columnCount = table.columns.length;
  const lastCol = Math.min(range.left + targetWidth - 1, columnCount);
  const maxRows = TABLE_LIMITS.rowsPerTable;
  const lastRow = Math.min(range.top + targetHeight - 1, maxRows - 1);
  let skipped = (targetHeight - (lastRow - range.top + 1)) * targetWidth + Math.max(0, range.left + targetWidth - 1 - columnCount) * (lastRow - range.top + 1);
  let invalid = 0;

  const field = (r: number, c: number): string | undefined => fields[(r - range.top) % height]![(c - range.left) % width];

  // Row names first: renamed rows give up their old names before new ones are handed
  // out, so swapping two names keeps both as typed.
  const rowNames = new RowNameSet(table.rows);
  const pastedNames = new Map<number, string>();
  if (range.left === 0) {
    for (let r = range.top; r <= lastRow; r++) {
      const text = field(r, 0);
      if (text === undefined) continue;
      const name = text.trim();
      if (!isValidIdentifier(name)) invalid++;
      else {
        pastedNames.set(r, name);
        if (r < table.rows.length) rowNames.remove(table.rows[r]!.name);
      }
    }
  }

  const patches: Patch[] = [];
  const appended: Row[] = [];
  for (let r = range.top; r <= lastRow; r++) {
    const existing = table.rows[r];
    const cells: Record<Id, CellValue> | null = existing === undefined ? {} : null;
    for (let c = Math.max(1, range.left); c <= lastCol; c++) {
      const text = field(r, c);
      if (text === undefined) continue; // ragged clipboard rows: nothing to write here
      const column = table.columns[c - 1]!;
      if (!isTextEditable(column)) {
        if (text !== "") skipped++;
        continue;
      }
      const previous = existing?.cells[column.id];
      const parsed = textToCell(column.type, text, names, previous, newId);
      if (parsed === undefined) {
        invalid++;
        continue;
      }
      const next = parsed === null ? undefined : parsed;
      if (cells !== null) {
        if (next !== undefined) cells[column.id] = next;
      } else if (!sameCellValue(previous, next)) {
        patches.push({ op: "set", path: ["assets", ai, "rows", r, "cells", column.id], value: next });
      }
    }

    const pasted = pastedNames.get(r);
    if (cells !== null) {
      const name = rowNames.free(pasted ?? NEW_ROW_NAME);
      rowNames.add(name);
      appended.push({ id: newId(), name, cells });
    } else if (pasted !== undefined) {
      const name = rowNames.free(pasted);
      rowNames.add(name);
      if (name !== existing!.name) patches.push({ op: "set", path: ["assets", ai, "rows", r, "name"], value: name });
    }
  }

  appended.forEach((row, k) => patches.push({ op: "insert", path: ["assets", ai, "rows"], index: table.rows.length + k, value: row }));
  if (skipped < 0) skipped = 0;
  return ok({ change: patches.length === 0 ? null : { label: "paste-cells", patches }, invalid, skipped, addedRows: appended.length });
}

/** Writes `value(row, column)` into every data cell of the range that `accept`s it. */
function writeRange(
  project: Project,
  tableId: Id,
  range: GridRange,
  label: string,
  accept: (column: Column) => boolean,
  value: (row: Row, column: Column) => CellValue | undefined,
): Result<Change | null, GridWriteError> {
  const at = findTable(project, tableId);
  if (at === null) return ok(null);
  const { table, index: ai } = at;
  const r = clampRange(table, { ...range, left: Math.max(1, range.left) });
  if (r === null) return ok(null);
  if (rangeCellCount(r) > MAX_GRID_WRITE_CELLS) return err({ code: "too-many-cells", limit: MAX_GRID_WRITE_CELLS });
  const columns = table.columns.slice(r.left - 1, r.right).filter(accept);
  const patches: Patch[] = [];
  for (let i = r.top; i <= r.bottom; i++) {
    const row = table.rows[i]!;
    for (const column of columns) {
      const next = value(row, column);
      if (!sameCellValue(row.cells[column.id], next)) patches.push({ op: "set", path: ["assets", ai, "rows", i, "cells", column.id], value: next });
    }
  }
  return ok(patches.length === 0 ? null : { label, patches });
}

/** Empties the data cells of the range. Row names stay, and so do curves (copy and paste skip them too). */
export function clearRange(project: Project, tableId: Id, range: GridRange): Result<Change | null, GridWriteError> {
  return writeRange(project, tableId, range, "clear-cells", isTextEditable, () => undefined);
}

/** Sets every Yes/No cell of the range; other columns are left alone. */
export function setBoolRange(project: Project, tableId: Id, range: GridRange, value: boolean): Result<Change | null, GridWriteError> {
  return writeRange(project, tableId, range, "edit-cells", (c) => c.type.kind === "bool", () => value);
}

/**
 * Copies the top row of the range into the rows below it (Ctrl+D). A one-row range copies
 * from the row above. Row names are not filled (they must stay unique). Localizable text
 * keeps each target cell's own localization key (so its translations stay linked); empty
 * targets get a new key.
 */
export function fillDown(project: Project, tableId: Id, range: GridRange, newId: IdGenerator): Result<Change | null, GridWriteError> {
  const at = findTable(project, tableId);
  if (at === null) return ok(null);
  const { table } = at;
  const oneRow = range.top === range.bottom;
  const sourceIndex = oneRow ? range.top - 1 : range.top;
  const source = table.rows[sourceIndex];
  if (source === undefined) return ok(null);
  const target = { ...range, top: oneRow ? range.top : range.top + 1 };
  return writeRange(project, tableId, target, "fill-down", isTextEditable, (row, column) => {
    const v = source.cells[column.id];
    if (v === null || typeof v !== "object" || Array.isArray(v) || !("key" in v)) return v;
    const own = row.cells[column.id];
    const key = own !== null && typeof own === "object" && !Array.isArray(own) && "key" in own ? own.key : newId();
    return { ...v, key };
  });
}
