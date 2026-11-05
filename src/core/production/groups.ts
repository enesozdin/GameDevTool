/**
 * Sub-chains (ROADMAP §4.1, IDEF0 hierarchical decomposition). Groups only change how a
 * chain is drawn; the solver always runs on the flat node list.
 *
 * A node or group is "shown as" the outermost collapsed group around it, or as itself when
 * no group around it is collapsed. Connections between two things shown as the same
 * collapsed group are hidden; the others are drawn between what their ends are shown as,
 * merged per (from, to, item). The ports of a collapsed group are the items crossing its
 * boundary, plus unconnected member ports (IDEF0 boundary arrows).
 *
 * Broken structure in a hand-edited file (missing group, parent loop, nesting deeper than
 * GRAPH_LIMITS.groupDepth) is tolerated: the affected node or group counts as top level.
 * Validation reports it.
 */
import type { Id } from "../model/primitives.ts";
import { GRAPH_LIMITS, type GraphGroup, type Position, type ProductionGraphAsset } from "../model/production-graph.ts";
import type { Network } from "./network.ts";
import { RATE_EPSILON, type SolveResult } from "./solve.ts";

export interface GroupStructure {
  readonly groups: ReadonlyMap<Id, GraphGroup>;
  /** Usable parent of each group (missing for top-level and broken ones). */
  readonly parent: ReadonlyMap<Id, Id>;
  /** Usable group of each node (missing for top-level nodes and broken references). */
  readonly nodeGroup: ReadonlyMap<Id, Id>;
  /** Nesting depth of each group: 0 = top level. */
  readonly depth: ReadonlyMap<Id, number>;
  /** Groups ordered children before parents. */
  readonly bottomUp: readonly Id[];
  /** Direct child groups and direct member nodes per group. */
  readonly childGroups: ReadonlyMap<Id, readonly Id[]>;
  readonly memberNodes: ReadonlyMap<Id, readonly Id[]>;
  /** What each node and group is shown as (see the module comment). */
  readonly shownAs: ReadonlyMap<Id, Id>;
}

const NONE: readonly Id[] = [];

/** O(nodes + groups · depth). Cheap enough to rebuild on every edit of the graph. */
export function groupStructure(graph: ProductionGraphAsset): GroupStructure {
  const groups = new Map<Id, GraphGroup>();
  for (const g of graph.groups ?? NONE_GROUPS) if (!groups.has(g.id)) groups.set(g.id, g);

  // Walk up from each group once. A missing parent, a loop or nesting deeper than the
  // limit makes the group where the chain breaks a top-level group.
  const parent = new Map<Id, Id>();
  const depth = new Map<Id, number>();
  const visiting = new Set<Id>();
  for (const id of groups.keys()) {
    const chain: Id[] = [];
    let at: Id | undefined = id;
    while (at !== undefined && !depth.has(at) && !visiting.has(at)) {
      visiting.add(at);
      chain.push(at);
      const p: Id | undefined = groups.get(at)!.parent;
      at = p !== undefined && groups.has(p) ? p : undefined;
    }
    // at: undefined (top reached), a finished group, or a group on this chain (loop).
    let d = at !== undefined && depth.has(at) ? depth.get(at)! : -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      const g = chain[i]!;
      if (d < 0 || d + 1 >= GRAPH_LIMITS.groupDepth) d = 0;
      else {
        d++;
        parent.set(g, groups.get(g)!.parent!);
      }
      depth.set(g, d);
      visiting.delete(g);
    }
  }

  const childGroups = new Map<Id, Id[]>();
  for (const [id, p] of parent) push(childGroups, p, id);
  const memberNodes = new Map<Id, Id[]>();
  const nodeGroup = new Map<Id, Id>();
  for (const node of graph.nodes) {
    if (node.group !== undefined && groups.has(node.group)) {
      nodeGroup.set(node.id, node.group);
      push(memberNodes, node.group, node.id);
    }
  }

  const bottomUp = [...groups.keys()].sort((a, b) => depth.get(b)! - depth.get(a)!);

  const shownAs = new Map<Id, Id>();
  for (const id of bottomUp) shownAs.set(id, outermostCollapsed(id, parent, groups) ?? id);
  for (const node of graph.nodes) {
    const g = nodeGroup.get(node.id);
    shownAs.set(node.id, g === undefined ? node.id : (outermostCollapsed(g, parent, groups, true) ?? node.id));
  }

  return { groups, parent, nodeGroup, depth, bottomUp, childGroups, memberNodes, shownAs };
}

const NONE_GROUPS: readonly GraphGroup[] = [];

function push(map: Map<Id, Id[]>, key: Id, value: Id): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * The outermost collapsed group among the ancestors of `id` (and `id` itself when
 * `inclusive`). Depth is bounded by GRAPH_LIMITS.groupDepth.
 */
function outermostCollapsed(id: Id, parent: ReadonlyMap<Id, Id>, groups: ReadonlyMap<Id, GraphGroup>, inclusive = false): Id | undefined {
  let found: Id | undefined;
  let at: Id | undefined = inclusive ? id : parent.get(id);
  while (at !== undefined) {
    if (groups.get(at)!.collapsed === true) found = at;
    at = parent.get(at);
  }
  return found;
}

/** Whether `id` (a node or group) is drawn on the canvas, i.e. shown as itself. */
export function isShown(structure: GroupStructure, id: Id): boolean {
  return structure.shownAs.get(id) === id;
}

/** All nodes inside a group, at any depth. */
export function descendantNodes(structure: GroupStructure, groupId: Id): Id[] {
  const out: Id[] = [];
  const stack: Id[] = [groupId];
  while (stack.length > 0) {
    const g = stack.pop()!;
    for (const n of structure.memberNodes.get(g) ?? NONE) out.push(n);
    for (const c of structure.childGroups.get(g) ?? NONE) stack.push(c);
  }
  return out;
}

/** The group itself and all groups inside it. */
export function descendantGroups(structure: GroupStructure, groupId: Id): Id[] {
  const out: Id[] = [];
  const stack: Id[] = [groupId];
  while (stack.length > 0) {
    const g = stack.pop()!;
    out.push(g);
    for (const c of structure.childGroups.get(g) ?? NONE) stack.push(c);
  }
  return out;
}

/** The enclosing group of a node or group (undefined = top level). */
export function containerOf(structure: GroupStructure, id: Id): Id | undefined {
  return structure.groups.has(id) ? structure.parent.get(id) : structure.nodeGroup.get(id);
}

// ---------------------------------------------------------------------------------------
// What the canvas draws
// ---------------------------------------------------------------------------------------

/** One drawn connection: a graph edge, or several merged at a collapsed group. */
export interface ShownEdge {
  /** The graph edge id, or "<from>><to>:<item>" for merged connections. */
  readonly id: string;
  readonly source: Id;
  readonly target: Id;
  readonly item: Id;
  /** Input port key at the target: the item, or "#tag" for a tag port (network.inItem). */
  readonly targetKey: string;
  /** Graph edge index when this is exactly one ungrouped edge; -1 when merged. */
  readonly edge: number;
  readonly flow: number;
  /** All merged edges are part of the network (a port matches). */
  readonly valid: boolean;
  /** An input fed by these edges gets less than it needs. */
  readonly short: boolean;
}

export function shownEdges(graph: ProductionGraphAsset, structure: GroupStructure, net: Network, result: SolveResult): ShownEdge[] {
  const out: ShownEdge[] = [];
  const merged = new Map<string, number>();
  graph.edges.forEach((e, i) => {
    const inPort = net.edgeInPort[i]!;
    const valid = inPort >= 0;
    const short = valid && result.inRequired[inPort]! - result.inSupplied[inPort]! > RATE_EPSILON;
    const flow = result.edgeFlow[i]!;
    const targetKey = valid ? net.inItem[inPort]! : e.item;
    const source = structure.shownAs.get(e.source) ?? e.source;
    const target = structure.shownAs.get(e.target) ?? e.target;
    if (source === e.source && target === e.target) {
      out.push({ id: e.id, source, target, item: e.item, targetKey, edge: i, flow, valid, short });
      return;
    }
    if (source === target) return; // inside one collapsed group
    const key = `${source}>${target}:${e.item}>${targetKey}`;
    const at = merged.get(key);
    if (at === undefined) {
      merged.set(key, out.length);
      out.push({ id: key, source, target, item: e.item, targetKey, edge: -1, flow, valid, short });
    } else {
      const prev = out[at]!;
      out[at] = { ...prev, flow: prev.flow + flow, valid: prev.valid && valid, short: prev.short || short };
    }
  });
  return out;
}

export interface BoundaryPort {
  /** Item id, or "#tag" for a member tag input fed from outside (network.inItem). */
  readonly item: string;
  /** Items/s crossing the boundary (outputs: plus the surplus of unconnected member outputs). */
  readonly rate: number;
  /** A member input of this item gets less than it needs. */
  readonly warn: boolean;
}

export interface CollapsedSummary {
  readonly inputs: readonly BoundaryPort[];
  readonly outputs: readonly BoundaryPort[];
  readonly nodeCount: number;
  /** Sum of member deficits, items/s. */
  readonly deficit: number;
  readonly bottleneck: boolean;
  readonly lockedCount: number;
}

/**
 * Ports and status of every collapsed group that is drawn, in one pass over nodes and
 * edges. `locked`: 1 per locked node (GateState.locked), or undefined.
 */
export function summarizeCollapsed(graph: ProductionGraphAsset, structure: GroupStructure, net: Network, result: SolveResult, locked?: Uint8Array): Map<Id, CollapsedSummary> {
  interface Draft {
    inputs: Map<string, { rate: number; warn: boolean }>;
    outputs: Map<string, { rate: number; warn: boolean }>;
    nodeCount: number;
    deficit: number;
    bottleneck: boolean;
    lockedCount: number;
  }
  const drafts = new Map<Id, Draft>();
  for (const id of structure.bottomUp) {
    if (structure.shownAs.get(id) === id && structure.groups.get(id)!.collapsed === true) {
      drafts.set(id, { inputs: new Map(), outputs: new Map(), nodeCount: 0, deficit: 0, bottleneck: false, lockedCount: 0 });
    }
  }
  if (drafts.size === 0) return new Map();

  const add = (ports: Draft["inputs"], item: string, rate: number, warn: boolean) => {
    const p = ports.get(item);
    if (p === undefined) ports.set(item, { rate, warn });
    else {
      p.rate += rate;
      p.warn ||= warn;
    }
  };
  const bottlenecks = new Set(result.bottlenecks);
  const shortAt = (q: number) => result.inRequired[q]! - result.inSupplied[q]! > RATE_EPSILON;

  graph.nodes.forEach((node, i) => {
    const d = drafts.get(structure.shownAs.get(node.id) ?? node.id);
    if (d === undefined) return;
    d.nodeCount++;
    d.deficit += result.nodeDeficit[i]!;
    if (bottlenecks.has(i)) d.bottleneck = true;
    if (locked !== undefined && locked[i] === 1) d.lockedCount++;
    for (let q = net.inStart[i]!; q < net.inStart[i + 1]!; q++) {
      if (net.inEdgeStart[q] === net.inEdgeStart[q + 1]) add(d.inputs, net.inItem[q]!, 0, shortAt(q));
    }
    for (let p = net.outStart[i]!; p < net.outStart[i + 1]!; p++) {
      if (net.outEdgeStart[p] === net.outEdgeStart[p + 1]) add(d.outputs, net.outItem[p]!, result.outProduced[p]!, false);
    }
  });

  graph.edges.forEach((e, i) => {
    const inPort = net.edgeInPort[i]!;
    if (inPort < 0) return;
    const source = structure.shownAs.get(e.source) ?? e.source;
    const target = structure.shownAs.get(e.target) ?? e.target;
    if (source === target) return;
    const flow = result.edgeFlow[i]!;
    const into = drafts.get(target);
    if (into !== undefined) add(into.inputs, net.inItem[inPort]!, flow, shortAt(inPort));
    const from = drafts.get(source);
    if (from !== undefined) add(from.outputs, e.item, flow, false);
  });

  const toPorts = (ports: Draft["inputs"]): BoundaryPort[] => [...ports].map(([item, p]) => ({ item, rate: p.rate, warn: p.warn }));
  const out = new Map<Id, CollapsedSummary>();
  for (const [id, d] of drafts) {
    out.set(id, { inputs: toPorts(d.inputs), outputs: toPorts(d.outputs), nodeCount: d.nodeCount, deficit: d.deficit, bottleneck: d.bottleneck, lockedCount: d.lockedCount });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Space between a frame and its contents; the top leaves room for the frame header. */
export const GROUP_PADDING = { side: 24, top: 44 } as const;

export interface GroupGeometry {
  /** Top-left of each drawn collapsed group: the top-left of its member nodes. */
  readonly collapsedAt: ReadonlyMap<Id, Position>;
  /** Frame of each drawn expanded group, around its contents. */
  readonly frames: ReadonlyMap<Id, Rect>;
}

/**
 * Positions of collapsed groups and frames of expanded ones. `size` gives the drawn size
 * of a node or collapsed group (measured by the UI, or an estimate). Groups without any
 * node are left out. O(nodes + groups).
 */
export function groupGeometry(graph: ProductionGraphAsset, structure: GroupStructure, size: (id: Id) => Size): GroupGeometry {
  const collapsedAt = new Map<Id, Position>();
  const frames = new Map<Id, Rect>();
  if (structure.groups.size === 0) return { collapsedAt, frames };

  const position = new Map<Id, Position>();
  for (const node of graph.nodes) position.set(node.id, node.position);
  // Top-left of all nodes inside each group, children before parents.
  const corner = new Map<Id, { x: number; y: number }>();
  const bounds = new Map<Id, Rect>();
  for (const id of structure.bottomUp) {
    let x = Infinity;
    let y = Infinity;
    for (const n of structure.memberNodes.get(id) ?? NONE) {
      const p = position.get(n)!;
      x = Math.min(x, p.x);
      y = Math.min(y, p.y);
    }
    for (const c of structure.childGroups.get(id) ?? NONE) {
      const cc = corner.get(c);
      if (cc === undefined) continue;
      x = Math.min(x, cc.x);
      y = Math.min(y, cc.y);
    }
    if (x !== Infinity) corner.set(id, { x, y });
  }

  // Bounds of what is drawn for each group (only groups with a drawn self matter).
  for (const id of structure.bottomUp) {
    const c = corner.get(id);
    if (c === undefined) continue;
    const g = structure.groups.get(id)!;
    if (g.collapsed === true) {
      const s = size(id);
      bounds.set(id, { x: c.x, y: c.y, width: s.width, height: s.height });
      if (structure.shownAs.get(id) === id) collapsedAt.set(id, c);
      continue;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const include = (r: Rect) => {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.width);
      y1 = Math.max(y1, r.y + r.height);
    };
    for (const n of structure.memberNodes.get(id) ?? NONE) {
      const p = position.get(n)!;
      const s = size(n);
      include({ x: p.x, y: p.y, width: s.width, height: s.height });
    }
    for (const child of structure.childGroups.get(id) ?? NONE) {
      const r = bounds.get(child);
      if (r !== undefined) include(r);
    }
    const frame = { x: x0 - GROUP_PADDING.side, y: y0 - GROUP_PADDING.top, width: x1 - x0 + 2 * GROUP_PADDING.side, height: y1 - y0 + GROUP_PADDING.top + GROUP_PADDING.side };
    bounds.set(id, frame);
    if (structure.shownAs.get(id) === id) frames.set(id, frame);
  }
  return { collapsedAt, frames };
}
