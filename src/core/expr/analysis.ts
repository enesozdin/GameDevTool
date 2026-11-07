/**
 * Static reasoning about conditions, for checks like "recipe unlocked before its input".
 *
 * A condition is split into its top-level `and` terms ("atoms"). Atom A implies atom B when
 * both print the same canonically, or when both compare the same variable with a number
 * and A's range lies inside B's (`Level >= 5` implies `Level > 3`). Anything else is
 * treated as unrelated, so the analysis is conservative: it may miss an implication, but
 * never claims one that does not hold.
 */
import type { Scope } from "./compile.ts";
import type { BinaryOp, Expr } from "./syntax.ts";

const PRECEDENCE: Readonly<Record<BinaryOp, number>> = {
  or: 1,
  and: 2,
  "==": 4,
  "!=": 4,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "^": 8,
};
const NOT_PRECEDENCE = 3;
const NEGATE_PRECEDENCE = 7;

/**
 * Canonical text: names in their declared spelling (when the scope knows them), lower-case
 * functions, minimal parentheses, single spaces. Equal meaning-preserving rewrites of the
 * same expression print the same, e.g. `(a&&B)` and `A and b`.
 */
export function printExpression(e: Expr, scope?: Scope): string {
  return print(e, scope, 0);
}

function print(e: Expr, scope: Scope | undefined, outer: number): string {
  switch (e.kind) {
    case "number":
      return String(e.value);
    case "bool":
      return e.value ? "true" : "false";
    case "string":
      return JSON.stringify(e.value);
    case "name":
      return scope?.byName.get(e.name.toLowerCase())?.name ?? e.name;
    case "member":
      return `${print(e.object, scope, 0)}.${e.name}`;
    case "call":
      return `${e.name.toLowerCase()}(${e.args.map((a) => print(a, scope, 0)).join(", ")})`;
    case "unary": {
      const p = e.op === "not" ? NOT_PRECEDENCE : NEGATE_PRECEDENCE;
      const text = e.op === "not" ? `not ${print(e.operand, scope, p)}` : `-${print(e.operand, scope, p)}`;
      return p < outer ? `(${text})` : text;
    }
    case "binary": {
      const p = PRECEDENCE[e.op];
      // Comparisons do not chain and ^ is right-associative: parenthesize the other side.
      const leftP = e.op === "^" || p === 4 ? p + 1 : p;
      const rightP = e.op === "^" ? p : p + 1;
      const text = `${print(e.left, scope, leftP)} ${e.op} ${print(e.right, scope, rightP)}`;
      return p < outer ? `(${text})` : text;
    }
  }
}

/** Top-level `and` terms, left to right. */
export function conjuncts(e: Expr): Expr[] {
  const out: Expr[] = [];
  const walk = (x: Expr) => {
    if (x.kind === "binary" && x.op === "and") {
      walk(x.left);
      walk(x.right);
    } else out.push(x);
  };
  walk(e);
  return out;
}

/** One atom of a condition, ready for implication tests. */
export interface Atom {
  readonly text: string;
  /** Set when the atom is `name <op> number` (either order). */
  readonly range?: Range;
}

interface Range {
  /** Lower-case variable name. */
  readonly name: string;
  readonly lo: number;
  readonly loOpen: boolean;
  readonly hi: number;
  readonly hiOpen: boolean;
  /** `!=`: every value except `lo`. */
  readonly except?: boolean;
}

const FLIP: Readonly<Record<string, BinaryOp>> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };

function rangeOf(e: Expr): Range | undefined {
  if (e.kind !== "binary" || FLIP[e.op] === undefined) return undefined;
  let op = e.op;
  let name: string;
  let x: number;
  if (e.left.kind === "name" && e.right.kind === "number") {
    name = e.left.name;
    x = e.right.value;
  } else if (e.left.kind === "number" && e.right.kind === "name") {
    name = e.right.name;
    x = e.left.value;
    op = FLIP[op]!;
  } else return undefined;
  name = name.toLowerCase();
  const inf = Number.POSITIVE_INFINITY;
  switch (op) {
    case ">":
      return { name, lo: x, loOpen: true, hi: inf, hiOpen: true };
    case ">=":
      return { name, lo: x, loOpen: false, hi: inf, hiOpen: true };
    case "<":
      return { name, lo: -inf, loOpen: true, hi: x, hiOpen: true };
    case "<=":
      return { name, lo: -inf, loOpen: true, hi: x, hiOpen: false };
    case "==":
      return { name, lo: x, loOpen: false, hi: x, hiOpen: false };
    default:
      return { name, lo: x, loOpen: false, hi: x, hiOpen: false, except: true };
  }
}

/** Atoms of a condition (canonical text + numeric range where it applies). */
export function atomsOf(e: Expr, scope?: Scope): Atom[] {
  return conjuncts(e).map((x) => {
    const range = rangeOf(x);
    return range === undefined ? { text: printExpression(x, scope) } : { text: printExpression(x, scope), range };
  });
}

/** True when every value allowed by `a` is allowed by `b`. */
function rangeImplies(a: Range, b: Range): boolean {
  if (a.name !== b.name) return false;
  if (b.except === true) {
    if (a.except === true) return a.lo === b.lo;
    // `a` must exclude the value b.lo.
    return a.lo > b.lo || a.hi < b.lo || (a.lo === b.lo && a.loOpen) || (a.hi === b.lo && a.hiOpen);
  }
  if (a.except === true) return false;
  const loOk = a.lo > b.lo || (a.lo === b.lo && (a.loOpen || !b.loOpen));
  const hiOk = a.hi < b.hi || (a.hi === b.hi && (a.hiOpen || !b.hiOpen));
  return loOk && hiOk;
}

export function atomImplies(a: Atom, b: Atom): boolean {
  if (a.text === b.text) return true;
  return a.range !== undefined && b.range !== undefined && rangeImplies(a.range, b.range);
}

/** True when the conjunction `given` implies every atom of `required`. */
export function conditionImplies(given: readonly Atom[], required: readonly Atom[]): boolean {
  return required.every((r) => given.some((g) => atomImplies(g, r)));
}

/** Atoms of `required` that `given` does not imply. */
export function missingAtoms(given: readonly Atom[], required: readonly Atom[]): Atom[] {
  return required.filter((r) => !given.some((g) => atomImplies(g, r)));
}
