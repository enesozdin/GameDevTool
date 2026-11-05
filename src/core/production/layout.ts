/**
 * Automatic left-to-right layout (IDEF0: inputs enter left, outputs leave right).
 * Layers by longest path from the producers; loops are broken at back edges. Within a
 * layer, nodes are ordered by the average row of their predecessors (one barycenter pass),
 * which removes most crossings in typical production chains. O(nodes + edges · log).
 * A collapsed group is laid out as one unit; its members move with it and keep their
 * relative positions.
 */
import type { Id } from "../model/primitives.ts";
import type { Position, ProductionGraphAsset } from "../model/production-graph.ts";
import { groupStructure } from "./groups.ts";
import { adjacency } from "./scc.ts";

export const LAYOUT_SPACING = { x: 300, y: 150 } as const;

export function autoLayout(graph: ProductionGraphAsset): Map<Id, Position> {
  // Units: what each node is shown as (itself, or its outermost collapsed group).
  const structure = groupStructure(graph);
  const unitIds: Id[] = [];
  const index = new Map<Id, number>();
  /** Per unit: top-left of its member nodes (collapsed groups) or the node position. */
  const corner: { x: number; y: number }[] = [];
  const unitOfNode = new Int32Array(graph.nodes.length);
  graph.nodes.forEach((node, i) => {
    const unit = structure.shownAs.get(node.id) ?? node.id;
    let u = index.get(unit);
    if (u === undefined) {
      u = unitIds.length;
      index.set(unit, u);
      unitIds.push(unit);
      corner.push({ x: node.position.x, y: node.position.y });
    } else {
      const c = corner[u]!;
      c.x = Math.min(c.x, node.position.x);
      c.y = Math.min(c.y, node.position.y);
    }
    unitOfNode[i] = u;
  });
  const nodeIndex = new Map<Id, number>();
  graph.nodes.forEach((node, i) => nodeIndex.set(node.id, i));
  const n = unitIds.length;
  const source = new Int32Array(graph.edges.length).fill(-1);
  const target = new Int32Array(graph.edges.length).fill(-1);
  graph.edges.forEach((edge, e) => {
    const si = nodeIndex.get(edge.source);
    const ti = nodeIndex.get(edge.target);
    const s = si === undefined ? undefined : unitOfNode[si];
    const t = ti === undefined ? undefined : unitOfNode[ti];
    if (s !== undefined && t !== undefined && s !== t) {
      source[e] = s;
      target[e] = t;
    }
  });
  const { adjStart, adj } = adjacency(n, source, target);

  // DFS from roots in index order classifies back edges; the rest is a DAG.
  const state = new Uint8Array(n); // 0 new, 1 on stack, 2 done
  const order: number[] = [];
  const back = new Set<number>(); // encoded u * n + v
  const stackNode: number[] = [];
  const stackEdge: number[] = [];
  const indegree = new Int32Array(n);
  for (let k = 0; k < adj.length; k++) indegree[adj[k]!]!++;
  const roots = [...Array(n).keys()].sort((a, b) => (indegree[a] === 0 ? 0 : 1) - (indegree[b] === 0 ? 0 : 1));
  for (const root of roots) {
    if (state[root] !== 0) continue;
    stackNode.push(root);
    stackEdge.push(adjStart[root]!);
    state[root] = 1;
    while (stackNode.length > 0) {
      const top = stackNode.length - 1;
      const u = stackNode[top]!;
      const k = stackEdge[top]!;
      if (k < adjStart[u + 1]!) {
        stackEdge[top] = k + 1;
        const v = adj[k]!;
        if (state[v] === 0) {
          state[v] = 1;
          stackNode.push(v);
          stackEdge.push(adjStart[v]!);
        } else if (state[v] === 1) {
          back.add(u * n + v);
        }
      } else {
        state[u] = 2;
        order.push(u);
        stackNode.pop();
        stackEdge.pop();
      }
    }
  }
  order.reverse(); // topological order of the DAG without back edges

  const layer = new Int32Array(n);
  for (const u of order) {
    for (let k = adjStart[u]!; k < adjStart[u + 1]!; k++) {
      const v = adj[k]!;
      if (!back.has(u * n + v) && layer[u]! + 1 > layer[v]!) layer[v] = layer[u]! + 1;
    }
  }

  // Predecessor lists for the barycenter pass.
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) {
    for (let k = adjStart[u]!; k < adjStart[u + 1]!; k++) if (!back.has(u * n + adj[k]!)) preds[adj[k]!]!.push(u);
  }
  const layers: number[][] = [];
  for (const u of order) (layers[layer[u]!] ??= []).push(u);
  const row = new Float64Array(n);
  const unitAt: Position[] = new Array<Position>(n);
  layers.forEach((nodes, l) => {
    if (l > 0) {
      const key = new Map<number, number>();
      for (const u of nodes) {
        const p = preds[u]!;
        key.set(u, p.length === 0 ? Infinity : p.reduce((sum, v) => sum + row[v]!, 0) / p.length);
      }
      nodes.sort((a, b) => key.get(a)! - key.get(b)! || a - b);
    }
    nodes.forEach((u, i) => {
      row[u] = i;
      unitAt[u] = { x: l * LAYOUT_SPACING.x, y: i * LAYOUT_SPACING.y };
    });
  });
  const positions = new Map<Id, Position>();
  graph.nodes.forEach((node, i) => {
    const u = unitOfNode[i]!;
    const at = unitAt[u]!;
    const c = corner[u]!;
    positions.set(node.id, { x: at.x + node.position.x - c.x, y: at.y + node.position.y - c.y });
  });
  return positions;
}
