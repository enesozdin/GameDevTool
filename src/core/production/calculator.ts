/**
 * Item-level calculations that need no graph, only the recipe data: the rate calculator
 * ("1 Iron Sword per minute" → everything upstream), bill of materials and time to first
 * unit. MVP rule: one recipe per item (the first recipe row that outputs it, unless the
 * caller picks another).
 */
import type { Id } from "../model/primitives.ts";
import { cycleSeconds, expectedCount, type Catalog, type CatalogRecipe } from "./catalog.ts";

/** Recipe used to make each item. Items without an entry are raw resources. */
export type RecipeChoice = ReadonlyMap<Id, CatalogRecipe>;

export function defaultRecipeChoice(catalog: Catalog, overrides: ReadonlyMap<Id, Id> = new Map()): Map<Id, CatalogRecipe> {
  const choice = new Map<Id, CatalogRecipe>();
  for (const recipe of catalog.recipes.values()) {
    for (const out of recipe.outputs) if (!choice.has(out.item)) choice.set(out.item, recipe);
  }
  for (const [item, recipeId] of overrides) {
    const recipe = catalog.recipes.get(recipeId);
    if (recipe !== undefined && recipe.outputs.some((o) => o.item === item)) choice.set(item, recipe);
  }
  return choice;
}

export interface RateLine {
  readonly item: Id;
  /** Net items/s needed from this item's recipe (or from outside, for raw items). */
  readonly rate: number;
  readonly recipe: CatalogRecipe | undefined;
  /** Recipe cycles/s and machines needed; 0 for raw items. */
  readonly cycles: number;
  readonly machines: number;
  /** By-product items/s produced beyond what is needed. */
  readonly surplus: number;
}

export interface RatePlan {
  readonly converged: boolean;
  /** Every involved item, in first-seen order from the target. */
  readonly lines: readonly RateLine[];
  /** Raw resources: items/s needed from sources. */
  readonly raw: ReadonlyMap<Id, number>;
}

/**
 * Required rate of every upstream item for `rate` items/s of `target`. Loops (catalysts,
 * by-products feeding back) are solved by fixed-point iteration.
 */
export function planRates(choice: RecipeChoice, target: Id, rate: number, maxIterations = 500): RatePlan {
  // Discover involved items breadth-first, so the output order reads top-down.
  const items: Id[] = [target];
  const seen = new Set<Id>(items);
  for (let i = 0; i < items.length; i++) {
    const recipe = choice.get(items[i]!);
    if (recipe === undefined) continue;
    for (const s of [...recipe.inputs, ...recipe.outputs]) {
      if (!seen.has(s.item)) {
        seen.add(s.item);
        items.push(s.item);
      }
    }
  }
  const index = new Map<Id, number>();
  items.forEach((id, i) => index.set(id, i));
  const recipeOf = items.map((id) => choice.get(id));
  // Recipes that run (one per item that has one); `cycles` per item index.
  const cycles = new Float64Array(items.length);
  const demand = new Float64Array(items.length);
  const supply = new Float64Array(items.length);

  let converged = false;
  for (let iter = 0; iter < maxIterations && !converged; iter++) {
    demand.fill(0);
    supply.fill(0);
    demand[0] = rate;
    for (let i = 0; i < items.length; i++) {
      const r = recipeOf[i];
      if (r === undefined || cycles[i] === 0) continue;
      for (const s of r.inputs) demand[index.get(s.item)!]! += cycles[i]! * s.count;
      for (const s of r.outputs) if (s.item !== items[i]) supply[index.get(s.item)!]! += cycles[i]! * expectedCount(s);
    }
    let change = 0;
    for (let i = 0; i < items.length; i++) {
      const r = recipeOf[i];
      if (r === undefined) continue;
      const own = r.outputs.reduce((sum, s) => (s.item === items[i] ? sum + expectedCount(s) : sum), 0);
      const next = own > 0 ? Math.max(0, demand[i]! - supply[i]!) / own : 0;
      if (!Number.isFinite(next)) return { converged: false, lines: [], raw: new Map() };
      change = Math.max(change, Math.abs(next - cycles[i]!) / Math.max(1, next));
      cycles[i] = next;
    }
    converged = change <= 1e-12;
  }

  const lines: RateLine[] = [];
  const raw = new Map<Id, number>();
  for (let i = 0; i < items.length; i++) {
    const r = recipeOf[i];
    const net = Math.max(0, demand[i]! - supply[i]!);
    if (r === undefined) {
      if (net > 0) raw.set(items[i]!, net);
      lines.push({ item: items[i]!, rate: net, recipe: undefined, cycles: 0, machines: 0, surplus: Math.max(0, supply[i]! - demand[i]!) });
      continue;
    }
    const time = cycleSeconds(r);
    const own = r.outputs.reduce((sum, s) => (s.item === items[i] ? sum + expectedCount(s) : sum), 0);
    lines.push({
      item: items[i]!,
      rate: net,
      recipe: r,
      cycles: cycles[i]!,
      machines: time === undefined ? NaN : cycles[i]! * time,
      surplus: Math.max(0, cycles[i]! * own + supply[i]! - demand[i]!),
    });
  }
  return { converged, lines, raw };
}

// ---------------------------------------------------------------------------------------

export interface BomNode {
  readonly item: Id;
  readonly quantity: number;
  readonly recipe: CatalogRecipe | undefined;
  readonly children: readonly BomNode[];
  /** The item is already being made further up this branch (a loop); not expanded. */
  readonly cycle: boolean;
}

export interface Bom {
  readonly root: BomNode;
  /** Total raw resources for the quantity (leaves of the tree). */
  readonly raw: ReadonlyMap<Id, number>;
  /** The tree was cut at `maxNodes`. */
  readonly truncated: boolean;
}

/** Bill of materials: total raw cost of `quantity` units of `item`, as a tree. */
export function billOfMaterials(choice: RecipeChoice, item: Id, quantity = 1, maxNodes = 10_000): Bom {
  const raw = new Map<Id, number>();
  let nodes = 0;
  let truncated = false;
  const path = new Set<Id>();

  const build = (id: Id, qty: number): BomNode => {
    nodes++;
    const recipe = choice.get(id);
    if (path.has(id)) return { item: id, quantity: qty, recipe, children: [], cycle: true };
    if (recipe === undefined) {
      raw.set(id, (raw.get(id) ?? 0) + qty);
      return { item: id, quantity: qty, recipe, children: [], cycle: false };
    }
    const per = recipe.outputs.reduce((sum, s) => (s.item === id ? sum + expectedCount(s) : sum), 0);
    const runs = per > 0 ? qty / per : 0;
    path.add(id);
    const children: BomNode[] = [];
    for (const input of recipe.inputs) {
      if (nodes >= maxNodes) {
        truncated = true;
        break;
      }
      children.push(build(input.item, input.count * runs));
    }
    path.delete(id);
    return { item: id, quantity: qty, recipe, children, cycle: false };
  };

  return { root: build(item, quantity), raw, truncated };
}

// ---------------------------------------------------------------------------------------

export interface FirstUnit {
  /** Seconds until the first unit exists, with unlimited machines and raw items at hand. */
  readonly seconds: number;
  /** Items on the critical path, from the slowest raw input to the target. */
  readonly path: readonly Id[];
}

/**
 * Time to first unit: the critical path through the recipe tree, where the inputs of a
 * recipe are made in parallel. Items in a loop count as already available (a catalyst is
 * needed to start the loop anyway).
 */
export function timeToFirstUnit(choice: RecipeChoice, item: Id): FirstUnit {
  const memo = new Map<Id, FirstUnit>();
  const visiting = new Set<Id>();
  const visit = (id: Id): FirstUnit => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const recipe = choice.get(id);
    if (recipe === undefined || visiting.has(id)) return { seconds: 0, path: [id] };
    visiting.add(id);
    let slowest: FirstUnit = { seconds: 0, path: [] };
    for (const input of recipe.inputs) {
      const t = visit(input.item);
      if (t.seconds > slowest.seconds || slowest.path.length === 0) slowest = t;
    }
    visiting.delete(id);
    const result = { seconds: slowest.seconds + (cycleSeconds(recipe) ?? 0), path: [...slowest.path, id] };
    memo.set(id, result);
    return result;
  };
  return visit(item);
}
