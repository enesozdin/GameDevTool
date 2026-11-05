/**
 * Typed edits on table assets (rows, columns, cells). Each returns a Change for the
 * history, or null when the edit is invalid or changes nothing.
 */
import type { Change, Patch } from "./history.ts";
import { IdentifierSchema, type Id } from "./model/primitives.ts";
import type { Project } from "./model/project.ts";
import { TABLE_LIMITS, type CellValue, type Column, type ColumnType, type Row, type ScalarType, type TableAsset } from "./model/table.ts";
import type { IdGenerator } from "./ids.ts";
import { err, ok, type Result } from "./result.ts";

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

// ---------------------------------------------------------------------------------------
// Column types from the "add column" form
// ---------------------------------------------------------------------------------------

/** Most enum options a column may have (EnumOptionsSchema). */
export const MAX_ENUM_OPTIONS = 1_000;

/** List item types that can be created from the UI. */
export type ScalarSpec =
  | { readonly kind: "int" | "float" | "string" | "bool" }
  | { readonly kind: "enum"; readonly options: string }
  | { readonly kind: "reference"; readonly table: Id };

/** What the user picked: simple kinds, enum options as text ("Common, Rare"), target tables. */
export type ColumnSpec =
  | ScalarSpec
  | { readonly kind: "text" }
  | { readonly kind: "stacks"; readonly table: Id }
  | { readonly kind: "list"; readonly item: ScalarSpec };

export type ColumnSpecError = "enum-empty" | "enum-invalid-name" | "enum-duplicate" | "enum-too-many" | "table-missing";

/**
 * Enum option names from comma- or newline-separated text. Names must be identifiers and
 * unique (case-insensitive); blanks are skipped.
 */
export function parseEnumOptions(text: string): Result<string[], { code: ColumnSpecError; name?: string }> {
  const names = text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (names.length === 0) return err({ code: "enum-empty" });
  if (names.length > MAX_ENUM_OPTIONS) return err({ code: "enum-too-many" });
  const seen = new Set<string>();
  for (const name of names) {
    if (!isValidIdentifier(name)) return err({ code: "enum-invalid-name", name });
    const key = name.toLowerCase();
    if (seen.has(key)) return err({ code: "enum-duplicate", name });
    seen.add(key);
  }
  return ok(names);
}

/** Builds a column type; enum options get new ids, target tables must be table assets. */
export function columnTypeFromSpec(project: Project, spec: ColumnSpec, newId: IdGenerator): Result<ColumnType, { code: ColumnSpecError; name?: string }> {
  const isTable = (id: Id) => project.assets.some((a) => a.id === id && a.kind === "table");
  const scalar = (sp: ScalarSpec): Result<ScalarType, { code: ColumnSpecError; name?: string }> => {
    switch (sp.kind) {
      case "enum": {
        const names = parseEnumOptions(sp.options);
        return names.ok ? ok({ kind: "enum", options: names.value.map((name) => ({ id: newId(), name })) }) : names;
      }
      case "reference":
        return isTable(sp.table) ? ok({ kind: "reference", table: sp.table }) : err({ code: "table-missing" });
      default:
        return ok({ kind: sp.kind });
    }
  };
  switch (spec.kind) {
    case "text":
      return ok({ kind: "text" });
    case "stacks":
      return isTable(spec.table) ? ok({ kind: "stacks", table: spec.table }) : err({ code: "table-missing" });
    case "list": {
      const item = scalar(spec.item);
      return item.ok ? ok({ kind: "list", item: item.value }) : item;
    }
    default:
      return scalar(spec);
  }
}
