/**
 * Strongly connected components (Tarjan, iterative so deep chains cannot overflow the
 * stack). `adjStart`/`adj` is a CSR adjacency list. Returns the component of each node
 * and whether the component contains a cycle (more than one node, or a self-loop).
 */
export interface Components {
  readonly component: Int32Array;
  readonly count: number;
  readonly cyclic: Uint8Array;
}

export function stronglyConnected(n: number, adjStart: Int32Array, adj: Int32Array): Components {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const component = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const callNode = new Int32Array(n);
  const callEdge = new Int32Array(n);
  const sizes: number[] = [];
  let sp = 0;
  let next = 0;
  let count = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    let depth = 0;
    callNode[0] = root;
    callEdge[0] = adjStart[root]!;
    index[root] = low[root] = next++;
    stack[sp++] = root;
    onStack[root] = 1;

    while (depth >= 0) {
      const u = callNode[depth]!;
      const k = callEdge[depth]!;
      if (k < adjStart[u + 1]!) {
        callEdge[depth] = k + 1;
        const v = adj[k]!;
        if (index[v] === -1) {
          index[v] = low[v] = next++;
          stack[sp++] = v;
          onStack[v] = 1;
          depth++;
          callNode[depth] = v;
          callEdge[depth] = adjStart[v]!;
        } else if (onStack[v] === 1 && index[v]! < low[u]!) {
          low[u] = index[v]!;
        }
        continue;
      }
      if (low[u] === index[u]) {
        let size = 0;
        let w: number;
        do {
          w = stack[--sp]!;
          onStack[w] = 0;
          component[w] = count;
          size++;
        } while (w !== u);
        sizes.push(size);
        count++;
      }
      depth--;
      if (depth >= 0) {
        const parent = callNode[depth]!;
        if (low[u]! < low[parent]!) low[parent] = low[u]!;
      }
    }
  }

  const cyclic = new Uint8Array(count);
  for (let c = 0; c < count; c++) if (sizes[c]! > 1) cyclic[c] = 1;
  for (let u = 0; u < n; u++) {
    for (let k = adjStart[u]!; k < adjStart[u + 1]!; k++) if (adj[k] === u) cyclic[component[u]!] = 1;
  }
  return { component, count, cyclic };
}

/** CSR adjacency from edge endpoint arrays; entries with source < 0 are skipped. */
export function adjacency(n: number, source: Int32Array, target: Int32Array): { adjStart: Int32Array; adj: Int32Array } {
  const adjStart = new Int32Array(n + 1);
  for (let e = 0; e < source.length; e++) if (source[e]! >= 0) adjStart[source[e]! + 1]!++;
  for (let i = 0; i < n; i++) adjStart[i + 1]! += adjStart[i]!;
  const adj = new Int32Array(adjStart[n]!);
  const fill = adjStart.slice(0, n);
  for (let e = 0; e < source.length; e++) if (source[e]! >= 0) adj[fill[source[e]!]!++] = target[e]!;
  return { adjStart, adj };
}
