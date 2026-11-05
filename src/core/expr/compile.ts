/**
 * Type checker + compiler: AST → typed closures. Names resolve to slots at compile time,
 * so evaluation is an array read per variable and no type checks run per evaluation.
 */
import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";
import type { EnumOption, Id } from "../model/primitives.ts";
import type { Variable } from "../model/project.ts";
import { parseExpression } from "./parser.ts";
import { ExprException, fail, KEYWORDS, type BinaryOp, type Expr, type ExprError, type Span } from "./syntax.ts";

/** Run-time value. Enum values are option ids (strings). */
export type Value = number | boolean | string;

export type ValueType =
  | { readonly kind: "bool" }
  | { readonly kind: "number" }
  | { readonly kind: "string" }
  /** Value of one enum: compared only with the same enum or with an option name. */
  | { readonly kind: "enum"; readonly owner: string; readonly options: readonly EnumOption[] };

export type TypeName = ValueType["kind"];

const BOOL: ValueType = { kind: "bool" };
const NUMBER: ValueType = { kind: "number" };
const STRING: ValueType = { kind: "string" };

export interface ScopeEntry {
  /** Index into the values array passed to `evaluate`. */
  readonly slot: number;
  /** Name as declared (for messages and canonical printing). */
  readonly name: string;
  readonly type: ValueType;
  /** Project variable id, when the entry is a variable. */
  readonly variable?: Id;
}

/** Names an expression can use. Lookup is case-insensitive, like identifier uniqueness. */
export interface Scope {
  readonly entries: readonly ScopeEntry[];
  readonly byName: ReadonlyMap<string, ScopeEntry>;
}

/**
 * Scope over the project variables, one slot per variable in declaration order.
 * Keyword names (`and`, `true`, ...) are left out; validation reports them.
 */
export function createVariableScope(variables: readonly Variable[]): Scope {
  const entries: ScopeEntry[] = [];
  const byName = new Map<string, ScopeEntry>();
  for (const v of variables) {
    const key = v.name.toLowerCase();
    if (KEYWORDS.has(key) || byName.has(key)) continue;
    const type: ValueType = v.type === "enum" ? { kind: "enum", owner: v.name, options: v.options } : v.type === "int" || v.type === "float" ? NUMBER : v.type === "bool" ? BOOL : STRING;
    const entry: ScopeEntry = { slot: entries.length, name: v.name, type, variable: v.id };
    entries.push(entry);
    byName.set(key, entry);
  }
  return { entries, byName };
}

/** Values array holding every variable's default, for `evaluate`. */
export function defaultValues(scope: Scope, variables: readonly Variable[]): Value[] {
  const byId = new Map<Id, Variable>();
  for (const v of variables) byId.set(v.id, v);
  const values: Value[] = new Array(scope.entries.length);
  for (const entry of scope.entries) {
    const v = entry.variable === undefined ? undefined : byId.get(entry.variable);
    values[entry.slot] = v?.default ?? (entry.type.kind === "number" ? 0 : entry.type.kind === "bool" ? false : "");
  }
  return values;
}

export interface CompiledExpression {
  readonly source: string;
  readonly ast: Expr;
  readonly type: ValueType;
  /** Slots read by the expression, ascending. */
  readonly slots: readonly number[];
  /** Never throws: run-time failures (division by zero, ...) are returned as errors. */
  evaluate(values: readonly Value[]): Result<Value, ExprError>;
}

type Fn = (v: readonly Value[]) => Value;
type NumFn = (v: readonly Value[]) => number;
type BoolFn = (v: readonly Value[]) => boolean;

interface Typed {
  readonly type: ValueType;
  readonly fn: Fn;
  /** Set for a string literal, so it can be resolved to an enum option. */
  readonly literal?: string;
}

const finite = (x: number, span: Span): number => (Number.isFinite(x) ? x : fail("expr-not-finite", span));

function typeLabel(t: ValueType): string {
  return t.kind === "enum" ? `enum ${t.owner}` : t.kind;
}

function sameType(a: ValueType, b: ValueType): boolean {
  return a.kind === b.kind && (a.kind !== "enum" || a.owner === (b as { owner: string }).owner);
}

// ---------------------------------------------------------------------------------------
// Functions (fixed MVP list; extend on real needs, ROADMAP §7)
// ---------------------------------------------------------------------------------------

interface NumericFunction {
  readonly min: number;
  readonly max: number;
  readonly build: (args: readonly NumFn[], span: Span) => NumFn;
}

const unaryMath = (f: (x: number) => number): NumericFunction => ({ min: 1, max: 1, build: ([a], span) => (v) => finite(f(a!(v)), span) });

const NUMERIC_FUNCTIONS: Readonly<Record<string, NumericFunction>> = {
  abs: unaryMath(Math.abs),
  floor: unaryMath(Math.floor),
  ceil: unaryMath(Math.ceil),
  /** Half rounds up (towards +∞), like Unreal's FMath::RoundToFloat. */
  round: unaryMath(Math.round),
  sqrt: unaryMath(Math.sqrt),
  pow: { min: 2, max: 2, build: ([a, b], span) => (v) => finite(a!(v) ** b!(v), span) },
  min: {
    min: 1,
    max: Number.POSITIVE_INFINITY,
    build: (args) => (v) => {
      let m = args[0]!(v);
      for (let i = 1; i < args.length; i++) m = Math.min(m, args[i]!(v));
      return m;
    },
  },
  max: {
    min: 1,
    max: Number.POSITIVE_INFINITY,
    build: (args) => (v) => {
      let m = args[0]!(v);
      for (let i = 1; i < args.length; i++) m = Math.max(m, args[i]!(v));
      return m;
    },
  },
  /** clamp(x, lo, hi): lo wins when lo > hi. */
  clamp: { min: 3, max: 3, build: ([x, lo, hi]) => (v) => Math.max(lo!(v), Math.min(hi!(v), x!(v))) },
  /** lerp(a, b, t) = a + (b - a) * t; t is not clamped. */
  lerp: {
    min: 3,
    max: 3,
    build: ([a, b, t], span) => (v) => {
      const x = a!(v);
      return finite(x + (b!(v) - x) * t!(v), span);
    },
  },
};

/** Every function name, for the spec, completion and tests. */
export const FUNCTION_NAMES: readonly string[] = ["if", ...Object.keys(NUMERIC_FUNCTIONS)].sort();

// ---------------------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------------------

class Compiler {
  readonly slots = new Set<number>();
  private readonly scope: Scope;

  constructor(scope: Scope) {
    this.scope = scope;
  }

  compile(e: Expr): Typed {
    switch (e.kind) {
      case "number": {
        const x = e.value;
        return { type: NUMBER, fn: () => x };
      }
      case "bool": {
        const b = e.value;
        return { type: BOOL, fn: () => b };
      }
      case "string": {
        const s = e.value;
        return { type: STRING, fn: () => s, literal: s };
      }
      case "name": {
        const entry = this.scope.byName.get(e.name.toLowerCase());
        if (entry === undefined) fail("expr-unknown-name", e.span, { name: e.name });
        this.slots.add(entry.slot);
        const slot = entry.slot;
        return { type: entry.type, fn: (v) => v[slot]! };
      }
      case "unary": {
        const operand = this.compile(e.operand);
        if (e.op === "not") {
          const f = this.expect(operand, BOOL, e.operand.span) as BoolFn;
          return { type: BOOL, fn: (v) => !f(v) };
        }
        const f = this.expect(operand, NUMBER, e.operand.span) as NumFn;
        return { type: NUMBER, fn: (v) => -f(v) };
      }
      case "binary":
        return this.binary(e.op, e.left, e.right, e.span);
      case "call":
        return this.call(e);
    }
  }

  private expect(t: Typed, type: ValueType, span: Span): Fn {
    if (!sameType(t.type, type)) fail("expr-type", span, { expected: typeLabel(type), found: typeLabel(t.type) });
    return t.fn;
  }

  /** Compiles a string literal against an enum type into the option id. */
  private option(t: Typed, type: ValueType & { kind: "enum" }, span: Span): Typed {
    const name = t.literal!.toLowerCase();
    const option = type.options.find((o) => o.name.toLowerCase() === name);
    if (option === undefined) fail("expr-unknown-option", span, { value: t.literal!, enum: type.owner });
    const id = option.id;
    return { type, fn: () => id };
  }

  private binary(op: BinaryOp, leftExpr: Expr, rightExpr: Expr, span: Span): Typed {
    let left = this.compile(leftExpr);
    let right = this.compile(rightExpr);
    switch (op) {
      case "and":
      case "or": {
        const a = this.expect(left, BOOL, leftExpr.span) as BoolFn;
        const b = this.expect(right, BOOL, rightExpr.span) as BoolFn;
        return { type: BOOL, fn: op === "and" ? (v) => a(v) && b(v) : (v) => a(v) || b(v) };
      }
      case "==":
      case "!=": {
        // "Done" next to an enum value names one of its options.
        if (left.type.kind === "enum" && right.literal !== undefined) right = this.option(right, left.type, rightExpr.span);
        else if (right.type.kind === "enum" && left.literal !== undefined) left = this.option(left, right.type, leftExpr.span);
        const a = left.fn;
        const b = this.expect(right, left.type, rightExpr.span);
        return { type: BOOL, fn: op === "==" ? (v) => a(v) === b(v) : (v) => a(v) !== b(v) };
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const a = this.expect(left, NUMBER, leftExpr.span) as NumFn;
        const b = this.expect(right, NUMBER, rightExpr.span) as NumFn;
        const fn: BoolFn = op === "<" ? (v) => a(v) < b(v) : op === "<=" ? (v) => a(v) <= b(v) : op === ">" ? (v) => a(v) > b(v) : (v) => a(v) >= b(v);
        return { type: BOOL, fn };
      }
      case "+":
      case "-":
      case "*":
      case "/":
      case "%":
      case "^": {
        if (op === "+" && left.type.kind === "string") {
          const a = left.fn as (v: readonly Value[]) => string;
          const b = this.expect(right, STRING, rightExpr.span) as (v: readonly Value[]) => string;
          return { type: STRING, fn: (v) => a(v) + b(v) };
        }
        const a = this.expect(left, NUMBER, leftExpr.span) as NumFn;
        const b = this.expect(right, NUMBER, rightExpr.span) as NumFn;
        return { type: NUMBER, fn: arithmetic(op, a, b, span, rightExpr.span) };
      }
    }
  }

  private call(e: Expr & { kind: "call" }): Typed {
    const name = e.name.toLowerCase();
    if (name === "if") {
      if (e.args.length !== 3) fail("expr-arg-count", e.span, { name: "if", min: 3, max: 3 });
      const cond = this.expect(this.compile(e.args[0]!), BOOL, e.args[0]!.span) as BoolFn;
      let then = this.compile(e.args[1]!);
      let otherwise = this.compile(e.args[2]!);
      if (then.type.kind === "enum" && otherwise.literal !== undefined) otherwise = this.option(otherwise, then.type, e.args[2]!.span);
      else if (otherwise.type.kind === "enum" && then.literal !== undefined) then = this.option(then, otherwise.type, e.args[1]!.span);
      const a = then.fn;
      const b = this.expect(otherwise, then.type, e.args[2]!.span);
      // Lazy: only the chosen branch runs, so if(x != 0, 1 / x, 0) is safe.
      return { type: then.type, fn: (v) => (cond(v) ? a(v) : b(v)) };
    }
    const f = NUMERIC_FUNCTIONS[name];
    if (f === undefined || !Object.hasOwn(NUMERIC_FUNCTIONS, name)) fail("expr-unknown-function", e.nameSpan, { name: e.name });
    if (e.args.length < f.min || e.args.length > f.max) {
      fail("expr-arg-count", e.span, { name, min: f.min, max: Number.isFinite(f.max) ? f.max : -1 });
    }
    const args = e.args.map((a) => this.expect(this.compile(a), NUMBER, a.span) as NumFn);
    return { type: NUMBER, fn: f.build(args, e.span) };
  }
}

function arithmetic(op: "+" | "-" | "*" | "/" | "%" | "^", a: NumFn, b: NumFn, span: Span, divisorSpan: Span): NumFn {
  switch (op) {
    case "+":
      return (v) => finite(a(v) + b(v), span);
    case "-":
      return (v) => finite(a(v) - b(v), span);
    case "*":
      return (v) => finite(a(v) * b(v), span);
    case "/":
      return (v) => {
        const d = b(v);
        return d === 0 ? fail("expr-division-by-zero", divisorSpan) : finite(a(v) / d, span);
      };
    case "%":
      return (v) => {
        const d = b(v);
        return d === 0 ? fail("expr-division-by-zero", divisorSpan) : a(v) % d;
      };
    case "^":
      return (v) => finite(a(v) ** b(v), span);
  }
}

export interface CompileOptions {
  /** Required result type, e.g. "bool" for conditions. */
  readonly expect?: TypeName;
}

/** Parses, type-checks and compiles. All errors carry a source range. */
export function compileExpression(source: string, scope: Scope, options: CompileOptions = {}): Result<CompiledExpression, ExprError> {
  const parsed = parseExpression(source);
  if (!parsed.ok) return parsed;
  const ast = parsed.value;
  const compiler = new Compiler(scope);
  let typed: Typed;
  try {
    typed = compiler.compile(ast);
  } catch (e) {
    if (e instanceof ExprException) return err(e.error);
    throw e;
  }
  if (options.expect !== undefined && typed.type.kind !== options.expect) {
    return err({ code: "expr-type", start: ast.span.start, end: ast.span.end, params: { expected: options.expect, found: typeLabel(typed.type) } });
  }
  const fn = typed.fn;
  return ok({
    source,
    ast,
    type: typed.type,
    slots: [...compiler.slots].sort((x, y) => x - y),
    evaluate(values) {
      try {
        return ok(fn(values));
      } catch (e) {
        if (e instanceof ExprException) return err(e.error);
        throw e;
      }
    },
  });
}
