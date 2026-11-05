/**
 * Typed edits on production graphs. Each returns a Change for the history, or null when
 * the edit is invalid or changes nothing.
 */
import type { Change, Patch } from "../history.ts";
import type { Id } from "../model/primitives.ts";
import type { Asset, Project } from "../model/project.ts";
import { MAX_ASSETS } from "../model/project.ts";
import { GRAPH_LIMITS, type GraphEdge, type GraphNode, type Position, type ProductionGraphAsset, type Scenario } from "../model/production-graph.ts";
import type { Catalog } from "./catalog.ts";

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

/** Items a node takes as input / gives as output. */
export function nodeInputs(node: GraphNode, catalog: Catalog): Id[] {
  if (node.type === "source") return [];
  if (node.type === "recipe") return unique((catalog.recipes.get(node.recipe)?.inputs ?? []).map((s) => s.item));
  return [node.item];
}

export function nodeOutputs(node: GraphNode, catalog: Catalog): Id[] {
  if (node.type === "sink") return [];
  if (node.type === "recipe") return unique((catalog.recipes.get(node.recipe)?.outputs ?? []).map((s) => s.item));
  return [node.item];
}

function unique(ids: Id[]): Id[] {
  return ids.length < 2 ? ids : [...new Set(ids)];
}

/** The live check of the editor: the item must be an output of `source` and an input of `target`. */
export function canConnect(graph: ProductionGraphAsset, catalog: Catalog, source: Id, target: Id, item: Id): boolean {
  if (source === target) return false;
  const s = graph.nodes.find((n) => n.id === source);
  const t = graph.nodes.find((n) => n.id === target);
  if (s === undefined || t === undefined) return false;
  if (!nodeOutputs(s, catalog).includes(item) || !nodeInputs(t, catalog).includes(item)) return false;
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

/** Removes nodes (with their connections) and connections, as one step. */
export function removeGraphElements(project: Project, graphId: Id, nodeIds: ReadonlySet<Id>, edgeIds: ReadonlySet<Id>): Change | null {
  const at = graphAt(project, graphId);
  if (at === null) return null;
  const patches: Patch[] = [];
  // Highest index first, so earlier indices stay valid.
  for (let i = at.graph.edges.length - 1; i >= 0; i--) {
    const e = at.graph.edges[i]!;
    if (edgeIds.has(e.id) || nodeIds.has(e.source) || nodeIds.has(e.target)) patches.push({ op: "remove", path: ["assets", at.index, "edges"], index: i });
  }
  for (let i = at.graph.nodes.length - 1; i >= 0; i--) {
    if (nodeIds.has(at.graph.nodes[i]!.id)) patches.push({ op: "remove", path: ["assets", at.index, "nodes"], index: i });
  }
  return patches.length === 0 ? null : { label: "remove-graph-elements", patches };
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
