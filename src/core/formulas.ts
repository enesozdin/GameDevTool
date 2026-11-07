/**
 * Table formulas (docs/EXPRESSIONS.md, "Table formulas"). A formula column computes every
 * cell from one expression over the same row's columns, the project variables (start
 * values) and, through reference columns, columns of other tables: `Weapon.Damage * Level`.
 *
 * Values are computed, never stored. The engine keeps a dependency graph of formula columns
 * across tables and, after an edit, recalculates only what the edit touched. Edits share
 * structure, so unchanged tables and rows keep their objects:
 * - a formula column whose inputs are all the same objects keeps its results;
 * - a formula column that reads only its own row recalculates only the rows that changed;
 * - everything else that depends on a change recalculates its whole column.
 */
import { compileExpression, type CompiledExpression, type NamePart, type Scope, type ScopeEntry, type Value, type ValueType } from "./expr/compile.ts";
import { parseExpression } from "./expr/parser.ts";
import { fail, KEYWORDS, type Expr, type ExprError, type Span } from "./expr/syntax.ts";
import type { Patch } from "./history.ts";
import type { Id } from "./model/primitives.ts";
import type { Project, Variable } from "./model/project.ts";
import { isRoleColumn, type CellValue, type Column, type Row, type TableAsset } from "./model/table.ts";
import { adjacency, stronglyConnected } from "./production/scc.ts";
import type { Result } from "./result.ts";

export type FormulaKind = "int" | "float" | "string" | "bool";

/** Column kinds that can have a formula. */
export const FORMULA_KINDS: ReadonlySet<string> = new Set<FormulaKind>(["int", "float", "string", "bool"]);

/** Whether the column's cells are computed by its formula. */
export function hasFormula(column: Column): boolean {
  return column.formula !== undefined && FORMULA_KINDS.has(column.type.kind);
}

/**
 * Whether the column may get a formula: a scalar kind (int, float, string, bool) that the
 * table's role does not use (the production tools read the stored cells of role columns).
 */
export function canHaveFormula(table: TableAsset, column: Column): boolean {
  return FORMULA_KINDS.has(column.type.kind) && !isRoleColumn(table, column.id);
}

// ---------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------

export interface FormulaColumnResult {
  readonly table: Id;
  readonly column: Id;
  readonly kind: FormulaKind;
  /**
   * Error of the whole column: the formula does not compile or has the wrong type, it is
   * part of a cycle, or it reads a formula column that has such an error.
   */
  readonly error: ExprError | undefined;
  /** Number of rows (table.rows.length when it was computed). */
  readonly length: number;
  /** Errors of single cells (division by zero, ...), by row index. */
  readonly cellErrors: ReadonlyMap<number, ExprError>;
  /** Value of row `i`; undefined when the column or that cell has an error. */
  value(i: number): Value | undefined;
}

export interface FormulaResults {
  readonly columns: readonly FormulaColumnResult[];
  get(table: Id, column: Id): FormulaColumnResult | undefined;
}

class ColumnResult implements FormulaColumnResult {
  readonly table: Id;
  readonly column: Id;
  readonly kind: FormulaKind;
  readonly error: ExprError | undefined;
  readonly length: number;
  readonly cellErrors = new Map<number, ExprError>();
  /** Numbers (int, float); NaN marks a cell error. Computed numbers are always finite. */
  readonly nums: Float64Array | null;
  /** Strings and bools; undefined marks a cell error. */
  readonly vals: (Value | undefined)[] | null;

  constructor(table: Id, column: Id, kind: FormulaKind, length: number, error?: ExprError) {
    this.table = table;
    this.column = column;
    this.kind = kind;
    this.length = length;
    this.error = error;
    const numeric = kind === "int" || kind === "float";
    this.nums = error === undefined && numeric ? new Float64Array(length) : null;
    this.vals = error === undefined && !numeric ? new Array<Value | undefined>(length) : null;
  }

  value(i: number): Value | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.nums !== null) {
      const v = this.nums[i]!;
      return Number.isNaN(v) ? undefined : v;
    }
    return this.vals?.[i];
  }

  set(i: number, v: Value): void {
    if (this.nums !== null) this.nums[i] = v as number;
    else this.vals![i] = v;
  }

  setError(i: number, e: ExprError): void {
    if (this.nums !== null) this.nums[i] = Number.NaN;
    else if (this.vals !== null) this.vals[i] = undefined;
    this.cellErrors.set(i, e);
  }

  /** Copies the unchanged head [0, head) and tail (last `tail` rows) from a previous result. */
  copyEnds(prev: ColumnResult, head: number, tail: number): void {
    const n = this.length;
    const m = prev.length;
    if (this.nums !== null && prev.nums !== null) {
      this.nums.set(prev.nums.subarray(0, head), 0);
      this.nums.set(prev.nums.subarray(m - tail, m), n - tail);
    } else if (this.vals !== null && prev.vals !== null) {
      for (let i = 0; i < head; i++) this.vals[i] = prev.vals[i];
      for (let k = 1; k <= tail; k++) this.vals[n - k] = prev.vals[m - k];
    }
    for (const [i, e] of prev.cellErrors) {
      if (i < head) this.cellErrors.set(i, e);
      else if (i >= m - tail) this.cellErrors.set(i + n - m, e);
    }
  }
}

const formulaKey = (table: Id, column: Id) => `${table}:${column}`;

class Results implements FormulaResults {
  readonly columns: readonly FormulaColumnResult[];
  private readonly byKey: ReadonlyMap<string, FormulaColumnResult>;
  constructor(byKey: ReadonlyMap<string, FormulaColumnResult>) {
    this.byKey = byKey;
    this.columns = [...byKey.values()];
  }
  get(table: Id, column: Id): FormulaColumnResult | undefined {
    return this.byKey.get(formulaKey(table, column));
  }
}

// ---------------------------------------------------------------------------------------
// Names: the formula scope
// ---------------------------------------------------------------------------------------

/** How a read value is taken from its cell. */
type ReadKind = "number" | "bool" | "string" | "text";

/** A column a formula reads: in the current row, or reached through reference columns. */
interface Read {
  /** Reference columns followed from the current row, each with the table it points to. */
  readonly steps: readonly { readonly column: Id; readonly table: Id }[];
  /** Table and column of the value. */
  readonly table: Id;
  readonly column: Id;
  /** As written in declared spelling, e.g. "Weapon.Damage" (for error messages). */
  readonly name: string;
  readonly kind: ReadKind;
}

type Source = { readonly kind: "variable"; readonly value: Value } | { readonly kind: "read"; readonly read: Read };

function findColumn(table: TableAsset, name: string): Column | undefined {
  const key = name.toLowerCase();
  return table.columns.find((c) => c.name.toLowerCase() === key);
}

function findVariable(variables: readonly Variable[], name: string): Variable | undefined {
  const key = name.toLowerCase();
  if (KEYWORDS.has(key)) return undefined;
  return variables.find((v) => v.name.toLowerCase() === key);
}

function variableType(v: Variable): ValueType {
  switch (v.type) {
    case "enum":
      return { kind: "enum", owner: v.name, options: v.options };
    case "int":
    case "float":
      return { kind: "number" };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
  }
}

/**
 * Names in a formula of `table`: its columns (by name), then project variables. A
 * reference column followed by `.` reads a column of the row it points to, as often as
 * needed: `Weapon.Material.Density`. Every distinct name gets one slot.
 */
class FormulaScope implements Scope {
  readonly entries: ScopeEntry[] = [];
  /** Empty: every name is resolved by `resolve`, so columns can shadow variables. */
  readonly byName: ReadonlyMap<string, ScopeEntry> = new Map();
  /** What each slot holds. */
  readonly sources: Source[] = [];
  /** Tables whose columns names were looked up in, with the columns array seen. */
  readonly touched = new Map<Id, readonly Column[] | undefined>();
  private readonly table: TableAsset;
  private readonly tables: ReadonlyMap<Id, TableAsset>;
  private readonly variables: readonly Variable[];
  private readonly byPath = new Map<string, ScopeEntry>();

  constructor(table: TableAsset, tables: ReadonlyMap<Id, TableAsset>, variables: readonly Variable[]) {
    this.table = table;
    this.tables = tables;
    this.variables = variables;
    this.touched.set(table.id, table.columns);
  }

  readonly resolve = (parts: readonly NamePart[]): ScopeEntry => {
    const key = parts.map((p) => p.name.toLowerCase()).join(".");
    const known = this.byPath.get(key);
    if (known !== undefined) return known;
    let table = this.table;
    const steps: { column: Id; table: Id }[] = [];
    const names: string[] = [];
    let column: Column | undefined;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      column = findColumn(table, part.name);
      if (column === undefined) {
        if (i === 0) {
          const variable = findVariable(this.variables, part.name);
          if (variable === undefined) fail("expr-unknown-name", part.span, { name: part.name, table: table.name });
          if (parts.length > 1) fail("expr-not-reference", part.span, { name: variable.name });
          return this.add(key, variable.name, variableType(variable), { kind: "variable", value: variable.default });
        }
        fail("expr-unknown-column", part.span, { name: part.name, table: table.name });
      }
      names.push(column.name);
      if (i === parts.length - 1) break;
      if (column.type.kind !== "reference") fail("expr-not-reference", part.span, { name: column.name });
      const target = this.tables.get(column.type.table);
      this.touched.set(column.type.table, target?.columns);
      // A missing target table is a broken reference (validation); its columns are unknown.
      if (target === undefined) fail("expr-unknown-column", parts[i + 1]!.span, { name: parts[i + 1]!.name, table: "" });
      steps.push({ column: column.id, table: target.id });
      table = target;
    }
    const c = column!;
    const last = parts[parts.length - 1]!;
    const name = names.join(".");
    let type: ValueType;
    let kind: ReadKind;
    switch (c.type.kind) {
      case "int":
      case "float":
        type = { kind: "number" };
        kind = "number";
        break;
      case "bool":
        type = { kind: "bool" };
        kind = "bool";
        break;
      case "string":
        type = { kind: "string" };
        kind = "string";
        break;
      case "text":
        type = { kind: "string" };
        kind = "text";
        break;
      case "enum":
        type = { kind: "enum", owner: `${table.name}.${c.name}`, options: c.type.options };
        kind = "string";
        break;
      case "reference":
        fail("expr-needs-column", last.span, { name: c.name, table: this.tables.get(c.type.table)?.name ?? "" });
      default:
        fail("expr-unsupported-column", last.span, { name: c.name, kind: c.type.kind });
    }
    return this.add(key, name, type, { kind: "read", read: { steps, table: table.id, column: c.id, name, kind } });
  };

  private add(key: string, name: string, type: ValueType, source: Source): ScopeEntry {
    const entry: ScopeEntry = { slot: this.entries.length, name, type };
    this.entries.push(entry);
    this.sources.push(source);
    this.byPath.set(key, entry);
    return entry;
  }
}

function tableMap(project: Project): Map<Id, TableAsset> {
  const tables = new Map<Id, TableAsset>();
  for (const asset of project.assets) if (asset.kind === "table") tables.set(asset.id, asset);
  return tables;
}

const EXPECTED: Readonly<Record<FormulaKind, "number" | "string" | "bool">> = { int: "number", float: "number", string: "string", bool: "bool" };

interface Compiled {
  readonly column: Column;
  readonly variables: readonly Variable[];
  /** Tables the names were resolved in: their columns arrays when compiled. */
  readonly touched: ReadonlyMap<Id, readonly Column[] | undefined>;
  readonly result: Result<{ readonly expr: CompiledExpression; readonly sources: readonly Source[] }, ExprError>;
}

function compileColumn(table: TableAsset, column: Column, tables: ReadonlyMap<Id, TableAsset>, variables: readonly Variable[]): Compiled {
  const scope = new FormulaScope(table, tables, variables);
  const compiled = compileExpression(column.formula ?? "", scope, { expect: EXPECTED[column.type.kind as FormulaKind] });
  return {
    column,
    variables,
    touched: scope.touched,
    result: compiled.ok ? { ok: true, value: { expr: compiled.value, sources: scope.sources } } : compiled,
  };
}

/** Still valid when the column, the variables and every table it looked into are unchanged. */
function isCurrent(c: Compiled, column: Column, tables: ReadonlyMap<Id, TableAsset>, variables: readonly Variable[]): boolean {
  if (c.column !== column || c.variables !== variables) return false;
  for (const [id, columns] of c.touched) if (tables.get(id)?.columns !== columns) return false;
  return true;
}

/**
 * Checks a formula draft for a column of `table` without saving or running it (live errors
 * in the formula bar). Cycles are found only once the formula is saved.
 */
export function checkFormula(project: Project, table: TableAsset, kind: FormulaKind, source: string): Result<CompiledExpression, ExprError> {
  const scope = new FormulaScope(table, tableMap(project), project.manifest.variables);
  return compileExpression(source, scope, { expect: EXPECTED[kind] });
}

// ---------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------

/** A reader's marker for "the formula cell it reads has an error". */
const BAD: unique symbol = Symbol("bad");
type Reader = (row: number) => Value | typeof BAD;

interface NodeState {
  readonly compiled: Compiled;
  readonly result: ColumnResult;
  /** The table's rows when the result was computed. */
  readonly rows: readonly Row[];
  /** Rows of the tables that reference steps went through, when computed. */
  readonly through: ReadonlyMap<Id, readonly Row[] | undefined>;
}

interface Node {
  readonly key: string;
  readonly table: TableAsset;
  readonly column: Column;
  readonly kind: FormulaKind;
  compiled: Compiled;
}

/** Nothing changed / only the rows that changed in the table / everything. */
const SAME = 0;
const ROWS = 1;
const ALL = 2;

function sameError(a: ExprError | undefined, b: ExprError | undefined): boolean {
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Evaluates every formula column of a project. Keep one engine per project history: each
 * `evaluate` reuses what the previous call computed for unchanged inputs. Results must not
 * be mutated; projects must never be mutated in place (the editor's history guarantees it).
 */
export class FormulaEngine {
  private states = new Map<string, NodeState>();
  /** Row id → index, per rows array. */
  private readonly rowIndexes = new WeakMap<readonly Row[], Map<Id, number>>();

  evaluate(project: Project): FormulaResults {
    const tables = tableMap(project);
    const variables = project.manifest.variables;
    const nodes: Node[] = [];
    const indexOf = new Map<string, number>();
    for (const table of tables.values()) {
      for (const column of table.columns) {
        if (!hasFormula(column)) continue;
        const key = formulaKey(table.id, column.id);
        const prev = this.states.get(key)?.compiled;
        const compiled = prev !== undefined && isCurrent(prev, column, tables, variables) ? prev : compileColumn(table, column, tables, variables);
        indexOf.set(key, nodes.length);
        nodes.push({ key, table, column, kind: column.type.kind as FormulaKind, compiled });
      }
    }

    // Dependency graph: node → formula columns it reads. Tarjan numbers components so that
    // dependencies come first.
    const n = nodes.length;
    const from: number[] = [];
    const to: number[] = [];
    nodes.forEach((node, i) => {
      if (!node.compiled.result.ok) return;
      for (const source of node.compiled.result.value.sources) {
        if (source.kind !== "read") continue;
        const j = indexOf.get(formulaKey(source.read.table, source.read.column));
        if (j !== undefined) {
          from.push(i);
          to.push(j);
        }
      }
    });
    const { adjStart, adj } = adjacency(n, Int32Array.from(from), Int32Array.from(to));
    const { component, cyclic } = stronglyConnected(n, adjStart, adj);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => component[a]! - component[b]!);

    const results = new Map<string, ColumnResult>();
    const changed = new Uint8Array(n);
    const next = new Map<string, NodeState>();
    const diffs = new Map<readonly Row[], { head: number; tail: number }>();

    for (const i of order) {
      const node = nodes[i]!;
      const { table, column, kind, compiled } = node;
      const prev = this.states.get(node.key);
      const whole = { start: 0, end: column.formula!.length };

      // Whole-column errors.
      let error: ExprError | undefined;
      if (!compiled.result.ok) error = compiled.result.error;
      else if (cyclic[component[i]!] === 1) {
        // Name another member of the cycle when there is one; a self-reference names itself.
        let other = i;
        for (let k = adjStart[i]!; k < adjStart[i + 1]!; k++) if (component[adj[k]!] === component[i]) other = adj[k]!;
        error = { code: "expr-cycle", ...whole, params: { column: displayName(nodes[other]!, table) } };
      } else {
        for (let k = adjStart[i]!; k < adjStart[i + 1]!; k++) {
          const dep = results.get(nodes[adj[k]!]!.key)!;
          if (dep.error !== undefined) {
            error = { code: "expr-input-error", ...whole, params: { column: displayName(nodes[adj[k]!]!, table) } };
            break;
          }
        }
      }
      if (error !== undefined || !compiled.result.ok) {
        const reuse = prev !== undefined && prev.result.length === table.rows.length && sameError(prev.result.error, error);
        const result = reuse ? prev.result : new ColumnResult(table.id, column.id, kind, table.rows.length, error);
        changed[i] = reuse ? SAME : ALL;
        results.set(node.key, result);
        next.set(node.key, { compiled, result, rows: table.rows, through: new Map() });
        continue;
      }

      const { expr, sources } = compiled.result.value;
      const through = new Map<Id, readonly Row[] | undefined>();
      for (const source of sources) {
        if (source.kind === "read") for (const step of source.read.steps) through.set(step.table, tables.get(step.table)?.rows);
      }

      // How much must be recalculated?
      let mode = SAME;
      if (prev === undefined || prev.compiled !== compiled || prev.result.error !== undefined) mode = ALL;
      else {
        if (prev.rows !== table.rows) mode = ROWS;
        for (const [id, rows] of through) {
          // Reads through other rows of this table see every row change.
          if (rows !== prev.through.get(id) || (id === table.id && prev.rows !== table.rows)) mode = ALL;
        }
        for (const source of sources) {
          if (mode === ALL) break;
          if (source.kind !== "read") continue;
          const j = indexOf.get(formulaKey(source.read.table, source.read.column));
          if (j === undefined || changed[j] === SAME) continue;
          // A same-row read of a column that changed in the same rows stays row-by-row.
          const sameRows = source.read.steps.length === 0 && changed[j] === ROWS && this.states.get(nodes[j]!.key)?.rows === prev.rows;
          mode = sameRows ? Math.max(mode, ROWS) : ALL;
        }
      }

      let result: ColumnResult;
      if (mode === SAME) {
        result = prev!.result;
      } else {
        const rows = table.rows;
        result = new ColumnResult(table.id, column.id, kind, rows.length);
        let lo = 0;
        let hi = rows.length;
        if (mode === ROWS) {
          let diff = diffs.get(prev!.rows);
          if (diff === undefined) {
            diff = rowDiff(prev!.rows, rows);
            diffs.set(prev!.rows, diff);
          }
          result.copyEnds(prev!.result, diff.head, diff.tail);
          lo = diff.head;
          hi = rows.length - diff.tail;
        }
        this.compute(result, table, expr, sources, tables, results, lo, hi, whole);
        if (mode === ROWS && lo >= hi && rows.length === prev!.result.length) {
          // Rows were replaced by equal objects only: keep the old result object.
          result = prev!.result;
          mode = SAME;
        }
      }
      changed[i] = mode;
      results.set(node.key, result);
      next.set(node.key, { compiled, result, rows: table.rows, through });
    }

    this.states = next;
    // Keep the project's column order in the results.
    const ordered = new Map<string, ColumnResult>();
    for (const node of nodes) ordered.set(node.key, results.get(node.key)!);
    return new Results(ordered);
  }

  private rowIndex(rows: readonly Row[]): Map<Id, number> {
    let index = this.rowIndexes.get(rows);
    if (index === undefined) {
      index = new Map();
      for (let i = 0; i < rows.length; i++) if (!index.has(rows[i]!.id)) index.set(rows[i]!.id, i);
      this.rowIndexes.set(rows, index);
    }
    return index;
  }

  /** Evaluates rows [lo, hi) of a formula column into `out`. */
  private compute(
    out: ColumnResult,
    table: TableAsset,
    expr: CompiledExpression,
    sources: readonly Source[],
    tables: ReadonlyMap<Id, TableAsset>,
    results: ReadonlyMap<string, ColumnResult>,
    lo: number,
    hi: number,
    whole: Span,
  ): void {
    if (lo >= hi) return;
    const values: Value[] = new Array(sources.length);
    const readers: (Reader | null)[] = sources.map((source, k) => {
      if (source.kind === "variable") {
        values[k] = source.value;
        return null;
      }
      return this.reader(table, source.read, tables, results);
    });
    const int = out.kind === "int";
    for (let r = lo; r < hi; r++) {
      let bad = -1;
      for (let k = 0; k < readers.length; k++) {
        const read = readers[k];
        if (read === null || read === undefined) continue;
        const v = read(r);
        if (v === BAD) {
          bad = k;
          break;
        }
        values[k] = v;
      }
      if (bad >= 0) {
        const name = (sources[bad] as { read: Read }).read.name;
        out.setError(r, { code: "expr-input-error", ...whole, params: { column: name } });
        continue;
      }
      const res = expr.evaluate(values);
      if (!res.ok) out.setError(r, res.error);
      else if (int && !Number.isSafeInteger(res.value)) out.setError(r, { code: "expr-not-integer", ...whole });
      else out.set(r, res.value);
    }
  }

  private reader(table: TableAsset, read: Read, tables: ReadonlyMap<Id, TableAsset>, results: ReadonlyMap<string, ColumnResult>): Reader {
    const convert = CONVERT[read.kind];
    const empty = EMPTY[read.kind];
    const formula = results.get(formulaKey(read.table, read.column));
    const column = read.column;
    const fromFormula = (i: number): Value | typeof BAD => formula!.value(i) ?? BAD;
    if (read.steps.length === 0) {
      const rows = table.rows;
      return formula !== undefined ? fromFormula : (r) => convert(rows[r]!.cells[column], empty);
    }
    const hops = read.steps.map((step) => {
      const target = tables.get(step.table);
      return { column: step.column, rows: target?.rows ?? [], index: target === undefined ? new Map<Id, number>() : this.rowIndex(target.rows) };
    });
    const ownRows = table.rows;
    return (r) => {
      let row = ownRows[r]!;
      let at = r;
      for (const hop of hops) {
        const id = row.cells[hop.column];
        // An empty or broken reference reads as an empty cell.
        const j = typeof id === "string" ? hop.index.get(id) : undefined;
        if (j === undefined) return empty;
        row = hop.rows[j]!;
        at = j;
      }
      return formula !== undefined ? fromFormula(at) : convert(row.cells[column], empty);
    };
  }
}

/** Evaluates a project's formulas once, without keeping anything for later edits. */
export function evaluateFormulas(project: Project): FormulaResults {
  return new FormulaEngine().evaluate(project);
}

/** Name of a formula column for messages: "Column", or "Table.Column" in another table. */
function displayName(node: Node, from: TableAsset): string {
  return node.table.id === from.id ? node.column.name : `${node.table.name}.${node.column.name}`;
}

/** Empty cells read as 0, "", false; enum cells as their option id. Mistyped cells read as empty. */
const EMPTY: Readonly<Record<ReadKind, Value>> = { number: 0, bool: false, string: "", text: "" };
const CONVERT: Readonly<Record<ReadKind, (cell: CellValue | undefined, empty: Value) => Value>> = {
  number: (c, e) => (typeof c === "number" && Number.isFinite(c) ? c : e),
  bool: (c, e) => (typeof c === "boolean" ? c : e),
  string: (c, e) => (typeof c === "string" ? c : e),
  text: (c, e) => (c !== null && typeof c === "object" && !Array.isArray(c) && "source" in c ? c.source : e),
};

/** Unchanged rows at the start and the end (same objects), so only the middle is recomputed. */
function rowDiff(prev: readonly Row[], rows: readonly Row[]): { head: number; tail: number } {
  const max = Math.min(prev.length, rows.length);
  let head = 0;
  while (head < max && prev[head] === rows[head]) head++;
  let tail = 0;
  while (tail < max - head && prev[prev.length - 1 - tail] === rows[rows.length - 1 - tail]) tail++;
  return { head, tail };
}

// ---------------------------------------------------------------------------------------
// Renames
// ---------------------------------------------------------------------------------------

/** Name chains in an expression (plain names and a.b.c members), in source order. */
function nameChains(e: Expr, out: NamePart[][]): void {
  switch (e.kind) {
    case "name":
      out.push([{ name: e.name, span: e.span }]);
      return;
    case "member": {
      const parts: NamePart[] = [];
      let x: Expr = e;
      while (x.kind === "member") {
        parts.push({ name: x.name, span: x.nameSpan });
        x = x.object;
      }
      if (x.kind === "name") {
        parts.push({ name: x.name, span: x.span });
        out.push(parts.reverse());
      }
      return;
    }
    case "unary":
      nameChains(e.operand, out);
      return;
    case "binary":
      nameChains(e.left, out);
      nameChains(e.right, out);
      return;
    case "call":
      for (const a of e.args) nameChains(a, out);
      return;
    default:
      return;
  }
}

/**
 * Patches that rewrite every formula naming column `columnId` of table `tableId` (as a
 * column of the formula's own table, or after a reference: `Weapon.Damage`) to `name`.
 * Names are resolved like the formula scope does, so a variable or another table's column
 * with the same name is left alone. Formulas that do not parse are left unchanged.
 */
export function renameColumnInFormulas(project: Project, tableId: Id, columnId: Id, name: string): Patch[] {
  const tables = tableMap(project);
  const patches: Patch[] = [];
  project.assets.forEach((asset, a) => {
    if (asset.kind !== "table") return;
    asset.columns.forEach((column, c) => {
      if (column.formula === undefined) return;
      const parsed = parseExpression(column.formula);
      if (!parsed.ok) return;
      const chains: NamePart[][] = [];
      nameChains(parsed.value, chains);
      const spans: Span[] = [];
      for (const chain of chains) {
        let table: TableAsset | undefined = asset;
        for (let i = 0; i < chain.length && table !== undefined; i++) {
          const found = findColumn(table, chain[i]!.name);
          if (found === undefined) break;
          if (table.id === tableId && found.id === columnId) spans.push(chain[i]!.span);
          table = found.type.kind === "reference" ? tables.get(found.type.table) : undefined;
        }
      }
      if (spans.length === 0) return;
      let text = column.formula;
      for (const span of spans.sort((x, y) => y.start - x.start)) text = text.slice(0, span.start) + name + text.slice(span.end);
      patches.push({ op: "set", path: ["assets", a, "columns", c, "formula"], value: text });
    });
  });
  return patches;
}
