import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addRow,
  applyPatches,
  ConditionCompiler,
  createEmptyProject,
  createProductionSample,
  createValidationCache,
  moveNodes,
  sameCalculation,
  updateNode,
  validateProject,
  type Change,
  type ProductionGraphAsset,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

function setup() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" });
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  return { project, newId };
}

const apply = (project: Project, change: Change | null): Project => {
  assert.ok(change !== null);
  return applyPatches(project, change.patches).value;
};
const graphOf = (p: Project) => p.assets.find((a) => a.kind === "production-graph") as ProductionGraphAsset;

describe("sameCalculation", () => {
  it("ignores positions and labels, not rates, recipes or connections", () => {
    const { project } = setup();
    const graph = graphOf(project);
    const node = graph.nodes[1]!;
    const moved = graphOf(apply(project, moveNodes(project, graph.id, new Map([[node.id, { x: 999, y: 5 }]]))));
    assert.equal(sameCalculation(graph, moved), true);
    const labelled = graphOf(apply(project, updateNode(project, graph.id, node.id, { label: "Fuel line" })));
    assert.equal(sameCalculation(graph, labelled), true);
    const faster = graphOf(apply(project, updateNode(project, graph.id, node.id, { rate: 2 })));
    assert.equal(sameCalculation(graph, faster), false);
    const poisson = graphOf(apply(project, updateNode(project, graph.id, node.id, { distribution: "poisson" })));
    assert.equal(sameCalculation(graph, poisson), false);
    assert.equal(sameCalculation(graph, { ...graph, edges: [...graph.edges] }), false);
  });
});

describe("validation cache", () => {
  it("gives the same findings as a full validation across edits", () => {
    let project = sampleProject();
    const cache = createValidationCache();
    const check = () => assert.deepEqual(validateProject(project, undefined, cache), validateProject(project));
    check();
    const table = project.assets.find((a) => a.kind === "table") as TableAsset;
    // A duplicate row name, then an asset moved in the list (paths must follow it).
    project = apply(project, addRow(project, table.id, { id: fixedIds(42)(), name: table.rows[0]!.name, cells: {} }));
    check();
    project = { ...project, assets: [project.assets[project.assets.length - 1]!, ...project.assets.slice(0, -1)] };
    check();
    // A variable change invalidates the checks that read variables.
    project = { ...project, manifest: { ...project.manifest, variables: project.manifest.variables.slice(1) } };
    check();
  });

  it("reports duplicate ids across cached assets with the right path", () => {
    const project = sampleProject();
    const cache = createValidationCache();
    validateProject(project, undefined, cache);
    const tables = project.assets.filter((a): a is TableAsset => a.kind === "table");
    const clash = { ...tables[1]!, rows: [...tables[1]!.rows, { ...tables[1]!.rows[0]!, id: tables[0]!.rows[0]!.id, name: "Clash" }] };
    const next: Project = { ...project, assets: project.assets.map((a) => (a === tables[1] ? clash : a)) };
    const cached = validateProject(next, undefined, cache).filter((i) => i.code === "duplicate-id");
    assert.deepEqual(cached, validateProject(next).filter((i) => i.code === "duplicate-id"));
    assert.equal(cached.length, 1);
    assert.equal(cached[0]!.path.at(-1), "id");
  });
});

describe("condition cache", () => {
  it("stays within its limit and keeps recently used conditions", () => {
    const compiler = new ConditionCompiler([{ id: fixedIds()(), name: "Level", type: "int", default: 0 }], 8);
    const hot = compiler.compile("Level > 1");
    for (let i = 0; i < 100; i++) {
      compiler.compile(`Level > ${i + 2}`);
      if (i % 4 === 0) assert.equal(compiler.compile("Level > 1"), hot);
    }
    assert.equal(compiler.size, 8);
    assert.equal(compiler.compile("Level > 1"), hot);
  });
});
