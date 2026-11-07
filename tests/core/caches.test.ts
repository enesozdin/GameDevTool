import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addColumn,
  addRow,
  applyPatches,
  buildReferenceIndex,
  commit,
  ConditionCompiler,
  createEmptyProject,
  ISSUES_TRUNCATED,
  MAX_ISSUES_PER_CODE,
  createHistory,
  createProductionSample,
  createReferenceIndexCache,
  createValidationCache,
  moveNodes,
  redo,
  removeRows,
  renameRow,
  replaceRows,
  sameCalculation,
  setCell,
  undo,
  updateNode,
  validateProject,
  type Asset,
  type Change,
  type History,
  type Id,
  type Issue,
  type ProductionGraphAsset,
  type Project,
  type ReferenceIndex,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

function setup() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" });
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  return { project, newId };
}

const apply = (project: Project, change: Change | null): Project => {
  assert.ok(change !== null);
  return applyPatches(project, change.patches).value;
};
const graphOf = (p: Project) => p.assets.find((a) => a.kind === "production-graph") as ProductionGraphAsset;

describe("sameCalculation", () => {
  it("ignores positions and labels, not rates, recipes or connections", () => {
    const { project } = setup();
    const graph = graphOf(project);
    const node = graph.nodes[1]!;
    const moved = graphOf(apply(project, moveNodes(project, graph.id, new Map([[node.id, { x: 999, y: 5 }]]))));
    assert.equal(sameCalculation(graph, moved), true);
    const labelled = graphOf(apply(project, updateNode(project, graph.id, node.id, { label: "Fuel line" })));
    assert.equal(sameCalculation(graph, labelled), true);
    const faster = graphOf(apply(project, updateNode(project, graph.id, node.id, { rate: 2 })));
    assert.equal(sameCalculation(graph, faster), false);
    const poisson = graphOf(apply(project, updateNode(project, graph.id, node.id, { distribution: "poisson" })));
    assert.equal(sameCalculation(graph, poisson), false);
    assert.equal(sameCalculation(graph, { ...graph, edges: [...graph.edges] }), false);
  });
});

describe("validation cache", () => {
  it("gives the same findings as a full validation across edits", () => {
    let project = sampleProject();
    const cache = createValidationCache();
    const check = () => assert.deepEqual(validateProject(project, undefined, cache), validateProject(project));
    check();
    const table = project.assets.find((a) => a.kind === "table") as TableAsset;
    // A duplicate row name, then an asset moved in the list (paths must follow it).
    project = apply(project, addRow(project, table.id, { id: fixedIds(42)(), name: table.rows[0]!.name, cells: {} }));
    check();
    project = { ...project, assets: [project.assets[project.assets.length - 1]!, ...project.assets.slice(0, -1)] };
    check();
    // A variable change invalidates the checks that read variables.
    project = { ...project, manifest: { ...project.manifest, variables: project.manifest.variables.slice(1) } };
    check();
  });

  it("reports duplicate ids across cached assets with the right path", () => {
    const project = sampleProject();
    const cache = createValidationCache();
    validateProject(project, undefined, cache);
    const tables = project.assets.filter((a): a is TableAsset => a.kind === "table");
    const clash = { ...tables[1]!, rows: [...tables[1]!.rows, { ...tables[1]!.rows[0]!, id: tables[0]!.rows[0]!.id, name: "Clash" }] };
    const next: Project = { ...project, assets: project.assets.map((a) => (a === tables[1] ? clash : a)) };
    const cached = validateProject(next, undefined, cache).filter((i) => i.code === "duplicate-id");
    assert.deepEqual(cached, validateProject(next).filter((i) => i.code === "duplicate-id"));
    assert.equal(cached.length, 1);
    assert.equal(cached[0]!.path.at(-1), "id");
  });
});

/** The "used by" count as the editor computed it before incomingCount: one usedBy per row. */
function countRowByRow(index: ReferenceIndex, asset: Asset): number {
  const incoming = (target: Id): number => index.usedBy(target).filter((r) => r.source !== asset.id).length;
  let count = incoming(asset.id);
  if (asset.kind === "table") for (const row of asset.rows) count += incoming(row.id);
  return count;
}

describe("incremental validation and reference index", () => {
  /** Sample project plus the production sample, with a recipes-like table of 300 rows. */
  function bigProject(): { project: Project; big: TableAsset; items: TableAsset } {
    const newId = fixedIds(7);
    const base = sampleProject();
    const { tables, graph } = createProductionSample(newId, { items: "PItems", machines: "PMachines", recipes: "PRecipes", graph: "Chain" });
    const items = base.assets[0] as TableAsset;
    const recipes = base.assets[1] as TableAsset;
    const [output, inputs, , , , , , code] = recipes.columns.map((c) => c.id);
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: newId(),
      name: `Recipe_${i}`,
      cells: { [output!]: items.rows[i % 2]!.id, [inputs!]: [items.rows[(i + 1) % 2]!.id], [code!]: `C${i}` },
    }));
    const big: TableAsset = { ...recipes, rows: [...recipes.rows, ...rows] };
    const project: Project = { ...base, assets: [items, big, ...base.assets.slice(2), tables.items, tables.machines, tables.recipes, graph] };
    return { project, big, items };
  }

  it("gives the same results as a fresh build through edits, undo and redo", () => {
    const { project, big, items } = bigProject();
    const [output, , , , , , , code] = big.columns.map((c) => c.id);
    const name = items.columns[0]!.id;
    const validationCache = createValidationCache();
    const indexCache = createReferenceIndexCache();
    const codes = new Set<string>();
    const check = (p: Project): void => {
      const index = buildReferenceIndex(p, indexCache);
      const fresh = buildReferenceIndex(p);
      assert.deepEqual(index.broken, fresh.broken);
      assert.deepEqual(index.references, fresh.references);
      for (const target of new Set(fresh.references.map((r) => r.target))) assert.deepEqual(index.usedBy(target), fresh.usedBy(target));
      for (const asset of p.assets) {
        const expected = countRowByRow(fresh, asset);
        assert.equal(fresh.incomingCount(asset), expected, asset.name);
        assert.equal(index.incomingCount(asset), expected, asset.name);
      }
      const issues = validateProject(p, index, validationCache);
      assert.deepEqual(issues, validateProject(p));
      for (const issue of issues) codes.add(issue.code);
    };

    let h: History<Project> = createHistory(project);
    let now = 0;
    const edit = (change: (p: Project) => Change | null): void => {
      const c = change(h.present);
      assert.ok(c !== null);
      h = commit(h, c, (now += 10_000));
      check(h.present);
    };
    const row = (r: number): Id => (h.present.assets[1] as TableAsset).rows[r]!.id;
    check(h.present);

    edit((p) => setCell(p, big.id, row(5), code!, "SMELT_IRON")); // duplicate unique value
    edit((p) => setCell(p, items.id, items.rows[1]!.id, name, { key: "item.iron_ore", source: "Copy" })); // duplicate loc key
    edit((p) => addRow(p, big.id, { id: fixedIds(99)(), name: "recipe_7", cells: {} })); // duplicate name, required missing
    edit((p) => removeRows(p, big.id, new Set([row(0), row(150), row(299)]))); // scattered: paths shift
    edit(() => ({ label: "insert-row", patches: [{ op: "insert", path: ["assets", 1, "rows"], index: 120, value: { id: fixedIds(77)(), name: "Inserted", cells: { [output!]: items.rows[0]!.id } } }] }));
    edit((p) => setCell(p, big.id, row(10), output!, fixedIds(123)())); // broken reference
    edit((p) => removeRows(p, items.id, new Set([items.rows[0]!.id]))); // breaks references into the items table
    h = undo(undo(h));
    check(h.present);
    h = redo(h);
    check(h.present);
    // References into the big table: from itself (not counted), from another table and
    // from a production graph (a recipe node pointing at a big row: counted, though broken).
    const bigCount = (): number => buildReferenceIndex(h.present, indexCache).incomingCount(h.present.assets[1]!);
    const selfRef = fixedIds(555)();
    const before = bigCount();
    edit((p) => addColumn(p, big.id, { id: selfRef, name: "Next", type: { kind: "reference", table: big.id } }));
    edit((p) => setCell(p, big.id, row(4), selfRef, row(5)));
    assert.equal(bigCount(), before);
    const itemRef = fixedIds(556)();
    edit((p) => addColumn(p, items.id, { id: itemRef, name: "BestRecipe", type: { kind: "reference", table: big.id } }));
    assert.equal(bigCount(), before + 1); // the column's reference to the table
    edit((p) => setCell(p, items.id, items.rows[1]!.id, itemRef, row(5)));
    assert.equal(bigCount(), before + 2);
    const graphIndex = h.present.assets.findIndex((a) => a.kind === "production-graph");
    const nodeIndex = graphOf(h.present).nodes.findIndex((n) => n.type === "recipe");
    edit(() => ({ label: "node-recipe", patches: [{ op: "set", path: ["assets", graphIndex, "nodes", nodeIndex, "recipe"], value: row(6) }] }));
    assert.equal(bigCount(), before + 3);
    edit((p) => removeRows(p, big.id, new Set([row(5)]))); // the items cell and the self-reference lose their target
    assert.equal(bigCount(), before + 2);
    edit((p) => replaceRows(p, big.id, (p.assets[1] as TableAsset).rows.slice().reverse())); // a sort: every row moves
    edit((p) => renameRow(p, big.id, row(3), "Renamed"));
    edit((p) => setCell(p, big.id, row(3), code!, 42)); // type mismatch
    edit((p) => addColumn(p, big.id, { id: fixedIds(321)(), name: "Level", type: { kind: "int", min: 0, unique: true } }));
    edit((p) => ({ label: "move", patches: [{ op: "set", path: ["assets"], value: [...p.assets.slice(1), p.assets[0]!] }] })); // asset moved
    while (h.past.length > 0) {
      h = undo(h);
      check(h.present);
    }
    while (h.future.length > 0) {
      h = redo(h);
      check(h.present);
    }
    for (const c of ["duplicate-value", "duplicate-loc-key", "duplicate-name", "required-missing", "broken-reference", "type-mismatch"]) assert.ok(codes.has(c), c);
  });

  it("keeps an older index correct after the cache moved on", () => {
    const { project, big } = bigProject();
    const cache = createReferenceIndexCache();
    const old = buildReferenceIndex(project, cache);
    const next = apply(project, removeRows(project, big.id, new Set([big.rows[1]!.id])));
    buildReferenceIndex(next, cache);
    const fresh = buildReferenceIndex(project);
    assert.deepEqual(old.references, fresh.references);
    for (const target of new Set(fresh.references.map((r) => r.target))) assert.deepEqual(old.usedBy(target), fresh.usedBy(target));
    for (const asset of project.assets) assert.equal(old.incomingCount(asset), countRowByRow(fresh, asset));
  });
});

describe("duplicate ids in crafted files", () => {
  // Paths of duplicates used to be found by re-running the checks once per duplicate, so a
  // file with many duplicate ids took minutes to load. Now one pass collects all paths.
  const N = 20_000;
  const LIMIT_MS = 2_000;

  it("reports duplicate enum option ids at each later option, in linear time", () => {
    const newId = fixedIds(11);
    const project = createEmptyProject("P", newId);
    const same = newId();
    const columns = Array.from({ length: N / 1_000 }, (_, c) => ({
      id: newId(),
      name: `C${c}`,
      type: { kind: "enum" as const, options: Array.from({ length: 1_000 }, (_, i) => ({ id: same, name: `O${i}` })) },
    }));
    project.assets.push({ id: newId(), kind: "table", name: "T", columns, rows: [] });
    const start = performance.now();
    const issues = validateProject(project);
    assert.ok(performance.now() - start < LIMIT_MS);
    const duplicates = issues.filter((i) => i.code === "duplicate-id");
    assert.equal(duplicates.length, MAX_ISSUES_PER_CODE);
    assert.deepEqual(duplicates[0]!.path, ["assets", 0, "columns", 0, "type", "options", 1, "id"]);
    // The first 999 options of column 0 after the first one, then column 1's first option.
    assert.deepEqual(duplicates.at(-1)!.path, ["assets", 0, "columns", 1, "type", "options", 0, "id"]);
    assert.deepEqual(issues.at(-1), { severity: "error", code: ISSUES_TRUNCATED, path: [], params: { code: "duplicate-id", omitted: N - 1 - MAX_ISSUES_PER_CODE } });
  });

  it("reports duplicate graph node ids at each later node, in linear time", () => {
    const { project } = setup();
    const graph = graphOf(project);
    const node = graph.nodes[0]!;
    const nodes = Array.from({ length: N }, (_, i) => ({ ...node, position: { x: i, y: 0 } }));
    const crafted: Project = { ...project, assets: project.assets.map((a) => (a === graph ? { ...graph, nodes, edges: [] } : a)) };
    const start = performance.now();
    const issues = validateProject(crafted);
    assert.ok(performance.now() - start < LIMIT_MS);
    const duplicates = issues.filter((i) => i.code === "duplicate-id");
    assert.equal(duplicates.length, MAX_ISSUES_PER_CODE);
    const at = crafted.assets.indexOf(crafted.assets.find((a) => a.kind === "production-graph")!);
    assert.deepEqual(duplicates[0]!.path, ["assets", at, "nodes", 1, "id"]);
    assert.deepEqual(duplicates.at(-1)!.path, ["assets", at, "nodes", MAX_ISSUES_PER_CODE, "id"]);
    const truncated = issues.filter((i) => i.code === ISSUES_TRUNCATED);
    assert.deepEqual(truncated.find((i) => i.params?.code === "duplicate-id")?.params?.omitted, N - 1 - MAX_ISSUES_PER_CODE);
  });
});

describe("issue cap", () => {
  it("lists the first issues of each code, the same with and without a cache, as edits move them", () => {
    const newId = fixedIds(21);
    const project = createEmptyProject("P", newId);
    const required = newId();
    const level = newId();
    const rows = Array.from({ length: 1_500 }, (_, i) => ({ id: newId(), name: `R${i}`, cells: { [level]: -1 } }));
    const table: TableAsset = {
      id: newId(),
      kind: "table",
      name: "T",
      columns: [
        { id: required, name: "Name", required: true, type: { kind: "string" } },
        { id: level, name: "Level", type: { kind: "int", min: 0 } },
      ],
      rows,
    };
    project.assets.push(table);
    const cache = createValidationCache();
    const indexCache = createReferenceIndexCache();
    const check = (p: Project): Issue[] => {
      const issues = validateProject(p, buildReferenceIndex(p, indexCache), cache);
      assert.deepEqual(issues, validateProject(p));
      return issues;
    };

    let issues = check(project);
    // 1,500 rows, each missing its required value and out of range: two capped codes.
    assert.equal(issues.filter((i) => i.code === "required-missing").length, MAX_ISSUES_PER_CODE);
    assert.equal(issues.filter((i) => i.code === "out-of-range").length, MAX_ISSUES_PER_CODE);
    assert.deepEqual(
      issues.filter((i) => i.code === ISSUES_TRUNCATED).map((i) => i.params),
      [
        { code: "required-missing", omitted: 500 },
        { code: "out-of-range", omitted: 500 },
      ],
    );

    // Fixing the first rows moves later rows into the list.
    let p = project;
    for (let r = 0; r < 600; r++) p = apply(p, setCell(p, table.id, rows[r]!.id, required, "x"));
    issues = check(p);
    assert.deepEqual(issues.filter((i) => i.code === "required-missing")[0]!.path, ["assets", 0, "rows", 600, "cells", required]);
    assert.deepEqual(issues.filter((i) => i.code === ISSUES_TRUNCATED).map((i) => i.params), [{ code: "out-of-range", omitted: 500 }]);
    // Removing rows from the start shifts every listed path.
    p = apply(p, removeRows(p, table.id, new Set(rows.slice(0, 700).map((r) => r.id))));
    issues = check(p);
    assert.deepEqual(issues.filter((i) => i.code === ISSUES_TRUNCATED), []);
    assert.equal(issues.length, 800 + 800);
  });
});

describe("condition cache", () => {
  it("stays within its limit and keeps recently used conditions", () => {
    const compiler = new ConditionCompiler([{ id: fixedIds()(), name: "Level", type: "int", default: 0 }], 8);
    const hot = compiler.compile("Level > 1");
    for (let i = 0; i < 100; i++) {
      compiler.compile(`Level > ${i + 2}`);
      if (i % 4 === 0) assert.equal(compiler.compile("Level > 1"), hot);
    }
    assert.equal(compiler.size, 8);
    assert.equal(compiler.compile("Level > 1"), hot);
  });
});
