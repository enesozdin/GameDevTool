/**
 * Typed edits on table assets (rows, columns, cells). Each returns a Change for the
 * history, or null when the edit is invalid or changes nothing.
 */
import type { Change, Patch } from "./history.ts";
import { IdentifierSchema, type Id } from "./model/primitives.ts";
import type { Project } from "./model/project.ts";
import { TABLE_LIMITS, type CellValue, type Column, type Row, type TableAsset } from "./model/table.ts";

export function isValidIdentifier(name: string): boolean {
  return IdentifierSchema.safeParse(name).success;
}

function tableAt(project: Project, tableId: Id): { table: TableAsset; index: number } | null {
  const index = project.assets.findIndex((a) => a.id === tableId);
  const table = project.assets[index];
  return table?.kind === "table" ? { table, index } : null;
}

/** A row name not used in the table yet: `base`, `base_2`, `base_3`, … (case-insensitive). */
export function uniqueRowName(table: TableAsset, base: string): string {
  const used = new Set(table.rows.map((r) => r.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base}_${i}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

export function addRow(project: Project, tableId: Id, row: Row): Change | null {
  const at = tableAt(project, tableId);
  if (at === null || at.table.rows.length >= TABLE_LIMITS.rowsPerTable) return null;
  return { label: "add-row", patches: [{ op: "insert", path: ["assets", at.index, "rows"], index: at.table.rows.length, value: row }] };
}

export function removeRows(project: Project, tableId: Id, rowIds: ReadonlySet<Id>): Change | null {
  const at = tableAt(project, tableId);
  if (at === null) return null;
  const patches: Patch[] = [];
  for (let i = at.table.rows.length - 1; i >= 0; i--) {
    if (rowIds.has(at.table.rows[i]!.id)) patches.push({ op: "remove", path: ["assets", at.index, "rows"], index: i });
  }
  return patches.length === 0 ? null : { label: "remove-rows", patches };
}

export function renameRow(project: Project, tableId: Id, rowId: Id, name: string): Change | null {
  const at = tableAt(project, tableId);
  if (at === null || !isValidIdentifier(name)) return null;
  const i = at.table.rows.findIndex((r) => r.id === rowId);
  if (i < 0 || at.table.rows[i]!.name === name) return null;
  return { label: "rename-row", coalesceKey: `rename-row:${rowId}`, patches: [{ op: "set", path: ["assets", at.index, "rows", i, "name"], value: name }] };
}

/** Sets one cell. `undefined` or null clears it. */
export function setCell(project: Project, tableId: Id, rowId: Id, columnId: Id, value: CellValue | undefined): Change | null {
  const at = tableAt(project, tableId);
  if (at === null || !at.table.columns.some((c) => c.id === columnId)) return null;
  const i = at.table.rows.findIndex((r) => r.id === rowId);
  if (i < 0) return null;
  const next = value === null ? undefined : value;
  const current = at.table.rows[i]!.cells[columnId];
  if (current === next || (next !== undefined && current !== undefined && JSON.stringify(current) === JSON.stringify(next))) return null;
  return {
    label: "edit-cell",
    coalesceKey: `edit-cell:${rowId}:${columnId}`,
    patches: [{ op: "set", path: ["assets", at.index, "rows", i, "cells", columnId], value: next }],
  };
}

export function addColumn(project: Project, tableId: Id, column: Column): Change | null {
  const at = tableAt(project, tableId);
  if (at === null || at.table.columns.length >= TABLE_LIMITS.columnsPerTable) return null;
  return { label: "add-column", patches: [{ op: "insert", path: ["assets", at.index, "columns"], index: at.table.columns.length, value: column }] };
}

export function renameColumn(project: Project, tableId: Id, columnId: Id, name: string): Change | null {
  const at = tableAt(project, tableId);
  if (at === null || !isValidIdentifier(name)) return null;
  const i = at.table.columns.findIndex((c) => c.id === columnId);
  if (i < 0 || at.table.columns[i]!.name === name) return null;
  return { label: "rename-column", coalesceKey: `rename-column:${columnId}`, patches: [{ op: "set", path: ["assets", at.index, "columns", i, "name"], value: name }] };
}

/** Removes a column and its cells. Columns used by the table's role cannot be removed. */
export function removeColumn(project: Project, tableId: Id, columnId: Id): Change | null {
  const at = tableAt(project, tableId);
  if (at === null) return null;
  const i = at.table.columns.findIndex((c) => c.id === columnId);
  if (i < 0 || isRoleColumn(at.table, columnId)) return null;
  const patches: Patch[] = [{ op: "remove", path: ["assets", at.index, "columns"], index: i }];
  at.table.rows.forEach((row, r) => {
    if (Object.hasOwn(row.cells, columnId)) patches.push({ op: "set", path: ["assets", at.index, "rows", r, "cells", columnId], value: undefined });
  });
  return { label: "remove-column", patches };
}

export function isRoleColumn(table: TableAsset, columnId: Id): boolean {
  if (table.role === undefined) return false;
  for (const [key, value] of Object.entries(table.role)) if (key !== "kind" && value === columnId) return true;
  return false;
}

/** Replaces all rows (CSV import). */
export function replaceRows(project: Project, tableId: Id, rows: readonly Row[]): Change | null {
  const at = tableAt(project, tableId);
  if (at === null || rows.length > TABLE_LIMITS.rowsPerTable) return null;
  return { label: "import-rows", patches: [{ op: "set", path: ["assets", at.index, "rows"], value: rows }] };
}
