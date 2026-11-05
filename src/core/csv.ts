/**
 * CSV / TSV (RFC 4180). Fields with the delimiter, a quote, CR/LF or surrounding spaces are
 * quoted; quotes are doubled. Output uses "\n" line endings (Git-friendly; Excel, Google
 * Sheets and Unreal all read it). The parser accepts LF and CRLF and strips a UTF-8 BOM.
 */
import { err, ok, type Result } from "./result.ts";

export interface CsvLimits {
  readonly maxChars: number;
  readonly maxCells: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = { maxChars: 64 * 1024 * 1024, maxCells: 20_000_000 };

export type CsvError =
  | { readonly code: "too-large"; readonly limit: number; readonly actual: number }
  | { readonly code: "too-many-cells"; readonly limit: number }
  /** A quoted field was not closed before the end of the text. */
  | { readonly code: "unclosed-quote"; readonly line: number };

/** Parses CSV text into rows of fields. A trailing newline does not add an empty row. */
export function parseCsv(text: string, delimiter = ",", limits: CsvLimits = DEFAULT_CSV_LIMITS): Result<string[][], CsvError> {
  if (text.length > limits.maxChars) return err({ code: "too-large", limit: limits.maxChars, actual: text.length });
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\n" || delimiter === "\r") {
    throw new Error("parseCsv: invalid delimiter");
  }
  const d = delimiter.charCodeAt(0);
  const rows: string[][] = [];
  let row: string[] = [];
  let cells = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const n = text.length;
  if (i >= n) return ok(rows);

  const pushField = (field: string): boolean => {
    row.push(field);
    return ++cells <= limits.maxCells;
  };

  while (i <= n) {
    // Start of a field.
    let field: string;
    if (i < n && text.charCodeAt(i) === 34 /* " */) {
      const startLine = line;
      let out = "";
      let start = ++i;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) return err({ code: "unclosed-quote", line: startLine });
        for (let k = i; k < q; k++) if (text.charCodeAt(k) === 10) line++;
        if (text.charCodeAt(q + 1) === 34) {
          out += text.slice(start, q + 1);
          i = start = q + 2;
          continue;
        }
        out += text.slice(start, q);
        i = q + 1;
        break;
      }
      // Anything between the closing quote and the delimiter is kept (lenient, like Excel).
      let end = i;
      while (end < n) {
        const c = text.charCodeAt(end);
        if (c === d || c === 10 || c === 13) break;
        end++;
      }
      field = out + text.slice(i, end);
      i = end;
    } else {
      let end = i;
      while (end < n) {
        const c = text.charCodeAt(end);
        if (c === d || c === 10 || c === 13) break;
        end++;
      }
      field = text.slice(i, end);
      i = end;
    }
    if (!pushField(field)) return err({ code: "too-many-cells", limit: limits.maxCells });

    if (i >= n) {
      rows.push(row);
      break;
    }
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      continue;
    }
    // End of record: CRLF, LF or lone CR.
    i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    line++;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return ok(rows);
}

export function writeCsv(rows: readonly (readonly string[])[], delimiter = ","): string {
  const out: string[] = [];
  for (const row of rows) {
    out.push(row.map((field) => quoteField(field, delimiter)).join(delimiter), "\n");
  }
  return out.join("");
}

function quoteField(field: string, delimiter: string): string {
  const needsQuotes =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r") ||
    (field.length > 0 && (field[0] === " " || field[field.length - 1] === " "));
  return needsQuotes ? `"${field.replace(/"/g, '""')}"` : field;
}
