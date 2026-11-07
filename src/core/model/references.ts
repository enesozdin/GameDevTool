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

function columnReference(table: TableAsset, assetIndex: number, spec: RefColumnSpec): Reference {
  return { kind: "column-table", source: table.id, path: ["assets", assetIndex, "columns", spec.index, "type"], target: spec.targetTable };
}

/** References stored in one cell, in path order. */
function cellReferences(source: Id, assetIndex: number, rowIndex: number, spec: RefColumnSpec, value: CellValue | undefined, out: Reference[]): void {
  const columnId = spec.column.id;
  const targetTable = spec.targetTable;
  // Non-string values are type errors, reported by validate.ts, not references.
  if (typeof value === "string") {
    out.push({ kind: "cell-row", source, path: ["assets", assetIndex, "rows", rowIndex, "cells", columnId], target: value, targetTable });
  } else if (Array.isArray(value)) {
    value.forEach((item, itemIndex) => {
      const path = ["assets", assetIndex, "rows", rowIndex, "cells", columnId, itemIndex];
      if (typeof item === "string") out.push({ kind: "cell-row", source, path, target: item, targetTable });
      else if (spec.column.type.kind === "stacks" && item !== null && typeof item === "object" && "item" in item) {
        out.push({ kind: "cell-row", source, path: [...path, "item"], target: item.item, targetTable });
      }
    });
  }
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
      references.push(columnReference(asset, assetIndex, spec));
      asset.rows.forEach((row, rowIndex) => cellReferences(asset.id, assetIndex, rowIndex, spec, row.cells[spec.column.id], references));
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

  return {
    references,
    broken,
    usedBy: (target) => byTarget.get(target) ?? EMPTY,
  };
}

// ---------------------------------------------------------------------------------------
// Incremental build. Per asset, the references are kept as a unit: documents and graphs
// by object, tables by id with their references per cell, so an edit re-collects only the
// changed rows (rowDiff). Row owners, references by target and the broken set are updated
// from the changes. Duplicate asset, row or column ids (already validation errors) fall back to
// the full build, which defines the exact semantics.
// ---------------------------------------------------------------------------------------

/** References of one cell: most cells hold one, so no array then. */
type CellRefs = Reference | readonly Reference[] | null;

function forEachRef(cell: CellRefs, fn: (ref: Reference) => void): void {
  if (cell === null) return;
  if (Array.isArray(cell)) for (const ref of cell as readonly Reference[]) fn(ref);
  else fn(cell as Reference);
}

function toCellRefs(refs: Reference[]): CellRefs {
  return refs.length === 0 ? null : refs.length === 1 ? refs[0]! : refs;
}

interface Unit {
  readonly assetIndex: number;
  /** References in project order. */
  forEach(fn: (ref: Reference) => void): void;
  /** Order of two references of this unit. */
  compare(a: Reference, b: Reference): number;
}

class StaticUnit implements Unit {
  readonly assetIndex: number;
  readonly refs: readonly Reference[];
  private positions: Map<Reference, number> | undefined;
  constructor(assetIndex: number, refs: readonly Reference[]) {
    this.assetIndex = assetIndex;
    this.refs = refs;
  }
  forEach(fn: (ref: Reference) => void): void {
    for (const ref of this.refs) fn(ref);
  }
  compare(a: Reference, b: Reference): number {
    if (this.positions === undefined) {
      this.positions = new Map();
      this.refs.forEach((ref, i) => this.positions!.set(ref, i));
    }
    return this.positions.get(a)! - this.positions.get(b)!;
  }
}

interface RefColumn extends RefColumnSpec {
  readonly ref: Reference;
  /** Parallel to the table's rows. */
  cells: CellRefs[];
}

class TableUnit implements Unit {
  columns: RefColumn[] = [];
  /** Column id and column index → order among the reference columns. */
  private order = new Map<Id | number, number>();
  table: TableAsset;
  assetIndex: number;
  constructor(table: TableAsset, assetIndex: number) {
    this.table = table;
    this.assetIndex = assetIndex;
  }

  /** Collects everything. The caller adds the references to the index. */
  build(): void {
    this.order.clear();
    this.columns = refColumns(this.table).map((spec, ordinal) => {
      this.order.set(spec.column.id, ordinal);
      this.order.set(spec.index, ordinal);
      return { ...spec, ref: columnReference(this.table, this.assetIndex, spec), cells: this.collect(spec, 0, this.table.rows.length) };
    });
  }

  collect(spec: RefColumnSpec, start: number, end: number): CellRefs[] {
    const out: CellRefs[] = new Array(end - start);
    const refs: Reference[] = [];
    for (let r = start; r < end; r++) {
      refs.length = 0;
      cellReferences(this.table.id, this.assetIndex, r, spec, this.table.rows[r]!.cells[spec.column.id], refs);
      out[r - start] = toCellRefs(refs.length > 1 ? refs.slice() : refs);
    }
    return out;
  }

  forEach(fn: (ref: Reference) => void): void {
    for (const column of this.columns) {
      fn(column.ref);
      for (const cell of column.cells) forEachRef(cell, fn);
    }
  }

  compare(a: Reference, b: Reference): number {
    const ka = this.key(a);
    const kb = this.key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  }

  /** [reference column, row (-1 for the column itself), list item (-1 for none)]. */
  private key(ref: Reference): [number, number, number] {
    const p = ref.path;
    if (p[2] === "columns") return [this.order.get(p[3]!)!, -1, -1];
    return [this.order.get(p[5]!)!, p[3] as number, p.length > 6 ? (p[6] as number) : -1];
  }
}

function hasDuplicateColumnIds(table: TableAsset): boolean {
  return new Set(table.columns.map((c) => c.id)).size !== table.columns.length;
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
  /** Target id → references to it. One reference is stored without a Set. */
  private targets = new Map<Id, Reference | Set<Reference>>();
  private broken = new Set<Reference>();
  private tables = new Map<Id, TableUnit>();
  private statics = new WeakMap<Asset, StaticUnit>();
  private units: Unit[] = [];
  private version = 0;

  /**
   * Returns null (and must be discarded) when the project has duplicate asset, row or
   * column ids: references can then no longer be told apart by their paths.
   */
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
    /** Kept table units whose columns or position changed: all references are re-collected. */
    const rebuilt = new Set<TableUnit>();
    for (let i = 0; i < project.assets.length; i++) {
      const asset = project.assets[i]!;
      if (asset.kind !== "table") {
        let unit = this.statics.get(asset);
        if (unit === undefined || unit.assetIndex !== i || !previous.has(unit)) {
          unit = new StaticUnit(i, staticReferences(asset, i));
          this.statics.set(asset, unit);
          added.push(unit);
        }
        units[i] = unit;
        continue;
      }
      let unit = this.tables.get(asset.id);
      if (unit === undefined || !previous.has(unit)) {
        if (hasDuplicateColumnIds(asset)) return null;
        unit = new TableUnit(asset, i);
        this.tables.set(asset.id, unit);
        added.push(unit);
      } else if (unit.table !== asset || unit.assetIndex !== i) {
        if (unit.table.columns !== asset.columns || unit.assetIndex !== i) {
          if (hasDuplicateColumnIds(asset)) return null;
          rebuilt.add(unit);
        }
        if (unit.table.rows !== asset.rows) {
          const d = rowDiff(unit.table.rows, asset.rows);
          changes.push({ unit, table: asset, start: d.start, beforeEnd: d.beforeEnd, afterEnd: d.afterEnd });
        }
      }
      units[i] = unit;
    }
    const current = new Set(units);
    const removed = this.units.filter((u) => !current.has(u));

    // Row owners. Removals first, so a row moved between tables is no duplicate.
    const changedIds = new Set<Id>();
    const removeRow = (id: Id): void => {
      this.owners.delete(id);
      changedIds.add(id);
    };
    const addRow = (id: Id, table: Id): boolean => {
      if (this.owners.has(id)) return false;
      this.owners.set(id, table);
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

    // References. Old ones go before units take their new table.
    for (const unit of removed) {
      unit.forEach((ref) => this.remove(ref));
      if (unit instanceof TableUnit && this.tables.get(unit.table.id) === unit) this.tables.delete(unit.table.id);
    }
    for (const unit of rebuilt) unit.forEach((ref) => this.remove(ref));
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
      unit.forEach((ref) => this.add(ref));
    }

    // References whose target appeared or disappeared.
    for (const id of changedIds) this.forTarget(id, (ref) => this.setBroken(ref));

    this.units = units;
    return this.snapshot(project, units);
  }

  /** Re-collects the changed rows of one table. Shifted rows have new paths, so a length
   *  change re-collects everything after the change. */
  private updateRows(c: RowChange): void {
    const unit = c.unit;
    const shifted = c.afterEnd - c.beforeEnd !== 0;
    const beforeEnd = shifted ? unit.table.rows.length : c.beforeEnd;
    const afterEnd = shifted ? c.table.rows.length : c.afterEnd;
    unit.table = c.table;
    for (const column of unit.columns) {
      for (let r = c.start; r < beforeEnd; r++) forEachRef(column.cells[r]!, (ref) => this.remove(ref));
      const cells = unit.collect(column, c.start, afterEnd);
      for (const cell of cells) forEachRef(cell, (ref) => this.add(ref));
      column.cells = replaceRange(column.cells, c.start, beforeEnd, cells);
    }
  }

  private add(ref: Reference): void {
    const entry = this.targets.get(ref.target);
    if (entry === undefined) this.targets.set(ref.target, ref);
    else if (entry instanceof Set) entry.add(ref);
    else this.targets.set(ref.target, new Set([entry, ref]));
    if (isBroken(ref, this.assets, this.owners)) this.broken.add(ref);
  }

  private remove(ref: Reference): void {
    const entry = this.targets.get(ref.target);
    if (entry === ref) this.targets.delete(ref.target);
    else if (entry instanceof Set) {
      entry.delete(ref);
      if (entry.size === 1) this.targets.set(ref.target, entry.values().next().value!);
    }
    this.broken.delete(ref);
  }

  private setBroken(ref: Reference): void {
    if (isBroken(ref, this.assets, this.owners)) this.broken.add(ref);
    else this.broken.delete(ref);
  }

  private forTarget(target: Id, fn: (ref: Reference) => void): void {
    const entry = this.targets.get(target);
    if (entry === undefined) return;
    if (entry instanceof Set) entry.forEach(fn);
    else fn(entry);
  }

  private snapshot(project: Project, units: readonly Unit[]): ReferenceIndex {
    const version = ++this.version;
    const self = this;
    const compare = (a: Reference, b: Reference): number => {
      const ai = a.path[1] as number;
      const bi = b.path[1] as number;
      return ai !== bi ? ai - bi : units[ai]!.compare(a, b);
    };
    const broken = [...this.broken].sort(compare);
    let full: ReferenceIndex | undefined;
    const fallback = (): ReferenceIndex => (full ??= buildFull(project));
    const sorted = new Map<Id, readonly Reference[]>();
    let references: Reference[] | undefined;
    return {
      broken,
      get references(): readonly Reference[] {
        if (self.version !== version) return fallback().references;
        if (references === undefined) {
          references = [];
          for (const unit of units) unit.forEach((ref) => references!.push(ref));
        }
        return references;
      },
      usedBy: (target) => {
        if (self.version !== version) return fallback().usedBy(target);
        // Most rows are used by nothing: answered without allocating.
        if (!self.targets.has(target)) return EMPTY;
        let list = sorted.get(target);
        if (list === undefined) {
          const out: Reference[] = [];
          self.forTarget(target, (ref) => out.push(ref));
          list = out.sort(compare);
          sorted.set(target, list);
        }
        return list;
      },
    };
  }
}
