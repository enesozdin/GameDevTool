/**
 * Tokenizer + recursive-descent parser. Precedence, lowest first (docs/EXPRESSIONS.md):
 *
 *   or  →  and  →  not  →  comparison (non-associative)  →  + -  →  * / %  →  unary -  →  ^  →  call / member / primary
 *
 * `not` binds looser than comparisons (as in Python), so `not Level >= 5` means
 * `not (Level >= 5)`. `^` is right-associative and binds tighter than unary minus:
 * `-2 ^ 2` is -4.
 */
import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";
import { EXPR_LIMITS, ExprException, fail, KEYWORDS, type BinaryOp, type Expr, type ExprError, type Span, type Token } from "./syntax.ts";

const isDigit = (c: number) => c >= 48 && c <= 57;
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isNamePart = (c: number) => isNameStart(c) || isDigit(c);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** Two-character operators first, so "<=" wins over "<". Aliases map to one spelling. */
const OPERATORS: readonly (readonly [string, string])[] = [
  ["&&", "and"],
  ["||", "or"],
  ["==", "=="],
  ["!=", "!="],
  ["<=", "<="],
  [">=", ">="],
  ["<", "<"],
  [">", ">"],
  ["!", "not"],
  ["+", "+"],
  ["-", "-"],
  ["*", "*"],
  ["/", "/"],
  ["%", "%"],
  ["^", "^"],
  ["(", "("],
  [")", ")"],
  [",", ","],
  [".", "."],
];

const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", n: "\n", t: "\t" };

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  outer: while (i < n) {
    const c = source.charCodeAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === 46 && isDigit(source.charCodeAt(i + 1)))) {
      while (isDigit(source.charCodeAt(i))) i++;
      if (source.charCodeAt(i) === 46) {
        i++;
        while (isDigit(source.charCodeAt(i))) i++;
      }
      const e = source.charCodeAt(i);
      if (e === 101 || e === 69) {
        i++;
        const sign = source.charCodeAt(i);
        if (sign === 43 || sign === 45) i++;
        if (!isDigit(source.charCodeAt(i))) fail("expr-bad-number", { start, end: i });
        while (isDigit(source.charCodeAt(i))) i++;
      }
      // "2x" or "1.2.3" is a typo, not a number followed by a name.
      if (isNameStart(source.charCodeAt(i)) || source.charCodeAt(i) === 46) {
        while (isNamePart(source.charCodeAt(i)) || source.charCodeAt(i) === 46) i++;
        fail("expr-bad-number", { start, end: i });
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) fail("expr-bad-number", { start, end: i });
      tokens.push({ kind: "number", text, value, start, end: i });
      continue;
    }
    if (isNameStart(c)) {
      while (isNamePart(source.charCodeAt(i))) i++;
      const text = source.slice(start, i);
      const lower = text.toLowerCase();
      if (KEYWORDS.has(lower)) tokens.push({ kind: lower === "true" || lower === "false" ? "name" : "op", text: lower, value: 0, start, end: i });
      else tokens.push({ kind: "name", text, value: 0, start, end: i });
      continue;
    }
    if (c === 34) {
      i++;
      let text = "";
      let chunk = i;
      while (i < n) {
        const d = source.charCodeAt(i);
        if (d === 34) {
          text += source.slice(chunk, i);
          i++;
          tokens.push({ kind: "string", text, value: 0, start, end: i });
          continue outer;
        }
        if (d === 92) {
          text += source.slice(chunk, i);
          const escaped = ESCAPES[source.charAt(i + 1)];
          if (escaped === undefined) fail("expr-bad-escape", { start: i, end: Math.min(i + 2, n) });
          text += escaped;
          i += 2;
          chunk = i;
          continue;
        }
        if (d === 10 || d === 13) break;
        i++;
      }
      fail("expr-unterminated-string", { start, end: i });
    }
    for (const [spelling, canonical] of OPERATORS) {
      if (source.startsWith(spelling, i)) {
        i += spelling.length;
        tokens.push({ kind: "op", text: canonical, value: 0, start, end: i });
        continue outer;
      }
    }
    // Report whole code points, so an emoji is not split into surrogate halves.
    const cp = source.codePointAt(i)!;
    fail("expr-unexpected-char", { start, end: i + (cp > 0xffff ? 2 : 1) }, { char: String.fromCodePoint(cp) });
  }
  tokens.push({ kind: "end", text: "", value: 0, start: n, end: n });
  return tokens;
}

const COMPARISONS: ReadonlySet<string> = new Set(["==", "!=", "<", "<=", ">", ">="]);

class Parser {
  private pos = 0;
  private depth = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parse(): Expr {
    const expr = this.or();
    const t = this.peek();
    if (t.kind !== "end") this.unexpected(t);
    return expr;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.text === text;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private unexpected(t: Token): never {
    if (t.kind === "end") fail("expr-unexpected-token", t, { found: "" });
    fail("expr-unexpected-token", t, { found: t.text });
  }

  private enter(at: Span): void {
    if (++this.depth > EXPR_LIMITS.depth) fail("expr-too-deep", at, { limit: EXPR_LIMITS.depth });
  }

  private binary(op: BinaryOp, left: Expr, right: Expr): Expr {
    return { kind: "binary", op, left, right, span: { start: left.span.start, end: right.span.end } };
  }

  /**
   * Operator chains build left-deep trees: `a + b + c` is `(a + b) + c`. Every operator in a
   * chain is one more level for the compiler and the evaluator, which recurse per level, so
   * each one counts toward EXPR_LIMITS.depth like a pair of parentheses.
   */
  private or(): Expr {
    const depth = this.depth;
    let left = this.and();
    while (this.isOp("or")) {
      this.enter(this.next());
      left = this.binary("or", left, this.and());
    }
    this.depth = depth;
    return left;
  }

  private and(): Expr {
    const depth = this.depth;
    let left = this.not();
    while (this.isOp("and")) {
      this.enter(this.next());
      left = this.binary("and", left, this.not());
    }
    this.depth = depth;
    return left;
  }

  private not(): Expr {
    if (!this.isOp("not")) return this.comparison();
    const t = this.next();
    this.enter(t);
    const operand = this.not();
    this.depth--;
    return { kind: "unary", op: "not", operand, span: { start: t.start, end: operand.span.end } };
  }

  private comparison(): Expr {
    const left = this.additive();
    const t = this.peek();
    if (t.kind !== "op" || !COMPARISONS.has(t.text)) return left;
    this.next();
    const expr = this.binary(t.text as BinaryOp, left, this.additive());
    const after = this.peek();
    if (after.kind === "op" && COMPARISONS.has(after.text)) fail("expr-chained-comparison", after);
    return expr;
  }

  private additive(): Expr {
    const depth = this.depth;
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.text !== "+" && t.text !== "-")) break;
      this.enter(this.next());
      left = this.binary(t.text, left, this.multiplicative());
    }
    this.depth = depth;
    return left;
  }

  private multiplicative(): Expr {
    const depth = this.depth;
    let left = this.negation();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.text !== "*" && t.text !== "/" && t.text !== "%")) break;
      this.enter(this.next());
      left = this.binary(t.text, left, this.negation());
    }
    this.depth = depth;
    return left;
  }

  private negation(): Expr {
    if (!this.isOp("-")) return this.power();
    const t = this.next();
    this.enter(t);
    const operand = this.negation();
    this.depth--;
    return { kind: "unary", op: "-", operand, span: { start: t.start, end: operand.span.end } };
  }

  private power(): Expr {
    const base = this.primary();
    if (!this.isOp("^")) return base;
    const t = this.next();
    this.enter(t);
    // Right-associative; the exponent may carry its own sign: 2 ^ -1.
    const exponent = this.negation();
    this.depth--;
    return this.binary("^", base, exponent);
  }

  private primary(): Expr {
    const t = this.next();
    switch (t.kind) {
      case "number":
        return { kind: "number", value: t.value, span: t };
      case "string":
        return { kind: "string", value: t.text, span: t };
      case "name": {
        if (t.text === "true" || t.text === "false") return { kind: "bool", value: t.text === "true", span: t };
        if (!this.isOp("(")) return this.members({ kind: "name", name: t.text, span: t });
        this.next();
        this.enter(t);
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            if (args.length === EXPR_LIMITS.args) fail("expr-arg-count", this.peek(), { name: t.text, max: EXPR_LIMITS.args });
            args.push(this.or());
            if (!this.isOp(",")) break;
            this.next();
          }
        }
        const close = this.expect(")");
        this.depth--;
        return { kind: "call", name: t.text, nameSpan: t, args, span: { start: t.start, end: close.end } };
      }
      case "op":
        if (t.text === "(") {
          this.enter(t);
          const inner = this.or();
          const close = this.expect(")");
          this.depth--;
          // Keep the parentheses in the span, so errors underline what the user wrote.
          return { ...inner, span: { start: t.start, end: close.end } };
        }
        return this.unexpected(t);
      default:
        return this.unexpected(t);
    }
  }

  /** `a.b.c`: member access after a name. Each `.` is one nesting level. */
  private members(first: Expr): Expr {
    if (!this.isOp(".")) return first;
    const depth = this.depth;
    let object = first;
    while (this.isOp(".")) {
      this.enter(this.next());
      const t = this.next();
      if (t.kind !== "name" || t.text === "true" || t.text === "false") this.unexpected(t);
      object = { kind: "member", object, name: t.text, nameSpan: t, span: { start: first.span.start, end: t.end } };
    }
    this.depth = depth;
    return object;
  }

  private expect(text: string): Token {
    const t = this.peek();
    if (t.kind === "op" && t.text === text) return this.next();
    fail("expr-expected", t, { expected: text, found: t.text });
  }
}

/** Parses source text into an AST. Blank text is `expr-empty`. */
export function parseExpression(source: string): Result<Expr, ExprError> {
  if (source.length > EXPR_LIMITS.length) return err({ code: "expr-too-long", start: 0, end: source.length, params: { limit: EXPR_LIMITS.length } });
  try {
    const tokens = tokenize(source);
    if (tokens.length === 1) return err({ code: "expr-empty", start: 0, end: source.length });
    return ok(new Parser(tokens).parse());
  } catch (e) {
    return err(caught(e, { start: 0, end: source.length }));
  }
}

/**
 * Turns an exception from parsing, compiling or evaluating into an error. A stack overflow
 * cannot happen within EXPR_LIMITS; it is still reported as too deep instead of escaping,
 * so untrusted project files can never crash loading.
 */
export function caught(e: unknown, span: Span): ExprError {
  if (e instanceof ExprException) return e.error;
  if (e instanceof RangeError) return { code: "expr-too-deep", start: span.start, end: span.end, params: { limit: EXPR_LIMITS.depth } };
  throw e;
}
