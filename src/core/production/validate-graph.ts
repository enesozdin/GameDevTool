/**
 * Production graph checks (ROADMAP §4.1 "Validation"): typed connections, unconnected
 * inputs, loops with no source, unreachable nodes, recipes without a usable cycle time,
 * gate conditions and recipes unlocked before their inputs.
 * Missing rows and tables are reported by the reference index as broken references.
 */
import type { Issue, IssuePath } from "../result.ts";
import type { Id } from "../model/primitives.ts";
import type { Asset, Project } from "../model/project.ts";
import { GRAPH_LIMITS, type ProductionGraphAsset } from "../model/production-graph.ts";
import { compileCatalog, type Catalog } from "./catalog.ts";
import { compileNetwork, inputPortOf, NodeKind } from "./network.ts";
import { adjacency, stronglyConnected } from "./scc.ts";
import { ConditionCompiler, exprIssue } from "../expr/conditions.ts";
import { checkUnlockOrder } from "./unlocks.ts";
import { fitsVariable } from "./gates.ts";
import { groupStructure } from "./groups.ts";

export function validateProductionGraph(
  project: Project,
  graph: ProductionGraphAsset,
  assetIndex: number,
  assets: ReadonlyMap<Id, Asset>,
  issues: Issue[],
  conditions: ConditionCompiler = new ConditionCompiler(project.manifest.variables),
): void {
  const base: IssuePath = ["assets", assetIndex];
  const roleOf = (id: Id) => {
    const a = assets.get(id);
    return a?.kind === "table" ? a.role?.kind : undefined;
  };
  for (const [field, expected] of [
    ["items", "items"],
    ["recipes", "recipes"],
  ] as const) {
    const table = assets.get(graph[field]);
    if (table !== undefined && roleOf(graph[field]) !== expected) {
      issues.push({ severity: "error", code: "role-mismatch", path: [...base, field], params: { expected } });
    }
  }

  const catalog = compileCatalog(project, graph.recipes, graph.items);
  if (catalog.recipesTable?.role?.kind === "recipes") {
    const inputs = catalog.recipesTable.columns.find((c) => c.id === (catalog.recipesTable!.role as { inputs: Id }).inputs);
    if (inputs?.type.kind === "stacks" && inputs.type.table !== graph.items) {
      issues.push({ severity: "error", code: "graph-items-mismatch", path: [...base, "items"] });
    }
  }
  const net = compileNetwork(graph, catalog);
  const n = graph.nodes.length;

  // Connections
  const seen = new Set<string>();
  graph.edges.forEach((edge, e) => {
    const path: IssuePath = [...base, "edges", e];
    const s = net.nodeIndex.get(edge.source);
    const t = net.nodeIndex.get(edge.target);
    if (s === undefined || t === undefined) {
      issues.push({ severity: "error", code: "edge-node-missing", path });
      return;
    }
    if (s === t) {
      issues.push({ severity: "error", code: "edge-self", path });
      return;
    }
    const key = `${edge.source}>${edge.target}:${edge.item}`;
    if (seen.has(key)) issues.push({ severity: "warning", code: "duplicate-edge", path });
    seen.add(key);
    if (!hasPort(net.outItem, net.outStart, s, edge.item)) {
      issues.push({ severity: "error", code: "port-mismatch", path: [...path, "item"], params: { side: "output" } });
    }
    if (inputPortOf(net, catalog, t, edge.item) < 0) {
      issues.push({ severity: "error", code: "port-mismatch", path: [...path, "item"], params: { side: "input" } });
    }
  });

  // Nodes
  graph.nodes.forEach((node, i) => {
    const path: IssuePath = [...base, "nodes", i];
    if (node.type === "recipe") {
      const recipe = catalog.recipes.get(node.recipe);
      if (recipe === undefined) return;
      if (recipe.time === undefined) issues.push({ severity: "error", code: "recipe-time-invalid", path: [...path, "recipe"] });
      if (recipe.outputs.length === 0) issues.push({ severity: "warning", code: "recipe-no-outputs", path: [...path, "recipe"] });
    } else if (node.type === "gate") {
      if (node.condition.trim() === "") {
        issues.push({ severity: "warning", code: "gate-condition-empty", path: [...path, "condition"] });
      } else {
        const c = conditions.compile(node.condition);
        if (!c.ok) issues.push(exprIssue([...path, "condition"], c.error));
      }
    }
    for (let q = net.inStart[i]!; q < net.inStart[i + 1]!; q++) {
      if (net.inEdgeStart[q] === net.inEdgeStart[q + 1]) {
        issues.push({ severity: "warning", code: "input-unconnected", path, params: { item: net.inItem[q]! } });
      }
    }
  });

  // Loops with no way in, and nodes no producer reaches.
  const { adjStart, adj } = adjacency(n, net.edgeSource, net.edgeTarget);
  const { component, count, cyclic } = stronglyConnected(n, adjStart, adj);
  const fed = new Uint8Array(count);
  const isProducer = (u: number) => net.kind[u] === NodeKind.source || (net.kind[u] === NodeKind.recipe && net.inStart[u] === net.inStart[u + 1]);
  for (let u = 0; u < n; u++) {
    if (isProducer(u)) fed[component[u]!] = 1;
    for (let k = adjStart[u]!; k < adjStart[u + 1]!; k++) {
      const v = adj[k]!;
      if (component[v] !== component[u]) fed[component[v]!] = 1;
    }
  }
  const reported = new Uint8Array(count);
  const sourceless = new Uint8Array(n);
  for (let u = 0; u < n; u++) {
    const c = component[u]!;
    if (cyclic[c] === 1 && fed[c] === 0) {
      sourceless[u] = 1;
      if (reported[c] === 0) {
        reported[c] = 1;
        issues.push({ severity: "error", code: "loop-without-source", path: [...base, "nodes", u] });
      }
    }
  }

  const reached = new Uint8Array(n);
  const queue: number[] = [];
  for (let u = 0; u < n; u++) {
    if (isProducer(u)) {
      reached[u] = 1;
      queue.push(u);
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h]!;
    for (let k = adjStart[u]!; k < adjStart[u + 1]!; k++) {
      const v = adj[k]!;
      if (reached[v] === 0) {
        reached[v] = 1;
        queue.push(v);
      }
    }
  }
  for (let u = 0; u < n; u++) {
    // Nodes without any incoming connection already get "input-unconnected".
    const hasIncoming = net.inEdgeStart[net.inStart[u]!] !== net.inEdgeStart[net.inStart[u + 1]!];
    if (reached[u] === 0 && sourceless[u] === 0 && hasIncoming) {
      issues.push({ severity: "warning", code: "unreachable", path: [...base, "nodes", u] });
    }
  }

  checkUnlockOrder(graph, catalog, net, conditions, base, issues);
  if (graph.groups !== undefined || graph.nodes.some((node) => node.group !== undefined)) checkGroups(graph, base, issues);

  if (graph.calculator?.recipes !== undefined) checkCalculator(graph, catalog, base, issues);

  // Saved scenario values: the solver ignores the ones that do not fit.
  if (graph.scenario !== undefined) {
    const variables = new Map(project.manifest.variables.map((v) => [v.id, v]));
    for (const [id, value] of Object.entries(graph.scenario.values)) {
      const variable = variables.get(id);
      const path: IssuePath = [...base, "scenario", "values", id];
      if (variable === undefined) issues.push({ severity: "warning", code: "scenario-unknown-variable", path });
      else if (!fitsVariable(variable, value)) issues.push({ severity: "warning", code: "scenario-type-mismatch", path, params: { name: variable.name } });
    }
  }
}

/**
 * Saved calculator recipe choices that no longer fit (the recipe stopped making the item).
 * Missing rows are already broken references; the calculator ignores both.
 */
function checkCalculator(graph: ProductionGraphAsset, catalog: Catalog, base: IssuePath, issues: Issue[]): void {
  for (const [item, recipeId] of Object.entries(graph.calculator?.recipes ?? {})) {
    const recipe = catalog.recipes.get(recipeId);
    if (recipe !== undefined && !recipe.outputs.some((o) => o.item === item)) {
      issues.push({ severity: "warning", code: "calculator-recipe-mismatch", path: [...base, "calculator", "recipes", item], params: { name: recipe.name } });
    }
  }
}

/** Broken group structure; groupStructure() treats the affected parts as top level. */
function checkGroups(graph: ProductionGraphAsset, base: IssuePath, issues: Issue[]): void {
  const structure = groupStructure(graph);
  const nonEmpty = new Set<string>();
  for (const start of structure.nodeGroup.values()) {
    for (let g: string | undefined = start; g !== undefined && !nonEmpty.has(g); g = structure.parent.get(g)) nonEmpty.add(g);
  }
  graph.nodes.forEach((node, i) => {
    if (node.group !== undefined && !structure.groups.has(node.group)) issues.push({ severity: "error", code: "group-missing", path: [...base, "nodes", i, "group"] });
  });
  (graph.groups ?? []).forEach((group, i) => {
    const path: IssuePath = [...base, "groups", i];
    if (group.parent !== undefined && structure.parent.get(group.id) !== group.parent) {
      if (!structure.groups.has(group.parent)) issues.push({ severity: "error", code: "group-missing", path: [...path, "parent"] });
      else if (onLoop(graph, group.id)) issues.push({ severity: "error", code: "group-cycle", path: [...path, "parent"] });
      else issues.push({ severity: "error", code: "group-too-deep", path: [...path, "parent"], params: { limit: GRAPH_LIMITS.groupDepth } });
    }
    if (structure.groups.get(group.id) === group && !nonEmpty.has(group.id)) {
      issues.push({ severity: "warning", code: "group-empty", path });
    }
  });
}

/** Whether following `parent` links from `id` comes back to it. */
function onLoop(graph: ProductionGraphAsset, id: string): boolean {
  const parents = new Map((graph.groups ?? []).map((g) => [g.id, g.parent]));
  let at = parents.get(id);
  for (let steps = 0; at !== undefined && steps <= parents.size; steps++) {
    if (at === id) return true;
    at = parents.get(at);
  }
  return false;
}

function hasPort(items: readonly Id[], start: Int32Array, node: number, item: Id): boolean {
  for (let p = start[node]!; p < start[node + 1]!; p++) if (items[p] === item) return true;
  return false;
}
