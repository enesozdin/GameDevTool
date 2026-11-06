import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  addColumn,
  addRow,
  buildReferenceIndex,
  cellToText,
  clearRange,
  copyRange,
  CSV_FORMATS,
  exportTableCsv,
  fillDown,
  gridRange,
  importTableCsv,
  isRoleColumn,
  isTextEditable,
  isValidIdentifier,
  parseClipboardText,
  pasteGrid,
  removeColumn,
  removeRows,
  renameRow,
  replaceRows,
  rowNames,
  setBoolRange,
  setCell,
  textToCell,
  uniqueRowName,
  type CellValue,
  type Change,
  type Column,
  type CsvFormatId,
  type GridPoint,
  type GridWriteError,
  type IdGenerator,
  type Project,
  type Result,
  type Row,
  type RowNames,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
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

/** Touch layouts get 44 px rows (minimum touch target). Read once; sizes stay fixed. */
const COARSE_POINTER = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const ROW_HEIGHT = COARSE_POINTER ? 44 : 40;
const NAME_WIDTH = 200;
const COLUMN_WIDTH = 180;
const ACTION_WIDTH = 48;

/** The cell being edited, by id, so an undo or a removed row cannot redirect the edit. */
interface Editing {
  readonly rowId: string;
  /** null = the row name. */
  readonly columnId: string | null;
  /** Text typed to start editing (replaces the value); null = edit the current value. */
  readonly typed: string | null;
}

interface Selection {
  readonly anchor: GridPoint;
  readonly focus: GridPoint;
}

/**
 * Spreadsheet-style grid for a table asset. Rows and columns are virtualized, so the DOM
 * holds only the visible cells; there is one editor, in the active cell. Keyboard: arrows
 * (Shift extends, Ctrl jumps to the edge), Home/End, PageUp/PageDown, Enter or F2 or
 * typing edits, Ctrl+Enter writes the edit into every selected cell, Delete clears,
 * Ctrl+D fills down, Ctrl+A selects all, Ctrl+C/X/V use the clipboard as TSV. Every
 * paste, fill or clear is one undo step.
 */
export function TableEditor({ strings, project, table, newId, commit, saveFile, pickTextFile, notify }: TableEditorProps) {
  const s = strings.tables;
  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<CsvFormatId>("generic");
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(false);
  const names = useMemo(() => rowNames(project), [project]);

  const lastRow = table.rows.length - 1;
  const lastCol = table.columns.length;
  const firstPoint: GridPoint = { row: 0, col: Math.min(1, lastCol) };
  const [selection, setSelection] = useState<Selection>({ anchor: firstPoint, focus: firstPoint });
  const [editing, setEditing] = useState<Editing | null>(null);

  // The selection is kept inside the table when rows or columns go away.
  const clamp = (p: GridPoint): GridPoint => ({ row: Math.max(0, Math.min(p.row, lastRow)), col: Math.max(0, Math.min(p.col, lastCol)) });
  const focus = clamp(selection.focus);
  const anchor = clamp(selection.anchor);
  const range = gridRange(anchor, focus);
  const hasCells = table.rows.length > 0;

  const rowVirtualizer = useVirtualizer({
    count: table.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => table.rows[i]!.id,
    overscan: 10,
    // The sticky header covers the first row.
    scrollPaddingStart: ROW_HEIGHT,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: table.columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COLUMN_WIDTH,
    getItemKey: (i) => table.columns[i]!.id,
    overscan: 2,
    paddingStart: NAME_WIDTH,
    // The sticky name column covers the first data columns.
    scrollPaddingStart: NAME_WIDTH,
  });
  const visibleCols = colVirtualizer.getVirtualItems();
  const c0 = visibleCols.length > 0 ? visibleCols[0]!.index : 0;
  const c1 = visibleCols.length > 0 ? visibleCols[visibleCols.length - 1]!.index : -1;
  const width = NAME_WIDTH + table.columns.length * COLUMN_WIDTH + ACTION_WIDTH;

  // Keep the active cell in view (and therefore rendered, for aria-activedescendant).
  useEffect(() => {
    if (!hasCells) return;
    rowVirtualizer.scrollToIndex(focus.row, { align: "auto" });
    if (focus.col > 0) colVirtualizer.scrollToIndex(focus.col - 1, { align: "auto" });
  }, [focus.row, focus.col, hasCells, rowVirtualizer, colVirtualizer]);

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });
  const select = (p: GridPoint, extend: boolean) => {
    const next = clamp(p);
    setSelection((cur) => ({ anchor: extend ? clamp(cur.anchor) : next, focus: next }));
  };

  const report = (result: Result<Change | null, GridWriteError>) => {
    if (result.ok) commit(result.value);
    else notify(s.tooManyCells(result.error.limit), "error");
  };

  const startEditing = (typed: string | null) => {
    const row = table.rows[focus.row];
    if (row === undefined) return;
    const column = focus.col === 0 ? null : table.columns[focus.col - 1]!;
    if (column !== null && !isTextEditable(column)) return;
    if (column?.type.kind === "bool") {
      // Yes/No cells toggle instead of opening an editor; the whole selection follows.
      report(setBoolRange(project, table.id, range, row.cells[column.id] !== true));
      return;
    }
    // The selection stays, so Ctrl+Enter can write the edit into all of it.
    setEditing({ rowId: row.id, columnId: column?.id ?? null, typed });
  };
  const setAnchorToFocus = () => setSelection({ anchor: focus, focus });

  const stopEditing = (move?: { dr: number; dc: number }) => {
    setEditing(null);
    if (move !== undefined) select({ row: focus.row + move.dr, col: focus.col + move.dc }, false);
    focusGrid();
  };

  // ---- Clipboard ------------------------------------------------------------------
  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !hasCells) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", copyRange(table, range, names));
  };
  const onCut = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !hasCells) return;
    onCopy(e);
    report(clearRange(project, table.id, range));
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text === "") return;
    const target = hasCells ? range : { top: 0, left: 0, bottom: 0, right: 0 };
    const result = pasteGrid(project, table.id, target, parseClipboardText(text), names, newId);
    if (!result.ok) return notify(s.tooManyCells(result.error.limit), "error");
    const { change, invalid, skipped, addedRows } = result.value;
    commit(change);
    if (invalid > 0 || skipped > 0) notify(s.pasted(invalid, skipped), "error");
    else if (addedRows > 0) notify(s.pastedRows(addedRows), "info");
  };

  // ---- Keyboard -------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || editor !== null || !hasCells) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 2);
    const go = (row: number, col: number) => {
      e.preventDefault();
      select({ row, col }, e.shiftKey);
    };
    switch (e.key) {
      case "ArrowUp":
        return go(ctrl ? 0 : focus.row - 1, focus.col);
      case "ArrowDown":
        return go(ctrl ? lastRow : focus.row + 1, focus.col);
      case "ArrowLeft":
        return go(focus.row, ctrl ? 0 : focus.col - 1);
      case "ArrowRight":
        return go(focus.row, ctrl ? lastCol : focus.col + 1);
      case "Home":
        return go(ctrl ? 0 : focus.row, 0);
      case "End":
        return go(ctrl ? lastRow : focus.row, lastCol);
      case "PageUp":
        return go(focus.row - page, focus.col);
      case "PageDown":
        return go(focus.row + page, focus.col);
      case "Enter":
      case "F2":
        e.preventDefault();
        return startEditing(null);
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return report(clearRange(project, table.id, range));
      case "Escape":
        return setAnchorToFocus();
    }
    if (ctrl && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        setSelection({ anchor: { row: 0, col: 0 }, focus: { row: lastRow, col: lastCol } });
      } else if (key === "d") {
        e.preventDefault();
        report(fillDown(project, table.id, range, newId));
      }
      return;
    }
    if (e.key === " " && focus.col > 0 && table.columns[focus.col - 1]!.type.kind === "bool") {
      e.preventDefault();
      return startEditing(null);
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      startEditing(e.key);
    }
  };

  // ---- Pointer --------------------------------------------------------------------
  const dragging = useRef(false);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  const pointAt = (target: EventTarget): GridPoint | null => {
    const cell = (target as HTMLElement).closest?.<HTMLElement>("[data-row]");
    if (cell === null || cell === undefined) return null;
    return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
  };
  const isEditorEvent = (target: EventTarget) => (target as HTMLElement).closest?.(".tcell-editor") != null;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isEditorEvent(e.target)) return;
    const p = pointAt(e.target);
    if (p === null) return;
    // An open editor commits on blur when the grid takes focus.
    if (e.pointerType === "mouse") {
      select(p, e.shiftKey);
      dragging.current = !e.shiftKey;
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const p = pointAt(e.target);
    if (p !== null && (p.row !== focus.row || p.col !== focus.col)) setSelection((cur) => ({ anchor: cur.anchor, focus: clamp(p) }));
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (isEditorEvent(e.target)) return;
    const p = pointAt(e.target);
    if (p === null) return;
    // Touch and pen: a tap selects, a tap on the active cell edits.
    const pointerType = (e.nativeEvent as globalThis.PointerEvent).pointerType;
    if (pointerType === "touch" || pointerType === "pen") {
      if (p.row === focus.row && p.col === focus.col && anchor.row === focus.row && anchor.col === focus.col) startEditing(null);
      else select(p, false);
    }
    if (editor === null) focusGrid();
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!isEditorEvent(e.target) && pointAt(e.target) !== null) startEditing(null);
  };

  // ---- Rows -----------------------------------------------------------------------
  const projectRef = useRef(project);
  useLayoutEffect(() => {
    projectRef.current = project;
  });
  const onDeleteRow = useCallback(
    (row: Row) => {
      // Other assets that use this row (recipes, graphs, references) would be left broken.
      const p = projectRef.current;
      const used = buildReferenceIndex(p).usedBy(row.id).filter((r) => r.source !== table.id).length;
      if (used > 0 && !window.confirm(s.confirmDeleteRow(row.name, used))) return;
      commit(removeRows(p, table.id, new Set([row.id])));
    },
    [commit, s, table.id],
  );
  const onDeleteSelectedRows = () => {
    const ids = new Set(table.rows.slice(range.top, range.bottom + 1).map((r) => r.id));
    const index = buildReferenceIndex(project);
    let used = 0;
    for (const id of ids) used += index.usedBy(id).filter((r) => r.source !== table.id).length;
    if ((used > 0 || ids.size > 1) && !window.confirm(s.confirmDeleteRows(ids.size, used))) return;
    commit(removeRows(project, table.id, ids));
    setSelection({ anchor: { row: range.top, col: focus.col }, focus: { row: range.top, col: focus.col } });
  };

  const onAddRow = () => {
    commit(addRow(project, table.id, { id: newId(), name: uniqueRowName(table, "NewRow"), cells: {} }));
    const p = { row: table.rows.length, col: focus.col };
    setSelection({ anchor: p, focus: p });
  };

  // ---- CSV ------------------------------------------------------------------------
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

  // ---- Editor ---------------------------------------------------------------------
  const editRow = editing === null ? undefined : table.rows.find((r) => r.id === editing.rowId);
  const editColumn = editing?.columnId == null ? null : table.columns.find((c) => c.id === editing.columnId);
  let editor: ReactNode = null;
  if (editing !== null && editRow !== undefined && editColumn !== undefined) {
    const onCommitValue = (value: CellValue | undefined, move?: { dr: number; dc: number }, toSelection?: string) => {
      if (toSelection !== undefined) {
        const result = pasteGrid(project, table.id, range, [[toSelection]], names, newId);
        if (result.ok) {
          commit(result.value.change);
          if (result.value.invalid > 0) notify(s.pasted(result.value.invalid, 0), "error");
        } else notify(s.tooManyCells(result.error.limit), "error");
      } else if (editColumn === null) {
        commit(renameRow(project, table.id, editRow.id, value as string));
      } else {
        commit(setCell(project, table.id, editRow.id, editColumn.id, value));
      }
      stopEditing(move);
    };
    editor =
      editColumn !== null && (editColumn.type.kind === "enum" || editColumn.type.kind === "reference") ? (
        <ChoiceEditor strings={strings} column={editColumn} value={editRow.cells[editColumn.id]} names={names} onCommit={(v) => onCommitValue(v)} onCancel={() => stopEditing()} />
      ) : (
        <TextEditor
          label={editColumn === null ? s.rowName : editColumn.name}
          initial={editing.typed ?? (editColumn === null ? editRow.name : cellToText(editColumn.type, editRow.cells[editColumn.id], names))}
          placeholder={editColumn?.type.kind === "stacks" ? s.stacksHint : editColumn?.type.kind === "list" ? s.listHint : undefined}
          parse={(t) => {
            if (editColumn === null) return isValidIdentifier(t.trim()) ? t.trim() : INVALID;
            const v = textToCell(editColumn.type, t, names, editRow.cells[editColumn.id], newId);
            return v === null ? undefined : v === undefined ? INVALID : v;
          }}
          allowFillSelection={range.top !== range.bottom || range.left !== range.right}
          onCommit={onCommitValue}
          onCancel={() => stopEditing()}
        />
      );
  }

  // The edited row or column went away (undo, delete): drop the edit.
  const staleEdit = editing !== null && editor === null;
  const editGridCol = editColumn === null ? 0 : editColumn === undefined ? -1 : table.columns.indexOf(editColumn) + 1;
  useEffect(() => {
    if (staleEdit) setEditing(null);
  }, [staleEdit]);

  const activeId = `${gridId}-active`;
  const singleRow = range.top === range.bottom;

  return (
    <div className="teditor">
      <div className="toolbar" role="toolbar" aria-label={strings.assets.kind.table}>
        <button type="button" onClick={onAddRow}>
          {s.addRow}
        </button>
        <button type="button" onClick={onDeleteSelectedRows} disabled={!hasCells}>
          {singleRow ? s.deleteSelectedRow : s.deleteSelectedRows(range.bottom - range.top + 1)}
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

      <div
        ref={scrollRef}
        className="tgrid"
        role="grid"
        tabIndex={0}
        aria-label={table.name}
        aria-describedby={`${gridId}-help`}
        aria-multiselectable="true"
        aria-rowcount={table.rows.length + 1}
        aria-colcount={table.columns.length + 1}
        aria-activedescendant={hasCells && editor === null ? activeId : undefined}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onCut={onCut}
        onPaste={onPaste}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <div className="tgrid-head" role="row" aria-rowindex={1} style={{ width }}>
          <div role="columnheader" aria-colindex={1} className="tcell tcell-name">
            {s.rowName}
          </div>
          <div className="tgrid-spacer" style={{ width: c0 * COLUMN_WIDTH }} />
          {table.columns.slice(c0, c1 + 1).map((c, k) => (
            <div key={c.id} role="columnheader" aria-colindex={c0 + k + 2} className="tcell" title={c.description}>
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
        {!hasCells ? (
          <p className="muted tgrid-empty">{s.empty}</p>
        ) : (
          <div className="listbox-inner" style={{ height: rowVirtualizer.getTotalSize(), width }}>
            {rowVirtualizer.getVirtualItems().map((v) => {
              const inRange = v.index >= range.top && v.index <= range.bottom;
              const isFocusRow = v.index === focus.row;
              return (
                <GridRow
                  key={v.key}
                  strings={strings}
                  table={table}
                  row={table.rows[v.index]!}
                  index={v.index}
                  top={v.start}
                  c0={c0}
                  c1={c1}
                  names={names}
                  selLeft={inRange ? range.left : -1}
                  selRight={inRange ? range.right : -1}
                  activeCol={isFocusRow ? focus.col : -1}
                  activeId={activeId}
                  editCol={editor !== null && editRow?.id === table.rows[v.index]!.id ? editGridCol : -1}
                  editor={editor !== null && editRow?.id === table.rows[v.index]!.id ? editor : null}
                  onDelete={onDeleteRow}
                />
              );
            })}
          </div>
        )}
      </div>
      <p id={`${gridId}-help`} className="muted small">
        {s.gridHelp}
      </p>
    </div>
  );
}

interface GridRowProps {
  readonly strings: UiStrings;
  readonly table: TableAsset;
  readonly row: Row;
  readonly index: number;
  readonly top: number;
  /** First and last rendered data column (indices into table.columns). */
  readonly c0: number;
  readonly c1: number;
  readonly names: RowNames;
  /** Selected grid columns in this row, or -1 when the row is not selected. */
  readonly selLeft: number;
  readonly selRight: number;
  /** Grid column of the active cell when it is in this row, else -1. */
  readonly activeCol: number;
  readonly activeId: string;
  /** Grid column being edited in this row, else -1. */
  readonly editCol: number;
  /** Editor for that cell. */
  readonly editor: ReactNode;
  readonly onDelete: (row: Row) => void;
}

const GridRow = memo(function GridRow({ strings, table, row, index, top, c0, c1, names, selLeft, selRight, activeCol, activeId, editCol, editor, onDelete }: GridRowProps) {
  const s = strings.tables;
  const cell = (col: number, className: string, content: ReactNode) => {
    const selected = col >= selLeft && col <= selRight;
    const active = col === activeCol;
    return (
      <div
        key={col}
        role="gridcell"
        id={active ? activeId : undefined}
        aria-colindex={col + 1}
        aria-selected={selected}
        data-row={index}
        data-col={col}
        className={`tcell ${className}${selected ? " is-sel" : ""}${active ? " is-active" : ""}`}
      >
        {col === editCol ? editor : content}
      </div>
    );
  };
  const cells: ReactNode[] = [cell(0, "tcell-name", <span className="tcell-text">{row.name}</span>)];
  cells.push(<div key="pad" className="tgrid-spacer" style={{ width: c0 * COLUMN_WIDTH }} />);
  for (let c = c0; c <= c1; c++) {
    const column = table.columns[c]!;
    cells.push(cell(c + 1, isNumeric(column) ? "tcell-num" : "", <CellView strings={strings} column={column} value={row.cells[column.id]} names={names} />));
  }
  cells.push(<div key="pad2" className="tgrid-spacer" style={{ width: (table.columns.length - c1 - 1) * COLUMN_WIDTH }} />);
  return (
    <div role="row" aria-rowindex={index + 2} className="tgrid-row" style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}>
      {cells}
      <div role="gridcell" className="tcell tcell-action">
        <button type="button" className="icon" tabIndex={-1} aria-label={s.deleteRow(row.name)} onClick={() => onDelete(row)}>
          ×
        </button>
      </div>
    </div>
  );
});

function isNumeric(column: Column): boolean {
  return column.type.kind === "int" || column.type.kind === "float";
}

function CellView({ strings, column, value, names }: { strings: UiStrings; column: Column; value: CellValue | undefined; names: RowNames }) {
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

function ChoiceEditor({ strings, column, value, names, onCommit, onCancel }: { strings: UiStrings; column: Column; value: CellValue | undefined; names: RowNames; onCommit: (v: CellValue | undefined) => void; onCancel: () => void }) {
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
const INVALID: unique symbol = Symbol("invalid");

function TextEditor<T>({
  label,
  initial,
  placeholder,
  parse,
  allowFillSelection,
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  placeholder?: string | undefined;
  parse: (text: string) => T | undefined | typeof INVALID;
  allowFillSelection: boolean;
  onCommit: (value: T | undefined, move?: { dr: number; dc: number }, toSelection?: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const parsed = parse(draft);
  const invalid = parsed === INVALID;
  const done = useRef(false);
  // Scrolled out of view or replaced before blur: keep a valid edit, as blur would.
  const latest = useRef({ draft, parsed, initial, onCommit, onCancel });
  useLayoutEffect(() => {
    latest.current = { draft, parsed, initial, onCommit, onCancel };
  });
  useEffect(
    () => () => {
      if (done.current) return;
      done.current = true;
      const l = latest.current;
      if (l.parsed === INVALID || l.draft === l.initial) l.onCancel();
      else l.onCommit(l.parsed as T | undefined);
    },
    [],
  );
  const finish = (move?: { dr: number; dc: number }, toSelection?: boolean) => {
    if (done.current) return;
    if (toSelection === true) {
      done.current = true;
      return onCommit(undefined, move, draft);
    }
    if (invalid) return;
    done.current = true;
    if (draft === initial) return onCancel();
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
        if (invalid || draft === initial) {
          done.current = true;
          onCancel();
        } else finish();
      }}
    />
  );
}
