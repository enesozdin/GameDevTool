import type { IssuePath } from "../result.ts";
import type { Id } from "./primitives.ts";
import type { Asset, Project } from "./project.ts";
import type { ProductionGraphAsset } from "./production-graph.ts";
import { replaceRange, rowDiff } from "./row-diff.ts";
import type { CellValue, Column, ColumnType, TableAsset } from "./table.ts";

export type ReferenceKind =
  /** A reference column (or list-of-reference column) points to a table asset. */
  | "column-table"
  /** A cell points to a row of the column's target table. */
  | "cell-row"
  /** A document page points to its parent page. */
  | "document-parent"
  /** A production graph points to its items or recipes table. */
  | "graph-table"
  /** A production graph node, connection or calculator setting points to an item or recipe row. */
  | "graph-row";

export interface Reference {
  readonly kind: ReferenceKind;
  /** Asset that stores the reference. */
  readonly source: Id;
  /** Where the reference is stored inside the project. */
  readonly path: IssuePath;
  /** Referenced asset id (column-table, document-parent) or row id (cell-row). */
  readonly target: Id;
  /** For cell-row and graph-row: the table the row must belong to. */
  readonly targetTable?: Id;
}

export interface ReferenceIndex {
  /** Every reference, in project order. */
  readonly references: readonly Reference[];
  /** References whose target does not exist or has the wrong kind, in project order. */
  readonly broken: readonly Reference[];
  /** Everything that points at an asset or row ("used by" lists, safe delete/rename), in project order. */
  usedBy(target: Id): readonly Reference[];
  /**
   * References that would break if `asset` were deleted: those to the asset and, for a
   * table, to each of its row ids, minus those the asset stores itself. Equals summing
   * `usedBy` over the asset id and the row ids, but an index built with a cache answers it
   * without visiting the rows. `asset` is expected to be from the indexed project.
   */
  incomingCount(asset: Asset): number;
}

const EMPTY: readonly Reference[] = [];

function referenceTable(type: ColumnType): Id | undefined {
  if (type.kind === "reference" || type.kind === "stacks") return type.table;
  if (type.kind === "list" && type.item.kind === "reference") return type.item.table;
  return undefined;
}

/**
 * Builds the index of `project`. O(assets + rows × reference columns).
 *
 * With a cache (one per project history, like the editor's), the index is updated from the
 * previous call instead: a single-cell edit costs O(changed rows), not O(all rows). An index
 * built with a cache stays correct after later builds, but answers `usedBy` and
 * `references` from a full rebuild then.
 */
export function buildReferenceIndex(project: Project, cache?: ReferenceIndexCache): ReferenceIndex {
  if (cache === undefined) return buildFull(project);
  const index = cache.update(project);
  return index ?? buildFull(project);
}

// ---------------------------------------------------------------------------------------
// Collecting references. Shared by the full and the incremental build, so both see the
// same references with the same paths.
// ---------------------------------------------------------------------------------------

/** Whether `ref` points at nothing. `owner` gives the table a row id belongs to. */
function isBroken(ref: Reference, assets: ReadonlyMap<Id, Asset>, owner: ReadonlyMap<Id, Id>): boolean {
  switch (ref.kind) {
    case "column-table":
    case "graph-table":
      return assets.get(ref.target)?.kind !== "table";
    case "document-parent":
      return assets.get(ref.target)?.kind !== "document";
    case "cell-row":
    case "graph-row":
      return owner.get(ref.target) !== ref.targetTable;
  }
}

/** Reference columns of a table, in column order. */
interface RefColumnSpec {
  readonly index: number;
  readonly column: Column;
  readonly targetTable: Id;
}

function refColumns(table: TableAsset): RefColumnSpec[] {
  const out: RefColumnSpec[] = [];
  table.columns.forEach((column, index) => {
    const targetTable = referenceTable(column.type);
    if (targetTable !== undefined) out.push({ index, column, targetTable });
  });
  return out;
}

function columnReference(source: Id, assetIndex: number, spec: RefColumnSpec): Reference {
  return { kind: "column-table", source, path: ["assets", assetIndex, "columns", spec.index, "type"], target: spec.targetTable };
}

/**
 * Row ids stored in one cell, in path order. `item` is the list index (-1 for a plain
 * reference cell), `stack` whether the id is the `item` field of a stack.
 */
function forEachCellTarget(spec: RefColumnSpec, value: CellValue | undefined, fn: (target: Id, item: number, stack: boolean) => void): void {
  // Non-string values are type errors, reported by validate.ts, not references.
  if (typeof value === "string") fn(value, -1, false);
  else if (Array.isArray(value)) {
    value.forEach((item, itemIndex) => {
      if (typeof item === "string") fn(item, itemIndex, false);
      else if (spec.column.type.kind === "stacks" && item !== null && typeof item === "object" && "item" in item) fn(item.item, itemIndex, true);
    });
  }
}

function cellReference(source: Id, assetIndex: number, rowIndex: number, spec: RefColumnSpec, target: Id, item: number, stack: boolean): Reference {
  const path: (string | number)[] = ["assets", assetIndex, "rows", rowIndex, "cells", spec.column.id];
  if (item >= 0) path.push(item);
  if (stack) path.push("item");
  return { kind: "cell-row", source, path, target, targetTable: spec.targetTable };
}

function documentReferences(asset: Asset, assetIndex: number, out: Reference[]): void {
  if (asset.kind === "document" && asset.parent !== undefined) {
    out.push({ kind: "document-parent", source: asset.id, path: ["assets", assetIndex, "parent"], target: asset.parent });
  }
}

function graphReferences(graph: ProductionGraphAsset, assetIndex: number, out: Reference[]): void {
  const base = ["assets", assetIndex] as const;
  for (const field of ["items", "recipes"] as const) {
    out.push({ kind: "graph-table", source: graph.id, path: [...base, field], target: graph[field] });
  }
  const addRow = (rowId: Id, table: Id, path: IssuePath): void => {
    out.push({ kind: "graph-row", source: graph.id, path, target: rowId, targetTable: table });
  };
  graph.nodes.forEach((node, i) => {
    if (node.type === "recipe") addRow(node.recipe, graph.recipes, [...base, "nodes", i, "recipe"]);
    else addRow(node.item, graph.items, [...base, "nodes", i, "item"]);
  });
  graph.edges.forEach((edge, i) => addRow(edge.item, graph.items, [...base, "edges", i, "item"]));
  const calc = graph.calculator;
  if (calc === undefined) return;
  if (calc.target !== undefined) addRow(calc.target, graph.items, [...base, "calculator", "target"]);
  for (const [item, recipe] of Object.entries(calc.recipes ?? {})) {
    addRow(item, graph.items, [...base, "calculator", "recipes", item]);
    addRow(recipe, graph.recipes, [...base, "calculator", "recipes", item]);
  }
}

/** References of a document or graph (tables are handled per cell). */
function staticReferences(asset: Asset, assetIndex: number): Reference[] {
  const out: Reference[] = [];
  if (asset.kind === "production-graph") graphReferences(asset, assetIndex, out);
  else documentReferences(asset, assetIndex, out);
  return out;
}

/** The full build: one pass over the project. */
function buildFull(project: Project): ReferenceIndex {
  const assets = new Map<Id, Asset>();
  const rowOwner = new Map<Id, Id>();
  for (const asset of project.assets) {
    assets.set(asset.id, asset);
    if (asset.kind === "table") for (const row of asset.rows) rowOwner.set(row.id, asset.id);
  }

  const references: Reference[] = [];
  project.assets.forEach((asset, assetIndex) => {
    if (asset.kind !== "table") {
      for (const ref of staticReferences(asset, assetIndex)) references.push(ref);
      return;
    }
    for (const spec of refColumns(asset)) {
      references.push(columnReference(asset.id, assetIndex, spec));
      asset.rows.forEach((row, rowIndex) => {
        forEachCellTarget(spec, row.cells[spec.column.id], (target, item, stack) => references.push(cellReference(asset.id, assetIndex, rowIndex, spec, target, item, stack)));
      });
    }
  });

  const broken: Reference[] = [];
  const byTarget = new Map<Id, Reference[]>();
  for (const ref of references) {
    if (isBroken(ref, assets, rowOwner)) broken.push(ref);
    const list = byTarget.get(ref.target);
    if (list) list.push(ref);
    else byTarget.set(ref.target, [ref]);
  }

  const usedBy = (target: Id): readonly Reference[] => byTarget.get(target) ?? EMPTY;
  return {
    references,
    broken,
    usedBy,
    incomingCount: (asset) => countRowByRow(usedBy, asset),
  };
}

/** incomingCount from usedBy: one lookup per row. */
function countRowByRow(usedBy: (target: Id) => readonly Reference[], asset: Asset): number {
  const incoming = (target: Id): number => {
    let n = 0;
    for (const ref of usedBy(target)) if (ref.source !== asset.id) n++;
    return n;
  };
  let count = incoming(asset.id);
  if (asset.kind === "table") for (const row of asset.rows) count += incoming(row.id);
  return count;
}


// ---------------------------------------------------------------------------------------
// Incremental build. Per asset, the references are kept as a unit: documents and graphs
// by object, tables by id with their references per row, so an edit re-collects only the
// changed rows (rowDiff). Row owners, references by target and the broken set are updated
// from the changes. Duplicate asset or row ids (already validation errors) fall back to
// the full build, which defines the exact semantics.
//
// Table references are kept without paths: each points to its row's slot, which holds the
// current row index. Removing or inserting a row then only renumbers the slots after it,
// and moving a table in the asset list renumbers nothing. Reference objects with paths are
// made when the index is read (broken, usedBy, references).
// ---------------------------------------------------------------------------------------

/** A table's reference column. */
interface RefColumn extends RefColumnSpec {
  readonly unit: TableUnit;
  /** Order among the table's reference columns. */
  readonly ordinal: number;
  readonly ref: ColumnRef;
}

/** The column's reference to its target table. */
class ColumnRef {
  readonly column: RefColumn;
  readonly target: Id;
  constructor(column: RefColumn) {
    this.column = column;
    this.target = column.targetTable;
  }
}

/**
 * One row of a table that holds references. `index` follows the row when rows shift.
 * Most rows hold one reference, which is then stored without an array.
 */
interface RowSlot {
  index: number;
  refs: CellRef | readonly CellRef[];
}

function forEachSlotRef(slot: RowSlot | null, fn: (ref: CellRef) => void): void {
  if (slot === null) return;
  if (slot.refs instanceof CellRef) fn(slot.refs);
  else for (const ref of slot.refs) fn(ref);
}

/** A row id stored in a cell (see forEachCellTarget for `item` and `stack`). */
class CellRef {
  readonly slot: RowSlot;
  readonly column: RefColumn;
  readonly item: number;
  readonly stack: boolean;
  readonly target: Id;
  constructor(slot: RowSlot, column: RefColumn, item: number, stack: boolean, target: Id) {
    this.slot = slot;
    this.column = column;
    this.item = item;
    this.stack = stack;
    this.target = target;
  }
}

/** What the incremental index stores: documents and graphs keep plain references. */
type Entry = Reference | ColumnRef | CellRef;

function materialize(entry: Entry): Reference {
  if (entry instanceof CellRef) {
    const unit = entry.column.unit;
    return cellReference(unit.table.id, unit.assetIndex, entry.slot.index, entry.column, entry.target, entry.item, entry.stack);
  }
  if (entry instanceof ColumnRef) return columnReference(entry.column.unit.table.id, entry.column.unit.assetIndex, entry.column);
  return entry;
}

/** Id of the asset that stores the entry. */
function sourceOf(entry: Entry): Id {
  return entry instanceof CellRef || entry instanceof ColumnRef ? entry.column.unit.table.id : entry.source;
}

function assetIndexOf(entry: Entry): number {
  return entry instanceof CellRef || entry instanceof ColumnRef ? entry.column.unit.assetIndex : (entry.path[1] as number);
}

interface Unit {
  readonly assetIndex: number;
  /** Entries in project order. */
  forEach(fn: (entry: Entry) => void): void;
  /** Entries in any order (cheaper). */
  forEachEntry(fn: (entry: Entry) => void): void;
}

class StaticUnit implements Unit {
  readonly assetIndex: number;
  readonly refs: readonly Reference[];
  private positions: Map<Reference, number> | undefined;
  constructor(assetIndex: number, refs: readonly Reference[]) {
    this.assetIndex = assetIndex;
    this.refs = refs;
  }
  forEach(fn: (entry: Entry) => void): void {
    for (const ref of this.refs) fn(ref);
  }
  forEachEntry(fn: (entry: Entry) => void): void {
    this.forEach(fn);
  }
  compare(a: Reference, b: Reference): number {
    if (this.positions === undefined) {
      this.positions = new Map();
      this.refs.forEach((ref, i) => this.positions!.set(ref, i));
    }
    return this.positions.get(a)! - this.positions.get(b)!;
  }
}

class TableUnit implements Unit {
  table: TableAsset;
  assetIndex: number;
  columns: RefColumn[] = [];
  /** Parallel to the table's rows; null for a row without references. */
  slots: (RowSlot | null)[] = [];
  private scratch: CellRef[] = [];
  constructor(table: TableAsset, assetIndex: number) {
    this.table = table;
    this.assetIndex = assetIndex;
  }

  /** Collects everything. The caller adds the entries to the index. */
  build(): void {
    this.columns = refColumns(this.table).map((spec, ordinal) => {
      const column: RefColumn = { ...spec, unit: this, ordinal, ref: undefined! };
      (column as { ref: ColumnRef }).ref = new ColumnRef(column);
      return column;
    });
    this.slots = this.table.rows.map((row, r) => this.slot(row, r));
  }

  /** The references of one row, or null when it has none. */
  slot(row: TableAsset["rows"][number], index: number): RowSlot | null {
    const scratch = this.scratch;
    scratch.length = 0;
    const slot: RowSlot = { index, refs: scratch };
    for (const column of this.columns) {
      forEachCellTarget(column, row.cells[column.column.id], (target, item, stack) => scratch.push(new CellRef(slot, column, item, stack, target)));
    }
    if (scratch.length === 0) return null;
    // Sized exactly: a pushed-to array keeps spare capacity, which adds up over many rows.
    slot.refs = scratch.length === 1 ? scratch[0]! : scratch.slice();
    return slot;
  }

  forEach(fn: (entry: Entry) => void): void {
    for (const column of this.columns) {
      fn(column.ref);
      for (const slot of this.slots) {
        forEachSlotRef(slot, (ref) => {
          if (ref.column === column) fn(ref);
        });
      }
    }
  }

  forEachEntry(fn: (entry: Entry) => void): void {
    for (const column of this.columns) fn(column.ref);
    for (const slot of this.slots) forEachSlotRef(slot, fn);
  }
}

/** Order of two entries of the same table: column, then row, then list item. */
function compareInTable(a: ColumnRef | CellRef, b: ColumnRef | CellRef): number {
  const ka = a instanceof CellRef ? [a.column.ordinal, a.slot.index, a.item] : [a.column.ordinal, -1, -1];
  const kb = b instanceof CellRef ? [b.column.ordinal, b.slot.index, b.item] : [b.column.ordinal, -1, -1];
  return ka[0]! - kb[0]! || ka[1]! - kb[1]! || ka[2]! - kb[2]!;
}

/** Opaque cache for buildReferenceIndex across the edits of one project history. */
export class ReferenceIndexCache {
  private state: IndexState | undefined;

  /** The index of `project`, or null when only the full build gives the exact answer. */
  update(project: Project): ReferenceIndex | null {
    this.state ??= new IndexState();
    const index = this.state.update(project);
    if (index === null) this.state = undefined;
    return index;
  }
}

export function createReferenceIndexCache(): ReferenceIndexCache {
  return new ReferenceIndexCache();
}

/** Rows that changed in one table: `table.rows[start, afterEnd)` replaces the old range. */
interface RowChange {
  readonly unit: TableUnit;
  readonly table: TableAsset;
  readonly start: number;
  readonly beforeEnd: number;
  readonly afterEnd: number;
}

class IndexState {
  private assets = new Map<Id, Asset>();
  /** Row id → id of its table. Row ids are unique while this state exists. */
  private owners = new Map<Id, Id>();
  /** Target id → entries pointing to it. One entry is stored without a Set. */
  private targets = new Map<Id, Entry | Set<Entry>>();
  private broken = new Set<Entry>();
  /**
   * Table id → number of entries whose target is one of its row ids (by `owners`) and
   * whose source is another asset. Kept exact whenever entries or owners change.
   */
  private incoming = new Map<Id, number>();
  private tables = new Map<Id, TableUnit>();
  private statics = new WeakMap<Asset, StaticUnit>();
  private units: Unit[] = [];
  private version = 0;

  /** Returns null (and must be discarded) when the project has duplicate asset or row ids. */
  update(project: Project): ReferenceIndex | null {
    const assets = new Map<Id, Asset>();
    for (const asset of project.assets) {
      if (assets.has(asset.id)) return null;
      assets.set(asset.id, asset);
    }

    // Plan: which units stay, which are new, which rows changed.
    const previous = new Set(this.units);
    const units: Unit[] = new Array(project.assets.length);
    const added: Unit[] = [];
    const changes: RowChange[] = [];
    /** Kept table units whose columns changed: all entries are re-collected. */
    const rebuilt = new Set<TableUnit>();
    project.assets.forEach((asset, i) => {
      if (asset.kind !== "table") {
        let unit = this.statics.get(asset);
        if (unit === undefined || unit.assetIndex !== i || !previous.has(unit)) {
          unit = new StaticUnit(i, staticReferences(asset, i));
          this.statics.set(asset, unit);
          added.push(unit);
        }
        units[i] = unit;
        return;
      }
      let unit = this.tables.get(asset.id);
      if (unit === undefined || !previous.has(unit)) {
        unit = new TableUnit(asset, i);
        this.tables.set(asset.id, unit);
        added.push(unit);
      } else if (unit.table !== asset) {
        if (unit.table.columns !== asset.columns) rebuilt.add(unit);
        if (unit.table.rows !== asset.rows) {
          const d = rowDiff(unit.table.rows, asset.rows);
          changes.push({ unit, table: asset, start: d.start, beforeEnd: d.beforeEnd, afterEnd: d.afterEnd });
        }
      }
      units[i] = unit;
    });
    const current = new Set(units);
    const removed = this.units.filter((u) => !current.has(u));

    // Row owners. Removals first, so a row moved between tables is no duplicate.
    const changedIds = new Set<Id>();
    const removeRow = (id: Id): void => {
      const table = this.owners.get(id);
      if (table !== undefined) this.countIncoming(id, table, -1);
      this.owners.delete(id);
      changedIds.add(id);
    };
    const addRow = (id: Id, table: Id): boolean => {
      if (this.owners.has(id)) return false;
      this.owners.set(id, table);
      this.countIncoming(id, table, 1);
      changedIds.add(id);
      return true;
    };
    for (const unit of removed) if (unit instanceof TableUnit) for (const row of unit.table.rows) removeRow(row.id);
    for (const c of changes) for (let r = c.start; r < c.beforeEnd; r++) removeRow(c.unit.table.rows[r]!.id);
    for (const unit of added) {
      if (unit instanceof TableUnit) for (const row of unit.table.rows) if (!addRow(row.id, unit.table.id)) return null;
    }
    for (const c of changes) for (let r = c.start; r < c.afterEnd; r++) if (!addRow(c.table.rows[r]!.id, c.table.id)) return null;

    // Assets added, removed or of another kind: references to them may break or heal.
    for (const [id, asset] of assets) if (this.assets.get(id)?.kind !== asset.kind) changedIds.add(id);
    for (const id of this.assets.keys()) if (!assets.has(id)) changedIds.add(id);
    this.assets = assets;

    // Entries. Old ones go before units take their new table.
    for (const unit of removed) {
      unit.forEachEntry((entry) => this.remove(entry));
      if (unit instanceof TableUnit && this.tables.get(unit.table.id) === unit) this.tables.delete(unit.table.id);
    }
    for (const unit of rebuilt) unit.forEachEntry((entry) => this.remove(entry));
    for (const c of changes) if (!rebuilt.has(c.unit)) this.updateRows(c);
    project.assets.forEach((asset, i) => {
      const unit = units[i];
      if (unit instanceof TableUnit) {
        unit.table = asset as TableAsset;
        unit.assetIndex = i;
      }
    });
    for (const unit of [...rebuilt, ...added]) {
      if (unit instanceof TableUnit) unit.build();
      unit.forEachEntry((entry) => this.add(entry));
    }

    // Entries whose target appeared or disappeared.
    for (const id of changedIds) this.forTarget(id, (entry) => this.setBroken(entry));

    this.units = units;
    return this.snapshot(project, units);
  }

  /** Re-collects the changed rows of one table and renumbers the rows after them. */
  private updateRows(c: RowChange): void {
    const unit = c.unit;
    for (let r = c.start; r < c.beforeEnd; r++) forEachSlotRef(unit.slots[r]!, (ref) => this.remove(ref));
    const fresh: (RowSlot | null)[] = new Array(c.afterEnd - c.start);
    for (let r = c.start; r < c.afterEnd; r++) {
      const slot = unit.slot(c.table.rows[r]!, r);
      forEachSlotRef(slot, (ref) => this.add(ref));
      fresh[r - c.start] = slot;
    }
    unit.slots = replaceRange(unit.slots, c.start, c.beforeEnd, fresh);
    if (c.afterEnd !== c.beforeEnd) {
      for (let r = c.afterEnd; r < unit.slots.length; r++) {
        const slot = unit.slots[r];
        if (slot) slot.index = r;
      }
    }
  }

  private isBroken(entry: Entry): boolean {
    if (entry instanceof CellRef) return this.owners.get(entry.target) !== entry.column.targetTable;
    if (entry instanceof ColumnRef) return this.assets.get(entry.target)?.kind !== "table";
    return isBroken(entry, this.assets, this.owners);
  }

  /** Adds `delta` to the incoming count of `table` for each entry from another asset to `rowId`. */
  private countIncoming(rowId: Id, table: Id, delta: number): void {
    let n = 0;
    this.forTarget(rowId, (entry) => {
      if (sourceOf(entry) !== table) n++;
    });
    if (n !== 0) this.addIncoming(table, n * delta);
  }

  private addIncoming(table: Id, delta: number): void {
    const n = (this.incoming.get(table) ?? 0) + delta;
    if (n === 0) this.incoming.delete(table);
    else this.incoming.set(table, n);
  }

  /** Updates the incoming count for one entry added (1) or removed (-1). */
  private countEntry(entry: Entry, delta: number): void {
    const table = this.owners.get(entry.target);
    if (table !== undefined && sourceOf(entry) !== table) this.addIncoming(table, delta);
  }

  private add(entry: Entry): void {
    this.countEntry(entry, 1);
    const set = this.targets.get(entry.target);
    if (set === undefined) this.targets.set(entry.target, entry);
    else if (set instanceof Set) set.add(entry);
    else this.targets.set(entry.target, new Set([set, entry]));
    if (this.isBroken(entry)) this.broken.add(entry);
  }

  private remove(entry: Entry): void {
    this.countEntry(entry, -1);
    const set = this.targets.get(entry.target);
    if (set === entry) this.targets.delete(entry.target);
    else if (set instanceof Set) {
      set.delete(entry);
      if (set.size === 1) this.targets.set(entry.target, set.values().next().value!);
    }
    this.broken.delete(entry);
  }

  private setBroken(entry: Entry): void {
    if (this.isBroken(entry)) this.broken.add(entry);
    else this.broken.delete(entry);
  }

  private forTarget(target: Id, fn: (entry: Entry) => void): void {
    const set = this.targets.get(target);
    if (set === undefined) return;
    if (set instanceof Set) set.forEach(fn);
    else fn(set);
  }

  private snapshot(project: Project, units: readonly Unit[]): ReferenceIndex {
    const version = ++this.version;
    const self = this;
    const compare = (a: Entry, b: Entry): number => {
      const ai = assetIndexOf(a);
      const bi = assetIndexOf(b);
      if (ai !== bi) return ai - bi;
      const unit = units[ai]!;
      return unit instanceof StaticUnit ? unit.compare(a as Reference, b as Reference) : compareInTable(a as ColumnRef | CellRef, b as ColumnRef | CellRef);
    };
    // Paths are taken now, so this list stays correct after later edits.
    const broken = [...this.broken].sort(compare).map(materialize);
    let full: ReferenceIndex | undefined;
    const fallback = (): ReferenceIndex => (full ??= buildFull(project));
    const sorted = new Map<Id, readonly Reference[]>();
    let references: Reference[] | undefined;
    const usedBy = (target: Id): readonly Reference[] => {
      if (self.version !== version) return fallback().usedBy(target);
      // Most rows are used by nothing: answered without allocating.
      if (!self.targets.has(target)) return EMPTY;
      let list = sorted.get(target);
      if (list === undefined) {
        const entries: Entry[] = [];
        self.forTarget(target, (entry) => entries.push(entry));
        list = entries.sort(compare).map(materialize);
        sorted.set(target, list);
      }
      return list;
    };
    return {
      broken,
      get references(): readonly Reference[] {
        if (self.version !== version) return fallback().references;
        if (references === undefined) {
          references = [];
          for (const unit of units) unit.forEach((entry) => references!.push(materialize(entry)));
        }
        return references;
      },
      usedBy,
      incomingCount: (asset) => {
        if (self.version !== version) return fallback().incomingCount(asset);
        // Not the indexed asset (e.g. another version of it): counted by its rows.
        if (self.assets.get(asset.id) !== asset) return countRowByRow(usedBy, asset);
        let count = 0;
        self.forTarget(asset.id, (entry) => {
          if (sourceOf(entry) !== asset.id) count++;
        });
        if (asset.kind === "table") count += self.incoming.get(asset.id) ?? 0;
        return count;
      },
    };
  }
}
