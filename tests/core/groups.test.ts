import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPatches,
  autoLayout,
  commonContainer,
  compileNetwork,
  compileCatalog,
  createEmptyProject,
  createProductionSample,
  groupElements,
  groupGeometry,
  groupStructure,
  GRAPH_LIMITS,
  loadProject,
  removeGraphElements,
  saveProject,
  shownEdges,
  solveNetwork,
  summarizeCollapsed,
  ungroup,
  updateGroup,
  validateProject,
  type Change,
  type GraphGroup,
  type Id,
  type ProductionGraphAsset,
  type Project,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

function setup() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" });
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  // Sample node order: mine, coal, smelt, forge, sword sink, slag sink.
  const [mine, coal, smelt, forge, swordSink, slagSink] = graph.nodes.map((n) => n.id) as [Id, Id, Id, Id, Id, Id];
  return { project, newId, ids: { mine, coal, smelt, forge, swordSink, slagSink } };
}

function apply(project: Project, change: Change | null): Project {
  assert.ok(change !== null, "expected a change");
  return applyPatches(project, change.patches).value;
}

const graphOf = (project: Project): ProductionGraphAsset => project.assets.find((a) => a.kind === "production-graph") as ProductionGraphAsset;

describe("groups: edits", () => {
  it("groups nodes, nests groups, and ungroups back to the original", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const g1 = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine, ids.smelt]), new Set(), { id: g1, label: "Smelting" }));
    let graph = graphOf(p);
    assert.deepEqual(graph.groups, [{ id: g1, label: "Smelting" }]);
    assert.equal(graph.nodes.find((n) => n.id === ids.mine)!.group, g1);

    // A group and a top-level node share the top level, so they can be grouped.
    const g2 = newId();
    p = apply(p, groupElements(p, graphId, new Set([ids.forge]), new Set([g1]), { id: g2, label: "Bars and swords" }));
    graph = graphOf(p);
    assert.equal(graph.groups!.find((g) => g.id === g1)!.parent, g2);
    assert.equal(groupStructure(graph).depth.get(g1), 1);

    // Mixed containers cannot be grouped.
    assert.equal(commonContainer(graph, [ids.mine, ids.coal], []), null);
    assert.equal(groupElements(p, graphId, new Set([ids.mine, ids.coal]), new Set(), { id: newId(), label: "X" }), null);

    p = apply(p, ungroup(p, graphId, g2));
    graph = graphOf(p);
    assert.deepEqual(graph.groups, [{ id: g1, label: "Smelting" }]);
    assert.equal(graph.nodes.find((n) => n.id === ids.forge)!.group, undefined);
    assert.equal("group" in graph.nodes.find((n) => n.id === ids.forge)!, false);

    p = apply(p, ungroup(p, graphId, g1));
    assert.deepEqual(saveProject(p), saveProject(project));
  });

  it("collapses, renames, and stores collapsed: false as no field", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const g = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine]), new Set(), { id: g, label: "A" }));
    p = apply(p, updateGroup(p, graphId, g, { collapsed: true }));
    assert.equal(graphOf(p).groups![0]!.collapsed, true);
    p = apply(p, updateGroup(p, graphId, g, { collapsed: false }));
    assert.equal("collapsed" in graphOf(p).groups![0]!, false);
    assert.equal(updateGroup(p, graphId, g, { collapsed: false }), null);
    assert.equal(updateGroup(p, graphId, g, { label: "" }), null);
    const rename = updateGroup(p, graphId, g, { label: "Mining" })!;
    assert.equal(rename.coalesceKey, `rename-group:${g}`);
  });

  it("removing a group removes its nodes and connections; emptied groups disappear", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const inner = newId();
    const outer = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine]), new Set(), { id: inner, label: "Inner" }));
    p = apply(p, groupElements(p, graphId, new Set([ids.smelt]), new Set([inner]), { id: outer, label: "Outer" }));

    const removed = apply(p, removeGraphElements(p, graphId, new Set(), new Set(), new Set([outer])));
    const graph = graphOf(removed);
    assert.equal(graph.groups, undefined);
    assert.equal(graph.nodes.length, 4);
    assert.ok(graph.edges.every((e) => e.source !== ids.smelt && e.target !== ids.smelt));

    // Deleting the only node of the inner group drops the inner group, keeps the outer one.
    const partial = graphOf(apply(p, removeGraphElements(p, graphId, new Set([ids.mine]), new Set())));
    assert.deepEqual(partial.groups!.map((g) => g.id), [outer]);
  });

  it("refuses groups beyond the nesting limit", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    let p = project;
    let last: Id | undefined;
    for (let level = 0; level < GRAPH_LIMITS.groupDepth; level++) {
      const id = newId();
      p = apply(p, groupElements(p, graphId, last === undefined ? new Set([ids.mine]) : new Set(), last === undefined ? new Set() : new Set([last]), { id, label: `L${level}` }));
      last = id;
    }
    assert.equal(Math.max(...groupStructure(graphOf(p)).depth.values()), GRAPH_LIMITS.groupDepth - 1);
    assert.equal(groupElements(p, graphId, new Set(), new Set([last!]), { id: newId(), label: "Too deep" }), null);
    assert.deepEqual(validateProject(p), []);
  });
});

describe("groups: drawing", () => {
  it("merges connections at a collapsed group and hides the ones inside it", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const g = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine, ids.coal, ids.smelt]), new Set(), { id: g, label: "Bars" }));
    p = apply(p, updateGroup(p, graphId, g, { collapsed: true }));
    const graph = graphOf(p);
    const structure = groupStructure(graph);
    assert.equal(structure.shownAs.get(ids.smelt), g);
    assert.equal(structure.shownAs.get(ids.forge), ids.forge);

    const catalog = compileCatalog(p, graph.recipes, graph.items);
    const net = compileNetwork(graph, catalog);
    const result = solveNetwork(net, "target");
    const edges = shownEdges(graph, structure, net, result);
    // mine→smelt and coal→smelt are inside; smelt→forge and smelt→slag leave the group.
    assert.equal(edges.length, 3);
    assert.ok(edges.every((e) => e.source !== ids.mine && e.target !== ids.smelt));
    assert.equal(edges.filter((e) => e.source === g).length, 2);
    assert.equal(edges.find((e) => e.source === g)!.edge, -1);

    const summary = summarizeCollapsed(graph, structure, net, result).get(g)!;
    assert.equal(summary.nodeCount, 3);
    assert.equal(summary.inputs.length, 0);
    assert.equal(summary.outputs.length, 2);
    const barRate = summary.outputs.find((o) => edges.some((e) => e.source === g && e.item === o.item && e.target === ids.forge))!.rate;
    assert.ok(Math.abs(barRate - 3 / 60) < 1e-9);
  });

  it("lays out a collapsed group as one unit and keeps member offsets", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const g = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine, ids.coal]), new Set(), { id: g, label: "Raw" }));
    p = apply(p, updateGroup(p, graphId, g, { collapsed: true }));
    const graph = graphOf(p);
    const before = new Map(graph.nodes.map((n) => [n.id, n.position]));
    const layout = autoLayout(graph);
    const dx = layout.get(ids.coal)!.x - layout.get(ids.mine)!.x;
    const dy = layout.get(ids.coal)!.y - layout.get(ids.mine)!.y;
    assert.equal(dx, before.get(ids.coal)!.x - before.get(ids.mine)!.x);
    assert.equal(dy, before.get(ids.coal)!.y - before.get(ids.mine)!.y);
    // The group (one unit at layer 0) comes before smelt.
    assert.ok(layout.get(ids.smelt)!.x > Math.min(layout.get(ids.mine)!.x, layout.get(ids.coal)!.x));
  });

  it("frames expanded groups around their members, nested frames inside outer ones", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const inner = newId();
    const outer = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine]), new Set(), { id: inner, label: "I" }));
    p = apply(p, groupElements(p, graphId, new Set([ids.smelt]), new Set([inner]), { id: outer, label: "O" }));
    const graph = graphOf(p);
    const geo = groupGeometry(graph, groupStructure(graph), () => ({ width: 100, height: 50 }));
    const i = geo.frames.get(inner)!;
    const o = geo.frames.get(outer)!;
    const mine = graph.nodes.find((n) => n.id === ids.mine)!.position;
    assert.ok(i.x < mine.x && i.y < mine.y && i.x + i.width > mine.x + 100);
    assert.ok(o.x < i.x && o.y < i.y && o.x + o.width > i.x + i.width && o.y + o.height > i.y + i.height);
    assert.equal(geo.collapsedAt.size, 0);
  });
});

describe("groups: files", () => {
  it("round-trips through save and load", () => {
    const { project, newId, ids } = setup();
    const graphId = graphOf(project).id;
    const g = newId();
    let p = apply(project, groupElements(project, graphId, new Set([ids.mine]), new Set(), { id: g, label: "Mining" }));
    p = apply(p, updateGroup(p, graphId, g, { collapsed: true }));
    const loaded = loadProject(saveProject(p));
    assert.ok(loaded.ok);
    assert.deepEqual(graphOf(loaded.value.project).groups, [{ id: g, label: "Mining", collapsed: true }]);
    assert.deepEqual(validateProject(p), []);
  });

  it("tolerates and reports broken structure from hand-edited files", () => {
    const { project, newId, ids } = setup();
    const graph = graphOf(project);
    const a = newId();
    const b = newId();
    const missing = newId();
    const groups: GraphGroup[] = [
      { id: a, label: "A", parent: b },
      { id: b, label: "B", parent: a },
    ];
    const broken: ProductionGraphAsset = {
      ...graph,
      groups,
      nodes: graph.nodes.map((n) => (n.id === ids.mine ? { ...n, group: a } : n.id === ids.coal ? { ...n, group: missing } : n)),
    };
    const p: Project = { ...project, assets: project.assets.map((x) => (x.id === graph.id ? broken : x)) };
    const structure = groupStructure(broken);
    // The loop is cut somewhere; every group still gets a depth.
    assert.equal(structure.depth.size, 2);
    assert.equal(structure.nodeGroup.has(ids.coal), false);
    const codes = validateProject(p).map((i) => i.code).sort();
    assert.deepEqual(codes, ["group-cycle", "group-missing"]);
  });
});
