import type { Issue, IssuePath } from "../result.ts";
import type { EnumOption, Id } from "./primitives.ts";
import type { Project } from "./project.ts";
import { buildReferenceIndex, type ReferenceIndex } from "./references.ts";
import type { CellValue, Column, ColumnType, ScalarType, TableAsset } from "./table.ts";
import { ULID_PATTERN } from "../ids.ts";
import type { Asset } from "./project.ts";
import { validateProductionGraph } from "../production/validate-graph.ts";

/**
 * Semantic checks that a structural schema cannot express: global id uniqueness,
 * name uniqueness, cell values against their column types, broken references.
 * Runs after the zod parse, so the project is structurally valid here.
 * Paths are allocated only when an issue is reported, so clean projects stay cheap.
 */
export function validateProject(project: Project, index: ReferenceIndex = buildReferenceIndex(project)): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<Id>();
  const claimId = (id: Id, path: () => IssuePath): void => {
    if (ids.has(id)) issues.push({ severity: "error", code: "duplicate-id", path: path(), params: { id } });
    else ids.add(id);
  };

  claimId(project.manifest.id, () => ["manifest", "id"]);

  // Variables
  const variableNames = new NameSet();
  project.manifest.variables.forEach((variable, i) => {
    claimId(variable.id, () => ["manifest", "variables", i, "id"]);
    if (!variableNames.add(variable.name)) {
      issues.push({ severity: "error", code: "duplicate-name", path: ["manifest", "variables", i, "name"], params: { name: variable.name } });
    }
    if (variable.type === "enum") {
      checkEnumOptions(variable.options, ["manifest", "variables", i, "options"], claimId, issues);
      if (!variable.options.some((o) => o.id === variable.default)) {
        issues.push({ severity: "error", code: "unknown-option", path: ["manifest", "variables", i, "default"], params: { value: variable.default } });
      }
    }
  });

  project.manifest.characters.forEach((character, i) => claimId(character.id, () => ["manifest", "characters", i, "id"]));

  // Assets
  const locKeys = new Set<string>();
  const assetsById = new Map<Id, Asset>();
  for (const asset of project.assets) assetsById.set(asset.id, asset);
  project.assets.forEach((asset, assetIndex) => {
    claimId(asset.id, () => ["assets", assetIndex, "id"]);
    if (asset.kind === "table") {
      validateTable(asset, assetIndex, claimId, locKeys, issues);
      if (asset.role !== undefined) validateRole(asset, assetIndex, assetsById, issues);
    } else if (asset.kind === "production-graph") {
      asset.nodes.forEach((node, i) => claimId(node.id, () => ["assets", assetIndex, "nodes", i, "id"]));
      asset.edges.forEach((edge, i) => claimId(edge.id, () => ["assets", assetIndex, "edges", i, "id"]));
      validateProductionGraph(project, asset, assetIndex, assetsById, issues);
    }
  });

  checkDocumentCycles(project, issues);

  for (const ref of index.broken) {
    issues.push({ severity: "error", code: "broken-reference", path: ref.path, params: { target: ref.target } });
  }
  return issues;
}

/** Case-insensitive name set (identifiers are ASCII, so toLowerCase is safe). */
class NameSet {
  private readonly names = new Set<string>();
  add(name: string): boolean {
    const key = name.toLowerCase();
    if (this.names.has(key)) return false;
    this.names.add(key);
    return true;
  }
}

type ClaimId = (id: Id, path: () => IssuePath) => void;

function checkEnumOptions(options: readonly EnumOption[], path: IssuePath, claimId: ClaimId, issues: Issue[]): void {
  const names = new NameSet();
  options.forEach((option, i) => {
    claimId(option.id, () => [...path, i, "id"]);
    if (!names.add(option.name)) issues.push({ severity: "error", code: "duplicate-name", path: [...path, i, "name"], params: { name: option.name } });
  });
}

function validateTable(table: TableAsset, assetIndex: number, claimId: ClaimId, locKeys: Set<string>, issues: Issue[]): void {
  const base: IssuePath = ["assets", assetIndex];
  const columnIds = new Set<Id>();
  const columnNames = new NameSet();

  table.columns.forEach((column, c) => {
    claimId(column.id, () => [...base, "columns", c, "id"]);
    columnIds.add(column.id);
    if (!columnNames.add(column.name)) {
      issues.push({ severity: "error", code: "duplicate-name", path: [...base, "columns", c, "name"], params: { name: column.name } });
    }
    checkColumnType(column.type, [...base, "columns", c, "type"], claimId, issues);
  });

  // One map per unique column: value -> first row index.
  const uniqueSeen = new Map<Id, Map<string | number, number>>();
  for (const column of table.columns) {
    const t = column.type;
    if ((t.kind === "int" || t.kind === "string") && t.unique === true) uniqueSeen.set(column.id, new Map());
  }

  const rowNames = new NameSet();
  // One reusable location object instead of a closure per cell.
  const at: CellLocation = { base, row: 0, column: "" };
  table.rows.forEach((row, r) => {
    at.row = r;
    claimId(row.id, () => [...base, "rows", r, "id"]);
    if (!rowNames.add(row.name)) {
      issues.push({ severity: "error", code: "duplicate-name", path: [...base, "rows", r, "name"], params: { name: row.name } });
    }

    for (const column of table.columns) {
      const value = row.cells[column.id];
      at.column = column.id;
      if (value === undefined || value === null) {
        if (column.required === true) issues.push({ severity: "error", code: "required-missing", path: cellPath(at) });
        continue;
      }
      checkCell(column.type, value, at, locKeys, issues);

      const seen = uniqueSeen.get(column.id);
      if (seen !== undefined && (typeof value === "number" || typeof value === "string")) {
        const first = seen.get(value);
        if (first === undefined) seen.set(value, r);
        else issues.push({ severity: "error", code: "duplicate-value", path: cellPath(at), params: { firstRow: first } });
      }
    }

    for (const key of Object.keys(row.cells)) {
      if (!columnIds.has(key)) issues.push({ severity: "warning", code: "unknown-column", path: [...base, "rows", r, "cells", key] });
    }
  });
}

// ---------------------------------------------------------------------------------------
// Table roles (Production Chain Editor)
// ---------------------------------------------------------------------------------------

type ColumnCheck = (type: ColumnType) => boolean;
const isNumber: ColumnCheck = (t) => t.kind === "int" || t.kind === "float";
const isStacks: ColumnCheck = (t) => t.kind === "stacks";
const isString: ColumnCheck = (t) => t.kind === "string";
const isStringList: ColumnCheck = (t) => t.kind === "list" && t.item.kind === "string";

function validateRole(table: TableAsset, assetIndex: number, assets: ReadonlyMap<Id, Asset>, issues: Issue[]): void {
  const role = table.role!;
  const columns = new Map<Id, Column>();
  for (const column of table.columns) columns.set(column.id, column);
  const check = (field: string, columnId: Id | undefined, ok: ColumnCheck): Column | undefined => {
    if (columnId === undefined) return undefined;
    const path: IssuePath = ["assets", assetIndex, "role", field];
    const column = columns.get(columnId);
    if (column === undefined) issues.push({ severity: "error", code: "role-column-missing", path, params: { field } });
    else if (!ok(column.type)) issues.push({ severity: "error", code: "role-column-type", path, params: { field } });
    else return column;
    return undefined;
  };
  const checkTableRole = (field: string, column: Column | undefined, kind: "items" | "machines"): void => {
    if (column === undefined || (column.type.kind !== "stacks" && column.type.kind !== "reference")) return;
    const target = assets.get(column.type.table);
    // A missing table is reported as a broken reference.
    if (target !== undefined && (target.kind !== "table" || target.role?.kind !== kind)) {
      issues.push({ severity: "error", code: "role-mismatch", path: ["assets", assetIndex, "role", field], params: { expected: kind } });
    }
  };

  switch (role.kind) {
    case "items":
      check("tags", role.tags, isStringList);
      return;
    case "recipes": {
      const inputs = check("inputs", role.inputs, isStacks);
      const outputs = check("outputs", role.outputs, isStacks);
      checkTableRole("inputs", inputs, "items");
      checkTableRole("outputs", outputs, "items");
      if (inputs !== undefined && outputs !== undefined && inputs.type.kind === "stacks" && outputs.type.kind === "stacks" && inputs.type.table !== outputs.type.table) {
        issues.push({ severity: "error", code: "role-items-mismatch", path: ["assets", assetIndex, "role", "outputs"] });
      }
      check("time", role.time, isNumber);
      checkTableRole("machine", check("machine", role.machine, (t) => t.kind === "reference"), "machines");
      check("gate", role.gate, isString);
      return;
    }
    case "machines":
      check("speed", role.speed, isNumber);
      check("power", role.power, isNumber);
      checkTableRole("buildCost", check("buildCost", role.buildCost, isStacks), "items");
      return;
  }
}

function checkColumnType(type: ColumnType, path: IssuePath, claimId: ClaimId, issues: Issue[]): void {
  if (type.kind === "list") {
    checkColumnType(type.item, [...path, "item"], claimId, issues);
    return;
  }
  if ((type.kind === "int" || type.kind === "float") && type.min !== undefined && type.max !== undefined && type.min > type.max) {
    issues.push({ severity: "error", code: "invalid-range", path });
  }
  if (type.kind === "enum") checkEnumOptions(type.options, [...path, "options"], claimId, issues);
}

interface CellLocation {
  readonly base: IssuePath;
  row: number;
  column: Id;
}

function cellPath(at: CellLocation, ...rest: (string | number)[]): IssuePath {
  return [...at.base, "rows", at.row, "cells", at.column, ...rest];
}

function checkCell(type: ColumnType, value: Exclude<CellValue, null>, at: CellLocation, locKeys: Set<string>, issues: Issue[]): void {
  switch (type.kind) {
    case "text": {
      if (typeof value !== "object" || Array.isArray(value) || !("source" in value)) {
        issues.push(mismatch(cellPath(at), type.kind));
        return;
      }
      if (locKeys.has(value.key)) {
        issues.push({ severity: "error", code: "duplicate-loc-key", path: cellPath(at), params: { key: value.key } });
      } else {
        locKeys.add(value.key);
      }
      return;
    }
    case "curve": {
      if (typeof value !== "object" || Array.isArray(value) || !("interp" in value)) {
        issues.push(mismatch(cellPath(at), type.kind));
        return;
      }
      for (let i = 1; i < value.keys.length; i++) {
        if (!(value.keys[i - 1]!.x < value.keys[i]!.x)) {
          issues.push({ severity: "error", code: "curve-keys-unsorted", path: cellPath(at, "keys", i) });
          return;
        }
      }
      return;
    }
    case "stacks": {
      if (!Array.isArray(value)) {
        issues.push(mismatch(cellPath(at), type.kind));
        return;
      }
      const seen = new Set<Id>();
      for (let i = 0; i < value.length; i++) {
        const stack = value[i];
        if (stack === null || typeof stack !== "object") {
          issues.push(mismatch(cellPath(at, i), type.kind));
        } else if (seen.has(stack.item)) {
          issues.push({ severity: "warning", code: "duplicate-stack-item", path: cellPath(at, i, "item") });
        } else {
          seen.add(stack.item);
        }
      }
      return;
    }
    case "list": {
      if (!Array.isArray(value)) {
        issues.push(mismatch(cellPath(at), type.kind));
        return;
      }
      if (type.maxItems !== undefined && value.length > type.maxItems) {
        issues.push({ severity: "error", code: "too-many-items", path: cellPath(at), params: { limit: type.maxItems } });
      }
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item === null || item === undefined || typeof item === "object") issues.push(mismatch(cellPath(at, i), type.item.kind));
        else checkScalar(type.item, item, at, i, issues);
      }
      return;
    }
    default:
      checkScalar(type, value, at, undefined, issues);
  }
}

/** `listIndex` is set when the value is an item of a list cell. */
function checkScalar(type: ScalarType, value: Exclude<CellValue, null>, at: CellLocation, listIndex: number | undefined, issues: Issue[]): void {
  switch (type.kind) {
    case "int":
    case "float": {
      if (typeof value !== "number" || (type.kind === "int" && !Number.isSafeInteger(value))) {
        issues.push(mismatch(scalarPath(at, listIndex), type.kind));
        return;
      }
      if ((type.min !== undefined && value < type.min) || (type.max !== undefined && value > type.max)) {
        issues.push({ severity: "error", code: "out-of-range", path: scalarPath(at, listIndex) });
      }
      return;
    }
    case "string":
      if (typeof value !== "string") issues.push(mismatch(scalarPath(at, listIndex), type.kind));
      else if (type.maxLength !== undefined && value.length > type.maxLength) {
        issues.push({ severity: "error", code: "too-long", path: scalarPath(at, listIndex), params: { limit: type.maxLength } });
      }
      return;
    case "bool":
      if (typeof value !== "boolean") issues.push(mismatch(scalarPath(at, listIndex), type.kind));
      return;
    case "enum":
      if (typeof value !== "string") issues.push(mismatch(scalarPath(at, listIndex), type.kind));
      else if (!type.options.some((o) => o.id === value)) issues.push({ severity: "error", code: "unknown-option", path: scalarPath(at, listIndex), params: { value } });
      return;
    case "reference":
      // Whether the row exists is checked by the reference index.
      if (typeof value !== "string" || !ULID_PATTERN.test(value)) issues.push(mismatch(scalarPath(at, listIndex), type.kind));
      return;
  }
}

function scalarPath(at: CellLocation, listIndex: number | undefined): IssuePath {
  return listIndex === undefined ? cellPath(at) : cellPath(at, listIndex);
}

function mismatch(path: IssuePath, expected: string): Issue {
  return { severity: "error", code: "type-mismatch", path, params: { expected } };
}

function checkDocumentCycles(project: Project, issues: Issue[]): void {
  const parentOf = new Map<Id, Id>();
  const indexOf = new Map<Id, number>();
  project.assets.forEach((asset, i) => {
    if (asset.kind === "document" && asset.parent !== undefined) {
      parentOf.set(asset.id, asset.parent);
      indexOf.set(asset.id, i);
    }
  });

  // Each node is walked at most once overall: 0 = unvisited, 1 = on current path, 2 = done.
  const state = new Map<Id, 1 | 2>();
  for (const start of parentOf.keys()) {
    const path: Id[] = [];
    let node: Id | undefined = start;
    while (node !== undefined && state.get(node) === undefined) {
      state.set(node, 1);
      path.push(node);
      node = parentOf.get(node);
    }
    if (node !== undefined && state.get(node) === 1) {
      issues.push({ severity: "error", code: "parent-cycle", path: ["assets", indexOf.get(node)!, "parent"] });
    }
    for (const id of path) state.set(id, 2);
  }
}
