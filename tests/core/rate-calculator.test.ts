import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPatches,
  buildReferenceIndex,
  compileCatalog,
  createEmptyProject,
  createProductionSample,
  defaultRecipeChoice,
  loadProject,
  planRates,
  producersByItem,
  resetCalculatorRecipes,
  saveProject,
  setCalculatorRecipe,
  setCalculatorTarget,
  validateProject,
  type Change,
  type Id,
  type ProductionGraphAsset,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

const NAMES = { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" };

/** The sample chain plus a second recipe for iron bars (from raw scrap). */
function sample() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, NAMES);
  const { items, recipes } = tables;
  items.rows.push({ id: newId(), name: "Scrap", cells: {} });
  const item = (name: string): Id => items.rows.find((r) => r.name === name)!.id;
  const [inputs, outputs, time] = recipes.columns;
  const recycle = {
    id: newId(),
    name: "MeltScrap",
    cells: { [inputs!.id]: [{ item: item("Scrap"), count: 2 }], [outputs!.id]: [{ item: item("IronBar"), count: 1 }], [time!.id]: 3 },
  };
  recipes.rows.push(recycle);
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  return { project, graph, items, recipes, item, recycle: recycle.id };
}

function applier(start: Project) {
  let project = start;
  return {
    apply(change: Change | null): Project {
      assert.ok(change !== null);
      project = applyPatches(project, change.patches).value;
      return project;
    },
    get project() {
      return project;
    },
  };
}

const chain = (project: Project, id: Id) => project.assets.find((a) => a.id === id) as ProductionGraphAsset;

describe("rate calculator recipe choice", () => {
  it("lists alternatives in table order and applies saved overrides", () => {
    const { project, graph, item, recycle } = sample();
    const catalog = compileCatalog(project, graph.recipes, graph.items);
    const bars = producersByItem(catalog).get(item("IronBar"))!;
    assert.deepEqual(bars.map((r) => r.name), ["SmeltIronBar", "MeltScrap"]);

    const sword = item("IronSword");
    const smelt = planRates(defaultRecipeChoice(catalog), sword, 1);
    assert.ok(smelt.raw.has(item("Coal")));
    const recycled = planRates(defaultRecipeChoice(catalog, { [item("IronBar")]: recycle }), sword, 1);
    assert.ok(recycled.converged);
    assert.deepEqual([...recycled.raw.keys()], [item("Scrap")]);
    assert.equal(recycled.raw.get(item("Scrap")), 6); // 3 bars × 2 scrap
    const melt = recycled.lines.find((l) => l.item === item("IronBar"))!;
    assert.equal(melt.recipe!.name, "MeltScrap");
    assert.equal(melt.machines, 3 * 3); // 3 cycles/s × 3 s

    // An override that does not make the item is ignored.
    const mine = [...catalog.recipes.values()].find((r) => r.name === "MineIronOre")!.id;
    const wrong = defaultRecipeChoice(catalog, { [item("IronBar")]: mine });
    assert.equal(wrong.get(item("IronBar"))!.name, "SmeltIronBar");
  });

  it("saves target, rate and choices as undoable edits and drops the field when empty", () => {
    const { project: p0, graph, item, recycle } = sample();
    const catalog = compileCatalog(p0, graph.recipes, graph.items);
    const h = applier(p0);
    const sword = item("IronSword");
    const bar = item("IronBar");

    const target = setCalculatorTarget(h.project, graph.id, sword, 1 / 60)!;
    // Picking a target merges only with other picks (arrowing through the item list).
    assert.equal(target.coalesceKey, `calculator-pick:${graph.id}`);
    h.apply(target);
    const rate = setCalculatorTarget(h.project, graph.id, sword, 2 / 60)!;
    assert.equal(rate.coalesceKey, `calculator-rate:${graph.id}`);
    h.apply(rate);
    assert.equal(setCalculatorTarget(h.project, graph.id, sword, 2 / 60), null);
    assert.equal(setCalculatorTarget(h.project, graph.id, sword, -1), null);
    assert.equal(setCalculatorTarget(h.project, graph.id, sword, Number.NaN), null);

    // Only a recipe that outputs the item can be chosen.
    assert.equal(setCalculatorRecipe(h.project, graph.id, catalog, item("Coal"), recycle), null);
    h.apply(setCalculatorRecipe(h.project, graph.id, catalog, bar, recycle));
    assert.equal(setCalculatorRecipe(h.project, graph.id, catalog, bar, recycle), null);
    assert.deepEqual(chain(h.project, graph.id).calculator, { target: sword, rate: 2 / 60, recipes: { [bar]: recycle } });

    // Indexed: the recipe row is "used by" the chain; validation is clean.
    assert.ok(buildReferenceIndex(h.project).usedBy(recycle).some((r) => r.source === graph.id));
    assert.deepEqual(validateProject(h.project), []);

    // Round trip keeps it.
    const loaded = loadProject(saveProject(h.project));
    assert.ok(loaded.ok);
    assert.deepEqual(chain(loaded.value.project, graph.id).calculator, chain(h.project, graph.id).calculator);

    h.apply(resetCalculatorRecipes(h.project, graph.id));
    assert.deepEqual(chain(h.project, graph.id).calculator, { target: sword, rate: 2 / 60 });
    assert.equal(resetCalculatorRecipes(h.project, graph.id), null);
    h.apply(setCalculatorTarget(h.project, graph.id, undefined, undefined));
    assert.equal("calculator" in chain(h.project, graph.id), false);
  });

  it("reports choices that no longer fit and broken rows", () => {
    const { project: p0, graph, item, recycle, recipes } = sample();
    const catalog = compileCatalog(p0, graph.recipes, graph.items);
    const h = applier(p0);
    const bar = item("IronBar");
    h.apply(setCalculatorRecipe(h.project, graph.id, catalog, bar, recycle));

    // The recipe stops making bars (hand edit of the table).
    const edited = structuredClone(h.project);
    const table = edited.assets.find((a) => a.id === recipes.id) as TableAsset;
    const row = table.rows.find((r) => r.id === recycle)!;
    row.cells[table.columns[1]!.id] = [{ item: item("Coal"), count: 1 }];
    assert.deepEqual(
      validateProject(edited).map((i) => i.code),
      ["calculator-recipe-mismatch"],
    );
    // The calculator falls back to the first recipe.
    const fallback = defaultRecipeChoice(compileCatalog(edited, graph.recipes, graph.items), chain(edited, graph.id).calculator!.recipes);
    assert.equal(fallback.get(bar)!.name, "SmeltIronBar");

    // The row is deleted: a broken reference.
    table.rows = table.rows.filter((r) => r.id !== recycle);
    assert.ok(validateProject(edited).some((i) => i.code === "broken-reference" && i.path.includes("calculator")));
  });
});
