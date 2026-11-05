/**
 * Typed edits on production graphs. Each returns a Change for the history, or null when
 * the edit is invalid or changes nothing.
 */
import type { Change, Patch } from "../history.ts";
import type { Id } from "../model/primitives.ts";
import type { Asset, Project } from "../model/project.ts";
import { MAX_ASSETS } from "../model/project.ts";
import { GRAPH_LIMITS, type GraphEdge, type GraphGroup, type GraphNode, type Position, type ProductionGraphAsset, type Scenario } from "../model/production-graph.ts";
import { keyAccepts, stackKey, type Catalog } from "./catalog.ts";
import { containerOf, descendantGroups, descendantNodes, groupStructure } from "./groups.ts";

function graphAt(project: Project, graphId: Id): { graph: ProductionGraphAsset; index: number } | null {
  const index = project.assets.findIndex((a) => a.id === graphId);
  const graph = project.assets[index];
  return graph?.kind === "production-graph" ? { graph, index } : null;
}

/** Adds several assets as one undo step (e.g. a graph together with its tables). */
export function addAssets(project: Project, assets: readonly Asset[], label: string): Change | null {
  if (assets.length === 0 || project.assets.length + assets.length > MAX_ASSETS) return null;
  return {
    label,
    patches: assets.map((value, i) => ({ op: "insert", path: ["assets"], index: project.assets.length + i, value })),
  };
}

/** Input port keys of a node: item ids, and "#tag" for tag inputs (catalog.stackKey). */
export function nodeInputs(node: GraphNode, catalog: Catalog): string[] {
  if (node.type === "source") return [];
  if (node.type === "recipe") return unique((catalog.recipes.get(node.recipe)?.inputs ?? []).map(stackKey));
  return [node.item];
}

/**
 * The input port `item` goes into on `node`: its own port if the node takes the item,
 * else the first tag port whose tag the item carries. Undefined if none accepts it.
 */
export function inputKeyFor(node: GraphNode, catalog: Catalog, item: Id): string | undefined {
  const keys = nodeInputs(node, catalog);
  if (keys.includes(item)) return item;
  return keys.find((k) => keyAccepts(catalog, k, item));
}

/** Items a node gives as output. */

export function nodeOutputs(node: GraphNode, catalog: Catalog): Id[] {
  if (node.type === "sink") return [];
  if (node.type === "recipe") return unique((catalog.recipes.get(node.recipe)?.outputs ?? []).map((s) => s.item));
  return [node.item];
}

function unique(ids: string[]): string[] {
  return ids.length < 2 ? ids : [...new Set(ids)];
}

/**
 * The live check of the editor: the item must be an output of `source` and accepted by an
 * input of `target` (the same item, or a tag the item carries).
 */
export function canConnect(graph: ProductionGraphAsset, catalog: Catalog, source: Id, target: Id, item: Id): boolean {
  if (source === target) return false;
  const s = graph.nodes.find((n) => n.id === source);
  const t = graph.nodes.find((n) => n.id === target);
  if (s === undefined || t === undefined) return false;
  if (!nodeOutputs(s, catalog).includes(item) || inputKeyFor(t, catalog, item) === undefined) return false;
  return !graph.edges.some((e) => e.source === source && e.target === target && e.item === item);
}

export function addNode(project: Project, graphId: Id, node: GraphNode): Change | null {
  const at = graphAt(project, graphId);
  if (at === null || at.graph.nodes.length >= GRAPH_LIMITS.nodes) return null;
  return { label: "add-node", patches: [{ op: "insert", path: ["assets", at.index, "nodes"], index: at.graph.nodes.length, value: node }] };
}

/** Replaces fields of a node (not id or type). Typing in a field coalesces into one step. */
export function updateNode(project: Project, graphId: Id, nodeId: Id, fields: Readonly<Record<string, unknown>>): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const i = at.graph.nodes.findIndex((n) => n.id === nodeId);
  if (i < 0) return null;
  const node = at.graph.nodes[i] as unknown as Record<string, unknown>;
  const patches: Patch[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "id" || key === "type" || node[key] === value) continue;
    patches.push({ op: "set", path: ["assets", at.index, "nodes", i, key], value });
  }
  if (patches.length === 0) return null;
  return { label: "edit-node", coalesceKey: `edit-node:${nodeId}:${Object.keys(fields).sort().join(",")}`, patches };
}

export function moveNodes(project: Project, graphId: Id, positions: ReadonlyMap<Id, Position>, label = "move-nodes"): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const patches: Patch[] = [];
  at.graph.nodes.forEach((node, i) => {
    const p = positions.get(node.id);
    if (p === undefined || (p.x === node.position.x && p.y === node.position.y)) return;
    const clamp = (v: number) => Math.max(-GRAPH_LIMITS.coordinate, Math.min(GRAPH_LIMITS.coordinate, Math.round(v)));
    patches.push({ op: "set", path: ["assets", at.index, "nodes", i, "position"], value: { x: clamp(p.x), y: clamp(p.y) } });
  });
  return patches.length === 0 ? null : { label, patches };
}

export function addEdge(project: Project, graphId: Id, edge: GraphEdge): Change | null {
  const at = graphAt(project, graphId);
  if (at === null || at.graph.edges.length >= GRAPH_LIMITS.edges) return null;
  return { label: "connect", patches: [{ op: "insert", path: ["assets", at.index, "edges"], index: at.graph.edges.length, value: edge }] };
}

export function setEdgeRatio(project: Project, graphId: Id, edgeId: Id, ratio: number | undefined): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const i = at.graph.edges.findIndex((e) => e.id === edgeId);
  if (i < 0 || at.graph.edges[i]!.ratio === ratio) return null;
  if (ratio !== undefined && !(ratio > 0 && ratio <= 1e6)) return null;
  return { label: "edit-connection", coalesceKey: `edit-connection:${edgeId}`, patches: [{ op: "set", path: ["assets", at.index, "edges", i, "ratio"], value: ratio }] };
}

/**
 * Removes nodes (with their connections), connections and groups (with everything inside
 * them), as one step. Groups left without any node are removed too.
 */
export function removeGraphElements(project: Project, graphId: Id, nodeIds: ReadonlySet<Id>, edgeIds: ReadonlySet<Id>, groupIds: ReadonlySet<Id> = new Set()): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const graph = at.graph;
  let removeNodes = nodeIds;
  if (groupIds.size > 0) {
    const structure = groupStructure(graph);
    const all = new Set(nodeIds);
    for (const g of groupIds) if (structure.groups.has(g)) for (const n of descendantNodes(structure, g)) all.add(n);
    removeNodes = all;
  }
  const patches: Patch[] = [];
  // Highest index first, so earlier indices stay valid.
  for (let i = graph.edges.length - 1; i >= 0; i--) {
    const e = graph.edges[i]!;
    if (edgeIds.has(e.id) || removeNodes.has(e.source) || removeNodes.has(e.target)) patches.push({ op: "remove", path: ["assets", at.index, "edges"], index: i });
  }
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    if (removeNodes.has(graph.nodes[i]!.id)) patches.push({ op: "remove", path: ["assets", at.index, "nodes"], index: i });
  }
  if (graph.groups !== undefined && (removeNodes.size > 0 || groupIds.size > 0)) {
    // Keep the groups that still contain a node, directly or through a child group.
    const structure = groupStructure(graph);
    const keep = new Set<Id>();
    for (const node of graph.nodes) {
      if (removeNodes.has(node.id)) continue;
      for (let g = structure.nodeGroup.get(node.id); g !== undefined && !keep.has(g); g = structure.parent.get(g)) keep.add(g);
    }
    const kept = graph.groups.filter((g) => keep.has(g.id));
    if (kept.length !== graph.groups.length) patches.push({ op: "set", path: ["assets", at.index, "groups"], value: kept.length === 0 ? undefined : kept });
  }
  return patches.length === 0 ? null : { label: "remove-graph-elements", patches };
}

// ---------------------------------------------------------------------------------------
// Groups (sub-chains, see groups.ts)
// ---------------------------------------------------------------------------------------

/**
 * The group that would contain a new group made of these nodes and groups: all of them
 * must sit in the same group (or all at the top level). `null` when they do not, or when
 * nothing usable is selected.
 */
export function commonContainer(graph: ProductionGraphAsset, nodeIds: Iterable<Id>, groupIds: Iterable<Id>): { container: Id | undefined } | null {
  const structure = groupStructure(graph);
  const nodes = new Set(graph.nodes.map((n) => n.id));
  let first = true;
  let container: Id | undefined;
  const visit = (id: Id): boolean => {
    const c = containerOf(structure, id);
    if (first) {
      first = false;
      container = c;
      return true;
    }
    return c === container;
  };
  for (const id of nodeIds) if (!nodes.has(id) || !visit(id)) return null;
  for (const id of groupIds) if (!structure.groups.has(id) || !visit(id)) return null;
  return first ? null : { container };
}

/** Puts nodes and groups that share one container into a new group, as one step. */
export function groupElements(project: Project, graphId: Id, nodeIds: ReadonlySet<Id>, groupIds: ReadonlySet<Id>, group: { readonly id: Id; readonly label: string }): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const graph = at.graph;
  const groups = graph.groups ?? [];
  if (groups.length >= GRAPH_LIMITS.groups || groups.some((g) => g.id === group.id)) return null;
  const common = commonContainer(graph, nodeIds, groupIds);
  if (common === null) return null;
  const structure = groupStructure(graph);
  if (common.container !== undefined && structure.depth.get(common.container)! + 1 >= GRAPH_LIMITS.groupDepth) return null;
  // The moved groups go one level deeper; their deepest descendant must stay in the limit.
  for (const g of groupIds) {
    const base = structure.depth.get(g)!;
    for (const d of descendantGroups(structure, g)) if (structure.depth.get(d)! - base + (common.container === undefined ? 1 : structure.depth.get(common.container)! + 2) >= GRAPH_LIMITS.groupDepth) return null;
  }

  const base = ["assets", at.index] as const;
  const created: GraphGroup = common.container === undefined ? { id: group.id, label: group.label } : { id: group.id, label: group.label, parent: common.container };
  const patches: Patch[] = [];
  if (graph.groups === undefined) patches.push({ op: "set", path: [...base, "groups"], value: [created] });
  else {
    graph.groups.forEach((g, i) => {
      if (groupIds.has(g.id)) patches.push({ op: "set", path: [...base, "groups", i, "parent"], value: group.id });
    });
    patches.push({ op: "insert", path: [...base, "groups"], index: graph.groups.length, value: created });
  }
  graph.nodes.forEach((n, i) => {
    if (nodeIds.has(n.id)) patches.push({ op: "set", path: [...base, "nodes", i, "group"], value: group.id });
  });
  return { label: "group", patches };
}

/** Dissolves a group: its members and child groups move to the enclosing group. */
export function ungroup(project: Project, graphId: Id, groupId: Id): Change | null {
  const at = graphAt(project, graphId);
  if (at === null || at.graph.groups === undefined) return null;
  const graph = at.graph;
  const groups = at.graph.groups;
  const index = groups.findIndex((g) => g.id === groupId);
  if (index < 0) return null;
  const structure = groupStructure(graph);
  const up = structure.parent.get(groupId);
  const base = ["assets", at.index] as const;
  const patches: Patch[] = [];
  graph.nodes.forEach((n, i) => {
    if (n.group === groupId) patches.push({ op: "set", path: [...base, "nodes", i, "group"], value: up });
  });
  if (groups.length === 1) {
    patches.push({ op: "set", path: [...base, "groups"], value: undefined });
  } else {
    groups.forEach((g, i) => {
      if (g.parent === groupId) patches.push({ op: "set", path: [...base, "groups", i, "parent"], value: up });
    });
    patches.push({ op: "remove", path: [...base, "groups"], index });
  }
  return { label: "ungroup", patches };
}

/** Renames a group or collapses / expands it. `collapsed: false` is stored as no field. */
export function updateGroup(project: Project, graphId: Id, groupId: Id, fields: { readonly label?: string; readonly collapsed?: boolean }): Change | null {
  const at = graphAt(project, graphId);
  if (at === null || at.graph.groups === undefined) return null;
  const i = at.graph.groups.findIndex((g) => g.id === groupId);
  if (i < 0) return null;
  const group = at.graph.groups[i]!;
  const path = ["assets", at.index, "groups", i] as const;
  const patches: Patch[] = [];
  if (fields.label !== undefined && fields.label !== group.label && fields.label.length >= 1 && fields.label.length <= 200) {
    patches.push({ op: "set", path: [...path, "label"], value: fields.label });
  }
  if (fields.collapsed !== undefined && fields.collapsed !== (group.collapsed === true)) {
    patches.push({ op: "set", path: [...path, "collapsed"], value: fields.collapsed ? true : undefined });
  }
  if (patches.length === 0) return null;
  if (fields.label !== undefined && fields.collapsed === undefined) return { label: "rename-group", coalesceKey: `rename-group:${groupId}`, patches };
  return { label: fields.collapsed === true ? "collapse-group" : fields.collapsed === false ? "expand-group" : "edit-group", patches };
}

// ---------------------------------------------------------------------------------------
// Scenario (saved what-if variable values, see gates.ts)
// ---------------------------------------------------------------------------------------

/** An empty scenario is stored as no field at all, so untouched chains stay unchanged. */
function setScenario(index: number, next: Scenario, label: string, coalesceKey?: string): Change {
  const empty = Object.keys(next.values).length === 0 && next.allOpen !== true;
  const value: Scenario | undefined = empty ? undefined : next.allOpen === true ? next : { values: next.values };
  const change: Change = { label, patches: [{ op: "set", path: ["assets", index, "scenario"], value }] };
  return coalesceKey === undefined ? change : { ...change, coalesceKey };
}

/** Sets (or with `undefined`, clears) the scenario value of one variable. */
export function setScenarioValue(project: Project, graphId: Id, variableId: Id, value: boolean | number | string | undefined): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const prev = at.graph.scenario ?? { values: {} };
  const had = Object.hasOwn(prev.values, variableId);
  if (value === undefined ? !had : had && prev.values[variableId] === value) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const values = { ...prev.values };
  if (value === undefined) delete values[variableId];
  else values[variableId] = value;
  return setScenario(at.index, { ...prev, values }, "edit-scenario", `scenario:${graphId}:${variableId}`);
}

export function setScenarioAllOpen(project: Project, graphId: Id, allOpen: boolean): Change | null {
  const at = graphAt(project, graphId);
  if (at === null || (at.graph.scenario?.allOpen === true) === allOpen) return null;
  return setScenario(at.index, { values: at.graph.scenario?.values ?? {}, allOpen }, "edit-scenario");
}

/** Back to start values (keeps "all gates open"). */
export function resetScenario(project: Project, graphId: Id): Change | null {
  const at = graphAt(project, graphId);
  if (at === null || at.graph.scenario === undefined || Object.keys(at.graph.scenario.values).length === 0) return null;
  return setScenario(at.index, { ...at.graph.scenario, values: {} }, "reset-scenario");
}
