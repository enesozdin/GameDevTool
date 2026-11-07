/**
 * Cell views and editors of the table grid. Editors save on Enter, Tab and blur (all user
 * events), never when they unmount: an unmount can follow an undo or a deleted row, and
 * saving then would write against a project that no longer matches.
 */
import { useEffect, useRef, useState } from "react";
import { cellToText, type CellValue, type Column, type RowNames } from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";

export function isNumeric(column: Column): boolean {
  return column.type.kind === "int" || column.type.kind === "float";
}

export function CellView({ strings, column, value, names }: { strings: UiStrings; column: Column; value: CellValue | undefined; names: RowNames }) {
  const s = strings.tables;
  if (column.type.kind === "bool") {
    return value === undefined || value === null ? null : <span aria-label={value === true ? s.yes : s.no}>{value === true ? "☑" : "☐"}</span>;
  }
  if (column.type.kind === "curve") {
    const keys = value !== null && typeof value === "object" && !Array.isArray(value) && "keys" in value ? value.keys.length : 0;
    return <span className="muted small">{s.curveSummary(keys)}</span>;
  }
  return <span className="tcell-text">{cellToText(column.type, value, names)}</span>;
}

/** Reference choices: the target table's rows. Capped; long tables get a filtered picker later. */
const MAX_REFERENCE_OPTIONS = 2_000;
function referenceOptions(names: RowNames, table: string, value: CellValue | undefined): { id: string; name: string }[] {
  const list = names.rowsOf(table).slice(0, MAX_REFERENCE_OPTIONS);
  if (typeof value === "string" && !list.some((r) => r.id === value)) list.push({ id: value, name: names.name(value) ?? value });
  return list;
}

export function ChoiceEditor({ strings, column, value, names, onCommit, onCancel }: { strings: UiStrings; column: Column; value: CellValue | undefined; names: RowNames; onCommit: (v: CellValue | undefined) => void; onCancel: () => void }) {
  const type = column.type;
  const options = type.kind === "enum" ? type.options.map((o) => ({ id: o.id, name: o.name })) : type.kind === "reference" ? referenceOptions(names, type.table, value) : [];
  // Open the list right away, so arrow keys choose in it instead of committing at once.
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    try {
      ref.current?.showPicker();
    } catch {
      // Not supported, or no user activation: the focused select still works.
    }
  }, []);
  return (
    <select
      ref={ref}
      className="tcell-editor"
      aria-label={column.name}
      autoFocus
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onCommit(e.target.value === "" ? undefined : e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <option value="">{strings.tables.noValue}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/** Marks text that does not parse (distinct from `undefined`, a cleared cell). */
export const INVALID: unique symbol = Symbol("invalid");

export function TextEditor<T>({
  label,
  current,
  typed,
  placeholder,
  parse,
  allowFillSelection,
  onCommit,
  onCancel,
}: {
  label: string;
  /** The cell's text now; an unchanged draft saves nothing. */
  current: string;
  /** The key that started editing (replaces the text), or null to edit `current`. */
  typed: string | null;
  placeholder?: string | undefined;
  parse: (text: string) => T | undefined | typeof INVALID;
  allowFillSelection: boolean;
  onCommit: (value: T | undefined, move?: { dr: number; dc: number }, toSelection?: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(typed ?? current);
  const parsed = parse(draft);
  const invalid = parsed === INVALID;
  // Enter, Tab, Escape and blur can follow each other for one edit; only the first counts.
  const done = useRef(false);
  const finish = (move?: { dr: number; dc: number }, toSelection?: boolean) => {
    if (done.current) return;
    if (toSelection === true) {
      done.current = true;
      return onCommit(undefined, move, draft);
    }
    if (invalid) return;
    done.current = true;
    if (draft === current) return onCancel();
    onCommit(parsed, move);
  };
  return (
    <input
      type="text"
      className="tcell-editor"
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      autoFocus
      placeholder={placeholder}
      value={draft}
      aria-invalid={invalid}
      onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && allowFillSelection) finish(undefined, true);
          else finish({ dr: e.shiftKey ? -1 : 1, dc: 0 });
        } else if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          finish({ dr: 0, dc: e.shiftKey ? -1 : 1 });
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        // Leaving the cell keeps a valid edit and drops an invalid one.
        if (done.current) return;
        if (invalid || draft === current) {
          done.current = true;
          onCancel();
        } else finish();
      }}
    />
  );
}
