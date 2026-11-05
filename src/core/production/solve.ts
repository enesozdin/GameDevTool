/**
 * Steady-state rate solver for a compiled production network (ROADMAP §4.1).
 *
 * Target-driven ("target"): sink rates are demands. Demand flows upstream: each node runs
 * just fast enough for its most demanded output; by-products that nobody asks for become
 * surplus. Source rates are capacities (0 = unlimited); exceeding one is a deficit.
 *
 * Supply-driven ("supply"): source rates are fixed supplies. Flow moves downstream: each
 * recipe runs as fast as its scarcest input (and its built machines, if set) allows. The
 * limiting factor of each node is recorded, and bottlenecks are found by following limits
 * upstream from the sinks.
 *
 * Splitting rules (MVP, documented for designers):
 * - Several connections into one input share the demand: surplus by-products in the same
 *   loop are used first (catalyst recycling), the rest is split evenly over the other
 *   connections.
 * - Several connections out of one output share the supply by their `ratio` (default 1).
 *
 * Loops are solved iteratively (Gauss-Seidel sweeps) until flows settle. A loop that
 * amplifies itself never settles; `converged` is then false.
 */
import type { Network } from "./network.ts";
import { NodeKind } from "./network.ts";

export type SolveMode = "target" | "supply";

/** What limits a node in supply mode. */
export const Limit = {
  none: 0,
  /** An input is scarce: `limitPort` names the input port. */
  input: 1,
  /** The built machine count caps the recipe. */
  machines: 2,
  /** A source at its fixed rate. */
  source: 3,
  /** Recipe without a valid cycle time, or without outputs. */
  invalid: 4,
} as const;

export interface SolveOptions {
  readonly maxSweeps?: number;
  /** Relative change below which flows count as settled. */
  readonly tolerance?: number;
  /** Supply mode: replaces source rates (Monte Carlo). NaN entries keep the node's rate. */
  readonly sourceRate?: Float64Array;
  /** Supply mode: multiplies output port coefficients (Monte Carlo chance outcomes). */
  readonly outScale?: Float64Array;
}

export interface SolveResult {
  readonly mode: SolveMode;
  readonly converged: boolean;
  readonly sweeps: number;
  /** Items/s per graph edge (0 for connections that are not part of the network). */
  readonly edgeFlow: Float64Array;
  /** Per node: cycles/s for recipes, items/s otherwise. */
  readonly activity: Float64Array;
  /** Per node: machines needed (recipes); NaN otherwise. */
  readonly machines: Float64Array;
  /** Per input port: items/s required by the node's activity, and items/s arriving. */
  readonly inRequired: Float64Array;
  readonly inSupplied: Float64Array;
  /** Per output port: items/s produced, and items/s taken by connections. */
  readonly outProduced: Float64Array;
  readonly outUsed: Float64Array;
  /** Per node: deficit in items/s against a source capacity (target) or sink demand (supply). */
  readonly nodeDeficit: Float64Array;
  /** Supply mode: Limit code per node, and the limiting input port (or -1). */
  readonly limit: Uint8Array;
  readonly limitPort: Int32Array;
  /** Supply mode: nodes that limit at least one sink. */
  readonly bottlenecks: readonly number[];
}

/** Flows below this many items/s count as zero in reports. */
export const RATE_EPSILON = 1e-9;

export function solveNetwork(net: Network, mode: SolveMode, options: SolveOptions = {}): SolveResult {
  const maxSweeps = options.maxSweeps ?? 500;
  const tolerance = options.tolerance ?? 1e-10;
  const n = net.nodeCount;
  const edgeFlow = new Float64Array(net.edgeSource.length);
  const activity = new Float64Array(n);
  const limit = new Uint8Array(n);
  const limitPort = new Int32Array(n).fill(-1);
  /** Part of an edge's flow that is claimed surplus (target mode); it never drives activity. */
  const claim = new Float64Array(net.edgeSource.length);

  let sweeps = 0;
  let converged = false;
  while (sweeps < maxSweeps) {
    sweeps++;
    const change = mode === "target" ? sweepTarget(net, edgeFlow, claim, activity) : sweepSupply(net, edgeFlow, activity, limit, limitPort, options);
    if (!Number.isFinite(change)) break;
    if (change <= tolerance) {
      converged = true;
      break;
    }
  }

  return report(net, mode, converged, sweeps, edgeFlow, activity, limit, limitPort);
}

/**
 * Surplus that edge `e` could carry without its producer running faster: for a recipe,
 * what it makes beyond its other connections; for a pass-through node, the surplus that
 * reaches it through the loop (recursively, so storages and mergers inside a loop are
 * transparent).
 */
function freeSupply(net: Network, flow: Float64Array, activity: Float64Array, e: number, depth: number): number {
  const s = net.edgeSource[e]!;
  const p = net.edgeOutPort[e]!;
  let others = 0;
  for (let j = net.outEdgeStart[p]!; j < net.outEdgeStart[p + 1]!; j++) if (net.outEdges[j] !== e) others += flow[net.outEdges[j]!]!;
  let available: number;
  if (net.kind[s] === NodeKind.recipe) {
    available = activity[s]! * net.outCoef[p]!;
  } else if (net.kind[s] === NodeKind.pass && depth < 64) {
    available = 0;
    const q = net.inStart[s]!;
    for (let k = net.inEdgeStart[q]!; k < net.inEdgeStart[q + 1]!; k++) {
      const into = net.inEdges[k]!;
      if (net.component[net.edgeSource[into]!] === net.component[s]) available += freeSupply(net, flow, activity, into, depth + 1);
    }
  } else {
    available = 0;
  }
  return Math.max(0, available - others);
}

/** Largest relative change of any edge flow in this sweep. */
function sweepTarget(net: Network, flow: Float64Array, claim: Float64Array, activity: Float64Array): number {
  let change = 0;
  const { topo, kind, outStart, inStart, outEdgeStart, outEdges, inEdgeStart, inEdges, outCoef, inCoef, edgeSource, component } = net;
  // Consumers first: walk the producer-first order backwards.
  for (let t = topo.length - 1; t >= 0; t--) {
    const u = topo[t]!;
    const isRecipe = kind[u] === NodeKind.recipe;
    let a = 0;
    if (kind[u] === NodeKind.sink) {
      const r = net.rate[u]!;
      a = Number.isNaN(r) ? 0 : r;
    } else {
      for (let p = outStart[u]!; p < outStart[u + 1]!; p++) {
        let demand = 0;
        for (let k = outEdgeStart[p]!; k < outEdgeStart[p + 1]!; k++) {
          const e = outEdges[k]!;
          // Claimed surplus never makes a recipe run faster; pass-through nodes carry it.
          demand += isRecipe ? flow[e]! - claim[e]! : flow[e]!;
        }
        const coef = outCoef[p]!;
        if (coef > 0 && demand / coef > a) a = demand / coef;
      }
    }
    activity[u] = a;

    for (let q = inStart[u]!; q < inStart[u + 1]!; q++) {
      const lo = inEdgeStart[q]!;
      const hi = inEdgeStart[q + 1]!;
      if (lo === hi) continue;
      let need = a * inCoef[q]!;
      // 1. Surplus from producers in the same loop (by-products, catalysts).
      let external = 0;
      for (let k = lo; k < hi; k++) {
        const e = inEdges[k]!;
        if (component[edgeSource[e]!] !== component[u]) {
          external++;
          continue;
        }
        const c = Math.min(need, freeSupply(net, flow, activity, e, 0));
        need -= c;
        change = Math.max(change, rel(claim[e]!, c));
        claim[e] = c;
      }
      // 2. The rest, evenly over connections from outside the loop (or all, if none).
      const share = need / (external > 0 ? external : hi - lo);
      for (let k = lo; k < hi; k++) {
        const e = inEdges[k]!;
        const inLoop = component[edgeSource[e]!] === component[u];
        const next = claim[e]! + (external === 0 || !inLoop ? share : 0);
        change = Math.max(change, rel(flow[e]!, next));
        flow[e] = next;
      }
    }
  }
  return change;
}

function sweepSupply(
  net: Network,
  flow: Float64Array,
  activity: Float64Array,
  limit: Uint8Array,
  limitPort: Int32Array,
  options: SolveOptions,
): number {
  let change = 0;
  const { topo, kind, outStart, inStart, outEdgeStart, outEdges, inEdgeStart, inEdges, outCoef, inCoef, edgeWeight } = net;
  const outScale = options.outScale;
  for (let t = 0; t < topo.length; t++) {
    const u = topo[t]!;
    let a: number;
    let lim: number = Limit.none;
    let limPort = -1;
    const k0 = kind[u]!;
    if (k0 === NodeKind.source) {
      const override = options.sourceRate?.[u];
      a = override !== undefined && !Number.isNaN(override) ? override : net.rate[u]!;
      lim = Limit.source;
    } else {
      a = Infinity;
      for (let q = inStart[u]!; q < inStart[u + 1]!; q++) {
        let supplied = 0;
        for (let k = inEdgeStart[q]!; k < inEdgeStart[q + 1]!; k++) supplied += flow[inEdges[k]!]!;
        const possible = supplied / inCoef[q]!;
        if (possible < a) {
          a = possible;
          lim = Limit.input;
          limPort = q;
        }
      }
      if (k0 === NodeKind.recipe) {
        const time = net.cycleTime[u]!;
        if (Number.isNaN(time) || outStart[u] === outStart[u + 1]) {
          a = 0;
          lim = Limit.invalid;
          limPort = -1;
        } else {
          const cap = net.machineCap[u]!;
          // A recipe without inputs (e.g. mining) and no machine count runs one machine.
          const machines = Number.isNaN(cap) ? (a === Infinity ? 1 : Infinity) : cap;
          const capRate = machines / time;
          if (capRate < a) {
            a = capRate;
            lim = Limit.machines;
            limPort = -1;
          }
        }
      }
      if (a === Infinity) a = 0;
    }
    activity[u] = a;
    limit[u] = lim;
    limitPort[u] = limPort;

    for (let p = outStart[u]!; p < outStart[u + 1]!; p++) {
      const lo = outEdgeStart[p]!;
      const hi = outEdgeStart[p + 1]!;
      if (lo === hi) continue;
      const produced = a * outCoef[p]! * (outScale === undefined ? 1 : outScale[p]!);
      let weights = 0;
      for (let k = lo; k < hi; k++) weights += edgeWeight[outEdges[k]!]!;
      for (let k = lo; k < hi; k++) {
        const e = outEdges[k]!;
        const next = (produced * edgeWeight[e]!) / weights;
        change = Math.max(change, rel(flow[e]!, next));
        flow[e] = next;
      }
    }
  }
  return change;
}

function rel(prev: number, next: number): number {
  if (!Number.isFinite(next)) return Infinity;
  const d = Math.abs(next - prev);
  return d === 0 ? 0 : d / Math.max(1, Math.abs(next));
}

function report(
  net: Network,
  mode: SolveMode,
  converged: boolean,
  sweeps: number,
  edgeFlow: Float64Array,
  activity: Float64Array,
  limit: Uint8Array,
  limitPort: Int32Array,
): SolveResult {
  const n = net.nodeCount;
  const machines = new Float64Array(n).fill(NaN);
  const inRequired = new Float64Array(net.inItem.length);
  const inSupplied = new Float64Array(net.inItem.length);
  const outProduced = new Float64Array(net.outItem.length);
  const outUsed = new Float64Array(net.outItem.length);
  const nodeDeficit = new Float64Array(n);

  for (let u = 0; u < n; u++) {
    const a = activity[u]!;
    if (net.kind[u] === NodeKind.recipe && !Number.isNaN(net.cycleTime[u]!)) machines[u] = a * net.cycleTime[u]!;
    for (let q = net.inStart[u]!; q < net.inStart[u + 1]!; q++) {
      inRequired[q] = a * net.inCoef[q]!;
      let s = 0;
      for (let k = net.inEdgeStart[q]!; k < net.inEdgeStart[q + 1]!; k++) s += edgeFlow[net.inEdges[k]!]!;
      inSupplied[q] = s;
    }
    for (let p = net.outStart[u]!; p < net.outStart[u + 1]!; p++) {
      outProduced[p] = a * net.outCoef[p]!;
      let s = 0;
      for (let k = net.outEdgeStart[p]!; k < net.outEdgeStart[p + 1]!; k++) s += edgeFlow[net.outEdges[k]!]!;
      outUsed[p] = s;
    }
    const r = net.rate[u]!;
    if (mode === "target" && net.kind[u] === NodeKind.source && r > 0 && a > r) nodeDeficit[u] = a - r;
    if (mode === "supply" && net.kind[u] === NodeKind.sink && !Number.isNaN(r) && a < r) nodeDeficit[u] = r - a;
  }
  if (mode === "target") {
    // Inputs that nothing supplies are a deficit at that node.
    for (let u = 0; u < n; u++) {
      for (let q = net.inStart[u]!; q < net.inStart[u + 1]!; q++) {
        const missing = inRequired[q]! - inSupplied[q]!;
        if (missing > RATE_EPSILON * Math.max(1, inRequired[q]!)) nodeDeficit[u] = Math.max(nodeDeficit[u]!, missing);
      }
    }
  }

  return {
    mode,
    converged,
    sweeps,
    edgeFlow,
    activity,
    machines,
    inRequired,
    inSupplied,
    outProduced,
    outUsed,
    nodeDeficit,
    limit,
    limitPort,
    bottlenecks: mode === "supply" ? findBottlenecks(net, edgeFlow, limit, limitPort) : [],
  };
}

/**
 * From each sink, follows the limiting input upstream (through the connection that brings
 * the most of it) until a node that limits itself: a source, a recipe capped by machines,
 * an input nothing supplies, or a loop.
 */
function findBottlenecks(net: Network, flow: Float64Array, limit: Uint8Array, limitPort: Int32Array): number[] {
  const found = new Set<number>();
  const visited = new Uint8Array(net.nodeCount);
  for (let s = 0; s < net.nodeCount; s++) {
    if (net.kind[s] !== NodeKind.sink) continue;
    visited.fill(0);
    let u = s;
    for (;;) {
      visited[u] = 1;
      const q = limitPort[u]!;
      if (limit[u] !== Limit.input || q < 0) break;
      let best = -1;
      for (let k = net.inEdgeStart[q]!; k < net.inEdgeStart[q + 1]!; k++) {
        const e = net.inEdges[k]!;
        if (best < 0 || flow[e]! > flow[best]!) best = e;
      }
      if (best < 0) break;
      const next = net.edgeSource[best]!;
      if (visited[next] === 1) break;
      u = next;
    }
    // A sink fed by nothing is not a bottleneck of anything.
    if (u !== s || limit[u] === Limit.input) found.add(u);
  }
  return [...found].sort((a, b) => a - b);
}
