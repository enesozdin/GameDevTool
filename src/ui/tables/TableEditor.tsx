import { useMemo, useState } from "react";
import {
  addColumn,
  addRow,
  CSV_FORMATS,
  exportTableCsv,
  fillDown,
  importTableCsv,
  rangeOf,
  replaceRows,
  rowNames,
  uniqueRowName,
  type Change,
  type CsvFormatId,
  type IdGenerator,
  type Project,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
import { confirmRemoveRows, DataGrid, INITIAL_SELECTION, type GridSelection } from "./DataGrid.tsx";
import { NewColumnForm } from "./NewColumnForm.tsx";

/** A text file the user picked, or why it could not be read. */
export type PickedTextFile = { readonly name: string; readonly text: string } | { readonly name: string; readonly error: "too-large" | "read-failed" };

export interface TableEditorProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  /** Saves a file (download); provided by the app. */
  readonly saveFile: (name: string, text: string, type: string) => void;
  /** Lets the user pick a text file; provided by the app. */
  readonly pickTextFile: (accept: string) => Promise<PickedTextFile | null>;
  readonly notify: (text: string, kind: "info" | "error") => void;
}

/**
 * Table asset editor: toolbar (rows, columns, CSV) above the spreadsheet grid. Every edit
 * is one undo step, including a paste or fill over many cells.
 */
export function TableEditor({ strings, project, table, newId, commit, saveFile, pickTextFile, notify }: TableEditorProps) {
  const s = strings.tables;
  const [selection, setSelection] = useState<GridSelection>(INITIAL_SELECTION);
  const range = rangeOf(table, selection.anchor, selection.active);
  const [format, setFormat] = useState<CsvFormatId>("generic");
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(false);
  const names = useMemo(() => rowNames(project), [project]);

  const onAddRow = () => {
    commit(addRow(project, table.id, { id: newId(), name: uniqueRowName(table, "NewRow"), cells: {} }));
    const row = table.rows.length;
    setSelection({ anchor: { row, col: 0 }, active: { row, col: 0 } });
  };

  const onDeleteRows = () => {
    if (range === null) return;
    commit(confirmRemoveRows(project, table, table.rows.slice(range.row0, range.row1 + 1), s));
  };

  const onExport = () => {
    const csv = exportTableCsv(project, table, { format: CSV_FORMATS[format], spreadsheetSafe });
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
    notify(s.imported(rows.length, removed, issues.filter((i) => i.code === "invalid-value").length), issues.length > 0 ? "error" : "info");
  };

  return (
    <div className="teditor">
      <div className="toolbar" role="toolbar" aria-label={strings.assets.kind.table}>
        <button type="button" onClick={onAddRow}>
          {s.addRow}
        </button>
        <button type="button" disabled={range === null} onClick={onDeleteRows}>
          {s.deleteRows(range === null ? 0 : range.row1 - range.row0 + 1)}
        </button>
        <button type="button" disabled={range === null || range.row0 === range.row1} title={s.fillDownHint} onClick={() => range !== null && commit(fillDown(project, table.id, range, newId))}>
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

      <DataGrid
        strings={strings}
        project={project}
        table={table}
        names={names}
        newId={newId}
        commit={commit}
        notify={notify}
        selection={selection}
        onSelect={setSelection}
      />
    </div>
  );
}
