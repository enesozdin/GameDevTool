import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeUnlocks,
  compileCatalog,
  compileNetwork,
  ConditionCompiler,
  createEmptyProject,
  createProductionGraph,
  createProductionTables,
  createRandom,
  defaultRecipeChoice,
  hasRandomness,
  monteCarloPercentiles,
  planRates,
  sampleBinomial,
  samplePoisson,
  solveNetwork,
  startMonteCarlo,
  stepMonteCarlo,
  validateProject,
  type GraphEdge,
  type GraphNode,
  type Id,
  type ItemStack,
  type Project,
  type ProductionGraphAsset,
  type Stack,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

/** A graph node without id and position (distributive over the node union). */
type NodeInput = GraphNode extends infer N ? (N extends GraphNode ? Omit<N, "id" | "position"> : never) : never;

/** A small chain builder on top of empty Items / Machines / Recipes tables. */
function builder() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const tables = createProductionTables(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "G" });
  const graph: ProductionGraphAsset = createProductionGraph(newId, "G", tables);
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  const [inputsCol, outputsCol, timeCol, , gateCol] = tables.recipes.columns.map((c) => c.id) as [Id, Id, Id, Id, Id];
  const item = (name: string): Id => {
    const id = newId();
    tables.items.rows.push({ id, name, cells: {} });
    return id;
  };
  const recipe = (name: string, inputs: Stack[], outputs: ItemStack[], time = 1, gate?: string): Id => {
    const id = newId();
    const cells: Record<string, unknown> = { [inputsCol]: inputs, [outputsCol]: outputs, [timeCol]: time };
    if (gate !== undefined) cells[gateCol] = gate;
    tables.recipes.rows.push({ id, name, cells: cells as never });
    return id;
  };
  const node = (n: NodeInput): GraphNode => {
    const full = { ...n, id: newId(), position: { x: 0, y: 0 } } as GraphNode;
    graph.nodes.push(full);
    return full;
  };
  const edge = (from: GraphNode, to: GraphNode, item: Id, ratio?: number): GraphEdge => {
    const e: GraphEdge = ratio === undefined ? { id: newId(), source: from.id, target: to.id, item } : { id: newId(), source: from.id, target: to.id, item, ratio };
    graph.edges.push(e);
    return e;
  };
  const compile = () => {
    const catalog = compileCatalog(project, graph.recipes, graph.items);
    return { catalog, net: compileNetwork(graph, catalog) };
  };
  return { project, newId, graph, item, recipe, node, edge, compile };
}

const near = (actual: number, expected: number, tolerance: number, what = "") => assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} ≉ ${expected} ± ${tolerance}`);

describe("random", () => {
  it("poisson samples have the right mean and variance on both code paths", () => {
    const random = createRandom(11);
    for (const lambda of [0.5, 4, 25, 200]) {
      const runs = 6_000;
      let sum = 0;
      let squares = 0;
      for (let i = 0; i < runs; i++) {
        const k = samplePoisson(random, lambda);
        assert.ok(Number.isInteger(k) && k >= 0);
        sum += k;
        squares += k * k;
      }
      const mean = sum / runs;
      const variance = squares / runs - mean * mean;
      near(mean, lambda, (5 * Math.sqrt(lambda)) / Math.sqrt(runs) + 0.01, `mean λ=${lambda}`);
      near(variance, lambda, lambda * 0.15 + 0.05, `variance λ=${lambda}`);
    }
    assert.equal(samplePoisson(random, 0), 0);
    assert.equal(samplePoisson(random, Number.NaN), 0);
  });

  it("binomial samples have the right variance and stay in range", () => {
    const random = createRandom(5);
    for (const [n, p] of [
      [40, 0.3],
      [5_000, 0.5],
      [2_000, 0.002],
      [2_000, 0.998],
    ] as const) {
      const runs = 6_000;
      let sum = 0;
      let squares = 0;
      for (let i = 0; i < runs; i++) {
        const k = sampleBinomial(random, n, p);
        assert.ok(k >= 0 && k <= n);
        sum += k;
        squares += k * k;
      }
      const mean = sum / runs;
      const expected = n * p * (1 - p);
      near(squares / runs - mean * mean, expected, expected * 0.15 + 0.1, `variance n=${n} p=${p}`);
    }
  });
});

describe("solver edge cases", () => {
  it("splits a flow by connection ratios in supply mode", () => {
    const b = builder();
    const ore = b.item("Ore");
    const source = b.node({ type: "source", item: ore, rate: 3 });
    const split = b.node({ type: "splitter", item: ore });
    const big = b.node({ type: "sink", item: ore });
    const small = b.node({ type: "sink", item: ore });
    b.edge(source, split, ore);
    b.edge(split, big, ore, 2);
    b.edge(split, small, ore, 1);
    const { net } = b.compile();
    const result = solveNetwork(net, "supply");
    near(result.activity[net.nodeIndex.get(big.id)!]!, 2, 1e-9);
    near(result.activity[net.nodeIndex.get(small.id)!]!, 1, 1e-9);
  });

  it("reports a loop that produces more than it consumes as not converged", () => {
    const b = builder();
    const x = b.item("X");
    const y = b.item("Y");
    const double = b.recipe("Double", [{ item: x, count: 1 }], [{ item: y, count: 2 }]);
    const back = b.recipe("Back", [{ item: y, count: 1 }], [{ item: x, count: 1 }]);
    const source = b.node({ type: "source", item: x, rate: 1 });
    const a = b.node({ type: "recipe", recipe: double });
    const c = b.node({ type: "recipe", recipe: back });
    b.edge(source, a, x);
    b.edge(a, c, y);
    b.edge(c, a, x);
    const { net } = b.compile();
    const result = solveNetwork(net, "supply", { maxSweeps: 50 });
    assert.equal(result.converged, false);
    assert.ok(result.edgeFlow.every((f) => Number.isFinite(f)));
  });

  it("samples each stack of a merged output port with its own chance", () => {
    const b = builder();
    const ore = b.item("Ore");
    const bar = b.item("Bar");
    // One guaranteed bar plus a 50% bonus bar per cycle.
    const smelt = b.recipe("Smelt", [{ item: ore, count: 1 }], [
      { item: bar, count: 1 },
      { item: bar, count: 1, chance: 0.5 },
    ]);
    const source = b.node({ type: "source", item: ore, rate: 1 });
    const r = b.node({ type: "recipe", recipe: smelt });
    const sink = b.node({ type: "sink", item: bar });
    b.edge(source, r, ore);
    b.edge(r, sink, bar);
    const { net } = b.compile();
    assert.equal(hasRandomness(net), true);
    const options = { runs: 3_000, seconds: 100, seed: 3 };
    const state = startMonteCarlo(net, options);
    while (!stepMonteCarlo(net, state, options, 500));
    const [p] = monteCarloPercentiles(state);
    // 100 cycles: 100 guaranteed + Binomial(100, 0.5) bonus → mean 150, sd 5.
    near(p!.mean, 150, 0.6, "mean");
    near(p!.p90 - p!.p10, 2 * 1.2816 * 5, 2.5, "P10–P90 spread");
  });

  it("an input fed by several suppliers needs only what they all need", () => {
    const b = builder();
    b.project.manifest.variables.push({ id: b.newId(), name: "A", type: "bool", default: false }, { id: b.newId(), name: "B", type: "bool", default: false });
    const ore = b.item("Ore");
    const bar = b.item("Bar");
    const smeltA = b.recipe("SmeltA", [{ item: ore, count: 1 }], [{ item: bar, count: 1 }], 1, "A");
    const smeltB = b.recipe("SmeltB", [{ item: ore, count: 1 }], [{ item: bar, count: 1 }], 1, "B");
    const source = b.node({ type: "source", item: ore, rate: 1 });
    const g1 = b.node({ type: "gate", item: ore, condition: "A" });
    const g2 = b.node({ type: "gate", item: ore, condition: "A and B" });
    const r = b.node({ type: "recipe", recipe: smeltA });
    b.edge(source, g1, ore);
    b.edge(source, g2, ore);
    b.edge(g1, r, ore);
    b.edge(g2, r, ore);
    const conditions = new ConditionCompiler(b.project.manifest.variables);
    const { catalog, net } = b.compile();
    const { required } = analyzeUnlocks(b.graph, catalog, net, conditions);
    // Shared part of {A} and {A, B} is {A}; plus the recipe's own condition A.
    assert.deepEqual([...required[net.nodeIndex.get(r.id)!]!.keys()], ["A"]);
    const warnings = (p: Project) => validateProject(p).filter((i) => i.code === "used-before-unlocked");
    assert.equal(warnings(b.project).length, 0);
    // A recipe unlocked by B alone can run before A holds.
    (b.graph.nodes[3] as { recipe: Id }).recipe = smeltB;
    const w = warnings(b.project);
    assert.equal(w.length, 1);
    assert.equal(w[0]!.params?.condition, "A");
  });
});

describe("rate calculator", () => {
  it("runs a recipe once when it is chosen for two of its outputs", () => {
    const b = builder();
    const ore = b.item("Ore");
    const bar = b.item("Bar");
    const slag = b.item("Slag");
    const sword = b.item("Sword");
    b.recipe("Smelt", [{ item: ore, count: 1 }], [
      { item: bar, count: 1 },
      { item: slag, count: 1 },
    ], 2);
    b.recipe("Forge", [
      { item: bar, count: 1 },
      { item: slag, count: 1 },
    ], [{ item: sword, count: 1 }]);
    const { catalog } = b.compile();
    const plan = planRates(defaultRecipeChoice(catalog), sword, 1);
    assert.equal(plan.converged, true);
    near(plan.raw.get(ore)!, 1, 1e-9, "ore");
    const barLine = plan.lines.find((l) => l.item === bar)!;
    const slagLine = plan.lines.find((l) => l.item === slag)!;
    near(barLine.cycles, 1, 1e-9);
    near(slagLine.cycles, 1, 1e-9);
    near(barLine.machines, 2, 1e-9);
    near(barLine.surplus + slagLine.surplus, 0, 1e-9);
  });

  it("runs the shared recipe for its most demanded output and reports the rest as surplus", () => {
    const b = builder();
    const ore = b.item("Ore");
    const bar = b.item("Bar");
    const slag = b.item("Slag");
    const sword = b.item("Sword");
    b.recipe("Smelt", [{ item: ore, count: 1 }], [
      { item: bar, count: 1 },
      { item: slag, count: 1 },
    ]);
    b.recipe("Forge", [
      { item: bar, count: 3 },
      { item: slag, count: 1 },
    ], [{ item: sword, count: 1 }]);
    const { catalog } = b.compile();
    const plan = planRates(defaultRecipeChoice(catalog), sword, 1);
    near(plan.raw.get(ore)!, 3, 1e-9, "ore");
    near(plan.lines.find((l) => l.item === slag)!.surplus, 2, 1e-9, "slag surplus");
  });
});
