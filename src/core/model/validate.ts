import type { Issue, IssuePath } from "../result.ts";
import type { EnumOption, Id } from "./primitives.ts";
import type { Project } from "./project.ts";
import { buildReferenceIndex, type ReferenceIndex } from "./references.ts";
import { isTagStack, TAG_PATTERN, type CellValue, type Column, type ColumnType, type ScalarType, type TableAsset } from "./table.ts";
import { ULID_PATTERN } from "../ids.ts";
import type { Asset } from "./project.ts";
import { validateProductionGraph } from "../production/validate-graph.ts";
import { ConditionCompiler, exprIssue } from "../expr/conditions.ts";
import { KEYWORDS } from "../expr/syntax.ts";

/**
 * Semantic checks that a structural schema cannot express: global id uniqueness,
 * name uniqueness, cell values against their column types, broken references.
 * Runs after the zod parse, so the project is structurally valid here.
 * Paths are allocated only when an issue is reported, so clean projects stay cheap.
 */
export function validateProject(project: Project, index: ReferenceIndex = buildReferenceIndex(project), cache?: ValidationCache): Issue[] {
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
    if (KEYWORDS.has(variable.name.toLowerCase())) {
      issues.push({ severity: "error", code: "reserved-name", path: ["manifest", "variables", i, "name"], params: { name: variable.name } });
    }
    if (variable.type === "enum") {
      checkEnumOptions(variable.options, ["manifest", "variables", i, "options"], claimId, issues);
      if (!variable.options.some((o) => o.id === variable.default)) {
        issues.push({ severity: "error", code: "unknown-option", path: ["manifest", "variables", i, "default"], params: { value: variable.default } });
      }
    }
  });

  project.manifest.characters.forEach((character, i) => claimId(character.id, () => ["manifest", "characters", i, "id"]));

  // Assets. The per-asset checks are cached (see checkAsset); ids and localization keys
  // are collected per asset and checked for duplicates across the project here.
  const locKeys = new Set<string>();
  let conditions: ConditionCompiler | undefined;
  const conditionsFor = () => (conditions ??= new ConditionCompiler(project.manifest.variables));
  const assetsById = new Map<Id, Asset>();
  for (const asset of project.assets) assetsById.set(asset.id, asset);
  const variables = project.manifest.variables;
  project.assets.forEach((asset, assetIndex) => {
    claimId(asset.id, () => ["assets", assetIndex, "id"]);
    let deps: unknown[];
    let run: (claim: ClaimId, claimLocKey: ClaimId, out: Issue[]) => void;
    if (asset.kind === "table") {
      deps = asset.role === undefined ? [] : [variables, ...referencedTables(asset, assetsById)];
      run = (claim, claimLocKey, out) => {
        validateTable(asset, assetIndex, claim, claimLocKey, out);
        if (asset.role !== undefined) validateRole(asset, assetIndex, assetsById, conditionsFor(), out);
      };
    } else if (asset.kind === "production-graph") {
      const recipes = assetsById.get(asset.recipes);
      deps = [variables, assetsById.get(asset.items), recipes, ...(recipes?.kind === "table" ? referencedTables(recipes, assetsById) : [])];
      run = (claim, _claimLocKey, out) => {
        asset.nodes.forEach((node, i) => claim(node.id, () => ["assets", assetIndex, "nodes", i, "id"]));
        asset.edges.forEach((edge, i) => claim(edge.id, () => ["assets", assetIndex, "edges", i, "id"]));
        asset.groups?.forEach((group, i) => claim(group.id, () => ["assets", assetIndex, "groups", i, "id"]));
        validateProductionGraph(project, asset, assetIndex, assetsById, out, conditionsFor());
      };
    } else {
      return;
    }
    const check = checkAsset(cache, asset, assetIndex, deps, run);
    for (const issue of check.issues) issues.push(issue);
    replayClaims(check.ids, ids, (k) => issues.push({ severity: "error", code: "duplicate-id", path: claimPath(run, "id", k), params: { id: check.ids[k]! } }));
    replayClaims(check.locKeys, locKeys, (k) => issues.push({ severity: "error", code: "duplicate-loc-key", path: claimPath(run, "loc", k), params: { key: check.locKeys[k]! } }));
  });

  checkDocumentCycles(project, issues);

  for (const ref of index.broken) {
    issues.push({ severity: "error", code: "broken-reference", path: ref.path, params: { target: ref.target } });
  }
  return issues;
}

// ---------------------------------------------------------------------------------------
// Per-asset cache. Edits share structure, so an asset that did not change keeps its object;
// its checks are reused as long as the assets and variables they read are the same objects.
// Typing in one table then re-checks that table only, not every cell of the project.
// ---------------------------------------------------------------------------------------

export interface AssetCheck {
  readonly deps: readonly unknown[];
  readonly assetIndex: number;
  readonly issues: readonly Issue[];
  /** Ids and localization keys the asset claims, in claim order. */
  readonly ids: readonly Id[];
  readonly locKeys: readonly string[];
}

type AssetRun = (claim: ClaimId, claimLocKey: ClaimId, out: Issue[]) => void;

/**
 * Opt-in cache for validateProject across edits of one project history. Only valid when
 * projects are never mutated in place (the editor's history guarantees that).
 */
export interface ValidationCache {
  readonly assets: WeakMap<object, AssetCheck>;
}

export function createValidationCache(): ValidationCache {
  return { assets: new WeakMap() };
}

function checkAsset(cache: ValidationCache | undefined, asset: Asset, assetIndex: number, deps: readonly unknown[], run: AssetRun): AssetCheck {
  const cached = cache?.assets.get(asset);
  if (cached !== undefined && cached.deps.length === deps.length && cached.deps.every((d, i) => d === deps[i])) {
    if (cached.assetIndex === assetIndex) return cached;
    // The asset moved in the list: same findings, new paths.
    const moved: AssetCheck = { ...cached, assetIndex, issues: cached.issues.map((issue) => (issue.path[0] === "assets" ? { ...issue, path: ["assets", assetIndex, ...issue.path.slice(2)] } : issue)) };
    cache!.assets.set(asset, moved);
    return moved;
  }
  const ids: Id[] = [];
  const locKeys: string[] = [];
  const issues: Issue[] = [];
  run((id) => ids.push(id), (key) => locKeys.push(key), issues);
  const check: AssetCheck = { deps, assetIndex, issues, ids, locKeys };
  cache?.assets.set(asset, check);
  return check;
}

/** Adds claims to the project-wide set; `duplicate(k)` for each claim already taken. */
function replayClaims(claims: readonly string[], taken: Set<string>, duplicate: (k: number) => void): void {
  for (let k = 0; k < claims.length; k++) {
    const key = claims[k]!;
    if (taken.has(key)) duplicate(k);
    else taken.add(key);
  }
}

/** Path of the k-th claim of a kind. Duplicates are rare, so this re-runs the checks. */
function claimPath(run: AssetRun, kind: "id" | "loc", k: number): IssuePath {
  let path: IssuePath = [];
  let n = 0;
  const capture: ClaimId = (_key, at) => {
    if (n++ === k) path = at();
  };
  const ignore: ClaimId = () => {};
  run(kind === "id" ? capture : ignore, kind === "loc" ? capture : ignore, []);
  return path;
}

/** Tables the columns of `table` point to (reference, stacks, list of reference). */
function referencedTables(table: TableAsset, assets: ReadonlyMap<Id, Asset>): (Asset | undefined)[] {
  const out: (Asset | undefined)[] = [];
  for (const column of table.columns) {
    const t = column.type;
    if (t.kind === "reference" || t.kind === "stacks") out.push(assets.get(t.table));
    else if (t.kind === "list" && t.item.kind === "reference") out.push(assets.get(t.item.table));
  }
  return out;
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

function validateTable(table: TableAsset, assetIndex: number, claimId: ClaimId, claimLocKey: ClaimId, issues: Issue[]): void {
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
  // Tag stacks ("any Fuel") are only meaningful as recipe inputs.
  const tagColumn = table.role?.kind === "recipes" ? table.role.inputs : undefined;
  // One reusable location object instead of a closure per cell.
  const at: CellLocation = { base, row: 0, column: "", tagsAllowed: false };
  table.rows.forEach((row, r) => {
    at.row = r;
    claimId(row.id, () => [...base, "rows", r, "id"]);
    if (!rowNames.add(row.name)) {
      issues.push({ severity: "error", code: "duplicate-name", path: [...base, "rows", r, "name"], params: { name: row.name } });
    }

    for (const column of table.columns) {
      const value = row.cells[column.id];
      at.column = column.id;
      at.tagsAllowed = column.id === tagColumn;
      if (value === undefined || value === null) {
        if (column.required === true) issues.push({ severity: "error", code: "required-missing", path: cellPath(at) });
        continue;
      }
      checkCell(column.type, value, at, claimLocKey, issues);

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

function validateRole(table: TableAsset, assetIndex: number, assets: ReadonlyMap<Id, Asset>, conditions: ConditionCompiler, issues: Issue[]): void {
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
    case "items": {
      const tags = check("tags", role.tags, isStringList);
      if (tags !== undefined) checkItemTags(table, tags.id, assetIndex, issues);
      return;
    }
    case "recipes": {
      const inputs = check("inputs", role.inputs, isStacks);
      const outputs = check("outputs", role.outputs, isStacks);
      checkTableRole("inputs", inputs, "items");
      if (inputs?.type.kind === "stacks") checkTags(table, inputs.id, assets.get(inputs.type.table), assetIndex, issues);
      checkTableRole("outputs", outputs, "items");
      if (inputs !== undefined && outputs !== undefined && inputs.type.kind === "stacks" && outputs.type.kind === "stacks" && inputs.type.table !== outputs.type.table) {
        issues.push({ severity: "error", code: "role-items-mismatch", path: ["assets", assetIndex, "role", "outputs"] });
      }
      check("time", role.time, isNumber);
      checkTableRole("machine", check("machine", role.machine, (t) => t.kind === "reference"), "machines");
      const gate = check("gate", role.gate, isString);
      if (gate !== undefined) {
        table.rows.forEach((row, r) => {
          const source = row.cells[gate.id];
          if (typeof source !== "string" || source.trim() === "") return;
          const c = conditions.compile(source);
          if (!c.ok) issues.push(exprIssue(["assets", assetIndex, "rows", r, "cells", gate.id], c.error));
        });
      }
      return;
    }
    case "machines":
      check("speed", role.speed, isNumber);
      check("power", role.power, isNumber);
      checkTableRole("buildCost", check("buildCost", role.buildCost, isStacks), "items");
      return;
  }
}

/**
 * Warns about item tags that no tag input can name: recipe inputs write tags as identifiers
 * (`#Fuel`), so a tag with a space or a symbol on an item is never matched.
 */
function checkItemTags(table: TableAsset, column: Id, assetIndex: number, issues: Issue[]): void {
  table.rows.forEach((row, r) => {
    const value = row.cells[column];
    if (!Array.isArray(value)) return;
    value.forEach((tag, i) => {
      if (typeof tag === "string" && !TAG_PATTERN.test(tag)) {
        issues.push({ severity: "warning", code: "tag-invalid", path: ["assets", assetIndex, "rows", r, "cells", column, i], params: { tag } });
      }
    });
  });
}

/** Warns about tag stacks that no item of the items table carries. */
function checkTags(table: TableAsset, column: Id, items: Asset | undefined, assetIndex: number, issues: Issue[]): void {
  let known: Set<string> | undefined;
  table.rows.forEach((row, r) => {
    const value = row.cells[column];
    if (!Array.isArray(value)) return;
    value.forEach((stack, i) => {
      if (stack === null || typeof stack !== "object" || !("tag" in stack)) return;
      known ??= itemTags(items);
      if (!known.has(stack.tag.toLowerCase())) {
        issues.push({ severity: "warning", code: "tag-no-items", path: ["assets", assetIndex, "rows", r, "cells", column, i, "tag"], params: { tag: stack.tag } });
      }
    });
  });
}

/** Lower-cased tags of an items table (role "items"). */
function itemTags(items: Asset | undefined): Set<string> {
  const out = new Set<string>();
  if (items?.kind !== "table" || items.role?.kind !== "items" || items.role.tags === undefined) return out;
  const column = items.role.tags;
  for (const row of items.rows) {
    const tags = row.cells[column];
    if (Array.isArray(tags)) for (const t of tags) if (typeof t === "string") out.add(t.toLowerCase());
  }
  return out;
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
  tagsAllowed: boolean;
}

function cellPath(at: CellLocation, ...rest: (string | number)[]): IssuePath {
  return [...at.base, "rows", at.row, "cells", at.column, ...rest];
}

function checkCell(type: ColumnType, value: Exclude<CellValue, null>, at: CellLocation, claimLocKey: ClaimId, issues: Issue[]): void {
  switch (type.kind) {
    case "text": {
      if (typeof value !== "object" || Array.isArray(value) || !("source" in value)) {
        issues.push(mismatch(cellPath(at), type.kind));
        return;
      }
      claimLocKey(value.key, () => cellPath(at));
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
      const seen = new Set<string>();
      for (let i = 0; i < value.length; i++) {
        const stack = value[i];
        if (stack === null || typeof stack !== "object") {
          issues.push(mismatch(cellPath(at, i), type.kind));
          continue;
        }
        const tag = isTagStack(stack);
        if (tag && !at.tagsAllowed) {
          issues.push({ severity: "error", code: "stack-tag-not-allowed", path: cellPath(at, i, "tag") });
          continue;
        }
        // Tags are case-insensitive; "#" cannot start an item id (ULID).
        const key = tag ? `#${stack.tag.toLowerCase()}` : stack.item;
        if (seen.has(key)) issues.push({ severity: "warning", code: "duplicate-stack-item", path: cellPath(at, i, tag ? "tag" : "item") });
        else seen.add(key);
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
