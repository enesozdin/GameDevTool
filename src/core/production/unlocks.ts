/**
 * Unlock analysis (ROADMAP §4.1 "Recipes that use items before those items are unlocked").
 *
 * For every node, `required` is the set of condition atoms that must hold before anything
 * flows out of it:
 *   source                     nothing
 *   gate                       its condition + what its input needs
 *   recipe                     its unlock condition + what each input needs
 *   storage/splitter/merger    what its input needs
 * An input fed by several connections needs only what all of them share (any supplier
 * will do). The analysis is a greatest fixpoint over the graph (loops included), seeded
 * from "unknown" and narrowed with a worklist, so each node is revisited only when a
 * supplier changes.
 *
 * A recipe with an unlock condition is reported when that condition does not imply what
 * one of its inputs needs: the recipe can be unlocked while the input is still locked.
 * Recipes without a condition are not reported; they become usable with their inputs.
 */
import type { Issue, IssuePath } from "../result.ts";
import type { Id } from "../model/primitives.ts";
import type { ProductionGraphAsset } from "../model/production-graph.ts";
import type { Atom } from "../expr/analysis.ts";
import { missingAtoms } from "../expr/analysis.ts";
import type { ConditionCompiler } from "../expr/conditions.ts";
import type { Catalog } from "./catalog.ts";
import { NodeKind, type Network } from "./network.ts";

/** Atom set keyed by canonical text; `null` = unknown (not yet reached by the fixpoint). */
type AtomSet = ReadonlyMap<string, Atom> | null;

export interface UnlockAnalysis {
  /** Per node: atoms needed before its outputs flow; null = no supply reaches it. */
  readonly required: readonly (ReadonlyMap<string, Atom> | null)[];
  /** Per node: its own condition atoms (gate condition, recipe unlock), if any compile. */
  readonly own: readonly (readonly Atom[] | undefined)[];
}

function intersect(a: AtomSet, b: AtomSet): AtomSet {
  if (a === null) return b;
  if (b === null) return a;
  const out = new Map<string, Atom>();
  for (const [k, v] of a) if (b.has(k)) out.set(k, v);
  return out;
}

function sameSet(a: AtomSet, b: AtomSet): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}

export function analyzeUnlocks(graph: ProductionGraphAsset, catalog: Catalog, net: Network, conditions: ConditionCompiler): UnlockAnalysis {
  const n = net.nodeCount;
  const own: (readonly Atom[] | undefined)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i]!;
    const source = node.type === "gate" ? node.condition : node.type === "recipe" ? catalog.recipes.get(node.recipe)?.gate : undefined;
    if (source === undefined || source.trim() === "") continue;
    const c = conditions.compile(source);
    if (c.ok) own[i] = c.value.atoms;
  }

  /** What input port p needs: the shared part of every supplier's requirement. */
  const required: AtomSet[] = new Array<AtomSet>(n).fill(null);
  const portNeeds = (p: number): AtomSet => {
    let acc: AtomSet = null;
    for (let k = net.inEdgeStart[p]!; k < net.inEdgeStart[p + 1]!; k++) {
      const s = net.edgeSource[net.inEdges[k]!]!;
      const r = required[s]!;
      if (r === null) continue;
      acc = acc === null ? r : intersect(acc, r);
    }
    return acc;
  };

  const evaluate = (u: number): AtomSet => {
    const kind = net.kind[u]!;
    if (kind === NodeKind.source) return new Map();
    const out = new Map<string, Atom>();
    for (const a of own[u] ?? []) out.set(a.text, a);
    let anySupplied = false;
    for (let p = net.inStart[u]!; p < net.inStart[u + 1]!; p++) {
      const need = portNeeds(p);
      if (need === null) {
        // A recipe needs every input; one input with no known supply leaves it unknown.
        if (kind === NodeKind.recipe && net.inEdgeStart[p] !== net.inEdgeStart[p + 1]) return null;
        continue;
      }
      anySupplied = true;
      for (const [k, v] of need) out.set(k, v);
    }
    // Recipes without inputs are producers; other nodes need a supplier.
    if (!anySupplied && !(kind === NodeKind.recipe && net.inStart[u] === net.inStart[u + 1])) return null;
    return out;
  };

  // Worklist in topological order; successors are queued when a node's set changes.
  const queued = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = net.topo[i]!;
    queued[u] = 1;
    queue.push(u);
  }
  // Each node's set only narrows, so this terminates; the cap guards against bugs.
  const cap = (n + 1) * 64;
  for (let h = 0; h < queue.length && h < cap; h++) {
    const u = queue[h]!;
    queued[u] = 0;
    const next = evaluate(u);
    if (sameSet(next, required[u]!)) continue;
    required[u] = next;
    for (let p = net.outStart[u]!; p < net.outStart[u + 1]!; p++) {
      for (let k = net.outEdgeStart[p]!; k < net.outEdgeStart[p + 1]!; k++) {
        const v = net.edgeTarget[net.outEdges[k]!]!;
        if (queued[v] === 0) {
          queued[v] = 1;
          queue.push(v);
        }
      }
    }
  }

  return { required, own };
}

/** Pushes "used-before-unlocked" warnings for recipe nodes. */
export function checkUnlockOrder(graph: ProductionGraphAsset, catalog: Catalog, net: Network, conditions: ConditionCompiler, base: IssuePath, issues: Issue[]): void {
  const { required, own } = analyzeUnlocks(graph, catalog, net, conditions);
  for (let u = 0; u < net.nodeCount; u++) {
    const given = own[u];
    if (net.kind[u] !== NodeKind.recipe || given === undefined) continue;
    for (let p = net.inStart[u]!; p < net.inStart[u + 1]!; p++) {
      let need: AtomSet = null;
      for (let k = net.inEdgeStart[p]!; k < net.inEdgeStart[p + 1]!; k++) {
        const r = required[net.edgeSource[net.inEdges[k]!]!]!;
        if (r !== null) need = need === null ? r : intersect(need, r);
      }
      if (need === null || need.size === 0) continue;
      const missing = missingAtoms(given, [...need.values()]);
      if (missing.length > 0) {
        const item: Id = net.inItem[p]!;
        issues.push({ severity: "warning", code: "used-before-unlocked", path: [...base, "nodes", u], params: { item, condition: missing.map((a) => a.text).join(" and ") } });
      }
    }
  }
}
