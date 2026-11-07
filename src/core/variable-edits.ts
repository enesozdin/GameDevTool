/**
 * Edits on project variables (flags, counters, quest states). Renaming a variable also
 * rewrites every expression that uses it (gate nodes, recipe unlock cells, column
 * formulas), so a rename never breaks a condition. Deleting a variable or changing its
 * type drops saved scenario values that no longer fit it.
 */
import type { Change, Patch } from "./history.ts";
import type { IdGenerator } from "./ids.ts";
import { IdentifierSchema, type EnumOption, type Id } from "./model/primitives.ts";
import type { Project, Variable } from "./model/project.ts";
import { tokenize } from "./expr/parser.ts";
import { ExprException, KEYWORDS } from "./expr/syntax.ts";
import { fitsVariable } from "./production/gates.ts";

export const MAX_VARIABLES = 10_000;

export type VariableType = Variable["type"];

/** Valid identifier, not a keyword, not used by another variable (case-insensitive). */
export function isValidVariableName(project: Project, name: string, except?: Id): boolean {
  if (!IdentifierSchema.safeParse(name).success || KEYWORDS.has(name.toLowerCase())) return false;
  const key = name.toLowerCase();
  return !project.manifest.variables.some((v) => v.id !== except && v.name.toLowerCase() === key);
}

/** A fresh name "Base", "Base2", ... that no variable uses yet. */
export function uniqueVariableName(project: Project, base: string): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}${i}`;
    if (isValidVariableName(project, name)) return name;
  }
}

export function createVariable(newId: IdGenerator, name: string, type: VariableType, options?: readonly EnumOption[]): Variable {
  const base = { id: newId(), name };
  switch (type) {
    case "bool":
      return { ...base, type, default: false };
    case "int":
    case "float":
      return { ...base, type, default: 0 };
    case "string":
      return { ...base, type, default: "" };
    case "enum": {
      const opts = options !== undefined && options.length > 0 ? [...options] : [{ id: newId(), name: "None" }];
      return { ...base, type, options: opts, default: opts[0]!.id };
    }
  }
}

export function addVariable(project: Project, variable: Variable): Change | null {
  const list = project.manifest.variables;
  if (list.length >= MAX_VARIABLES || !isValidVariableName(project, variable.name)) return null;
  return { label: "add-variable", patches: [{ op: "insert", path: ["manifest", "variables"], index: list.length, value: variable }] };
}

export function removeVariable(project: Project, id: Id): Change | null {
  const index = project.manifest.variables.findIndex((v) => v.id === id);
  if (index < 0) return null;
  return { label: "remove-variable", patches: [{ op: "remove", path: ["manifest", "variables"], index }, ...dropScenarioValues(project, id, undefined)] };
}

/**
 * Replaces a variable (type, default, options, description). The id is kept. A new name
 * is validated and rewritten in every expression that uses the old one.
 */
export function updateVariable(project: Project, next: Variable): Change | null {
  const index = project.manifest.variables.findIndex((v) => v.id === next.id);
  if (index < 0) return null;
  const prev = project.manifest.variables[index]!;
  if (prev.name !== next.name && !isValidVariableName(project, next.name, next.id)) return null;
  if (next.type === "enum" && !next.options.some((o) => o.id === next.default)) return null;
  if (JSON.stringify(prev) === JSON.stringify(next)) return null;
  const patches: Patch[] = [{ op: "set", path: ["manifest", "variables", index], value: next }];
  if (prev.name.toLowerCase() !== next.name.toLowerCase()) patches.push(...renameInExpressions(project, prev.name, next.name));
  patches.push(...dropScenarioValues(project, next.id, next));
  return { label: prev.name === next.name ? "edit-variable" : "rename-variable", coalesceKey: `variable:${next.id}`, patches };
}

/**
 * Rewrites the name `from` to `to` in one expression. Only variable names change, never
 * function names, strings or keywords. Text that does not tokenize is left unchanged.
 */
export function renameInExpression(source: string, from: string, to: string): string {
  const key = from.toLowerCase();
  let tokens;
  try {
    tokens = tokenize(source);
  } catch (e) {
    if (e instanceof ExprException) return source;
    throw e;
  }
  let out = "";
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "name" || t.text.toLowerCase() !== key) continue;
    const next = tokens[i + 1];
    if (next !== undefined && next.kind === "op" && next.text === "(") continue;
    // After a dot the name is a column of a referenced table (Weapon.Level), not a variable.
    const before = tokens[i - 1];
    if (before !== undefined && before.kind === "op" && before.text === ".") continue;
    out += source.slice(last, t.start) + to;
    last = t.end;
  }
  return last === 0 ? source : out + source.slice(last);
}

/**
 * Patches that remove a variable's scenario value from every production graph where it
 * no longer fits (`next` undefined = the variable is deleted).
 */
function dropScenarioValues(project: Project, id: Id, next: Variable | undefined): Patch[] {
  const patches: Patch[] = [];
  project.assets.forEach((asset, a) => {
    const scenario = asset.kind === "production-graph" ? asset.scenario : undefined;
    if (scenario === undefined || !Object.hasOwn(scenario.values, id)) return;
    if (next !== undefined && fitsVariable(next, scenario.values[id]!)) return;
    const values = { ...scenario.values };
    delete values[id];
    const empty = Object.keys(values).length === 0 && scenario.allOpen !== true;
    patches.push({ op: "set", path: ["assets", a, "scenario"], value: empty ? undefined : { ...scenario, values } });
  });
  return patches;
}

/** Patches that rename a variable in gate nodes, recipe unlock cells and column formulas. */
function renameInExpressions(project: Project, from: string, to: string): Patch[] {
  const patches: Patch[] = [];
  const key = from.toLowerCase();
  // Cheap prefilter: most expressions do not mention the name at all.
  const mentions = (s: string) => s.toLowerCase().includes(key);
  project.assets.forEach((asset, a) => {
    if (asset.kind === "production-graph") {
      asset.nodes.forEach((node, n) => {
        if (node.type !== "gate" || !mentions(node.condition)) return;
        const next = renameInExpression(node.condition, from, to);
        if (next !== node.condition) patches.push({ op: "set", path: ["assets", a, "nodes", n, "condition"], value: next });
      });
    } else if (asset.kind === "table") {
      if (asset.role?.kind === "recipes" && asset.role.gate !== undefined) {
        const column = asset.role.gate;
        asset.rows.forEach((row, r) => {
          const cell = row.cells[column];
          if (typeof cell !== "string" || !mentions(cell)) return;
          const next = renameInExpression(cell, from, to);
          if (next !== cell) patches.push({ op: "set", path: ["assets", a, "rows", r, "cells", column], value: next });
        });
      }
      // Column formulas, unless a column of the same name shadows the variable there.
      if (asset.columns.some((c) => c.name.toLowerCase() === key)) return;
      asset.columns.forEach((column, c) => {
        if (column.formula === undefined || !mentions(column.formula)) return;
        const next = renameInExpression(column.formula, from, to);
        if (next !== column.formula) patches.push({ op: "set", path: ["assets", a, "columns", c, "formula"], value: next });
      });
    }
  });
  return patches;
}

/** The same variable with another type; the default is reset for the new type. */
export function changeVariableType(variable: Variable, type: VariableType, newId: IdGenerator): Variable {
  if (variable.type === type) return variable;
  const next = createVariable(newId, variable.name, type);
  return variable.description === undefined ? { ...next, id: variable.id } : { ...next, id: variable.id, description: variable.description };
}

/**
 * An enum variable with the given option names. Options keep their id when the name
 * matches an existing one (case-insensitive), so renaming one option in a list is a
 * remove + add, but reordering keeps every id. Returns null for invalid or duplicate
 * names or an empty list.
 */
export function withEnumOptions(variable: Variable & { type: "enum" }, names: readonly string[], newId: IdGenerator): Variable | null {
  if (names.length === 0 || names.length > 1_000) return null;
  const existing = new Map(variable.options.map((o) => [o.name.toLowerCase(), o]));
  const seen = new Set<string>();
  const options: EnumOption[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (!IdentifierSchema.safeParse(name).success || seen.has(key)) return null;
    seen.add(key);
    const prev = existing.get(key);
    options.push(prev === undefined ? { id: newId(), name } : { id: prev.id, name });
  }
  const def = options.some((o) => o.id === variable.default) ? variable.default : options[0]!.id;
  return { ...variable, options, default: def };
}
