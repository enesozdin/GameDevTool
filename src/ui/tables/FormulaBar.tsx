import { useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  canHaveFormula,
  checkFormula,
  hasFormula,
  isRoleColumn,
  setColumnFormula,
  type Change,
  type Column,
  type ExprError,
  type FormulaKind,
  type FormulaResults,
  type Id,
  type Project,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";

export interface FormulaBarProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  /** Column of the active cell; null for the row name or an empty table. */
  readonly column: Column | null;
  /** Row of the active cell (for its error), or -1. */
  readonly rowIndex: number;
  readonly formulas: FormulaResults;
  readonly commit: (change: Change | null) => void;
  readonly notify: (text: string, kind: "info" | "error") => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  /** Gives focus back to the grid (after Enter or Escape). */
  readonly onDone: () => void;
}

/**
 * The column formula of the active cell's column, like a spreadsheet's formula bar. The
 * draft is checked live; Enter or leaving the field saves it (one undo step), Escape
 * cancels. A blank formula removes it and keeps the computed values. Invalid formulas can
 * be saved: they are work in progress, and validation lists them.
 */
export function FormulaBar({ strings, project, table, column, rowIndex, formulas, commit, notify, inputRef, onDone }: FormulaBarProps) {
  const s = strings.tables;
  const id = useId();
  // The draft remembers its column: a click on another cell re-renders this bar for the new
  // column before the field's blur saves, and the draft must still go to the old one.
  // `base` is the formula the edit started from: when it changes underneath (undo, another
  // edit), the draft is dropped.
  const [pending, setPending] = useState<{ readonly column: Id; readonly base: string; readonly text: string } | null>(null);
  // Enter and Escape hand focus to the grid, which blurs the field: that blur must not save again.
  const handled = useRef(false);
  const saved = column?.formula ?? "";
  const allowed = column !== null && canHaveFormula(table, column);
  const draft = pending !== null && pending.column === column?.id && pending.base === saved ? pending.text : null;
  const text = draft ?? saved;
  const kind = column?.type.kind as FormulaKind;
  const draftError = useMemo(() => {
    if (!allowed || draft === null || draft.trim() === "") return undefined;
    const checked = checkFormula(project, table, kind, draft);
    return checked.ok ? undefined : checked.error;
  }, [allowed, draft, project, table, kind]);

  const result = column !== null && hasFormula(column) ? formulas.get(table.id, column.id) : undefined;
  const row = table.rows[rowIndex];
  const message = (e: ExprError) => strings.expression.message(e.code, e.params ?? {});
  let status: string;
  let statusIsError = false;
  if (draftError !== undefined) {
    status = `${message(draftError)} ${strings.expression.at(draftError.start + 1)}`;
    statusIsError = true;
  } else if (draft === null && result?.error !== undefined) {
    status = s.formulaColumnError(message(result.error));
    statusIsError = true;
  } else if (draft === null && row !== undefined && result?.cellErrors.get(rowIndex) !== undefined) {
    status = s.formulaCellError(row.name, message(result.cellErrors.get(rowIndex)!));
    statusIsError = true;
  } else status = s.formulaHint;

  const save = () => {
    if (pending === null) return;
    setPending(null);
    const target = table.columns.find((c) => c.id === pending.column);
    const text = pending.text.trim();
    const current = target?.formula ?? "";
    if (target === undefined || !canHaveFormula(table, target) || current !== pending.base || text === current) return;
    if (target.formula === undefined && text !== "") {
      let stored = 0;
      for (const r of table.rows) if (r.cells[target.id] !== undefined && r.cells[target.id] !== null) stored++;
      if (stored > 0 && !window.confirm(s.confirmFormula(target.name, stored))) return;
    }
    commit(setColumnFormula(project, table.id, target.id, text, formulas));
    if (text === "") notify(s.formulaRemoved(target.name), "info");
  };

  const placeholder = column === null ? s.formulaNoColumn : !allowed ? (isRoleColumn(table, column.id) ? s.formulaRoleColumn : s.formulaNotAllowed(s.kinds[column.type.kind] ?? column.type.kind)) : s.formulaPlaceholder;
  const statusId = `${id}-status`;

  return (
    <div className="formula-bar">
      <label htmlFor={id} className="formula-label" title={column === null ? s.formula : s.formulaOf(column.name)} aria-hidden="true">
        <span className="formula-badge">{s.formulaBadge}</span>
        {column !== null && <span className="formula-column">{column.name}</span>}
      </label>
      <input
        id={id}
        ref={inputRef}
        type="text"
        className="formula-input"
        aria-label={column === null ? s.formula : s.formulaOf(column.name)}
        spellCheck={false}
        autoComplete="off"
        maxLength={10_000}
        disabled={!allowed}
        placeholder={placeholder}
        value={allowed ? text : ""}
        aria-invalid={draftError !== undefined || (draft === null && result?.error !== undefined)}
        aria-describedby={allowed ? statusId : undefined}
        onChange={(e) => column !== null && setPending({ column: column.id, base: saved, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
            handled.current = true;
            onDone();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setPending(null);
            handled.current = true;
            onDone();
          }
        }}
        onBlur={() => {
          if (handled.current) handled.current = false;
          else save();
        }}
      />
      {allowed && (
        <p id={statusId} className={statusIsError ? "field-error small formula-status" : "muted small formula-status"} role={statusIsError ? "alert" : undefined}>
          {status}
        </p>
      )}
    </div>
  );
}
