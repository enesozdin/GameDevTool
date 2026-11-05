/**
 * CSV value formats. Table ⇄ CSV conversion (table-csv.ts) is engine-neutral: it turns
 * cells into neutral values (strings, numbers, booleans, arrays, records) and lets a
 * format decide how those are written as text. Adding an engine means adding a format,
 * not touching the converter.
 *
 *   generic  engine-neutral default. Complex cells are JSON, which every engine and
 *            spreadsheet tool can read (Unity JsonUtility, Godot JSON, Python, …).
 *            Header of the row-name column: "Name". Booleans: true / false.
 *   unreal   Unreal DataTable import: header "---", True / False, struct/array text
 *            format ((Item="IronOre",Count=2)), FText as NSLOCTEXT(...).
 */
import { DEFAULT_JSON_LIMITS, parseUntrustedJson } from "../json.ts";

/** A neutral value. Records keep key order as written. */
export type CsvStructured = string | number | boolean | readonly CsvStructured[] | { readonly [key: string]: CsvStructured };

export interface CsvTextValue {
  readonly key: string | undefined;
  readonly source: string;
}

export interface CsvFormat {
  readonly id: CsvFormatId;
  /** Header of the first column, which holds the row name. */
  readonly rowNameHeader: string;
  /** Record field name as written, from the neutral lowercase name (e.g. "item"). */
  fieldName(name: string): string;
  formatBool(value: boolean): string;
  /** Writes a list or record cell. */
  formatStructured(value: CsvStructured): string;
  /** Reads a list or record cell; null if malformed. Field names match case-insensitively. */
  parseStructured(text: string): CsvStructured | null;
  /** Localizable text. `namespace` is the table name. */
  formatText(namespace: string, key: string, source: string): string;
  /** Reads localizable text; `key` is undefined when the cell carries only the source. */
  parseText(text: string): CsvTextValue | null;
}

export type CsvFormatId = "generic" | "unreal";

/** Field values inside JSON cells are limited like project files, but tighter. */
const CELL_JSON_LIMITS = { maxChars: DEFAULT_JSON_LIMITS.maxChars, maxDepth: 16, maxValues: 1_000_000 };

export const GENERIC_CSV: CsvFormat = {
  id: "generic",
  rowNameHeader: "Name",
  fieldName: (name) => name,
  formatBool: (value) => (value ? "true" : "false"),
  formatStructured: (value) => JSON.stringify(value),
  parseStructured(text) {
    const parsed = parseUntrustedJson(text.trim(), CELL_JSON_LIMITS);
    return parsed.ok && parsed.value !== null ? (parsed.value as CsvStructured) : null;
  },
  // The localization key travels in the localization export; here only the source.
  formatText: (_namespace, _key, source) => source,
  parseText: (text) => ({ key: undefined, source: text }),
};

// ---------------------------------------------------------------------------------------
// Unreal
// ---------------------------------------------------------------------------------------

function unrealQuote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unrealWrite(value: CsvStructured): string {
  if (typeof value === "string") return unrealQuote(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `(${value.map(unrealWrite).join(",")})`;
  const record = value as { readonly [key: string]: CsvStructured };
  return `(${Object.keys(record)
    .map((k) => `${k}=${unrealWrite(record[k]!)}`)
    .join(",")})`;
}

export const UNREAL_CSV: CsvFormat = {
  id: "unreal",
  rowNameHeader: "---",
  fieldName: (name) => name.charAt(0).toUpperCase() + name.slice(1),
  formatBool: (value) => (value ? "True" : "False"),
  formatStructured: unrealWrite,
  parseStructured: (text) => parseUnrealValue(text.trim()),
  formatText: (namespace, key, source) => `NSLOCTEXT(${unrealQuote(namespace)}, ${unrealQuote(key)}, ${unrealQuote(source)})`,
  parseText(text) {
    const m = /^\s*NSLOCTEXT\s*\(([\s\S]*)\)\s*$/.exec(text);
    if (m === null) return { key: undefined, source: text };
    const args = parseUnrealValue(`(${m[1]})`);
    if (!Array.isArray(args) || args.length !== 3) return null;
    const [, key, source] = args as CsvStructured[];
    return typeof key === "string" && typeof source === "string" ? { key, source } : null;
  },
};

/**
 * Parses Unreal's text import format: "(...)" tuples (with Key=Value fields → record,
 * without → array), "\"...\"" strings with backslash escapes, and bare tokens (kept as
 * strings; the caller converts numbers). Returns null on malformed input.
 */
export function parseUnrealValue(text: string): CsvStructured | null {
  let i = 0;
  let depth = 0;
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  };
  const parseQuoted = (): string | null => {
    let out = "";
    i++;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
      } else if (c === '"') {
        i++;
        return out;
      } else {
        out += c;
        i++;
      }
    }
    return null;
  };
  const parseValue = (): CsvStructured | null => {
    ws();
    if (text[i] === '"') return parseQuoted();
    if (text[i] === "(") {
      if (++depth > 16) return null;
      i++;
      const values: CsvStructured[] = [];
      const record: Record<string, CsvStructured> = {};
      let keyed: boolean | undefined;
      ws();
      if (text[i] === ")") {
        i++;
        depth--;
        return values;
      }
      for (;;) {
        ws();
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text.slice(i, i + 80));
        if (keyed === undefined) keyed = m !== null;
        else if (keyed !== (m !== null)) return null; // mixed tuple
        if (m !== null) i += m[0].length;
        const value = parseValue();
        if (value === null) return null;
        if (m !== null) {
          // Own property only; forbidden keys cannot pollute a plain record via defineProperty.
          if (m[1] === "__proto__" || m[1] === "constructor" || m[1] === "prototype") return null;
          record[m[1]!] = value;
        } else {
          values.push(value);
        }
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === ")") {
          i++;
          depth--;
          return keyed ? record : values;
        }
        return null;
      }
    }
    const start = i;
    while (i < text.length && !',()"'.includes(text[i]!)) i++;
    return text.slice(start, i).trim();
  };
  const value = parseValue();
  ws();
  return value !== null && i === text.length ? value : null;
}

export const CSV_FORMATS: Readonly<Record<CsvFormatId, CsvFormat>> = { generic: GENERIC_CSV, unreal: UNREAL_CSV };
