/**
 * Shared compile cache for conditions (gates, recipe unlocks, later dialogue conditions).
 * The same source text is compiled once per project snapshot, however often it is used.
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

export class ConditionCompiler {
  readonly scope: Scope;
  private readonly cache = new Map<string, Result<CompiledCondition, ExprError>>();

  constructor(variables: readonly Variable[]) {
    this.scope = createVariableScope(variables);
  }

  /** Compiles a bool condition; the result is cached by source text. */
  compile(source: string): Result<CompiledCondition, ExprError> {
    let result = this.cache.get(source);
    if (result === undefined) {
      const compiled = compileExpression(source, this.scope, { expect: "bool" });
      result = compiled.ok ? { ok: true, value: { compiled: compiled.value, atoms: atomsOf(compiled.value.ast, this.scope) } } : compiled;
      this.cache.set(source, result);
    }
    return result;
  }
}

/** Expression errors become issues with the error range in `params.start` / `params.end`. */
export function exprIssue(path: IssuePath, error: ExprError): Issue {
  return { severity: "error", code: error.code, path, params: { ...error.params, start: error.start, end: error.end } };
}
