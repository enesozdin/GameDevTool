/**
 * Item-level calculations that need no graph, only the recipe data: the rate calculator
 * ("1 Iron Sword per minute" → everything upstream), bill of materials and time to first
 * unit. MVP rule: one recipe per item (the first recipe row that outputs it, unless the
 * caller picks another).
 *
 * A tag input ("any Fuel") is made from one item with that tag: the first one (table
 * order) that has a recipe, else the first one at all (bought as a raw resource). With no
 * tagged item it stays the raw entry "#Fuel".
 */
import type { Id } from "../model/primitives.ts";
import { isTagStack, type Stack } from "../model/table.ts";
import { cycleSeconds, expectedCount, tagKey, type Catalog, type CatalogRecipe } from "./catalog.ts";

/**
 * Recipe used to make each item. Items without an entry are raw resources. `tagged`
 * (lower-cased tag → items) resolves tag inputs.
 */
export type RecipeChoice = ReadonlyMap<Id, CatalogRecipe> & { readonly tagged?: ReadonlyMap<string, readonly Id[]> };

/** The item (or "#tag" key) an input stack is made from under this choice. */
export function inputItem(choice: RecipeChoice, stack: Stack): Id {
  if (!isTagStack(stack)) return stack.item;
  const items = choice.tagged?.get(stack.tag.toLowerCase());
  if (items === undefined || items.length === 0) return tagKey(stack.tag);
  return items.find((id) => choice.has(id)) ?? items[0]!;
}

export function defaultRecipeChoice(catalog: Catalog, overrides: ReadonlyMap<Id, Id> = new Map()): Map<Id, CatalogRecipe> & { readonly tagged: ReadonlyMap<string, readonly Id[]> } {
  const choice = Object.assign(new Map<Id, CatalogRecipe>(), { tagged: catalog.tagged });
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
  /**
   * Recipe cycles/s and machines needed; 0 for raw items. A recipe chosen for several
   * items runs once: those lines show the same cycles and machines.
   */
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
    for (const id of [...recipe.inputs.map((s) => inputItem(choice, s)), ...recipe.outputs.map((s) => s.item)]) {
      if (!seen.has(id)) {
        seen.add(id);
        items.push(id);
      }
    }
  }
  const index = new Map<Id, number>();
  items.forEach((id, i) => index.set(id, i));
  const recipeOf = items.map((id) => choice.get(id));

  // Each recipe runs once, however many of its outputs it was chosen for (a smelter that
  // makes bars and slag is one machine group, not two). Activity is per recipe.
  const recipes: CatalogRecipe[] = [];
  const recipeIndex = new Map<CatalogRecipe, number>();
  const recipeOfItem = new Int32Array(items.length).fill(-1);
  recipeOf.forEach((r, i) => {
    if (r === undefined) return;
    let k = recipeIndex.get(r);
    if (k === undefined) {
      k = recipes.length;
      recipeIndex.set(r, k);
      recipes.push(r);
    }
    recipeOfItem[i] = k;
  });
  /** Expected output of item i per cycle of its own recipe. */
  const own = new Float64Array(items.length);
  recipeOf.forEach((r, i) => {
    if (r !== undefined) own[i] = r.outputs.reduce((sum, s) => (s.item === items[i] ? sum + expectedCount(s) : sum), 0);
  });
  // Flattened inputs / outputs per recipe as item indices, so the loop allocates nothing.
  const inputs = recipes.map((r) => r.inputs.map((s) => [index.get(inputItem(choice, s))!, s.count] as const));
  const outputs = recipes.map((r) => r.outputs.map((s) => [index.get(s.item)!, expectedCount(s)] as const));

  const cycles = new Float64Array(recipes.length);
  const demand = new Float64Array(items.length);
  const supply = new Float64Array(items.length);
  const need = new Float64Array(recipes.length);
  /** Items/s of item i that come from recipes other than its own. */
  const fromOthers = (i: number) => supply[i]! - (recipeOfItem[i]! >= 0 ? cycles[recipeOfItem[i]!]! * own[i]! : 0);

  let converged = false;
  for (let iter = 0; iter < maxIterations && !converged; iter++) {
    demand.fill(0);
    supply.fill(0);
    demand[0] = rate;
    for (let k = 0; k < recipes.length; k++) {
      const c = cycles[k]!;
      if (c === 0) continue;
      for (const [i, count] of inputs[k]!) demand[i]! += c * count;
      for (const [i, count] of outputs[k]!) supply[i]! += c * count;
    }
    // A recipe runs fast enough for the most demanding of the items it was chosen for.
    need.fill(0);
    for (let i = 0; i < items.length; i++) {
      const k = recipeOfItem[i]!;
      if (k < 0 || !(own[i]! > 0)) continue;
      const next = Math.max(0, demand[i]! - fromOthers(i)) / own[i]!;
      if (!Number.isFinite(next)) return { converged: false, lines: [], raw: new Map() };
      if (next > need[k]!) need[k] = next;
    }
    let change = 0;
    for (let k = 0; k < recipes.length; k++) {
      change = Math.max(change, Math.abs(need[k]! - cycles[k]!) / Math.max(1, need[k]!));
      cycles[k] = need[k]!;
    }
    converged = change <= 1e-12;
  }

  // Final flows for the settled cycles.
  demand.fill(0);
  supply.fill(0);
  demand[0] = rate;
  for (let k = 0; k < recipes.length; k++) {
    for (const [i, count] of inputs[k]!) demand[i]! += cycles[k]! * count;
    for (const [i, count] of outputs[k]!) supply[i]! += cycles[k]! * count;
  }

  const lines: RateLine[] = [];
  const raw = new Map<Id, number>();
  for (let i = 0; i < items.length; i++) {
    const r = recipeOf[i];
    const k = recipeOfItem[i]!;
    if (r === undefined) {
      const net = Math.max(0, demand[i]! - supply[i]!);
      if (net > 0) raw.set(items[i]!, net);
      lines.push({ item: items[i]!, rate: net, recipe: undefined, cycles: 0, machines: 0, surplus: Math.max(0, supply[i]! - demand[i]!) });
      continue;
    }
    const time = cycleSeconds(r);
    lines.push({
      item: items[i]!,
      rate: Math.max(0, demand[i]! - fromOthers(i)),
      recipe: r,
      cycles: cycles[k]!,
      machines: time === undefined ? NaN : cycles[k]! * time,
      surplus: Math.max(0, supply[i]! - demand[i]!),
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
      children.push(build(inputItem(choice, input), input.count * runs));
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
      const t = visit(inputItem(choice, input));
      if (t.seconds > slowest.seconds || slowest.path.length === 0) slowest = t;
    }
    visiting.delete(id);
    const result = { seconds: slowest.seconds + (cycleSeconds(recipe) ?? 0), path: [...slowest.path, id] };
    memo.set(id, result);
    return result;
  };
  return visit(item);
}
