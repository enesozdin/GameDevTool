import type { Issue, IssuePath } from "../result.ts";
import type { EnumOption, Id, LocalizableText } from "./primitives.ts";
import type { Manifest, Project } from "./project.ts";
import { buildReferenceIndex, type ReferenceIndex } from "./references.ts";
import { replaceRange, rowDiff } from "./row-diff.ts";
import { isTagStack, TAG_PATTERN, type CellValue, type Column, type ColumnType, type Row, type ScalarType, type TableAsset } from "./table.ts";
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
 *
 * With a cache (one per project history, like the editor's), the checks are updated from
 * the previous call: unchanged assets keep their findings, and an edited table re-checks
 * only its changed rows. The result is the same as without a cache.
 */
export function validateProject(project: Project, index: ReferenceIndex = buildReferenceIndex(project), cache: ValidationCache = createValidationCache()): Issue[] {
  const variables = project.manifest.variables;
  let conditions: ConditionCompiler | undefined;
  const conditionsFor = () => (conditions ??= new ConditionCompiler(variables));
  const assetsById = new Map<Id, Asset>();
  for (const asset of project.assets) assetsById.set(asset.id, asset);

  // Pass 1: bring each asset's checks up to date and count every claimed id and
  // localization key, so pass 2 knows which claims are duplicates.
  const sources = new Map<ClaimSource, number>();
  const use = (source: ClaimSource): void => void sources.set(source, (sources.get(source) ?? 0) + 1);
  use(cache.manifestClaims(project.manifest));
  use(cache.assetIdClaims(project.assets));
  const usedTables = new Set<TableCheck>();
  const checks = project.assets.map((asset, assetIndex): TableCheck | GraphCheck | undefined => {
    if (asset.kind === "table") {
      const deps = asset.role === undefined ? [] : [variables, ...referencedTables(asset, assetsById)];
      let check = cache.tables.get(asset.id);
      if (check === undefined || usedTables.has(check)) {
        // A second table with the same id (a duplicate-id error) gets a check of its own.
        const fresh = new TableCheck();
        if (check === undefined) cache.tables.set(asset.id, fresh);
        check = fresh;
      }
      usedTables.add(check);
      check.update(asset, assetIndex, deps, assetsById, conditionsFor, cache.counted.has(check) ? cache : undefined);
      use(check);
      return check;
    }
    if (asset.kind === "production-graph") {
      const recipes = assetsById.get(asset.recipes);
      const deps = [variables, assetsById.get(asset.items), recipes, ...(recipes?.kind === "table" ? referencedTables(recipes, assetsById) : [])];
      const claims = (claim: ClaimId): void => {
        asset.nodes.forEach((node, i) => claim(node.id, () => ["assets", assetIndex, "nodes", i, "id"]));
        asset.edges.forEach((edge, i) => claim(edge.id, () => ["assets", assetIndex, "edges", i, "id"]));
        asset.groups?.forEach((group, i) => claim(group.id, () => ["assets", assetIndex, "groups", i, "id"]));
      };
      const run: AssetRun = (claim, out) => {
        claims(claim);
        validateProductionGraph(project, asset, assetIndex, assetsById, out, conditionsFor());
      };
      const check = checkAsset(cache, asset, assetIndex, deps, run);
      use(check);
      return { check, claims };
    }
    return undefined;
  });
  cache.reconcile(sources);
  for (const [id, check] of cache.tables) if (!usedTables.has(check)) cache.tables.delete(id);

  // Pass 2: report in project order. A duplicate is reported at every claim but the first.
  const issues: Issue[] = [];
  const ids = new ClaimReplay(cache.ids.duplicates);
  const locKeys = new ClaimReplay(cache.locKeys.duplicates);
  const claimId: ClaimId = (id, path) => {
    if (ids.isDuplicate(id)) issues.push({ severity: "error", code: "duplicate-id", path: path(), params: { id } });
  };
  checkManifest(project.manifest, claimId, issues);
  project.assets.forEach((asset, assetIndex) => {
    claimId(asset.id, () => ["assets", assetIndex, "id"]);
    const check = checks[assetIndex];
    if (check === undefined) return;
    if (check instanceof TableCheck) {
      check.report(issues, ids, locKeys);
      return;
    }
    for (const issue of check.check.issues) issues.push(issue);
    if (ids.active) {
      let paths: ClaimPaths | undefined;
      check.check.ids.forEach((id, k) => {
        if (ids.isDuplicate(id)) issues.push({ severity: "error", code: "duplicate-id", path: (paths ??= claimPaths(check.claims))[k]!(), params: { id } });
      });
    }
  });

  checkDocumentCycles(project, issues);

  for (const ref of index.broken) {
    issues.push({ severity: "error", code: "broken-reference", path: ref.path, params: { target: ref.target } });
  }
  return issues;
}

function checkManifest(manifest: Manifest, claimId: ClaimId, issues: Issue[]): void {
  claimId(manifest.id, () => ["manifest", "id"]);

  // Variables
  const variableNames = new NameSet();
  manifest.variables.forEach((variable, i) => {
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

  manifest.characters.forEach((character, i) => claimId(character.id, () => ["manifest", "characters", i, "id"]));
}

// ---------------------------------------------------------------------------------------
// Cache. Edits share structure: an asset or row that did not change keeps its object.
// Production graphs are cached per object; tables per id with their findings per row, so
// typing in one cell re-checks that row only. Ids and localization keys are counted
// project-wide and updated with each change; only when a count reaches two are the claims
// replayed in project order to find which one is reported.
// ---------------------------------------------------------------------------------------

/**
 * Opt-in cache for validateProject across edits of one project history. Only valid when
 * projects are never mutated in place (the editor's history guarantees that).
 */
export class ValidationCache {
  /** Production graph checks by asset object. */
  readonly assets = new WeakMap<object, AssetCheck>();
  /** Table checks by table id. */
  readonly tables = new Map<Id, TableCheck>();
  readonly ids = new ClaimCounts();
  readonly locKeys = new ClaimCounts();
  /** Sources whose claims are in `ids` and `locKeys`, with how often they are counted. */
  counted = new Map<ClaimSource, number>();
  private manifests = new WeakMap<Manifest, ClaimList>();
  private assetIds: ClaimList = { ids: [], locKeys: [] };

  manifestClaims(manifest: Manifest): ClaimList {
    let claims = this.manifests.get(manifest);
    if (claims === undefined) {
      const ids: Id[] = [];
      checkManifest(manifest, (id) => ids.push(id), []);
      claims = { ids, locKeys: [] };
      this.manifests.set(manifest, claims);
    }
    return claims;
  }

  assetIdClaims(assets: readonly Asset[]): ClaimList {
    const last = this.assetIds.ids;
    if (last.length !== assets.length || assets.some((a, i) => a.id !== last[i])) {
      this.assetIds = { ids: assets.map((a) => a.id), locKeys: [] };
    }
    return this.assetIds;
  }

  /** Makes the counts match `sources`. Table checks updated in place already counted their changes. */
  reconcile(sources: ReadonlyMap<ClaimSource, number>): void {
    for (const [source, before] of this.counted) {
      for (let n = sources.get(source) ?? 0; n < before; n++) forEachClaim(source, (id) => this.ids.remove(id), (key) => this.locKeys.remove(key));
    }
    for (const [source, after] of sources) {
      for (let n = this.counted.get(source) ?? 0; n < after; n++) forEachClaim(source, (id) => this.ids.add(id), (key) => this.locKeys.add(key));
    }
    this.counted = new Map(sources);
  }
}

export function createValidationCache(): ValidationCache {
  return new ValidationCache();
}

/** How often each key is claimed. Keys claimed once sit in a Set, which is smaller than a Map. */
class ClaimCounts<K = string> {
  private readonly once = new Set<K>();
  /** Keys claimed more than once → number of claims. */
  readonly duplicates = new Map<K, number>();
  add(key: K): void {
    const n = this.duplicates.get(key);
    if (n !== undefined) this.duplicates.set(key, n + 1);
    else if (this.once.has(key)) {
      this.once.delete(key);
      this.duplicates.set(key, 2);
    } else this.once.add(key);
  }
  remove(key: K): void {
    const n = this.duplicates.get(key);
    if (n === undefined) this.once.delete(key);
    else if (n > 2) this.duplicates.set(key, n - 1);
    else {
      this.duplicates.delete(key);
      this.once.add(key);
    }
  }
}

/** Walks claims in project order; the first claim of a key wins. */
class ClaimReplay<K = string> {
  private readonly seen = new Set<K>();
  readonly active: boolean;
  private readonly duplicates: ReadonlyMap<K, number>;
  constructor(duplicates: ReadonlyMap<K, number>) {
    this.duplicates = duplicates;
    this.active = duplicates.size > 0;
  }
  isDuplicate(key: K): boolean {
    if (!this.active || !this.duplicates.has(key)) return false;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }
}

interface ClaimList {
  readonly ids: readonly Id[];
  readonly locKeys: readonly string[];
}

type ClaimSource = ClaimList | TableCheck;

function forEachClaim(source: ClaimSource, onId: (id: Id) => void, onLocKey: (key: string) => void): void {
  if (source instanceof TableCheck) source.forEachClaim(onId, onLocKey);
  else {
    for (const id of source.ids) onId(id);
    for (const key of source.locKeys) onLocKey(key);
  }
}

export interface AssetCheck extends ClaimList {
  readonly deps: readonly unknown[];
  readonly assetIndex: number;
  readonly issues: readonly Issue[];
}

type AssetRun = (claim: ClaimId, out: Issue[]) => void;

interface GraphCheck {
  readonly check: AssetCheck;
  /** Claims the graph's ids, in the same order as `check.ids`. */
  readonly claims: (claim: ClaimId) => void;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

function checkAsset(cache: ValidationCache, asset: Asset, assetIndex: number, deps: readonly unknown[], run: AssetRun): AssetCheck {
  const cached = cache.assets.get(asset);
  if (cached !== undefined && sameDeps(cached.deps, deps)) {
    if (cached.assetIndex === assetIndex) return cached;
    // The asset moved in the list: same findings, new paths.
    const moved: AssetCheck = { ...cached, assetIndex, issues: cached.issues.map((issue) => (issue.path[0] === "assets" ? { ...issue, path: ["assets", assetIndex, ...issue.path.slice(2)] } : issue)) };
    cache.assets.set(asset, moved);
    return moved;
  }
  const ids: Id[] = [];
  const issues: Issue[] = [];
  run((id) => ids.push(id), issues);
  const check: AssetCheck = { deps, assetIndex, issues, ids, locKeys: [] };
  cache.assets.set(asset, check);
  return check;
}

/** Path makers of every claim, by claim index. */
type ClaimPaths = readonly (() => IssuePath)[];

/**
 * Collects the path of every claim in one pass, the first time a duplicate needs one.
 * Re-running the claims once per duplicate would be quadratic: a crafted file with many
 * duplicate ids could then freeze the tab.
 */
function claimPaths(claims: (claim: ClaimId) => void): ClaimPaths {
  const paths: (() => IssuePath)[] = [];
  claims((_id, at) => paths.push(at));
  return paths;
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

// ---------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------

/** What the row checks need from the columns and the role. */
interface TableLayout {
  readonly columns: readonly Column[];
  readonly columnIds: ReadonlySet<Id>;
  /** Text columns (each claims the localization key of its cells), in column order. */
  readonly textColumns: readonly Id[];
  /** Indexes of the columns whose id belongs to a unique int/string column. Columns sharing an id share one count. */
  readonly unique: readonly number[];
  /** The column that may hold tag stacks ("any Fuel"): only recipe inputs. */
  readonly tagColumn: Id | undefined;
}

function tableLayout(table: TableAsset): TableLayout {
  const columnIds = new Set<Id>();
  const uniqueIds = new Set<Id>();
  const textColumns: Id[] = [];
  for (const column of table.columns) {
    columnIds.add(column.id);
    const t = column.type;
    if (t.kind === "text") textColumns.push(column.id);
    if ((t.kind === "int" || t.kind === "string") && t.unique === true) uniqueIds.add(column.id);
  }
  // Uniqueness is tracked per column id: a column sharing its id with a unique one takes part.
  const unique: number[] = [];
  table.columns.forEach((column, c) => {
    if (uniqueIds.has(column.id)) unique.push(c);
  });
  return { columns: table.columns, columnIds, textColumns, unique, tagColumn: table.role?.kind === "recipes" ? table.role.inputs : undefined };
}

function isText(value: CellValue | undefined): value is LocalizableText {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) && "source" in value;
}

/** Findings of one row that do not depend on other rows, at the row index they were made for. */
interface RowFindings {
  assetIndex: number;
  row: number;
  /** Cell, required and unknown-column findings. */
  cells: readonly Issue[];
  /** Findings of each role rule (RolePart functions, in plan order). */
  role: readonly (readonly Issue[])[];
}

/** Duplicate findings of one row, from the walk over all rows. */
interface RowDuplicates {
  readonly name: boolean;
  /** Column index → first row with the same value. */
  readonly cells: ReadonlyMap<number, number> | undefined;
}

/** Role checks in report order: fixed findings and per-row rules. */
type RolePart = Issue | RowRule;
type RowRule = (row: Row, r: number, out: Issue[]) => void;

const NO_ISSUES: readonly Issue[] = [];

/**
 * Checks of one table, kept up to date across edits. Per row it stores the findings that
 * depend on that row only, and it counts names and unique values, so duplicates are found
 * without looking at every row. Rows are compared by object (rowDiff).
 */
class TableCheck {
  table: TableAsset | undefined;
  private assetIndex = -1;
  private deps: readonly unknown[] = [];
  private layout!: TableLayout;
  private header: Issue[] = [];
  private headerIds: Id[] = [];
  private plan: RolePart[] = [];
  private rules: RowRule[] = [];
  /** Parallel to the table's rows; null for a row without findings. */
  private rows: (RowFindings | null)[] = [];
  private withFindings = 0;
  private names = new ClaimCounts();
  private unique = new Map<Id, ClaimCounts<string | number>>();
  private scratch: Issue[] = [];
  /** Scratch location for cell paths. */
  private at: CellLocation = { base: [], row: 0, column: "", tagsAllowed: false };

  /**
   * Brings the check to `table`. `counts` is set when this check's claims are counted:
   * the changed claims are then counted here.
   */
  update(
    table: TableAsset,
    assetIndex: number,
    deps: readonly unknown[],
    assets: ReadonlyMap<Id, Asset>,
    conditions: () => ConditionCompiler,
    counts: ValidationCache | undefined,
  ): void {
    const before = this.table;
    if (before === table && this.assetIndex === assetIndex && sameDeps(this.deps, deps)) return;
    if (before === undefined || before.columns !== table.columns || before.role !== table.role || !sameDeps(this.deps, deps)) {
      if (counts !== undefined && before !== undefined) this.forEachClaim((id) => counts.ids.remove(id), (key) => counts.locKeys.remove(key));
      this.rebuild(table, assetIndex, deps, assets, conditions);
      if (counts !== undefined) this.forEachClaim((id) => counts.ids.add(id), (key) => counts.locKeys.add(key));
      return;
    }
    if (this.assetIndex !== assetIndex) {
      // Moved in the asset list: new paths. Row findings are moved when reported.
      this.assetIndex = assetIndex;
      this.at.base = ["assets", assetIndex];
      this.header = [];
      checkHeader(table, assetIndex, () => {}, this.header);
      this.setPlan(table, assets, conditions);
    }
    if (before.rows !== table.rows) this.updateRows(before.rows, table.rows, counts);
    this.table = table;
  }

  private rebuild(table: TableAsset, assetIndex: number, deps: readonly unknown[], assets: ReadonlyMap<Id, Asset>, conditions: () => ConditionCompiler): void {
    this.table = table;
    this.assetIndex = assetIndex;
    this.deps = deps;
    this.layout = tableLayout(table);
    this.at = { base: ["assets", assetIndex], row: 0, column: "", tagsAllowed: false };
    this.header = [];
    this.headerIds = [];
    checkHeader(table, assetIndex, (id) => this.headerIds.push(id), this.header);
    this.setPlan(table, assets, conditions);
    this.names = new ClaimCounts();
    this.unique = new Map();
    for (const c of this.layout.unique) {
      const id = table.columns[c]!.id;
      if (!this.unique.has(id)) this.unique.set(id, new ClaimCounts());
    }
    this.withFindings = 0;
    this.rows = new Array(table.rows.length);
    table.rows.forEach((row, r) => {
      this.rows[r] = this.check(row, r);
      this.count(row, 1);
    });
  }

  private setPlan(table: TableAsset, assets: ReadonlyMap<Id, Asset>, conditions: () => ConditionCompiler): void {
    this.plan = table.role === undefined ? [] : rolePlan(table, this.assetIndex, assets, conditions());
    this.rules = this.plan.filter((part): part is RowRule => typeof part === "function");
  }

  /** Re-checks the rows between the common prefix and suffix of the two arrays. */
  private updateRows(before: readonly Row[], after: readonly Row[], counts: ValidationCache | undefined): void {
    const d = rowDiff(before, after);
    // Rows that only moved inside the changed range (a sort, scattered deletes) keep their findings.
    let reuse: Map<Row, RowFindings | null> | undefined;
    if (d.beforeEnd - d.start > 32 && d.afterEnd - d.start > 32) {
      reuse = new Map();
      for (let r = d.start; r < d.beforeEnd; r++) reuse.set(before[r]!, this.rows[r]!);
    }
    for (let r = d.start; r < d.beforeEnd; r++) {
      const row = before[r]!;
      if (this.rows[r] !== null) this.withFindings--;
      this.count(row, -1);
      if (counts !== undefined) this.forEachRowClaim(row, (id) => counts.ids.remove(id), (key) => counts.locKeys.remove(key));
    }
    const fresh: (RowFindings | null)[] = new Array(d.afterEnd - d.start);
    for (let r = d.start; r < d.afterEnd; r++) {
      const row = after[r]!;
      let findings: RowFindings | null;
      if (reuse !== undefined && reuse.has(row)) {
        findings = reuse.get(row)!;
        // A row object listed twice must not share one entry: its path is fixed per row.
        reuse.delete(row);
        if (findings !== null) this.withFindings++;
      } else {
        findings = this.check(row, r);
      }
      fresh[r - d.start] = findings;
      this.count(row, 1);
      if (counts !== undefined) this.forEachRowClaim(row, (id) => counts.ids.add(id), (key) => counts.locKeys.add(key));
    }
    this.rows = replaceRange(this.rows, d.start, d.beforeEnd, fresh);
  }

  /** The row's own findings, or null when it has none. */
  private check(row: Row, r: number): RowFindings | null {
    // Most rows are clean: check into a scratch array and copy only when something was found.
    const scratch = this.scratch;
    scratch.length = 0;
    this.at.row = r;
    checkRow(this.layout, row, this.at, scratch, undefined);
    const cells = scratch.length === 0 ? NO_ISSUES : scratch.slice();
    let role: (readonly Issue[])[] | undefined;
    for (let k = 0; k < this.rules.length; k++) {
      scratch.length = 0;
      this.rules[k]!(row, r, scratch);
      if (scratch.length > 0) (role ??= this.rules.map(() => NO_ISSUES))[k] = scratch.slice();
    }
    if (cells.length === 0 && role === undefined) return null;
    this.withFindings++;
    return { assetIndex: this.assetIndex, row: r, cells, role: role ?? this.rules.map(() => NO_ISSUES) };
  }

  /** Adds (+1) or removes (-1) the row's name and unique values. */
  private count(row: Row, delta: 1 | -1): void {
    const key = row.name.toLowerCase();
    if (delta > 0) this.names.add(key);
    else this.names.remove(key);
    for (const c of this.layout.unique) {
      const id = this.layout.columns[c]!.id;
      const value = row.cells[id];
      if (typeof value !== "number" && typeof value !== "string") continue;
      const counts = this.unique.get(id)!;
      if (delta > 0) counts.add(value);
      else counts.remove(value);
    }
  }

  forEachClaim(onId: (id: Id) => void, onLocKey: (key: string) => void): void {
    for (const id of this.headerIds) onId(id);
    for (const row of this.table!.rows) this.forEachRowClaim(row, onId, onLocKey);
  }

  private forEachRowClaim(row: Row, onId: (id: Id) => void, onLocKey: (key: string) => void): void {
    onId(row.id);
    for (const column of this.layout.textColumns) {
      const value = row.cells[column];
      if (isText(value)) onLocKey(value.key);
    }
  }

  /** The row's findings, with paths for its current position. */
  private findingsAt(r: number): RowFindings | null {
    const findings = this.rows[r]!;
    if (findings !== null && (findings.row !== r || findings.assetIndex !== this.assetIndex)) {
      const move = (issue: Issue): Issue => ({ ...issue, path: ["assets", this.assetIndex, "rows", r, ...issue.path.slice(4)] });
      findings.cells = findings.cells.map(move);
      findings.role = findings.role.map((issues) => issues.map(move));
      findings.row = r;
      findings.assetIndex = this.assetIndex;
    }
    return findings;
  }

  report(issues: Issue[], ids: ClaimReplay, locKeys: ClaimReplay): void {
    const table = this.table!;
    for (const issue of this.header) issues.push(issue);
    this.reportRows(table, issues);
    let rule = 0;
    for (const part of this.plan) {
      if (typeof part !== "function") {
        issues.push(part);
        continue;
      }
      const k = rule++;
      if (this.withFindings === 0) continue;
      for (let r = 0; r < this.rows.length; r++) {
        if (this.rows[r] === null) continue;
        for (const issue of this.findingsAt(r)!.role[k]!) issues.push(issue);
      }
    }

    const base = this.at.base;
    if (ids.active) {
      let paths: ClaimPaths | undefined;
      this.headerIds.forEach((id, k) => {
        if (!ids.isDuplicate(id)) return;
        paths ??= claimPaths((claim) => checkHeader(table, this.assetIndex, claim, []));
        issues.push({ severity: "error", code: "duplicate-id", path: paths[k]!(), params: { id } });
      });
      table.rows.forEach((row, r) => {
        if (ids.isDuplicate(row.id)) issues.push({ severity: "error", code: "duplicate-id", path: [...base, "rows", r, "id"], params: { id: row.id } });
      });
    }
    if (locKeys.active) {
      table.rows.forEach((row, r) => {
        for (const column of this.layout.textColumns) {
          const value = row.cells[column];
          if (isText(value) && locKeys.isDuplicate(value.key)) {
            issues.push({ severity: "error", code: "duplicate-loc-key", path: [...base, "rows", r, "cells", column], params: { key: value.key } });
          }
        }
      });
    }
  }

  /** Row findings in row order. Rows with a duplicate name or value are checked again. */
  private reportRows(table: TableAsset, issues: Issue[]): void {
    const names = this.names.duplicates;
    const unique = this.layout.unique
      .map((c) => ({ c, id: table.columns[c]!.id }))
      .filter(({ id }) => this.unique.get(id)!.duplicates.size > 0);
    if (names.size === 0 && unique.length === 0) {
      if (this.withFindings === 0) return;
      for (let r = 0; r < this.rows.length; r++) {
        if (this.rows[r] === null) continue;
        for (const issue of this.findingsAt(r)!.cells) issues.push(issue);
      }
      return;
    }

    const seenNames = new Set<string>();
    const first = new Map<Id, Map<string | number, number>>();
    for (const { id } of unique) first.set(id, new Map());
    table.rows.forEach((row, r) => {
      let name = false;
      if (names.size > 0) {
        const key = row.name.toLowerCase();
        if (names.has(key)) {
          if (seenNames.has(key)) name = true;
          else seenNames.add(key);
        }
      }
      let cells: Map<number, number> | undefined;
      for (const { c, id } of unique) {
        const value = row.cells[id];
        if ((typeof value !== "number" && typeof value !== "string") || !this.unique.get(id)!.duplicates.has(value)) continue;
        const seen = first.get(id)!;
        const firstRow = seen.get(value);
        if (firstRow === undefined) seen.set(value, r);
        else (cells ??= new Map()).set(c, firstRow);
      }
      if (name || cells !== undefined) {
        this.at.row = r;
        checkRow(this.layout, row, this.at, issues, { name, cells });
      } else if (this.rows[r] !== null) {
        for (const issue of this.findingsAt(r)!.cells) issues.push(issue);
      }
    });
  }
}

/** Column findings and claims (column ids, enum option ids). */
function checkHeader(table: TableAsset, assetIndex: number, claimId: ClaimId, issues: Issue[]): void {
  const base: IssuePath = ["assets", assetIndex];
  const columnNames = new NameSet();
  table.columns.forEach((column, c) => {
    claimId(column.id, () => [...base, "columns", c, "id"]);
    if (!columnNames.add(column.name)) {
      issues.push({ severity: "error", code: "duplicate-name", path: [...base, "columns", c, "name"], params: { name: column.name } });
    }
    checkColumnType(column.type, [...base, "columns", c, "type"], claimId, issues);
  });
}

/**
 * Checks one row against the columns. `duplicates` is undefined when the row has no
 * duplicate name or value; such findings are added in column order otherwise.
 */
function checkRow(layout: TableLayout, row: Row, at: CellLocation, issues: Issue[], duplicates: RowDuplicates | undefined): void {
  const r = at.row;
  if (duplicates?.name === true) {
    issues.push({ severity: "error", code: "duplicate-name", path: [...at.base, "rows", r, "name"], params: { name: row.name } });
  }
  layout.columns.forEach((column, c) => {
    const value = row.cells[column.id];
    at.column = column.id;
    at.tagsAllowed = column.id === layout.tagColumn;
    if (value === undefined || value === null) {
      if (column.required === true) issues.push({ severity: "error", code: "required-missing", path: cellPath(at) });
      return;
    }
    checkCell(column.type, value, at, issues);
    const firstRow = duplicates?.cells?.get(c);
    if (firstRow !== undefined) issues.push({ severity: "error", code: "duplicate-value", path: cellPath(at), params: { firstRow } });
  });
  for (const key of Object.keys(row.cells)) {
    if (!layout.columnIds.has(key)) issues.push({ severity: "warning", code: "unknown-column", path: [...at.base, "rows", r, "cells", key] });
  }
}

// ---------------------------------------------------------------------------------------
// Table roles (Production Chain Editor)
// ---------------------------------------------------------------------------------------

type ColumnCheck = (type: ColumnType) => boolean;
const isNumber: ColumnCheck = (t) => t.kind === "int" || t.kind === "float";
const isStacks: ColumnCheck = (t) => t.kind === "stacks";
const isString: ColumnCheck = (t) => t.kind === "string";
const isStringList: ColumnCheck = (t) => t.kind === "list" && t.item.kind === "string";

/** Role checks in report order. Per-row checks are rules, run per row by TableCheck. */
function rolePlan(table: TableAsset, assetIndex: number, assets: ReadonlyMap<Id, Asset>, conditions: ConditionCompiler): RolePart[] {
  const role = table.role!;
  const plan: RolePart[] = [];
  const columns = new Map<Id, Column>();
  for (const column of table.columns) columns.set(column.id, column);
  const check = (field: string, columnId: Id | undefined, ok: ColumnCheck): Column | undefined => {
    if (columnId === undefined) return undefined;
    const path: IssuePath = ["assets", assetIndex, "role", field];
    const column = columns.get(columnId);
    if (column === undefined) plan.push({ severity: "error", code: "role-column-missing", path, params: { field } });
    else if (!ok(column.type)) plan.push({ severity: "error", code: "role-column-type", path, params: { field } });
    else return column;
    return undefined;
  };
  const checkTableRole = (field: string, column: Column | undefined, kind: "items" | "machines"): void => {
    if (column === undefined || (column.type.kind !== "stacks" && column.type.kind !== "reference")) return;
    const target = assets.get(column.type.table);
    // A missing table is reported as a broken reference.
    if (target !== undefined && (target.kind !== "table" || target.role?.kind !== kind)) {
      plan.push({ severity: "error", code: "role-mismatch", path: ["assets", assetIndex, "role", field], params: { expected: kind } });
    }
  };

  switch (role.kind) {
    case "items": {
      const tags = check("tags", role.tags, isStringList);
      if (tags !== undefined) plan.push(itemTagsRule(tags.id, assetIndex));
      return plan;
    }
    case "recipes": {
      const inputs = check("inputs", role.inputs, isStacks);
      const outputs = check("outputs", role.outputs, isStacks);
      checkTableRole("inputs", inputs, "items");
      if (inputs?.type.kind === "stacks") plan.push(tagsRule(inputs.id, assets.get(inputs.type.table), assetIndex));
      checkTableRole("outputs", outputs, "items");
      if (inputs !== undefined && outputs !== undefined && inputs.type.kind === "stacks" && outputs.type.kind === "stacks" && inputs.type.table !== outputs.type.table) {
        plan.push({ severity: "error", code: "role-items-mismatch", path: ["assets", assetIndex, "role", "outputs"] });
      }
      check("time", role.time, isNumber);
      checkTableRole("machine", check("machine", role.machine, (t) => t.kind === "reference"), "machines");
      const gate = check("gate", role.gate, isString);
      if (gate !== undefined) {
        plan.push((row, r, out) => {
          const source = row.cells[gate.id];
          if (typeof source !== "string" || source.trim() === "") return;
          const c = conditions.compile(source);
          if (!c.ok) out.push(exprIssue(["assets", assetIndex, "rows", r, "cells", gate.id], c.error));
        });
      }
      return plan;
    }
    case "machines":
      check("speed", role.speed, isNumber);
      check("power", role.power, isNumber);
      checkTableRole("buildCost", check("buildCost", role.buildCost, isStacks), "items");
      return plan;
  }
}

/**
 * Warns about item tags that no tag input can name: recipe inputs write tags as identifiers
 * (`#Fuel`), so a tag with a space or a symbol on an item is never matched.
 */
function itemTagsRule(column: Id, assetIndex: number): RowRule {
  return (row, r, out) => {
    const value = row.cells[column];
    if (!Array.isArray(value)) return;
    value.forEach((tag, i) => {
      if (typeof tag === "string" && !TAG_PATTERN.test(tag)) {
        out.push({ severity: "warning", code: "tag-invalid", path: ["assets", assetIndex, "rows", r, "cells", column, i], params: { tag } });
      }
    });
  };
}

/** Warns about tag stacks that no item of the items table carries. */
function tagsRule(column: Id, items: Asset | undefined, assetIndex: number): RowRule {
  let known: Set<string> | undefined;
  return (row, r, out) => {
    const value = row.cells[column];
    if (!Array.isArray(value)) return;
    value.forEach((stack, i) => {
      if (stack === null || typeof stack !== "object" || !("tag" in stack)) return;
      known ??= itemTags(items);
      if (!known.has(stack.tag.toLowerCase())) {
        out.push({ severity: "warning", code: "tag-no-items", path: ["assets", assetIndex, "rows", r, "cells", column, i, "tag"], params: { tag: stack.tag } });
      }
    });
  };
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
  base: IssuePath;
  row: number;
  column: Id;
  tagsAllowed: boolean;
}

function cellPath(at: CellLocation, ...rest: (string | number)[]): IssuePath {
  return [...at.base, "rows", at.row, "cells", at.column, ...rest];
}

function checkCell(type: ColumnType, value: Exclude<CellValue, null>, at: CellLocation, issues: Issue[]): void {
  switch (type.kind) {
    case "text": {
      if (typeof value !== "object" || Array.isArray(value) || !("source" in value)) {
        issues.push(mismatch(cellPath(at), type.kind));
      }
      // The localization key is claimed by TableCheck (isText).
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
