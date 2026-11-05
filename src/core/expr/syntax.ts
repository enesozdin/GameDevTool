/**
 * Expression language: tokens, AST and errors (spec: docs/EXPRESSIONS.md).
 * One language for production gates, table formulas, dialogue conditions and loot rules.
 * Source text is parsed by our own code and compiled to closures; it is never run as
 * JavaScript.
 */

export const EXPR_LIMITS = {
  /** Characters of source text. */
  length: 10_000,
  /** Nesting depth of the syntax tree (parentheses, operators, calls). */
  depth: 64,
  /** Arguments per function call. */
  args: 64,
} as const;

/** Half-open character range [start, end) in the source text. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * A compile-time or run-time error. Core never produces user-facing text: `code` is a
 * stable identifier, `params` holds what the UI needs to build a localized message.
 */
export interface ExprError extends Span {
  readonly code: ExprErrorCode;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type ExprErrorCode =
  | "expr-empty"
  | "expr-too-long"
  | "expr-too-deep"
  | "expr-unexpected-char"
  | "expr-unterminated-string"
  | "expr-bad-escape"
  | "expr-bad-number"
  | "expr-unexpected-token"
  | "expr-expected"
  | "expr-chained-comparison"
  | "expr-unknown-name"
  | "expr-unknown-function"
  | "expr-arg-count"
  | "expr-type"
  | "expr-unknown-option"
  | "expr-division-by-zero"
  | "expr-not-finite";

export class ExprException extends Error {
  readonly error: ExprError;
  constructor(error: ExprError) {
    super(error.code);
    this.error = error;
  }
}

export function fail(code: ExprErrorCode, span: Span, params?: Record<string, string | number>): never {
  throw new ExprException(params === undefined ? { code, start: span.start, end: span.end } : { code, start: span.start, end: span.end, params });
}

// ---------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------

/** `op`: operators and punctuation; `text` holds the canonical spelling. */
export type TokenKind = "number" | "string" | "name" | "op" | "end";

export interface Token extends Span {
  readonly kind: TokenKind;
  /** Canonical text: lower-case keyword, unescaped string, operator ("&&" → "and"). */
  readonly text: string;
  readonly value: number;
}

/** Keywords are case-insensitive, like names. They cannot be used as variable names. */
export const KEYWORDS: ReadonlySet<string> = new Set(["and", "or", "not", "true", "false"]);

// ---------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------

export type BinaryOp = "or" | "and" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%" | "^";
export type UnaryOp = "not" | "-";

export type Expr =
  | { readonly kind: "number"; readonly value: number; readonly span: Span }
  | { readonly kind: "string"; readonly value: string; readonly span: Span }
  | { readonly kind: "bool"; readonly value: boolean; readonly span: Span }
  /** `name` as written; resolved case-insensitively. */
  | { readonly kind: "name"; readonly name: string; readonly span: Span }
  | { readonly kind: "unary"; readonly op: UnaryOp; readonly operand: Expr; readonly span: Span }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr; readonly span: Span }
  | { readonly kind: "call"; readonly name: string; readonly nameSpan: Span; readonly args: readonly Expr[]; readonly span: Span };
