import { useMemo, useRef, useState } from "react";
import {
  addColumn,
  addRow,
  CSV_FORMATS,
  exportTableCsv,
  fillDown,
  importTableCsv,
  removeRows,
  replaceRows,
  rowNames,
  uniqueRowName,
  type Change,
  type CsvFormatId,
  type FormulaResults,
  type IdGenerator,
  type Project,
  type ReferenceIndex,
  type Row,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
import { FormulaBar } from "./FormulaBar.tsx";
import { NewColumnForm } from "./NewColumnForm.tsx";
import { initialSelection, resolveSelection, TableGrid, type GridSelection } from "./TableGrid.tsx";

/** A text file the user picked, or why it could not be read. */
export type PickedTextFile = { readonly name: string; readonly text: string } | { readonly name: string; readonly error: "too-large" | "read-failed" };

export interface TableEditorProps {
  readonly strings: UiStrings;
  readonly project: Project;
  /** Reference index of `project`, kept by the app's cache: deleting rows builds none. */
  readonly index: ReferenceIndex;
  readonly table: TableAsset;
  /** Computed formula columns of the project. */
  readonly formulas: FormulaResults;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  /** Saves a file (download); provided by the app. */
  readonly saveFile: (name: string, text: string, type: string) => void;
  /** Lets the user pick a text file; provided by the app. */
  readonly pickTextFile: (accept: string) => Promise<PickedTextFile | null>;
  readonly notify: (text: string, kind: "info" | "error") => void;
}

/**
 * Table asset editor: a toolbar (rows, columns, CSV) and the formula bar above the
 * spreadsheet grid (TableGrid.tsx). The toolbar works on the grid's selection, so touch
 * users, who have no keyboard shortcuts, can still delete rows and fill down.
 */
export function TableEditor({ strings, project, index, table, formulas, newId, commit, saveFile, pickTextFile, notify }: TableEditorProps) {
  const s = strings.tables;
  const [format, setFormat] = useState<CsvFormatId>("generic");
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(false);
  const names = useMemo(() => rowNames(project), [project]);
  const [selection, setSelection] = useState<GridSelection>(() => initialSelection(table));
  const { focus, range } = resolveSelection(table, selection);
  const hasCells = table.rows.length > 0;
  const selectedRows = range.bottom - range.top + 1;
  const gridRef = useRef<HTMLDivElement>(null);
  const formulaRef = useRef<HTMLInputElement>(null);
  const activeColumn = focus.col > 0 ? (table.columns[focus.col - 1] ?? null) : null;

  /**
   * Deletes rows, asking first when other assets (recipes, graphs, references) use them or
   * when several go. Returns false when nothing was deleted (cancelled or no rows).
   */
  const deleteRows = (rows: readonly Row[]): boolean => {
    if (rows.length === 0) return false;
    let used = 0;
    for (const row of rows) for (const ref of index.usedBy(row.id)) if (ref.source !== table.id) used++;
    const message = rows.length === 1 ? (used > 0 ? s.confirmDeleteRow(rows[0]!.name, used) : null) : s.confirmDeleteRows(rows.length, used);
    if (message !== null && !window.confirm(message)) return false;
    commit(removeRows(project, table.id, new Set(rows.map((r) => r.id))));
    return true;
  };

  const onDeleteSelectedRows = () => {
    // Cancelled: the selection stays as it was.
    if (!deleteRows(table.rows.slice(range.top, range.bottom + 1))) return;
    const p = { row: range.top, col: focus.col };
    setSelection({ anchor: p, focus: p });
  };

  const onFillDown = () => {
    const result = fillDown(project, table.id, range, newId);
    if (result.ok) commit(result.value);
    else notify(s.tooManyCells(result.error.limit), "error");
  };

  const onAddRow = () => {
    commit(addRow(project, table.id, { id: newId(), name: uniqueRowName(table, "NewRow"), cells: {} }));
    const p = { row: table.rows.length, col: focus.col };
    setSelection({ anchor: p, focus: p });
  };

  const onExport = () => {
    const csv = exportTableCsv(project, table, { format: CSV_FORMATS[format], spreadsheetSafe, formulas });
    saveFile(`${table.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "table"}.csv`, csv, "text/csv");
  };

  const onImport = async () => {
    const file = await pickTextFile(".csv,.tsv,text/csv,text/tab-separated-values");
    if (file === null) return;
    if ("error" in file) {
      notify(s.importFailed(strings.loadErrors[file.error] ?? file.error), "error");
      return;
    }
    const delimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    const result = importTableCsv(project, table, file.text, newId, { format: CSV_FORMATS[format], delimiter, spreadsheetSafe });
    if (!result.ok) {
      notify(s.importFailed(strings.loadErrors[result.error.code] ?? result.error.code), "error");
      return;
    }
    const { rows, issues, removed } = result.value;
    if (removed > 0 && !window.confirm(s.confirmImport(removed))) return;
    commit(replaceRows(project, table.id, rows));
    const skipped = issues.flatMap((i) => (i.code === "formula-column" ? [i.column] : []));
    const text = s.imported(rows.length, removed, issues.filter((i) => i.code === "invalid-value").length);
    notify(skipped.length > 0 ? `${text} ${s.importedFormulas(skipped.join(", "))}` : text, issues.length > skipped.length ? "error" : "info");
  };

  return (
    <div className="teditor">
      <div className="toolbar" role="toolbar" aria-label={strings.assets.kind.table}>
        <button type="button" onClick={onAddRow}>
          {s.addRow}
        </button>
        <button type="button" onClick={onDeleteSelectedRows} disabled={!hasCells}>
          {selectedRows === 1 ? s.deleteSelectedRow : s.deleteSelectedRows(selectedRows)}
        </button>
        <button type="button" onClick={onFillDown} disabled={!hasCells} title={s.fillDownHint}>
          {s.fillDown}
        </button>
        <span className="toolbar-sep" aria-hidden="true" />
        <NewColumnForm strings={strings} project={project} table={table} newId={newId} onAdd={(column) => commit(addColumn(project, table.id, column))} />
        <span className="toolbar-sep" aria-hidden="true" />
        <select aria-label={s.format} value={format} onChange={(e) => setFormat(e.target.value as CsvFormatId)}>
          {Object.keys(CSV_FORMATS).map((f) => (
            <option key={f} value={f}>
              {s.formats[f]}
            </option>
          ))}
        </select>
        <label className="check" title={s.spreadsheetSafeHint}>
          <input type="checkbox" checked={spreadsheetSafe} onChange={(e) => setSpreadsheetSafe(e.target.checked)} />
          {s.spreadsheetSafe}
        </label>
        <button type="button" onClick={() => void onImport()}>
          {s.importCsv}
        </button>
        <button type="button" onClick={onExport}>
          {s.exportCsv}
        </button>
        <span className="muted small">{s.rowsCount(table.rows.length)}</span>
      </div>

      <FormulaBar
        strings={strings}
        project={project}
        table={table}
        column={activeColumn}
        rowIndex={hasCells ? focus.row : -1}
        formulas={formulas}
        commit={commit}
        notify={notify}
        inputRef={formulaRef}
        onDone={() => gridRef.current?.focus({ preventScroll: true })}
      />

      <TableGrid
        strings={strings}
        project={project}
        table={table}
        names={names}
        newId={newId}
        commit={commit}
        notify={notify}
        selection={selection}
        setSelection={setSelection}
        deleteRows={deleteRows}
        formulas={formulas}
        gridRef={gridRef}
        onEditFormula={() => formulaRef.current?.focus()}
      />
    </div>
  );
}
