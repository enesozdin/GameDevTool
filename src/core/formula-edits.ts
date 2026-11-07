/**
 * Setting and removing column formulas (src/core/formulas.ts). Each edit is one undo step.
 */
import { canHaveFormula, type FormulaResults } from "./formulas.ts";
import type { Change, Patch } from "./history.ts";
import type { Id } from "./model/primitives.ts";
import type { Project } from "./model/project.ts";
import type { Column } from "./model/table.ts";
import { EXPR_LIMITS } from "./expr/syntax.ts";
import { findTable, sameCellValue } from "./table-edits.ts";

/**
 * Sets the formula of a column, or removes it (`formula` blank or undefined).
 * - A column that gets its first formula loses its stored cells: they would be hidden by
 *   the computed values and silently travel along in the project file.
 * - Removing a formula keeps the computed values as plain values when `results` holds
 *   them (cells with errors become empty), so turning a formula off loses nothing.
 * Returns null when nothing changes or the column cannot have a formula.
 */
export function setColumnFormula(project: Project, tableId: Id, columnId: Id, formula: string | undefined, results?: FormulaResults): Change | null {
  const at = findTable(project, tableId);
  if (at === null) return null;
  const { table, index: ai } = at;
  const ci = table.columns.findIndex((c) => c.id === columnId);
  const column = table.columns[ci];
  if (column === undefined) return null;
  const text = formula === undefined || formula.trim() === "" ? undefined : formula.trim();
  if (text === column.formula) return null;
  if (text !== undefined && (!canHaveFormula(table, column) || text.length > EXPR_LIMITS.length)) return null;

  const next: Column = { ...column };
  if (text === undefined) delete next.formula;
  else next.formula = text;
  const patches: Patch[] = [{ op: "set", path: ["assets", ai, "columns", ci], value: next }];
  const cellPath = (r: number) => ["assets", ai, "rows", r, "cells", columnId];

  if (column.formula === undefined) {
    table.rows.forEach((row, r) => {
      if (row.cells[columnId] !== undefined) patches.push({ op: "set", path: cellPath(r), value: undefined });
    });
  } else if (text === undefined) {
    const computed = results?.get(tableId, columnId);
    if (computed !== undefined && computed.length === table.rows.length) {
      table.rows.forEach((row, r) => {
        const value = computed.value(r);
        if (!sameCellValue(row.cells[columnId], value)) patches.push({ op: "set", path: cellPath(r), value });
      });
    }
  }
  const label = text === undefined ? "remove-formula" : column.formula === undefined ? "add-formula" : "edit-formula";
  return { label, patches };
}
