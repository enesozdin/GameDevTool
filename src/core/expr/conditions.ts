/**
 * Shared compile cache for conditions (gates, recipe unlocks, later dialogue conditions).
 * The same source text is compiled once per project snapshot, however often it is used.
 * The cache is LRU-bounded: a condition field compiles every draft while the designer
 * types, and those prefixes must not pile up for the lifetime of the editor.
 */
import type { Issue, IssuePath, Result } from "../result.ts";
import type { Variable } from "../model/project.ts";
import { createVariableScope, compileExpression, type CompiledExpression, type Scope } from "./compile.ts";
import { atomsOf, type Atom } from "./analysis.ts";
import type { ExprError } from "./syntax.ts";

export interface CompiledCondition {
  readonly compiled: CompiledExpression;
  readonly atoms: readonly Atom[];
}

/** Default number of cached conditions; far above the distinct conditions of a project. */
export const CONDITION_CACHE_SIZE = 1_024;

export class ConditionCompiler {
  readonly scope: Scope;
  /** Map iteration order is insertion order: the first key is the least recently used. */
  private readonly cache = new Map<string, Result<CompiledCondition, ExprError>>();
  private readonly limit: number;

  constructor(variables: readonly Variable[], limit = CONDITION_CACHE_SIZE) {
    this.scope = createVariableScope(variables);
    this.limit = Math.max(1, limit);
  }

  /** Number of cached conditions (for tests and diagnostics). */
  get size(): number {
    return this.cache.size;
  }

  /** Compiles a bool condition; the result is cached by source text. */
  compile(source: string): Result<CompiledCondition, ExprError> {
    let result = this.cache.get(source);
    if (result !== undefined) {
      // Mark as most recently used.
      this.cache.delete(source);
      this.cache.set(source, result);
      return result;
    }
    const compiled = compileExpression(source, this.scope, { expect: "bool" });
    result = compiled.ok ? { ok: true, value: { compiled: compiled.value, atoms: atomsOf(compiled.value.ast, this.scope) } } : compiled;
    if (this.cache.size >= this.limit) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(source, result);
    return result;
  }
}

/** Expression errors become issues with the error range in `params.start` / `params.end`. */
export function exprIssue(path: IssuePath, error: ExprError): Issue {
  return { severity: "error", code: error.code, path, params: { ...error.params, start: error.start, end: error.end } };
}
