import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  addColumn,
  addRow,
  CSV_FORMATS,
  exportTableCsv,
  importTableCsv,
  isRoleColumn,
  isValidIdentifier,
  removeColumn,
  removeRows,
  renameRow,
  replaceRows,
  rowNames,
  setCell,
  uniqueRowName,
  type CellValue,
  type Change,
  type Column,
  type CsvFormatId,
  type IdGenerator,
  type Project,
  type Row,
  type RowNames,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
import { cellToText, textToCell } from "./cell-text.ts";
import { NewColumnForm } from "./NewColumnForm.tsx";

export interface TableEditorProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  /** Saves a file (download); provided by the app. */
  readonly saveFile: (name: string, text: string, type: string) => void;
  /** Lets the user pick a text file; provided by the app. */
  readonly pickTextFile: (accept: string) => Promise<{ name: string; text: string } | null>;
  readonly notify: (text: string, kind: "info" | "error") => void;
}

const ROW_HEIGHT = 40;
const NAME_WIDTH = 200;
const COLUMN_WIDTH = 180;
const ACTION_WIDTH = 48;

/**
 * Typed grid for a table asset. Rows are virtualized (DOM size stays constant), cells
 * commit on Enter or blur, so each edit is one undo step. Spreadsheet features (formulas,
 * copy/paste, bulk edit) follow in Phase 2.
 */
export function TableEditor({ strings, project, table, newId, commit, saveFile, pickTextFile, notify }: TableEditorProps) {
  const s = strings.tables;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<CsvFormatId>("generic");
  const names = useMemo(() => rowNames(project), [project]);

  const virtualizer = useVirtualizer({
    count: table.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => table.rows[i]!.id,
    overscan: 10,
  });
  const width = NAME_WIDTH + table.columns.length * COLUMN_WIDTH + ACTION_WIDTH;

  const onAddRow = () => {
    commit(addRow(project, table.id, { id: newId(), name: uniqueRowName(table, "NewRow"), cells: {} }));
    requestAnimationFrame(() => virtualizer.scrollToIndex(table.rows.length, { align: "end" }));
  };

  const onExport = () => {
    const csv = exportTableCsv(project, table, { format: CSV_FORMATS[format] });
    saveFile(`${table.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "table"}.csv`, csv, "text/csv");
  };

  const onImport = async () => {
    const file = await pickTextFile(".csv,.tsv,text/csv,text/tab-separated-values");
    if (file === null) return;
    const delimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    const result = importTableCsv(project, table, file.text, newId, { format: CSV_FORMATS[format], delimiter });
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
        <button type="button" onClick={() => void onImport()}>
          {s.importCsv}
        </button>
        <button type="button" onClick={onExport}>
          {s.exportCsv}
        </button>
        <span className="muted small">{s.rowsCount(table.rows.length)}</span>
      </div>

      <div ref={scrollRef} className="tgrid" role="grid" aria-rowcount={table.rows.length + 1} aria-colcount={table.columns.length + 1}>
        <div className="tgrid-head" role="row" style={{ width }}>
          <div role="columnheader" className="tcell tcell-name">
            {s.rowName}
          </div>
          {table.columns.map((c) => (
            <div key={c.id} role="columnheader" className="tcell" title={c.description}>
              <span className="tcol-name">{c.name}</span>
              <span className="tcol-type">{s.kindLabel[c.type.kind]}</span>
              {isRoleColumn(table, c.id) ? (
                <span className="tcol-type" title={s.builtIn}>
                  ●
                </span>
              ) : (
                <button type="button" className="icon" aria-label={s.deleteColumn(c.name)} onClick={() => commit(removeColumn(project, table.id, c.id))}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        {table.rows.length === 0 ? (
          <p className="muted tgrid-empty">{s.empty}</p>
        ) : (
          <div className="listbox-inner" style={{ height: virtualizer.getTotalSize(), width }}>
            {virtualizer.getVirtualItems().map((v) => (
              <GridRow
                key={v.key}
                strings={strings}
                project={project}
                table={table}
                row={table.rows[v.index]!}
                index={v.index}
                top={v.start}
                names={names}
                newId={newId}
                commit={commit}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface GridRowProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly row: Row;
  readonly index: number;
  readonly top: number;
  readonly names: RowNames;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
}

const GridRow = memo(function GridRow({ strings, project, table, row, index, top, names, newId, commit }: GridRowProps) {
  const s = strings.tables;
  return (
    <div role="row" aria-rowindex={index + 2} className="tgrid-row" style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}>
      <div role="gridcell" className="tcell tcell-name">
        <CellInput label={s.rowName} text={row.name} parse={(t) => (isValidIdentifier(t) ? t : undefined)} onCommit={(t) => commit(renameRow(project, table.id, row.id, t))} />
      </div>
      {table.columns.map((c) => (
        <div key={c.id} role="gridcell" className="tcell">
          <Cell strings={strings} column={c} value={row.cells[c.id]} names={names} newId={newId} onCommit={(v) => commit(setCell(project, table.id, row.id, c.id, v))} />
        </div>
      ))}
      <div role="gridcell" className="tcell tcell-action">
        <button type="button" className="icon" aria-label={s.deleteRow(row.name)} onClick={() => commit(removeRows(project, table.id, new Set([row.id])))}>
          ×
        </button>
      </div>
    </div>
  );
});

function Cell({ strings, column, value, names, newId, onCommit }: { strings: UiStrings; column: Column; value: CellValue | undefined; names: RowNames; newId: IdGenerator; onCommit: (v: CellValue | undefined) => void }) {
  const s = strings.tables;
  const type = column.type;
  if (type.kind === "bool") {
    return <input type="checkbox" aria-label={column.name} checked={value === true} onChange={(e) => onCommit(e.target.checked)} />;
  }
  if (type.kind === "enum" || type.kind === "reference") {
    const options = type.kind === "enum" ? type.options.map((o) => ({ id: o.id, name: o.name })) : referenceOptions(names, type.table, value);
    return (
      <select aria-label={column.name} value={typeof value === "string" ? value : ""} onChange={(e) => onCommit(e.target.value === "" ? undefined : e.target.value)}>
        <option value="">–</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (type.kind === "curve") {
    const keys = value !== null && typeof value === "object" && !Array.isArray(value) && "keys" in value ? value.keys.length : 0;
    return <span className="muted small">{s.curveSummary(keys)}</span>;
  }
  return (
    <CellInput
      label={column.name}
      text={cellToText(type, value, names)}
      placeholder={type.kind === "stacks" ? s.stacksHint : type.kind === "list" ? s.listHint : undefined}
      parse={(t) => textToCell(type, t, names, value, newId)}
      onCommit={(v) => onCommit(v === null ? undefined : v)}
    />
  );
}

/** Reference choices: the target table's rows. Capped; long tables get a filtered grid in Phase 2. */
const MAX_REFERENCE_OPTIONS = 2_000;
function referenceOptions(names: RowNames, table: string, value: CellValue | undefined): { id: string; name: string }[] {
  const list = names.rowsOf(table).slice(0, MAX_REFERENCE_OPTIONS);
  if (typeof value === "string" && !list.some((r) => r.id === value)) list.push({ id: value, name: names.name(value) ?? value });
  return list;
}

function CellInput<T>({ label, text, placeholder, parse, onCommit }: { label: string; text: string; placeholder?: string; parse: (text: string) => T | undefined; onCommit: (value: T) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [text]);
  const invalid = draft !== null && parse(draft) === undefined;
  const commit = () => {
    if (draft === null || draft === text) return setDraft(null);
    const v = parse(draft);
    if (v === undefined) return;
    setDraft(null);
    onCommit(v);
  };
  return (
    <input
      type="text"
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={draft ?? text}
      aria-invalid={invalid}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(null);
      }}
      onBlur={() => {
        commit();
        setDraft(null);
      }}
    />
  );
}
