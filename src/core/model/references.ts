import type { IssuePath } from "../result.ts";
import type { Id } from "./primitives.ts";
import type { Asset, Project } from "./project.ts";
import type { ProductionGraphAsset } from "./production-graph.ts";
import type { ColumnType, TableAsset } from "./table.ts";

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
  readonly references: readonly Reference[];
  /** References whose target does not exist or has the wrong kind. */
  readonly broken: readonly Reference[];
  /** Everything that points at an asset or row ("used by" lists, safe delete/rename). */
  usedBy(target: Id): readonly Reference[];
}

const EMPTY: readonly Reference[] = [];

function referenceTable(type: ColumnType): Id | undefined {
  if (type.kind === "reference" || type.kind === "stacks") return type.table;
  if (type.kind === "list" && type.item.kind === "reference") return type.item.table;
  return undefined;
}

/** Builds the index in one pass over the project. O(assets + rows × reference columns). */
export function buildReferenceIndex(project: Project): ReferenceIndex {
  const assets = new Map<Id, Asset>();
  const rowOwner = new Map<Id, Id>();
  for (const asset of project.assets) {
    assets.set(asset.id, asset);
    if (asset.kind === "table") for (const row of asset.rows) rowOwner.set(row.id, asset.id);
  }

  const references: Reference[] = [];
  const broken: Reference[] = [];
  const byTarget = new Map<Id, Reference[]>();

  const add = (ref: Reference, isBroken: boolean): void => {
    references.push(ref);
    if (isBroken) broken.push(ref);
    const list = byTarget.get(ref.target);
    if (list) list.push(ref);
    else byTarget.set(ref.target, [ref]);
  };

  project.assets.forEach((asset, assetIndex) => {
    if (asset.kind === "document") {
      if (asset.parent !== undefined) {
        const parent = assets.get(asset.parent);
        add(
          { kind: "document-parent", source: asset.id, path: ["assets", assetIndex, "parent"], target: asset.parent },
          parent === undefined || parent.kind !== "document",
        );
      }
      return;
    }
    if (asset.kind === "production-graph") {
      collectGraphReferences(asset, assetIndex, assets, rowOwner, add);
      return;
    }
    collectTableReferences(asset, assetIndex, assets, rowOwner, add);
  });

  return {
    references,
    broken,
    usedBy: (target) => byTarget.get(target) ?? EMPTY,
  };
}

function collectTableReferences(
  table: TableAsset,
  assetIndex: number,
  assets: ReadonlyMap<Id, Asset>,
  rowOwner: ReadonlyMap<Id, Id>,
  add: (ref: Reference, isBroken: boolean) => void,
): void {
  table.columns.forEach((column, columnIndex) => {
    const targetTable = referenceTable(column.type);
    if (targetTable === undefined) return;

    const target = assets.get(targetTable);
    add(
      {
        kind: "column-table",
        source: table.id,
        path: ["assets", assetIndex, "columns", columnIndex, "type"],
        target: targetTable,
      },
      target === undefined || target.kind !== "table",
    );

    table.rows.forEach((row, rowIndex) => {
      const value = row.cells[column.id];
      const addRow = (rowId: Id, path: IssuePath): void =>
        add(
          { kind: "cell-row", source: table.id, path, target: rowId, targetTable },
          rowOwner.get(rowId) !== targetTable,
        );

      // Non-string values are type errors, reported by validate.ts, not references.
      if (typeof value === "string") {
        addRow(value, ["assets", assetIndex, "rows", rowIndex, "cells", column.id]);
      } else if (Array.isArray(value)) {
        value.forEach((item, itemIndex) => {
          const path = ["assets", assetIndex, "rows", rowIndex, "cells", column.id, itemIndex];
          if (typeof item === "string") addRow(item, path);
          else if (column.type.kind === "stacks" && item !== null && typeof item === "object" && "item" in item) addRow(item.item, [...path, "item"]);
        });
      }
    });
  });
}

function collectGraphReferences(
  graph: ProductionGraphAsset,
  assetIndex: number,
  assets: ReadonlyMap<Id, Asset>,
  rowOwner: ReadonlyMap<Id, Id>,
  add: (ref: Reference, isBroken: boolean) => void,
): void {
  const base = ["assets", assetIndex] as const;
  for (const field of ["items", "recipes"] as const) {
    const target = assets.get(graph[field]);
    add({ kind: "graph-table", source: graph.id, path: [...base, field], target: graph[field] }, target === undefined || target.kind !== "table");
  }
  const addRow = (rowId: Id, table: Id, path: IssuePath): void =>
    add({ kind: "graph-row", source: graph.id, path, target: rowId, targetTable: table }, rowOwner.get(rowId) !== table);

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
