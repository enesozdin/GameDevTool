import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAssets,
  autoLayout,
  billOfMaterials,
  canConnect,
  commit,
  compileCatalog,
  compileNetwork,
  createEmptyProject,
  createHistory,
  createProductionSample,
  defaultRecipeChoice,
  hasRandomness,
  Limit,
  loadProject,
  monteCarloPercentiles,
  planRates,
  removeGraphElements,
  saveProject,
  solveNetwork,
  startMonteCarlo,
  stepMonteCarlo,
  timeToFirstUnit,
  validateProject,
  type GraphNode,
  type Id,
  type ProductionGraphAsset,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

const NAMES = { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" };

function sample(): { project: Project; graph: ProductionGraphAsset; items: TableAsset; recipes: TableAsset } {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, NAMES);
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  return { project, graph, items: tables.items, recipes: tables.recipes };
}

const itemId = (items: TableAsset, name: string): Id => items.rows.find((r) => r.name === name)!.id;
const recipeId = (recipes: TableAsset, name: string): Id => recipes.rows.find((r) => r.name === name)!.id;
const nodeOf = (graph: ProductionGraphAsset, pred: (n: GraphNode) => boolean): number => graph.nodes.findIndex(pred);
const close = (actual: number, expected: number, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${actual} ≉ ${expected}`);

describe("production sample", () => {
  it("is valid and round-trips through save/load", () => {
    const { project } = sample();
    assert.deepEqual(validateProject(project), []);
    const text = saveProject(project);
    const loaded = loadProject(text);
    assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.error));
    assert.deepEqual(loaded.value.issues, []);
    assert.equal(saveProject(loaded.value.project), text);
  });
});

describe("target-driven solve", () => {
  it("computes upstream rates, machine counts and by-product surplus", () => {
    const { project, graph, items, recipes } = sample();
    const net = compileNetwork(graph, compileCatalog(project, graph.recipes, graph.items));
    const r = solveNetwork(net, "target");
    assert.ok(r.converged);

    const sword = 1 / 60;
    const forge = nodeOf(graph, (n) => n.type === "recipe" && n.recipe === recipeId(recipes, "ForgeIronSword"));
    const smelt = nodeOf(graph, (n) => n.type === "recipe" && n.recipe === recipeId(recipes, "SmeltIronBar"));
    const mine = nodeOf(graph, (n) => n.type === "recipe" && n.recipe === recipeId(recipes, "MineIronOre"));
    const coal = nodeOf(graph, (n) => n.type === "source");
    close(r.activity[forge]!, sword); // 1 sword per cycle
    close(r.machines[forge]!, sword * 10); // 10 s cycle
    close(r.activity[smelt]!, 3 * sword); // 3 bars per sword
    close(r.activity[mine]!, 6 * sword); // 2 ore per bar
    close(r.machines[mine]!, 6 * sword * 2);
    close(r.activity[coal]!, 3 * sword);
    assert.equal(r.nodeDeficit[coal], 0); // capacity 0.5/s is plenty

    // Slag (10% chance) is a by-product: produced, and the slag sink has no demand.
    const slagPort = net.outItem.findIndex((item, p) => item === itemId(items, "Slag") && p >= net.outStart[smelt]! && p < net.outStart[smelt + 1]!);
    close(r.outProduced[slagPort]!, 0.1 * 3 * sword);
  });

  it("reports a deficit when a source capacity is exceeded", () => {
    const { project, graph } = sample();
    const coal = graph.nodes.find((n) => n.type === "source")!;
    if (coal.type === "source") coal.rate = 0.01;
    const net = compileNetwork(graph, compileCatalog(project, graph.recipes, graph.items));
    const r = solveNetwork(net, "target");
    close(r.nodeDeficit[net.nodeIndex.get(coal.id)!]!, 3 / 60 - 0.01);
  });

  it("uses recycled catalyst before outside supply", () => {
    const newId = fixedIds();
    const project = createEmptyProject("Loop", newId);
    const { tables, graph } = createProductionSample(newId, NAMES);
    const { items, recipes } = tables;
    const cat = { id: newId(), name: "Catalyst", cells: {} };
    items.rows.push(cat);
    const ore = itemId(items, "IronOre");
    const bar = itemId(items, "IronBar");
    const [inputs, outputs, time] = recipes.columns.map((c) => c.id) as [Id, Id, Id];
    const loopRecipe = {
      id: newId(),
      name: "CatalyticSmelt",
      cells: {
        [inputs]: [
          { item: ore, count: 1 },
          { item: cat.id, count: 1 },
        ],
        [outputs]: [
          { item: bar, count: 1 },
          { item: cat.id, count: 0.9 },
        ],
        [time]: 1,
      },
    };
    recipes.rows.push(loopRecipe);
    const at = { x: 0, y: 0 };
    const g: ProductionGraphAsset = {
      ...graph,
      nodes: [
        { id: newId(), type: "source", position: at, item: ore, rate: 0 },
        { id: newId(), type: "source", position: at, item: cat.id, rate: 0 },
        { id: newId(), type: "recipe", position: at, recipe: loopRecipe.id },
        { id: newId(), type: "sink", position: at, item: bar, rate: 1 },
      ],
      edges: [],
    };
    const [oreN, catN, recN, sinkN] = g.nodes as [GraphNode, GraphNode, GraphNode, GraphNode];
    g.edges.push(
      { id: newId(), source: oreN.id, target: recN.id, item: ore },
      { id: newId(), source: catN.id, target: recN.id, item: cat.id },
      { id: newId(), source: recN.id, target: recN.id, item: cat.id },
      { id: newId(), source: recN.id, target: sinkN.id, item: bar },
    );
    // A self-loop edge is rejected by validation; route the catalyst through a storage.
    const store: GraphNode = { id: newId(), type: "storage", position: at, item: cat.id };
    g.nodes.push(store);
    g.edges[2] = { id: g.edges[2]!.id, source: recN.id, target: store.id, item: cat.id };
    g.edges.push({ id: newId(), source: store.id, target: recN.id, item: cat.id });
    project.assets.push(items, tables.machines, recipes, g);
    assert.deepEqual(validateProject(project), []);

    const net = compileNetwork(g, compileCatalog(project, g.recipes, g.items));
    const r = solveNetwork(net, "target");
    assert.ok(r.converged);
    close(r.activity[2]!, 1);
    close(r.activity[1]!, 0.1, 1e-6); // only the 10% loss comes from outside
  });
});

describe("supply-driven solve", () => {
  it("finds the limiting input and the bottleneck", () => {
    const { project, graph, recipes } = sample();
    const net = compileNetwork(graph, compileCatalog(project, graph.recipes, graph.items));
    const r = solveNetwork(net, "supply");
    assert.ok(r.converged);
    const mine = nodeOf(graph, (n) => n.type === "recipe" && n.recipe === recipeId(recipes, "MineIronOre"));
    const smelt = nodeOf(graph, (n) => n.type === "recipe" && n.recipe === recipeId(recipes, "SmeltIronBar"));
    const sword = nodeOf(graph, (n) => n.type === "sink" && n.rate !== undefined);
    // One drill: 0.5 ore/s → 0.25 smelts/s (coal 0.5/s would allow 0.5).
    close(r.activity[mine]!, 0.5);
    assert.equal(r.limit[mine], Limit.machines);
    close(r.activity[smelt]!, 0.25);
    assert.equal(r.limit[smelt], Limit.input);
    close(r.activity[sword]!, 0.25 / 3);
    assert.deepEqual(r.bottlenecks, [mine]);
  });

  it("caps a recipe by its built machines", () => {
    const { project, graph, recipes } = sample();
    const forge = graph.nodes.find((n) => n.type === "recipe" && n.recipe === recipeId(recipes, "ForgeIronSword"))!;
    if (forge.type === "recipe") forge.machines = 0.5;
    const net = compileNetwork(graph, compileCatalog(project, graph.recipes, graph.items));
    const r = solveNetwork(net, "supply");
    const i = net.nodeIndex.get(forge.id)!;
    close(r.activity[i]!, 0.05);
    assert.equal(r.limit[i], Limit.machines);
  });
});

describe("validation", () => {
  it("rejects mismatched connections and flags unconnected inputs", () => {
    const { project, graph, items } = sample();
    const smelt = graph.nodes[2]!;
    const sink = graph.nodes[4]!;
    graph.edges.push({ id: fixedIds(5)(), source: smelt.id, target: sink.id, item: itemId(items, "IronBar") });
    graph.edges.splice(1, 1); // coal → smelt
    const codes = validateProject(project).map((i) => i.code);
    assert.ok(codes.includes("port-mismatch"));
    assert.ok(codes.includes("input-unconnected"));
  });

  it("detects a loop with no way in", () => {
    const newId = fixedIds(7);
    const { project, graph, items } = sample();
    const bar = itemId(items, "IronBar");
    const at = { x: 0, y: 0 };
    const a: GraphNode = { id: newId(), type: "storage", position: at, item: bar };
    const b: GraphNode = { id: newId(), type: "merger", position: at, item: bar };
    graph.nodes.push(a, b);
    graph.edges.push({ id: newId(), source: a.id, target: b.id, item: bar }, { id: newId(), source: b.id, target: a.id, item: bar });
    assert.ok(validateProject(project).some((i) => i.code === "loop-without-source"));
  });

  it("canConnect enforces typed ports", () => {
    const { project, graph, items } = sample();
    const catalog = compileCatalog(project, graph.recipes, graph.items);
    const [mine, coal, smelt] = graph.nodes as [GraphNode, GraphNode, GraphNode];
    assert.equal(canConnect(graph, catalog, mine.id, smelt.id, itemId(items, "IronOre")), false); // exists already
    assert.equal(canConnect(graph, catalog, coal.id, mine.id, itemId(items, "Coal")), false); // mine takes no coal
    assert.equal(canConnect(graph, catalog, smelt.id, smelt.id, itemId(items, "IronBar")), false);
  });
});

describe("edits", () => {
  it("removing a node removes its connections in one undo step", () => {
    const { project, graph } = sample();
    const h = commit(createHistory(project), removeGraphElements(project, graph.id, new Set([graph.nodes[2]!.id]), new Set())!, 0);
    const g = h.present.assets[3] as ProductionGraphAsset;
    assert.equal(g.nodes.length, 5);
    assert.equal(g.edges.length, 1);
    assert.deepEqual(validateProject(h.present).filter((i) => i.severity === "error"), []);
  });

  it("addAssets inserts several assets as one change", () => {
    const newId = fixedIds();
    const project = createEmptyProject("P", newId);
    const { tables, graph } = createProductionSample(newId, NAMES);
    const change = addAssets(project, [tables.items, tables.machines, tables.recipes, graph], "add-production-graph")!;
    assert.equal(commit(createHistory(project), change, 0).present.assets.length, 4);
  });
});

describe("calculator", () => {
  it("plans rates, bill of materials and time to first unit", () => {
    const { project, graph, items } = sample();
    const catalog = compileCatalog(project, graph.recipes);
    const choice = defaultRecipeChoice(catalog);
    const sword = itemId(items, "IronSword");
    const plan = planRates(choice, sword, 1 / 60);
    assert.ok(plan.converged);
    close(plan.raw.get(itemId(items, "Coal"))!, 3 / 60);
    assert.equal(plan.raw.has(itemId(items, "IronOre")), false); // mined by a recipe

    const bom = billOfMaterials(choice, sword, 1);
    close(bom.raw.get(itemId(items, "Coal"))!, 3);
    assert.equal(bom.root.children.length, 1);

    const first = timeToFirstUnit(choice, sword);
    assert.equal(first.seconds, 2 + 4 + 10);
    assert.deepEqual(first.path, [itemId(items, "IronOre"), itemId(items, "IronBar"), sword]);
  });
});

describe("monte carlo", () => {
  it("is reproducible and centred on the expected value", () => {
    const { project, graph, items } = sample();
    const net = compileNetwork(graph, compileCatalog(project, graph.recipes, graph.items));
    assert.ok(hasRandomness(net));
    const options = { runs: 2_000, seconds: 3_600, seed: 42 };
    const run = () => {
      const state = startMonteCarlo(net, options);
      while (!stepMonteCarlo(net, state, options, 300));
      return monteCarloPercentiles(state);
    };
    const a = run();
    assert.deepEqual(a, run());
    const slagSink = [...net.nodeIndex.entries()].map(([, i]) => i).filter((i) => net.kind[i] === 3);
    const slagIndex = slagSink.findIndex((i) => (graph.nodes[i] as { item: Id }).item === itemId(items, "Slag"));
    const slag = a[slagIndex]!;
    // 0.25 smelts/s × 3600 s × 10% = 90 per hour.
    assert.ok(Math.abs(slag.mean - 90) < 2, String(slag.mean));
    assert.ok(slag.p10 < slag.p50 && slag.p50 < slag.p90);
  });
});

describe("layout", () => {
  it("places producers left of consumers", () => {
    const { graph } = sample();
    const pos = autoLayout(graph);
    for (const e of graph.edges) assert.ok(pos.get(e.source)!.x < pos.get(e.target)!.x);
  });
});
