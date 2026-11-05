/**
 * Plain-text editing of cells in the grid. Short syntaxes designers can type:
 *   list    a, b, c
 *   stacks  IronOre*2, Slag*1@0.1     (item*count@chance; count defaults to 1)
 * Engine exports use csv-formats.ts instead; this is only the in-app editing syntax.
 */
import type { CellValue, ColumnType, Id, ItemStack, RowNames, ScalarType } from "../../core/index.ts";
import { parseNumberInput } from "../production/format.ts";

/** undefined = invalid input; null = empty cell. */
export type Parsed = CellValue | undefined;

export function cellToText(type: ColumnType, value: CellValue | undefined, names: RowNames): string {
  if (value === undefined || value === null) return "";
  switch (type.kind) {
    case "text":
      return typeof value === "object" && !Array.isArray(value) && "source" in value ? value.source : "";
    case "stacks":
      return Array.isArray(value)
        ? value
            .filter((s): s is ItemStack => s !== null && typeof s === "object")
            .map((s) => `${names.name(s.item) ?? s.item}*${s.count}${s.chance === undefined ? "" : `@${s.chance}`}`)
            .join(", ")
        : "";
    case "list":
      return Array.isArray(value) ? value.map((v) => (v === null || typeof v === "object" ? "" : scalarToText(type.item, v, names))).join(", ") : "";
    case "curve":
      return "";
    default:
      return typeof value === "object" ? "" : scalarToText(type, value, names);
  }
}

function scalarToText(type: ScalarType, value: string | number | boolean, names: RowNames): string {
  if (type.kind === "enum") return type.options.find((o) => o.id === value)?.name ?? String(value);
  if (type.kind === "reference") return names.name(String(value)) ?? String(value);
  return String(value);
}

function scalarFromText(type: ScalarType, text: string, names: RowNames): string | number | boolean | undefined {
  const t = text.trim();
  switch (type.kind) {
    case "int": {
      const n = parseNumberInput(t);
      return typeof n === "number" && Number.isSafeInteger(n) ? n : undefined;
    }
    case "float": {
      const n = parseNumberInput(t);
      return typeof n === "number" ? n : undefined;
    }
    case "bool":
      return t === "true" ? true : t === "false" ? false : undefined;
    case "string":
      return text;
    case "enum":
      return type.options.find((o) => o.name.toLowerCase() === t.toLowerCase())?.id;
    case "reference":
      return names.find(type.table, t);
  }
}

export function textToCell(type: ColumnType, text: string, names: RowNames, previous: CellValue | undefined, newId: () => Id): Parsed {
  if (text.trim() === "" && type.kind !== "string") return null;
  switch (type.kind) {
    case "text": {
      const key = previous !== null && typeof previous === "object" && !Array.isArray(previous) && "key" in previous ? previous.key : newId();
      return { key, source: text };
    }
    case "stacks": {
      const out: ItemStack[] = [];
      for (const part of text.split(",")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\*\s*([0-9.eE+-]+))?\s*(?:@\s*([0-9.eE+-]+))?\s*$/.exec(part);
        if (m === null) return undefined;
        const item = names.find(type.table, m[1]!);
        const count = m[2] === undefined ? 1 : parseNumberInput(m[2]);
        const chance = m[3] === undefined ? undefined : parseNumberInput(m[3]);
        if (item === undefined || typeof count !== "number" || !(count > 0 && count <= 1e12)) return undefined;
        if (chance !== undefined && (typeof chance !== "number" || !(chance > 0 && chance <= 1))) return undefined;
        out.push(chance === undefined || chance === 1 ? { item, count } : { item, count, chance });
      }
      return out;
    }
    case "list": {
      const out: (string | number | boolean)[] = [];
      for (const part of text.split(",")) {
        const v = scalarFromText(type.item, type.item.kind === "string" ? part.trim() : part, names);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case "curve":
      return previous;
    default:
      if (type.kind === "string" && text === "") return null;
      return scalarFromText(type, text, names);
  }
}
