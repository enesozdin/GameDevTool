import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  buildReferenceIndex,
  cellToText,
  clearRange,
  copyRange,
  fillDown,
  gridColumnCount,
  isRoleColumn,
  isValidIdentifier,
  MAX_PASTE_CELLS,
  pasteText,
  rangeOf,
  rangeSize,
  removeColumn,
  removeRows,
  renameRow,
  setCell,
  setRangeText,
  textToCell,
  type CellValue,
  type Change,
  type Column,
  type GridPos,
  type GridRange,
  type IdGenerator,
  type Patch,
  type Project,
  type Row,
  type RowNames,
  type TableAsset,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";

export interface GridSelection {
  /** Fixed corner of the range (where a Shift+click or drag started). */
  readonly anchor: GridPos;
  /** Moving corner; the focused cell. */
  readonly active: GridPos;
}

export const INITIAL_SELECTION: GridSelection = { anchor: { row: 0, col: 0 }, active: { row: 0, col: 0 } };

interface Editing {
  readonly row: number;
  readonly col: number;
  /** Text typed to start editing (replaces the cell), or null to edit the current text. */
  readonly seed: string | null;
}

export interface DataGridProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly names: RowNames;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  readonly notify: (text: string, kind: "info" | "error") => void;
  readonly selection: GridSelection;
  readonly onSelect: (selection: GridSelection) => void;
}

/** Touch layouts get 44 px rows (minimum touch target). Read once; sizes stay fixed. */
const COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const ROW_HEIGHT = COARSE ? 44 : 40;
const HEAD_HEIGHT = 40;
const NAME_WIDTH = 200;
const COLUMN_WIDTH = 180;
const ACTION_WIDTH = 48;

/** Clamps a position to the grid; an empty table keeps row 0 (paste target). */
function clampPos(table: TableAsset, p: GridPos): GridPos {
  return {
    row: Math.min(Math.max(p.row, 0), Math.max(table.rows.length - 1, 0)),
    col: Math.min(Math.max(p.col, 0), gridColumnCount(table) - 1),
  };
}

function inRange(range: GridRange | null, row: number, col: number): boolean {
  return range !== null && row >= range.row0 && row <= range.row1 && col >= range.col0 && col <= range.col1;
}

/** Asks before deleting rows that other assets still use. Returns the change or null. */
export function confirmRemoveRows(project: Project, table: TableAsset, rows: readonly Row[], s: UiStrings["tables"]): Change | null {
  if (rows.length === 0) return null;
  const index = buildReferenceIndex(project);
  let used = 0;
  for (const row of rows) used += index.usedBy(row.id).filter((r) => r.source !== table.id).length;
  if (used > 0 && !window.confirm(rows.length === 1 ? s.confirmDeleteRow(rows[0]!.name, used) : s.confirmDeleteRows(rows.length, used))) return null;
  return removeRows(project, table.id, new Set(rows.map((r) => r.id)));
}

/**
 * Spreadsheet-style grid for a table asset. Cells are plain text until edited, so the DOM
 * holds one input at most; rows and columns are virtualized, so DOM size stays constant.
 * Keyboard: arrows (+Shift extends, +Ctrl jumps to the edge), Tab, Home/End, PageUp/Down,
 * Enter/F2 or typing edits, Delete clears, Space toggles yes/no cells, Ctrl+D fills down,
 * Ctrl+A selects all, Ctrl+Enter while editing writes to the whole selection.
 * Copy/cut/paste use the browser's clipboard events (TSV, works from a local file).
 */
export function DataGrid({ strings, project, table, names, newId, commit, notify, selection, onSelect }: DataGridProps) {
  const s = strings.tables;
  const gridRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLTextAreaElement>(null);
  const gridId = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  const rowCount = table.rows.length;
  const colCount = gridColumnCount(table);
  const active = clampPos(table, selection.active);
  const anchor = clampPos(table, selection.anchor);
  const range = rangeOf(table, anchor, active);
  const edit = editing !== null && editing.row < rowCount && editing.col < colCount ? editing : null;

  const rowV = useVirtualizer({
    count: rowCount,
    getScrollElement: () => gridRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => table.rows[i]!.id,
    scrollMargin: HEAD_HEIGHT,
    overscan: 8,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: table.columns.length,
    getScrollElement: () => gridRef.current,
    estimateSize: () => COLUMN_WIDTH,
    getItemKey: (i) => table.columns[i]!.id,
    paddingStart: NAME_WIDTH,
    overscan: 2,
  });
  const visibleCols = colV.getVirtualItems();
  const colStart = visibleCols[0]?.index ?? 0;
  const colEnd = visibleCols.length === 0 ? -1 : visibleCols[visibleCols.length - 1]!.index;
  const width = NAME_WIDTH + table.columns.length * COLUMN_WIDTH + ACTION_WIDTH;

  // Keep the active cell in view (fixed sizes, so no measuring); the name column and the
  // header are sticky, so they are excluded from the visible area.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (el === null || rowCount === 0) return;
    const top = HEAD_HEIGHT + active.row * ROW_HEIGHT;
    if (top - HEAD_HEIGHT < el.scrollTop) el.scrollTop = top - HEAD_HEIGHT;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    if (active.col > 0) {
      const left = NAME_WIDTH + (active.col - 1) * COLUMN_WIDTH;
      if (left - NAME_WIDTH < el.scrollLeft) el.scrollLeft = left - NAME_WIDTH;
      else if (left + COLUMN_WIDTH > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COLUMN_WIDTH - el.clientWidth;
    }
  }, [active.row, active.col]);

  // Handlers read the latest props through a ref, so memoized rows keep stable callbacks.
  const latest = { project, table, names, newId, commit, notify, selection: { anchor, active }, range, onSelect, s, colCount, rowCount };
  const ref = useRef(latest);
  useLayoutEffect(() => {
    ref.current = latest;
  });

  const actions = useMemo(() => {
    const focusGrid = () => gridRef.current?.focus({ preventScroll: true });
    const select = (a: GridPos, b: GridPos = a) => {
      const { table: t, onSelect: set } = ref.current;
      set({ anchor: clampPos(t, a), active: clampPos(t, b) });
    };
    const commitValue = (row: number, col: number, value: CellValue | undefined | string) => {
      const { project: p, table: t, commit: c } = ref.current;
      const r = t.rows[row];
      if (r === undefined) return;
      if (col === 0) c(renameRow(p, t.id, r.id, String(value)));
      else c(setCell(p, t.id, r.id, t.columns[col - 1]!.id, value as CellValue | undefined));
    };
    /** Space / Enter on a yes/no cell; `single` (a click on the box) ignores the selection. */
    const toggleBool = (row: number, col: number, single = false) => {
      const { project: p, table: t, range: rg, commit: c } = ref.current;
      const column = t.columns[col - 1];
      if (column?.type.kind !== "bool") return;
      const next = t.rows[row]?.cells[column.id] !== true;
      if (single || rg === null || !inRange(rg, row, col) || (rg.row0 === rg.row1 && rg.col0 === rg.col1)) return commitValue(row, col, next);
      // Whole selection: every yes/no column in it gets the toggled value of this cell.
      const patches: Patch[] = [];
      for (let k = Math.max(rg.col0, 1); k <= rg.col1; k++) {
        if (t.columns[k - 1]?.type.kind !== "bool") continue;
        const part = setRangeText(p, t.id, { ...rg, col0: k, col1: k }, String(next), ref.current.names, ref.current.newId).change;
        if (part !== null) patches.push(...part.patches);
      }
      c(patches.length === 0 ? null : { label: "bulk-edit", patches });
    };
    return {
      focusGrid,
      select,
      toggleBool,
      startEdit(row: number, col: number, seed: string | null) {
        const { table: t } = ref.current;
        const column = col === 0 ? undefined : t.columns[col - 1];
        if (t.rows[row] === undefined || column?.type.kind === "curve") return;
        if (column?.type.kind === "bool") return toggleBool(row, col);
        setEditing({ row, col, seed });
      },
      /**
       * Ends editing. `value` null = cancelled or unchanged. `move` (from the keyboard) steps
       * the active cell (Enter → down, Tab → right) and returns focus to the grid; null (blur)
       * leaves focus where the user put it.
       */
      finishEdit(row: number, col: number, value: { text: string } | null, move: Move, all = false) {
        setEditing(null);
        const { project: p, table: t, names: n, newId: id, range: rg, commit: c, notify: say, s: str } = ref.current;
        if (value !== null) {
          if (all && rg !== null && inRange(rg, row, col)) {
            const result = setRangeText(p, t.id, rg, value.text, n, id);
            c(result.change);
            if (result.invalid > 0) say(str.bulkInvalid(result.invalid), "error");
          } else if (col === 0) {
            if (isValidIdentifier(value.text.trim())) commitValue(row, col, value.text.trim());
            else say(str.invalidCell(str.rowName), "error");
          } else {
            const column = t.columns[col - 1]!;
            const parsed = textToCell(column.type, value.text, n, t.rows[row]?.cells[column.id], id);
            if (parsed === undefined) say(str.invalidCell(column.name), "error");
            else commitValue(row, col, parsed === null ? undefined : parsed);
          }
        }
        if (move === null) return;
        if (move.dr !== 0 || move.dc !== 0) select({ row: row + move.dr, col: col + move.dc });
        focusGrid();
      },
      commitValue,
      dragging: { current: false },
    };
  }, []);

  useEffect(() => {
    const stop = () => {
      actions.dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [actions]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== gridRef.current) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const pageRows = Math.max(1, Math.floor((e.currentTarget.clientHeight - HEAD_HEIGHT) / ROW_HEIGHT) - 1);
    const move = (row: number, col: number, extend = e.shiftKey) => {
      e.preventDefault();
      if (extend) actions.select(anchor, { row, col });
      else actions.select({ row, col });
    };
    switch (e.key) {
      case "ArrowUp":
        return move(ctrl ? 0 : active.row - 1, active.col);
      case "ArrowDown":
        return move(ctrl ? rowCount - 1 : active.row + 1, active.col);
      case "ArrowLeft":
        return move(active.row, ctrl ? 0 : active.col - 1);
      case "ArrowRight":
        return move(active.row, ctrl ? colCount - 1 : active.col + 1);
      case "Home":
        return move(ctrl ? 0 : active.row, 0);
      case "End":
        return move(ctrl ? rowCount - 1 : active.row, colCount - 1);
      case "PageUp":
        return move(active.row - pageRows, active.col);
      case "PageDown":
        return move(active.row + pageRows, active.col);
      case "Tab":
        // Leaves the grid at the row's ends, so keyboard users are never trapped.
        if (e.shiftKey ? active.col > 0 : active.col < colCount - 1) move(active.row, active.col + (e.shiftKey ? -1 : 1), false);
        return;
      case "Enter":
      case "F2":
        if (ctrl || e.altKey) return;
        e.preventDefault();
        return actions.startEdit(active.row, active.col, null);
      case "Escape":
        if (anchor.row !== active.row || anchor.col !== active.col) move(active.row, active.col, false);
        return;
      case "Delete":
      case "Backspace":
        if (range === null) return;
        e.preventDefault();
        return commit(clearRange(project, table.id, range));
      case " ":
        if (table.columns[active.col - 1]?.type.kind === "bool") {
          e.preventDefault();
          return actions.toggleBool(active.row, active.col);
        }
        break;
    }
    if (ctrl && !e.altKey) {
      const key = e.key.toLowerCase();
      if ((key === "c" || key === "x" || key === "v") && !e.shiftKey) {
        // Clipboard events need an editable target in every browser: route this one through
        // the hidden text area (not prevented, so the browser's own copy/paste runs there).
        const clip = clipRef.current;
        if (clip === null) return;
        clip.value = " ";
        clip.focus({ preventScroll: true });
        clip.select();
      } else if (key === "a") {
        e.preventDefault();
        actions.select({ row: 0, col: 0 }, { row: rowCount - 1, col: colCount - 1 });
      } else if (key === "d" && range !== null) {
        e.preventDefault();
        commit(fillDown(project, table.id, range, newId));
      }
      return;
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      actions.startEdit(active.row, active.col, e.key);
    }
  };

  const onCopy = (e: ClipboardEvent<HTMLTextAreaElement>, cut = false) => {
    e.preventDefault();
    actions.focusGrid();
    if (range === null) return;
    const { rows, cols } = rangeSize(range);
    if (rows * cols > MAX_PASTE_CELLS) return notify(s.copyTooLarge, "error");
    e.clipboardData.setData("text/plain", copyRange(table, range, names));
    if (cut) commit(clearRange(project, table.id, range));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    actions.focusGrid();
    const text = e.clipboardData.getData("text/plain");
    const target = range ?? { row0: 0, col0: active.col, row1: 0, col1: active.col };
    const result = pasteText(project, table.id, target, text, names, newId);
    if (!result.ok) return notify(s.pasteFailed(s.pasteErrors[result.error.code] ?? result.error.code), "error");
    const { change, range: written, addedRows, invalid, dropped } = result.value;
    commit(change);
    actions.select({ row: written.row0, col: written.col0 }, { row: written.row1, col: written.col1 });
    if (addedRows > 0 || invalid > 0 || dropped > 0) notify(s.pasted(addedRows, invalid, dropped), invalid > 0 ? "error" : "info");
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest("button, input, select") !== null) return;
    const cell = target.closest<HTMLElement>("[data-cell]");
    if (cell === null) return;
    const [row, col] = cell.dataset.cell!.split(":").map(Number) as [number, number];
    e.preventDefault(); // no text selection; focus stays on the grid
    actions.focusGrid();
    if (e.shiftKey) return actions.select(anchor, { row, col });
    const again = row === active.row && col === active.col && anchor.row === row && anchor.col === col;
    actions.select({ row, col });
    if (target.classList.contains("tbool")) return actions.toggleBool(row, col, true);
    // Touch and pen: tapping the active cell again edits it (mouse uses double-click).
    if (again && e.pointerType !== "mouse") return actions.startEdit(row, col, null);
    if (e.pointerType === "mouse") actions.dragging.current = true;
  };

  const onPointerOver = (e: PointerEvent<HTMLDivElement>) => {
    if (!actions.dragging.current) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (cell === null) return;
    const [row, col] = cell.dataset.cell!.split(":").map(Number) as [number, number];
    if (row !== active.row || col !== active.col) actions.select(anchor, { row, col });
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (cell === null || (e.target as HTMLElement).closest("button, input, select") !== null) return;
    const [row, col] = cell.dataset.cell!.split(":").map(Number) as [number, number];
    // Yes/no cells toggle on single clicks already.
    if (table.columns[col - 1]?.type.kind === "bool") return;
    actions.startEdit(row, col, null);
  };

  const cellId = (row: number, col: number) => `${gridId}-${row}-${col}`;

  return (
    <div
      ref={gridRef}
      className="tgrid"
      role="grid"
      tabIndex={0}
      aria-label={table.name}
      aria-multiselectable="true"
      aria-rowcount={rowCount + 1}
      aria-colcount={colCount + 1}
      aria-activedescendant={rowCount > 0 && edit === null ? cellId(active.row, active.col) : undefined}
      aria-describedby={`${gridId}-help`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerOver={onPointerOver}
      onDoubleClick={onDoubleClick}
    >
      <span id={`${gridId}-help`} hidden>
        {s.gridHelp}
      </span>
      <textarea
        ref={clipRef}
        className="tgrid-clip"
        tabIndex={-1}
        aria-hidden="true"
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        onKeyUp={() => actions.focusGrid()}
        onBlur={(e) => {
          e.currentTarget.value = "";
        }}
      />
      <div className="tgrid-head" role="row" aria-rowindex={1} style={{ width, height: HEAD_HEIGHT }}>
        <div role="columnheader" aria-colindex={1} className="tcell tcell-name">
          {s.rowName}
        </div>
        <span className="tspacer" style={{ width: (visibleCols[0]?.start ?? NAME_WIDTH) - NAME_WIDTH }} />
        {visibleCols.map((v) => {
          const c = table.columns[v.index]!;
          return (
            <div key={v.key} role="columnheader" aria-colindex={v.index + 2} className="tcell" title={c.description}>
              <span className="tcol-name">{c.name}</span>
              <span className="tcol-type">{s.kindLabel[c.type.kind]}</span>
              <ColumnAction strings={strings} project={project} table={table} column={c} commit={commit} />
            </div>
          );
        })}
        <span className="tspacer-fill" />
        <div className="tcell tcell-action" aria-hidden="true" />
      </div>
      {rowCount === 0 ? (
        <p className="muted tgrid-empty">{s.empty}</p>
      ) : (
        <div className="listbox-inner" style={{ height: rowV.getTotalSize(), width }}>
          {rowV.getVirtualItems().map((v) => {
            const row = v.index;
            const sel = range !== null && row >= range.row0 && row <= range.row1;
            return (
              <GridRow
                key={v.key}
                strings={strings}
                project={project}
                table={table}
                row={table.rows[row]!}
                index={row}
                top={v.start - HEAD_HEIGHT}
                width={width}
                names={names}
                commit={commit}
                gridId={gridId}
                colStart={colStart}
                colEnd={colEnd}
                spacer={(visibleCols[0]?.start ?? NAME_WIDTH) - NAME_WIDTH}
                selCol0={sel ? range.col0 : -1}
                selCol1={sel ? range.col1 : -1}
                activeCol={row === active.row ? active.col : -1}
                editCol={edit !== null && edit.row === row ? edit.col : -1}
                editSeed={edit !== null && edit.row === row ? edit.seed : null}
                finishEdit={actions.finishEdit}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ColumnAction({ strings, project, table, column, commit }: { strings: UiStrings; project: Project; table: TableAsset; column: Column; commit: (c: Change | null) => void }) {
  const s = strings.tables;
  if (isRoleColumn(table, column.id)) {
    return (
      <span className="tcol-type" title={s.builtIn}>
        ●
      </span>
    );
  }
  return (
    <button type="button" className="icon" aria-label={s.deleteColumn(column.name)} onClick={() => commit(removeColumn(project, table.id, column.id))}>
      ×
    </button>
  );
}

interface GridRowProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly row: Row;
  readonly index: number;
  readonly top: number;
  readonly width: number;
  readonly names: RowNames;
  readonly commit: (change: Change | null) => void;
  readonly gridId: string;
  /** Visible column range (indices into table.columns). */
  readonly colStart: number;
  readonly colEnd: number;
  readonly spacer: number;
  /** Selected grid columns in this row, or -1. */
  readonly selCol0: number;
  readonly selCol1: number;
  readonly activeCol: number;
  readonly editCol: number;
  readonly editSeed: string | null;
  readonly finishEdit: (row: number, col: number, value: { text: string } | null, move: Move, all?: boolean) => void;
}

const GridRow = memo(function GridRow(p: GridRowProps) {
  const { strings, project, table, row, index, names } = p;
  const s = strings.tables;
  const cellClass = (col: number, extra = "") =>
    `tcell${extra}${col >= p.selCol0 && col <= p.selCol1 ? " sel" : ""}${col === p.activeCol ? " active" : ""}`;
  const cells = [];
  for (let i = p.colStart; i <= p.colEnd; i++) {
    const column = table.columns[i]!;
    const col = i + 1;
    cells.push(
      <div
        key={column.id}
        id={`${p.gridId}-${index}-${col}`}
        role="gridcell"
        aria-colindex={col + 1}
        aria-selected={col >= p.selCol0 && col <= p.selCol1}
        className={cellClass(col)}
        data-cell={`${index}:${col}`}
      >
        {p.editCol === col ? (
          <CellEditor column={column} row={row} index={index} col={col} names={names} seed={p.editSeed} finishEdit={p.finishEdit} />
        ) : (
          <CellView strings={strings} column={column} value={row.cells[column.id]} names={names} />
        )}
      </div>,
    );
  }
  return (
    <div role="row" aria-rowindex={index + 2} className="tgrid-row" style={{ transform: `translateY(${p.top}px)`, height: ROW_HEIGHT, width: p.width }}>
      <div
        id={`${p.gridId}-${index}-0`}
        role="rowheader"
        aria-colindex={1}
        aria-selected={0 >= p.selCol0 && 0 <= p.selCol1}
        className={cellClass(0, " tcell-name")}
        data-cell={`${index}:0`}
      >
        {p.editCol === 0 ? (
          <TextEditor label={s.rowName} current={row.name} seed={p.editSeed} valid={(t) => isValidIdentifier(t.trim())} onDone={(v, m, all) => p.finishEdit(index, 0, v, m, all)} />
        ) : (
          <span className="tcell-text">{row.name}</span>
        )}
      </div>
      <span className="tspacer" style={{ width: p.spacer }} />
      {cells}
      <span className="tspacer-fill" />
      <div role="gridcell" className="tcell tcell-action">
        <button
          type="button"
          className="icon"
          aria-label={s.deleteRow(row.name)}
          onClick={() => p.commit(confirmRemoveRows(project, table, [row], s))}
        >
          ×
        </button>
      </div>
    </div>
  );
});

function CellView({ strings, column, value, names }: { strings: UiStrings; column: Column; value: CellValue | undefined; names: RowNames }) {
  const s = strings.tables;
  const type = column.type;
  if (type.kind === "bool") {
    return (
      <span className="tbool" aria-label={value === true ? s.yes : s.no} role="img">
        {value === true ? "☑" : "☐"}
      </span>
    );
  }
  if (type.kind === "curve") {
    const keys = value !== null && typeof value === "object" && !Array.isArray(value) && "keys" in value ? value.keys.length : 0;
    return <span className="muted small">{s.curveSummary(keys)}</span>;
  }
  const text = cellToText(type, value, names);
  return (
    <span className="tcell-text" title={text.length > 20 ? text : undefined}>
      {text}
    </span>
  );
}

function CellEditor({
  column,
  row,
  index,
  col,
  names,
  seed,
  finishEdit,
}: {
  column: Column;
  row: Row;
  index: number;
  col: number;
  names: RowNames;
  seed: string | null;
  finishEdit: GridRowProps["finishEdit"];
}) {
  const type = column.type;
  const value = row.cells[column.id];
  // Choices open as a list unless the user started typing a name.
  if ((type.kind === "enum" || type.kind === "reference") && seed === null) {
    const options =
      type.kind === "enum" ? type.options.map((o) => ({ id: o.id, name: o.name })) : referenceOptions(names, type.table, value);
    return (
      <SelectEditor
        label={column.name}
        value={typeof value === "string" ? value : ""}
        options={options}
        onDone={(id, move) => finishEdit(index, col, id === null ? null : { text: id === "" ? "" : (options.find((o) => o.id === id)?.name ?? "") }, move)}
      />
    );
  }
  return (
    <TextEditor
      label={column.name}
      current={cellToText(type, value, names)}
      seed={seed}
      valid={(t) => textToCell(type, t, names, value, () => "") !== undefined}
      onDone={(v, m, all) => finishEdit(index, col, v, m, all)}
    />
  );
}

/** Reference choices: the target table's rows. Capped; typing a row name works for any row. */
const MAX_REFERENCE_OPTIONS = 2_000;
function referenceOptions(names: RowNames, table: string, value: CellValue | undefined): { id: string; name: string }[] {
  const list = names.rowsOf(table).slice(0, MAX_REFERENCE_OPTIONS);
  if (typeof value === "string" && !list.some((r) => r.id === value)) list.push({ id: value, name: names.name(value) ?? value });
  return list;
}

type Move = { readonly dr: number; readonly dc: number } | null;
/** Finish from the keyboard without moving: focus returns to the grid. */
const STAY: Move = { dr: 0, dc: 0 };

/** Text input for one cell. `seed`: the key that started editing (replaces the text). */
function TextEditor({
  label,
  current,
  seed,
  valid,
  onDone,
}: {
  label: string;
  current: string;
  seed: string | null;
  valid: (text: string) => boolean;
  onDone: (value: { text: string } | null, move: Move, all?: boolean) => void;
}) {
  const [draft, setDraft] = useState(seed ?? current);
  const done = useRef(false);
  const finish = (value: { text: string } | null, move: Move, all = false) => {
    if (done.current) return;
    done.current = true;
    onDone(value, move, all);
  };
  return (
    <input
      type="text"
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      autoFocus
      value={draft}
      aria-invalid={!valid(draft)}
      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        const changed = draft === current ? null : { text: draft };
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) finish({ text: draft }, STAY, true);
          else finish(changed, { dr: e.shiftKey ? -1 : 1, dc: 0 });
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(changed, { dr: 0, dc: e.shiftKey ? -1 : 1 });
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null, STAY);
        }
      }}
      onBlur={() => finish(draft === current ? null : { text: draft }, null)}
    />
  );
}

function SelectEditor({
  label,
  value,
  options,
  onDone,
}: {
  label: string;
  value: string;
  options: readonly { id: string; name: string }[];
  onDone: (id: string | null, move: Move) => void;
}) {
  const done = useRef(false);
  const finish = (id: string | null, move: Move) => {
    if (done.current) return;
    done.current = true;
    onDone(id, move);
  };
  return (
    <select
      aria-label={label}
      autoFocus
      value={value}
      onChange={(e) => finish(e.target.value, STAY)}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          finish(null, e.key === "Tab" ? { dr: 0, dc: e.shiftKey ? -1 : 1 } : STAY);
        }
      }}
      onBlur={() => finish(null, null)}
    >
      <option value="">–</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
