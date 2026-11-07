import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  clearRange,
  copyRange,
  fillDown,
  gridRange,
  isRoleColumn,
  isTextEditable,
  isValidIdentifier,
  parseClipboardText,
  pasteGrid,
  removeColumn,
  renameRow,
  setBoolRange,
  setCell,
  textToCell,
  cellToText,
  type CellValue,
  type Change,
  type GridPoint,
  type GridRange,
  type GridWrite,
  type GridWriteError,
  type IdGenerator,
  type Project,
  type Result,
  type Row,
  type RowNames,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
import { CellView, ChoiceEditor, INVALID, isNumeric, TextEditor } from "./CellEditors.tsx";

/** Touch layouts get 44 px rows (minimum touch target). Read once; sizes stay fixed. */
const COARSE_POINTER = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const ROW_HEIGHT = COARSE_POINTER ? 44 : 40;
const NAME_WIDTH = 200;
const COLUMN_WIDTH = 180;
const ACTION_WIDTH = 48;

export interface GridSelection {
  /** Fixed corner (where Shift+click or a drag started). */
  readonly anchor: GridPoint;
  /** Moving corner: the active cell. */
  readonly focus: GridPoint;
}

export function initialSelection(table: TableAsset): GridSelection {
  const p: GridPoint = { row: 0, col: Math.min(1, table.columns.length) };
  return { anchor: p, focus: p };
}

/** The selection clamped to the table (rows or columns may have gone away) and its range. */
export function resolveSelection(table: TableAsset, selection: GridSelection): { anchor: GridPoint; focus: GridPoint; range: GridRange } {
  const clamp = (p: GridPoint): GridPoint => ({
    row: Math.max(0, Math.min(p.row, table.rows.length - 1)),
    col: Math.max(0, Math.min(p.col, table.columns.length)),
  });
  const anchor = clamp(selection.anchor);
  const focus = clamp(selection.focus);
  return { anchor, focus, range: gridRange(anchor, focus) };
}

/** The cell being edited, by id, so an undo or a removed row cannot redirect the edit. */
interface Editing {
  readonly rowId: string;
  /** null = the row name. */
  readonly columnId: string | null;
  /** Text typed to start editing (replaces the value); null = edit the current value. */
  readonly typed: string | null;
}

type Move = { readonly dr: number; readonly dc: number };

export interface TableGridProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly names: RowNames;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  readonly notify: (text: string, kind: "info" | "error") => void;
  readonly selection: GridSelection;
  readonly setSelection: Dispatch<SetStateAction<GridSelection>>;
  /** Deletes a row after asking when other assets use it (shared with the toolbar). */
  readonly deleteRows: (rows: readonly Row[]) => void;
}

/**
 * Spreadsheet-style grid for a table asset. Rows and columns are virtualized, so the DOM
 * holds only the visible cells plus the active one; there is one editor, in the active
 * cell. Keyboard: arrows (Shift extends, Ctrl jumps to the edge), Home/End,
 * PageUp/PageDown, Enter or F2 or typing edits, Ctrl+Enter writes the edit into every
 * selected cell, Delete clears, Ctrl+D fills down, Ctrl+A selects all, Ctrl+C/X/V use the
 * clipboard as TSV. Every paste, fill or clear is one undo step.
 */
export function TableGrid({ strings, project, table, names, newId, commit, notify, selection, setSelection, deleteRows }: TableGridProps) {
  const s = strings.tables;
  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const lastRow = table.rows.length - 1;
  const lastCol = table.columns.length;
  const hasCells = table.rows.length > 0;
  const { anchor, focus, range } = resolveSelection(table, selection);
  const clamp = (p: GridPoint): GridPoint => resolveSelection(table, { anchor: p, focus: p }).focus;

  // ---- Editor state (resolved by id; a missing row or column drops the edit) ----------
  const editRowIndex = editing === null ? -1 : table.rows.findIndex((r) => r.id === editing.rowId);
  const editRow = editRowIndex < 0 ? undefined : table.rows[editRowIndex];
  const editColumn = editing?.columnId == null ? null : table.columns.find((c) => c.id === editing.columnId);
  const editActive = editing !== null && editRow !== undefined && editColumn !== undefined;
  const editGridCol = !editActive ? -1 : editColumn === null ? 0 : table.columns.indexOf(editColumn) + 1;
  useEffect(() => {
    if (editing !== null && !editActive) setEditing(null);
  }, [editing, editActive]);

  // ---- Virtualization. The active and the edited row are always rendered, so the
  // editor never unmounts while scrolled away and aria-activedescendant always resolves.
  const keepRows = useCallback(
    (r: Range) => {
      const out = defaultRangeExtractor(r);
      for (const i of [focus.row, editRowIndex]) if (i >= 0 && i < r.count && !out.includes(i)) out.push(i);
      return out.sort((a, b) => a - b);
    },
    [focus.row, editRowIndex],
  );
  const rowVirtualizer = useVirtualizer({
    count: table.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => table.rows[i]!.id,
    rangeExtractor: keepRows,
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

  const scrollToCell = (p: GridPoint) => {
    if (!hasCells) return;
    rowVirtualizer.scrollToIndex(p.row, { align: "auto" });
    if (p.col > 0) colVirtualizer.scrollToIndex(p.col - 1, { align: "auto" });
  };
  // Moving the active cell brings it into view.
  useEffect(() => scrollToCell(focus), [focus.row, focus.col, hasCells]);

  // ---- Actions ----------------------------------------------------------------------
  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });
  const select = (p: GridPoint, extend: boolean) => {
    const next = clamp(p);
    setSelection((cur) => ({ anchor: extend ? clamp(cur.anchor) : next, focus: next }));
  };
  const report = (result: Result<Change | null, GridWriteError>) => {
    if (result.ok) commit(result.value);
    else notify(s.tooManyCells(result.error.limit), "error");
  };
  /** Commits a paste-like write and tells the user what did not fit. */
  const applyWrite = (result: Result<GridWrite, GridWriteError>) => {
    if (!result.ok) return notify(s.tooManyCells(result.error.limit), "error");
    const { change, invalid, skipped, addedRows } = result.value;
    commit(change);
    if (invalid > 0 || skipped > 0) notify(s.pasted(invalid, skipped), "error");
    else if (addedRows > 0) notify(s.pastedRows(addedRows), "info");
  };

  const startEditing = (typed: string | null) => {
    const row = table.rows[focus.row];
    if (row === undefined) return;
    const column = focus.col === 0 ? null : table.columns[focus.col - 1]!;
    if (column !== null && !isTextEditable(column)) return;
    if (column?.type.kind === "bool") {
      // Yes/No cells toggle (Enter, Space, double-click, tap) instead of opening an
      // editor; typed letters do nothing. The whole selection follows the active cell.
      if (typed === null) report(setBoolRange(project, table.id, range, row.cells[column.id] !== true));
      return;
    }
    scrollToCell(focus);
    // The selection stays, so Ctrl+Enter can write the edit into all of it.
    setEditing({ rowId: row.id, columnId: column?.id ?? null, typed });
  };
  const stopEditing = (move?: Move) => {
    setEditing(null);
    if (move !== undefined) select({ row: focus.row + move.dr, col: focus.col + move.dc }, false);
    focusGrid();
  };

  // ---- Clipboard --------------------------------------------------------------------
  // Browsers fire copy/cut/paste reliably only on an editable element (Safari enables Copy
  // only with a text selection). Ctrl+C/X/V on the grid therefore moves focus to a hidden
  // text area with a selection, the browser runs its own copy or paste there, and the
  // handlers below fill or read the clipboard and give focus back.
  const routeClipboard = () => {
    const clip = clipRef.current;
    if (clip === null) return;
    clip.value = " ";
    clip.focus({ preventScroll: true });
    clip.select();
  };
  const onCopy = (e: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    e.preventDefault();
    focusGrid();
    if (!hasCells) return;
    const text = copyRange(table, range, names);
    if (!text.ok) return notify(s.tooManyCells(text.error.limit), "error");
    e.clipboardData.setData("text/plain", text.value);
    if (cut) report(clearRange(project, table.id, range));
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    focusGrid();
    const text = e.clipboardData.getData("text/plain");
    if (text === "") return;
    const target = hasCells ? range : { top: 0, left: 0, bottom: 0, right: 0 };
    applyWrite(pasteGrid(project, table.id, target, parseClipboardText(text), names, newId));
  };

  // ---- Keyboard ---------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in the editor or the clipboard area are theirs.
    if (e.target !== e.currentTarget) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && !e.altKey && !e.shiftKey && (key === "c" || key === "x" || key === "v")) {
      // Not prevented: the browser's copy/paste runs in the text area. Paste also works on
      // an empty table.
      return routeClipboard();
    }
    if (!hasCells) return;
    // AltGr (Ctrl+Alt on Windows) types characters such as @ and {, used by the stacks syntax.
    const altGr = e.getModifierState("AltGraph");
    const page = Math.max(1, Math.floor(e.currentTarget.clientHeight / ROW_HEIGHT) - 2);
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
        return setSelection({ anchor: focus, focus });
    }
    if (ctrl && !e.altKey) {
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
    if (e.key.length === 1 && ((!ctrl && !e.altKey) || altGr)) {
      e.preventDefault();
      startEditing(e.key);
    }
  };

  // ---- Pointer ----------------------------------------------------------------------
  const dragging = useRef(false);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
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
    // An open editor saves on blur when the grid takes focus.
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
    if (!editActive) focusGrid();
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!isEditorEvent(e.target) && pointAt(e.target) !== null) startEditing(null);
  };

  // Rows keep a stable callback; the delete button had focus, so give it back to the grid.
  const deleteRowsRef = useRef(deleteRows);
  useLayoutEffect(() => {
    deleteRowsRef.current = deleteRows;
  });
  const onDeleteRow = useCallback((row: Row) => {
    deleteRowsRef.current([row]);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // ---- Editor -----------------------------------------------------------------------
  let editor: ReactNode = null;
  if (editActive && editing !== null && editRow !== undefined && editColumn !== undefined) {
    // Called from the editor's own events (Enter, Tab, blur) with this render's project.
    const onCommitValue = (value: CellValue | undefined, move?: Move, toSelection?: string) => {
      if (toSelection !== undefined) applyWrite(pasteGrid(project, table.id, range, [[toSelection]], names, newId));
      else if (editColumn === null) commit(renameRow(project, table.id, editRow.id, value as string));
      else commit(setCell(project, table.id, editRow.id, editColumn.id, value));
      stopEditing(move);
    };
    editor =
      editColumn !== null && (editColumn.type.kind === "enum" || editColumn.type.kind === "reference") ? (
        <ChoiceEditor strings={strings} column={editColumn} value={editRow.cells[editColumn.id]} names={names} onCommit={(v) => onCommitValue(v)} onCancel={() => stopEditing()} />
      ) : (
        <TextEditor
          label={editColumn === null ? s.rowName : editColumn.name}
          current={editColumn === null ? editRow.name : cellToText(editColumn.type, editRow.cells[editColumn.id], names)}
          typed={editing.typed}
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

  const activeId = `${gridId}-active`;
  const colCount = table.columns.length + 2; // name + data columns + row actions

  return (
    <>
      <div
        ref={scrollRef}
        className="tgrid"
        role="grid"
        tabIndex={0}
        aria-label={table.name}
        aria-describedby={`${gridId}-help`}
        aria-multiselectable="true"
        aria-rowcount={table.rows.length + 1}
        aria-colcount={colCount}
        aria-activedescendant={hasCells && !editActive ? activeId : undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <textarea
          ref={clipRef}
          className="tgrid-clip"
          tabIndex={-1}
          aria-hidden="true"
          onCopy={(e) => onCopy(e, false)}
          onCut={(e) => onCopy(e, true)}
          onPaste={onPaste}
          onKeyUp={focusGrid}
          onBlur={(e) => {
            e.currentTarget.value = "";
          }}
        />
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
          <div className="tgrid-spacer" style={{ width: (table.columns.length - c1 - 1) * COLUMN_WIDTH }} />
          <div role="columnheader" aria-colindex={colCount} aria-label={s.rowActions} className="tcell tcell-action" />
        </div>
        {!hasCells ? (
          <p className="muted tgrid-empty">{s.empty}</p>
        ) : (
          <div className="listbox-inner" style={{ height: rowVirtualizer.getTotalSize(), width }}>
            {rowVirtualizer.getVirtualItems().map((v) => {
              const inRange = v.index >= range.top && v.index <= range.bottom;
              const editsThisRow = editor !== null && v.index === editRowIndex;
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
                  activeCol={v.index === focus.row ? focus.col : -1}
                  activeId={activeId}
                  editCol={editsThisRow ? editGridCol : -1}
                  editor={editsThisRow ? editor : null}
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
    </>
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
  const cell = (col: number, className: string, style?: { left: number }) => {
    const selected = col >= selLeft && col <= selRight;
    const active = col === activeCol;
    const column = col === 0 ? undefined : table.columns[col - 1]!;
    const content =
      column === undefined ? <span className="tcell-text">{row.name}</span> : <CellView strings={strings} column={column} value={row.cells[column.id]} names={names} />;
    return (
      <div
        key={col}
        role="gridcell"
        id={active ? activeId : undefined}
        aria-colindex={col + 1}
        aria-selected={selected}
        data-row={index}
        data-col={col}
        style={style}
        className={`tcell ${column !== undefined && isNumeric(column) ? "tcell-num " : ""}${className}${selected ? " is-sel" : ""}${active ? " is-active" : ""}`}
      >
        {col === editCol ? editor : content}
      </div>
    );
  };
  const cells: ReactNode[] = [cell(0, "tcell-name")];
  cells.push(<div key="pad" className="tgrid-spacer" style={{ width: c0 * COLUMN_WIDTH }} />);
  for (let c = c0; c <= c1; c++) cells.push(cell(c + 1, ""));
  cells.push(<div key="pad2" className="tgrid-spacer" style={{ width: (table.columns.length - c1 - 1) * COLUMN_WIDTH }} />);
  // The active and the edited cell stay rendered when scrolled sideways out of view,
  // positioned where they belong (outside the flex flow).
  for (const col of new Set([activeCol, editCol])) {
    if (col > 0 && (col - 1 < c0 || col - 1 > c1)) cells.push(cell(col, "tcell-float", { left: NAME_WIDTH + (col - 1) * COLUMN_WIDTH }));
  }
  return (
    <div role="row" aria-rowindex={index + 2} className="tgrid-row" style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}>
      {cells}
      <div role="gridcell" aria-colindex={table.columns.length + 2} className="tcell tcell-action">
        <button type="button" className="icon" tabIndex={-1} aria-label={s.deleteRow(row.name)} onClick={() => onDelete(row)}>
          ×
        </button>
      </div>
    </div>
  );
});
