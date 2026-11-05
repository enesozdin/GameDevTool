/**
 * Flattens a production graph into typed arrays for the solver and the Monte Carlo runs.
 * Compiled once per edit; solving then allocates nothing per node or edge.
 *
 * Every node is a process with an activity level a ≥ 0 and per-port coefficients:
 *   source      out[item] = 1                 a = items/s
 *   recipe      in[i] = count, out[o] = count × chance   a = cycles/s
 *   pass-through (storage, splitter, merger, gate): in[item] = out[item] = 1
 *   sink        in[item] = 1                  a = items/s
 * A port is (node, item). Connections that do not match a port are left out (validation
 * reports them) and carry no flow.
 */
import type { Id } from "../model/primitives.ts";
import type { GraphNode, ProductionGraphAsset } from "../model/production-graph.ts";
import { cycleSeconds, expectedCount, type Catalog } from "./catalog.ts";
import { adjacency, stronglyConnected } from "./scc.ts";

export const NodeKind = { source: 0, recipe: 1, pass: 2, sink: 3 } as const;
export type NodeKindCode = (typeof NodeKind)[keyof typeof NodeKind];

export interface Network {
  readonly graph: ProductionGraphAsset;
  readonly nodeCount: number;
  readonly kind: Uint8Array;
  /** Input ports of node n: inStart[n] .. inStart[n+1]-1. */
  readonly inStart: Int32Array;
  readonly inItem: readonly Id[];
  readonly inCoef: Float64Array;
  readonly outStart: Int32Array;
  readonly outItem: readonly Id[];
  /** Expected count per unit of activity. */
  readonly outCoef: Float64Array;
  /** Chance per cycle (1 for guaranteed outputs). */
  readonly outChance: Float64Array;
  /** Edges of input port p: inEdgeStart[p] .. inEdgeStart[p+1]-1 into inEdges (edge indices). */
  readonly inEdgeStart: Int32Array;
  readonly inEdges: Int32Array;
  readonly outEdgeStart: Int32Array;
  readonly outEdges: Int32Array;
  /** Per graph edge: source/target node index, ports, weight; -1 ports = not in the network. */
  readonly edgeSource: Int32Array;
  readonly edgeTarget: Int32Array;
  readonly edgeOutPort: Int32Array;
  readonly edgeInPort: Int32Array;
  readonly edgeWeight: Float64Array;
  /** Seconds per cycle on the machine (recipe nodes); NaN if unknown. */
  readonly cycleTime: Float64Array;
  /** Built machines (recipe nodes); NaN if not set. */
  readonly machineCap: Float64Array;
  /** Source supply / sink demand in items/s; NaN if not set. */
  readonly rate: Float64Array;
  /** Node indices, producers before consumers where possible (see order()). */
  readonly topo: Int32Array;
  /** Strongly connected component of each node; nodes on one loop share a component. */
  readonly component: Int32Array;
  readonly nodeIndex: ReadonlyMap<Id, number>;
}

interface Port {
  readonly item: Id;
  readonly coef: number;
  readonly chance: number;
}

function portsOf(node: GraphNode, catalog: Catalog): { inputs: Port[]; outputs: Port[]; kind: NodeKindCode } {
  switch (node.type) {
    case "source":
      return { kind: NodeKind.source, inputs: [], outputs: [{ item: node.item, coef: 1, chance: 1 }] };
    case "sink":
      return { kind: NodeKind.sink, inputs: [{ item: node.item, coef: 1, chance: 1 }], outputs: [] };
    case "recipe": {
      const recipe = catalog.recipes.get(node.recipe);
      if (recipe === undefined) return { kind: NodeKind.recipe, inputs: [], outputs: [] };
      return {
        kind: NodeKind.recipe,
        inputs: mergePorts(recipe.inputs.map((s) => ({ item: s.item, coef: s.count, chance: 1 }))),
        outputs: mergePorts(recipe.outputs.map((s) => ({ item: s.item, coef: expectedCount(s), chance: s.chance ?? 1 }))),
      };
    }
    default:
      return { kind: NodeKind.pass, inputs: [{ item: node.item, coef: 1, chance: 1 }], outputs: [{ item: node.item, coef: 1, chance: 1 }] };
  }
}

/** The same item twice in one recipe side becomes one port (validation warns about it). */
function mergePorts(ports: Port[]): Port[] {
  if (ports.length < 2) return ports;
  const byItem = new Map<Id, Port>();
  for (const p of ports) {
    const prev = byItem.get(p.item);
    byItem.set(p.item, prev === undefined ? p : { item: p.item, coef: prev.coef + p.coef, chance: Math.max(prev.chance, p.chance) });
  }
  return [...byItem.values()];
}

export function compileNetwork(graph: ProductionGraphAsset, catalog: Catalog): Network {
  const n = graph.nodes.length;
  const kind = new Uint8Array(n);
  const inStart = new Int32Array(n + 1);
  const outStart = new Int32Array(n + 1);
  const inItem: Id[] = [];
  const outItem: Id[] = [];
  const inCoefs: number[] = [];
  const outCoefs: number[] = [];
  const outChances: number[] = [];
  const cycleTime = new Float64Array(n).fill(NaN);
  const machineCap = new Float64Array(n).fill(NaN);
  const rate = new Float64Array(n).fill(NaN);
  const nodeIndex = new Map<Id, number>();
  /** Port lookup "node:item" → port index. */
  const inPortOf = new Map<string, number>();
  const outPortOf = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i]!;
    nodeIndex.set(node.id, i);
    const { inputs, outputs, kind: k } = portsOf(node, catalog);
    kind[i] = k;
    inStart[i] = inItem.length;
    outStart[i] = outItem.length;
    for (const p of inputs) {
      inPortOf.set(`${i}:${p.item}`, inItem.length);
      inItem.push(p.item);
      inCoefs.push(p.coef);
    }
    for (const p of outputs) {
      outPortOf.set(`${i}:${p.item}`, outItem.length);
      outItem.push(p.item);
      outCoefs.push(p.coef);
      outChances.push(p.chance);
    }
    if (node.type === "recipe") {
      const recipe = catalog.recipes.get(node.recipe);
      const t = recipe === undefined ? undefined : cycleSeconds(recipe);
      if (t !== undefined) cycleTime[i] = t;
      if (node.machines !== undefined) machineCap[i] = node.machines;
    } else if (node.type === "source") {
      rate[i] = node.rate;
    } else if (node.type === "sink" && node.rate !== undefined) {
      rate[i] = node.rate;
    }
  }
  inStart[n] = inItem.length;
  outStart[n] = outItem.length;

  const m = graph.edges.length;
  const edgeSource = new Int32Array(m).fill(-1);
  const edgeTarget = new Int32Array(m).fill(-1);
  const edgeOutPort = new Int32Array(m).fill(-1);
  const edgeInPort = new Int32Array(m).fill(-1);
  const edgeWeight = new Float64Array(m);
  const inCount = new Int32Array(inItem.length);
  const outCount = new Int32Array(outItem.length);
  for (let e = 0; e < m; e++) {
    const edge = graph.edges[e]!;
    const s = nodeIndex.get(edge.source);
    const t = nodeIndex.get(edge.target);
    if (s === undefined || t === undefined || s === t) continue;
    const op = outPortOf.get(`${s}:${edge.item}`);
    const ip = inPortOf.get(`${t}:${edge.item}`);
    if (op === undefined || ip === undefined) continue;
    edgeSource[e] = s;
    edgeTarget[e] = t;
    edgeOutPort[e] = op;
    edgeInPort[e] = ip;
    edgeWeight[e] = edge.ratio ?? 1;
    outCount[op]!++;
    inCount[ip]!++;
  }

  const inEdgeStart = prefix(inCount);
  const outEdgeStart = prefix(outCount);
  const inEdges = new Int32Array(inEdgeStart[inEdgeStart.length - 1]!);
  const outEdges = new Int32Array(outEdgeStart[outEdgeStart.length - 1]!);
  const inFill = inEdgeStart.slice(0, -1);
  const outFill = outEdgeStart.slice(0, -1);
  for (let e = 0; e < m; e++) {
    if (edgeInPort[e]! < 0) continue;
    inEdges[inFill[edgeInPort[e]!]!++] = e;
    outEdges[outFill[edgeOutPort[e]!]!++] = e;
  }

  return {
    graph,
    nodeCount: n,
    kind,
    inStart,
    inItem,
    inCoef: Float64Array.from(inCoefs),
    outStart,
    outItem,
    outCoef: Float64Array.from(outCoefs),
    outChance: Float64Array.from(outChances),
    inEdgeStart,
    inEdges,
    outEdgeStart,
    outEdges,
    edgeSource,
    edgeTarget,
    edgeOutPort,
    edgeInPort,
    edgeWeight,
    cycleTime,
    machineCap,
    rate,
    ...orderAndComponents(n, edgeSource, edgeTarget),
    nodeIndex,
  };
}

function prefix(counts: Int32Array): Int32Array {
  const start = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) start[i + 1] = start[i]! + counts[i]!;
  return start;
}

/**
 * Producers before consumers (Kahn). Nodes on cycles cannot be ordered; they are appended
 * in index order and the solver iterates until the flows settle.
 */
function orderAndComponents(n: number, source: Int32Array, target: Int32Array): { topo: Int32Array; component: Int32Array } {
  const { adjStart: outStart, adj } = adjacency(n, source, target);
  const indegree = new Int32Array(n);
  for (let e = 0; e < source.length; e++) if (source[e]! >= 0) indegree[target[e]!]!++;

  const result = new Int32Array(n);
  const placed = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (indegree[i] === 0) result[tail++] = i;
  while (head < tail) {
    const u = result[head++]!;
    placed[u] = 1;
    for (let k = outStart[u]!; k < outStart[u + 1]!; k++) {
      const v = adj[k]!;
      if (--indegree[v]! === 0) result[tail++] = v;
    }
  }
  for (let i = 0; i < n; i++) if (placed[i] === 0) result[tail++] = i;
  return { topo: result, component: stronglyConnected(n, outStart, adj).component };
}
