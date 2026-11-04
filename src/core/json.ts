import { err, ok, type Result } from "./result.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Keys that can reach Object.prototype through careless merging. Rejected anywhere in a file. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export interface JsonLimits {
  /** Maximum input length in UTF-16 code units (checked before parsing). */
  readonly maxChars: number;
  /** Maximum nesting depth of arrays/objects. The root container is depth 1. */
  readonly maxDepth: number;
  /** Maximum number of values (containers + primitives) in the document. */
  readonly maxValues: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxChars: 64 * 1024 * 1024,
  maxDepth: 64,
  maxValues: 10_000_000,
};

export type JsonParseError =
  | { readonly code: "too-large"; readonly limit: number; readonly actual: number }
  | { readonly code: "invalid-json" }
  | { readonly code: "too-deep"; readonly limit: number }
  | { readonly code: "too-many-values"; readonly limit: number }
  | { readonly code: "forbidden-key"; readonly key: string };

/**
 * Parses untrusted JSON text (project files). Never executes anything: plain JSON.parse,
 * then one iterative pass (no recursion, so hostile nesting cannot overflow the stack)
 * that enforces the depth/value limits and rejects prototype-polluting keys.
 */
export function parseUntrustedJson(text: string, limits: JsonLimits = DEFAULT_JSON_LIMITS): Result<JsonValue, JsonParseError> {
  if (text.length > limits.maxChars) {
    return err({ code: "too-large", limit: limits.maxChars, actual: text.length });
  }

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return err({ code: "invalid-json" });
  }

  // Parallel stacks avoid allocating a tuple per visited container.
  const stack: unknown[] = [root];
  const depths: number[] = [1];
  let values = 0;

  while (stack.length > 0) {
    const value = stack.pop();
    const depth = depths.pop()!;
    values++;
    if (values > limits.maxValues) return err({ code: "too-many-values", limit: limits.maxValues });
    if (value === null || typeof value !== "object") continue;
    if (depth > limits.maxDepth) return err({ code: "too-deep", limit: limits.maxDepth });

    const childDepth = depth + 1;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        stack.push(value[i]);
        depths.push(childDepth);
      }
    } else {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (FORBIDDEN_KEYS.has(key)) return err({ code: "forbidden-key", key });
        stack.push(obj[key]);
        depths.push(childDepth);
      }
    }
  }

  return ok(root as JsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deterministic, Git-friendly JSON: object keys sorted (code-unit order), arrays keep
 * their order, 2-space indent, "\n" line endings, trailing newline. The same data always
 * produces the same bytes, so diffs only show real changes.
 * `undefined` properties are skipped, like JSON.stringify.
 */
export function stableStringify(value: unknown): string {
  const out: string[] = [];
  writeValue(out, value, "");
  out.push("\n");
  return out.join("");
}

const INDENT = "  ";

function writeValue(out: string[], value: unknown, indent: string): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("stableStringify: non-finite number");
      out.push(JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`stableStringify: unsupported type ${typeof value}`);
  }

  const inner = indent + INDENT;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push("[]");
      return;
    }
    out.push("[\n");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",\n");
      out.push(inner);
      // Like JSON.stringify: holes/undefined in arrays become null.
      writeValue(out, value[i] === undefined ? null : value[i], inner);
    }
    out.push("\n", indent, "]");
    return;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  if (keys.length === 0) {
    out.push("{}");
    return;
  }
  out.push("{\n");
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (i > 0) out.push(",\n");
    out.push(inner, JSON.stringify(key), ": ");
    writeValue(out, obj[key], inner);
  }
  out.push("\n", indent, "}");
}
