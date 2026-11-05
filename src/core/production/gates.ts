/**
 * Gate evaluation for the solver and Monte Carlo runs (ROADMAP §4.1, Machinations Gate).
 *
 * A scenario gives every project variable a value: its start value, unless the graph's
 * saved `scenario` overrides it. Against it:
 * - a gate node is open when its condition is true; an empty condition is open
 *   (validation warns about it);
 * - a recipe node is unlocked when its recipe's unlock condition is true, or it has none.
 * A condition that does not compile, or fails at run time (division by zero, ...), counts
 * as closed: nothing flows through a condition the designer still has to fix.
 *
 * Locked nodes run at 0 in the solver (`SolveOptions.locked`), so locks show up as
 * deficits and bottlenecks like any other limit.
 */
import type { Id } from "../model/primitives.ts";
import type { ProductionGraphAsset } from "../model/production-graph.ts";
import type { Variable } from "../model/project.ts";
import { defaultValues, type Value } from "../expr/compile.ts";
import type { ConditionCompiler } from "../expr/conditions.ts";
import type { Catalog } from "./catalog.ts";

export const GateStatus = {
  /** No condition (pass-through nodes, sources, sinks, ungated recipes). */
  none: 0,
  open: 1,
  closed: 2,
  /** The condition does not compile or fails at run time; treated as closed. */
  error: 3,
} as const;
export type GateStatusCode = (typeof GateStatus)[keyof typeof GateStatus];

export interface GateState {
  /** GateStatus per node. */
  readonly status: Uint8Array;
  /** 1 = locked (closed or error) per node; pass to `solveNetwork` as `locked`. */
  readonly locked: Uint8Array;
  readonly lockedCount: number;
  /** Slots of the variables any condition of this graph reads, ascending. */
  readonly slots: readonly number[];
}

/** True when `value` is a valid value of `variable` (enum: one of its option ids). */
export function fitsVariable(variable: Variable, value: Value): boolean {
  switch (variable.type) {
    case "bool":
      return typeof value === "boolean";
    case "int":
      return Number.isSafeInteger(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "enum":
      return variable.options.some((o) => o.id === value);
  }
}

/**
 * Variable values for a scenario: start values with `overrides` (variable id → value)
 * applied. Overrides that do not fit their variable (validation warns) are ignored.
 */
export function scenarioValues(conditions: ConditionCompiler, variables: readonly Variable[], overrides: Readonly<Record<Id, Value>> | undefined): Value[] {
  const values = defaultValues(conditions.scope, variables);
  if (overrides === undefined) return values;
  const byId = new Map<Id, Variable>();
  for (const v of variables) byId.set(v.id, v);
  for (const entry of conditions.scope.entries) {
    if (entry.variable === undefined || !Object.hasOwn(overrides, entry.variable)) continue;
    const v = overrides[entry.variable]!;
    const variable = byId.get(entry.variable);
    if (variable !== undefined && fitsVariable(variable, v)) values[entry.slot] = v;
  }
  return values;
}

/** Evaluates every gate node and recipe unlock in the graph (nodes in graph order). */
export function evaluateGates(graph: ProductionGraphAsset, catalog: Catalog, conditions: ConditionCompiler, values: readonly Value[]): GateState {
  const n = graph.nodes.length;
  const status = new Uint8Array(n);
  const locked = new Uint8Array(n);
  const slots = new Set<number>();
  let lockedCount = 0;
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i]!;
    const source = node.type === "gate" ? node.condition : node.type === "recipe" ? catalog.recipes.get(node.recipe)?.gate : undefined;
    if (source === undefined || source.trim() === "") {
      if (node.type === "gate") status[i] = GateStatus.open;
      continue;
    }
    const c = conditions.compile(source);
    let s: GateStatusCode = GateStatus.error;
    if (c.ok) {
      for (const slot of c.value.compiled.slots) slots.add(slot);
      const r = c.value.compiled.evaluate(values);
      if (r.ok) s = r.value === true ? GateStatus.open : GateStatus.closed;
    }
    status[i] = s;
    if (s !== GateStatus.open) {
      locked[i] = 1;
      lockedCount++;
    }
  }
  return { status, locked, lockedCount, slots: [...slots].sort((a, b) => a - b) };
}
