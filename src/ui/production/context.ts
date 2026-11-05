import { createContext, useContext } from "react";
import type { Catalog, GateState, GraphNode, Id, Network, SolveResult } from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
import type { RateUnit } from "./format.ts";

/**
 * Data every node on the canvas needs. Passed by context instead of node `data`, so React
 * Flow's node objects stay stable and only re-render when the solution changes.
 */
export interface ProductionView {
  readonly strings: UiStrings;
  readonly catalog: Catalog;
  readonly network: Network;
  readonly result: SolveResult;
  readonly unit: RateUnit;
  readonly nodes: ReadonlyMap<Id, GraphNode>;
  readonly bottlenecks: ReadonlySet<number>;
  /** Gate evaluation for the current scenario; null when all gates are treated as open. */
  readonly gates: GateState | null;
}

export const ProductionContext = createContext<ProductionView | null>(null);

export function useProductionView(): ProductionView {
  const view = useContext(ProductionContext);
  if (view === null) throw new Error("ProductionContext missing");
  return view;
}

export function itemName(view: Pick<ProductionView, "catalog" | "strings">, id: Id): string {
  return view.catalog.items.get(id)?.name ?? view.strings.production.unknownItem;
}

/** Title shown on a node: its label, or the recipe / item name. */
export function nodeTitle(view: Pick<ProductionView, "catalog" | "strings">, node: GraphNode): string {
  if (node.label !== undefined) return node.label;
  if (node.type === "recipe") return view.catalog.recipes.get(node.recipe)?.name ?? view.strings.production.unknownRecipe;
  return itemName(view, node.item);
}
