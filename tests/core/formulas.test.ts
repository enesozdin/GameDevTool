import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPatches,
  checkFormula,
  clearRange,
  compileExpression,
  ConditionCompiler,
  copyRange,
  createEmptyProject,
  evaluateFormulas,
  exportTableCsv,
  FormulaEngine,
  importTableCsv,
  loadProject,
  parseExpression,
  pasteGrid,
  printExpression,
  removeRows,
  renameColumn,
  rowNames,
  saveProject,
  setCell,
  setColumnFormula,
  updateVariable,
  validateProject,
  addRow,
  type Change,
  type Column,
  type FormulaResults,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

/**
 * Materials(Mult, Tier) ← Weapons(Base, Mat → Materials, Rarity enum, Title text, Damage = formula)
 * and a Level variable (start value 3).
 */
function sample() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const level = { id: newId(), name: "Level", type: "int" as const, default: 3 };
  project.manifest.variables.push(level);
  const m = { mult: newId(), tier: newId() };
  const materials: TableAsset = {
    id: newId(),
    kind: "table",
    name: "Materials",
    columns: [
      { id: m.mult, name: "Mult", type: { kind: "float" } },
      { id: m.tier, name: "Tier", type: { kind: "int" } },
    ],
    rows: [
      { id: newId(), name: "Iron", cells: { [m.mult]: 1.5, [m.tier]: 1 } },
      { id: newId(), name: "Steel", cells: { [m.mult]: 2, [m.tier]: 2 } },
    ],
  };
  const common = { id: newId(), name: "Common" };
  const rare = { id: newId(), name: "Rare" };
  const w = { base: newId(), mat: newId(), rarity: newId(), title: newId(), damage: newId() };
  const weapons: TableAsset = {
    id: newId(),
    kind: "table",
    name: "Weapons",
    columns: [
      { id: w.base, name: "Base", type: { kind: "float" } },
      { id: w.mat, name: "Mat", type: { kind: "reference", table: materials.id } },
      { id: w.rarity, name: "Rarity", type: { kind: "enum", options: [common, rare] } },
      { id: w.title, name: "Title", type: { kind: "text" } },
      { id: w.damage, name: "Damage", type: { kind: "float" }, formula: "Base * Mat.Mult * (1 + Level * 0.1)" },
    ],
    rows: [
      { id: newId(), name: "Sword", cells: { [w.base]: 10, [w.mat]: materials.rows[0]!.id, [w.rarity]: rare.id, [w.title]: { key: "k.sword", source: "Sword" } } },
      { id: newId(), name: "Axe", cells: { [w.base]: 20, [w.mat]: materials.rows[1]!.id, [w.rarity]: common.id } },
      { id: newId(), name: "Stick", cells: { [w.base]: 2 } },
    ],
  };
  project.assets.push(materials, weapons);
  return { project, newId, materials, weapons, m, w, level, common, rare };
}

function table(project: Project, id: string): TableAsset {
  const t = project.assets.find((a) => a.id === id);
  assert.ok(t !== undefined && t.kind === "table");
  return t;
}

function apply(project: Project, change: Change | null): Project {
  assert.ok(change !== null, "expected a change");
  return applyPatches(project, change.patches).value;
}

function withColumn(project: Project, tableId: string, column: Column): Project {
  const t = table(project, tableId);
  const index = project.assets.indexOf(t);
  return applyPatches(project, [{ op: "insert", path: ["assets", index, "columns"], index: t.columns.length, value: column }]).value;
}

function columnValues(results: FormulaResults, tableId: string, columnId: string) {
  const r = results.get(tableId, columnId);
  assert.ok(r !== undefined, "formula column missing from results");
  return Array.from({ length: r.length }, (_, i) => r.value(i));
}

/** Values and error codes of every formula column, for comparing engines. */
function snapshot(results: FormulaResults) {
  return results.columns.map((r) => ({
    column: r.column,
    error: r.error?.code,
    values: Array.from({ length: r.length }, (_, i) => r.value(i) ?? `!${r.cellErrors.get(i)?.code}`),
  }));
}

describe("expression syntax: members", () => {
  it("parses a.b.c left-nested and prints it back", () => {
    const parsed = parseExpression("Weapon . Material.Density * 2");
    assert.ok(parsed.ok);
    const e = parsed.value;
    assert.equal(e.kind, "binary");
    assert.equal(printExpression(e), "Weapon.Material.Density * 2");
  });

  it("rejects a dot without a name after it", () => {
    for (const source of ["a.", "a.1", "a.and", "a.true", "f(x).y", "(a).b"]) {
      assert.equal(parseExpression(source).ok, false, source);
    }
  });

  it("is an error in conditions, which have no dotted names", () => {
    const conditions = new ConditionCompiler([{ id: "01KDVDNA000000000000000001", name: "Level", type: "int", default: 0 }]);
    const r = conditions.compile("Level.Max > 1");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, "expr-unexpected-token");
    assert.equal(!r.ok && r.error.start, 5);
  });

  it("keeps .5 a number", () => {
    const scope = { entries: [], byName: new Map() };
    const r = compileExpression(".5 + 1", scope);
    assert.ok(r.ok);
    assert.deepEqual(r.value.evaluate([]), { ok: true, value: 1.5 });
  });
});

describe("formula evaluation", () => {
  it("computes same-row columns, variables and columns of referenced rows", () => {
    const { project, weapons, w } = sample();
    const results = evaluateFormulas(project);
    // Sword 10 × 1.5 × 1.3, Axe 20 × 2 × 1.3, Stick: no material → Mult reads 0.
    const values = columnValues(results, weapons.id, w.damage);
    assert.ok(Math.abs((values[0] as number) - 19.5) < 1e-9);
    assert.ok(Math.abs((values[1] as number) - 52) < 1e-9);
    assert.equal(values[2], 0);
  });

  it("reads empty cells as 0, empty text and false; text columns as their source", () => {
    const { project, weapons, newId } = sample();
    let p = withColumn(project, weapons.id, { id: newId(), name: "Flag", type: { kind: "bool" } });
    const label = newId();
    p = withColumn(p, weapons.id, { id: label, name: "Label", type: { kind: "string" }, formula: 'Title + if(Flag, "!", "?")' });
    assert.deepEqual(columnValues(evaluateFormulas(p), weapons.id, label), ["Sword?", "?", "?"]);
  });

  it("compares enum columns with option names", () => {
    const { project, weapons, newId } = sample();
    const bonus = newId();
    const p = withColumn(project, weapons.id, { id: bonus, name: "Bonus", type: { kind: "int" }, formula: 'if(Rarity == "rare", 5, 0)' });
    assert.deepEqual(columnValues(evaluateFormulas(p), weapons.id, bonus), [5, 0, 0]);
    const bad = checkFormula(p, table(p, weapons.id), "int", 'if(Rarity == "Epic", 5, 0)');
    assert.equal(!bad.ok && bad.error.code, "expr-unknown-option");
  });

  it("lets columns shadow variables of the same name", () => {
    const { project, weapons, newId } = sample();
    const levelColumn = newId();
    const out = newId();
    let p = withColumn(project, weapons.id, { id: levelColumn, name: "level", type: { kind: "int" } });
    p = withColumn(p, weapons.id, { id: out, name: "Out", type: { kind: "float" }, formula: "Level * 2" });
    // The empty column reads 0, not the variable's 3.
    assert.deepEqual(columnValues(evaluateFormulas(p), weapons.id, out), [0, 0, 0]);
  });

  it("follows chains of references and evaluates dependencies first, across tables", () => {
    const { project, materials, weapons, newId } = sample();
    // Materials gets a formula column that Weapons reads through Mat; Loot reads Weapons.
    const power = newId();
    let p = withColumn(project, materials.id, { id: power, name: "Power", type: { kind: "float" }, formula: "Mult * 10 + Tier" });
    const wPower = newId();
    p = withColumn(p, weapons.id, { id: wPower, name: "MatPower", type: { kind: "float" }, formula: "Mat.Power" });
    const lootWeapon = newId();
    const lootValue = newId();
    const loot: TableAsset = {
      id: newId(),
      kind: "table",
      name: "Loot",
      columns: [
        { id: lootWeapon, name: "Weapon", type: { kind: "reference", table: weapons.id } },
        { id: lootValue, name: "Value", type: { kind: "float" }, formula: "Weapon.Mat.Tier * 100 + Weapon.MatPower" },
      ],
      rows: [{ id: newId(), name: "Drop1", cells: { [lootWeapon]: weapons.rows[1]!.id } }],
    };
    // Put Loot first, so the evaluation order cannot follow the asset order.
    p = { ...p, assets: [loot, ...p.assets] };
    const results = evaluateFormulas(p);
    assert.deepEqual(columnValues(results, materials.id, power), [16, 22]);
    assert.deepEqual(columnValues(results, weapons.id, wPower), [16, 22, 0]);
    assert.deepEqual(columnValues(results, loot.id, lootValue), [222]);
  });

  it("treats broken references as empty rows", () => {
    const { project, weapons, w } = sample();
    const p = apply(project, setCell(project, weapons.id, weapons.rows[0]!.id, w.mat, "01KDVDNAZZZZZZZZZZZZZZZZZZ"));
    assert.equal(columnValues(evaluateFormulas(p), weapons.id, w.damage)[0], 0);
  });

  it("reports cell errors per row and passes them on as input errors", () => {
    const { project, weapons, newId } = sample();
    const ratio = newId();
    const twice = newId();
    let p = withColumn(project, weapons.id, { id: ratio, name: "Ratio", type: { kind: "float" }, formula: "Damage / Mat.Tier" });
    p = withColumn(p, weapons.id, { id: twice, name: "Twice", type: { kind: "float" }, formula: "Ratio * 2" });
    const results = evaluateFormulas(p);
    const r = results.get(weapons.id, ratio)!;
    assert.equal(r.error, undefined);
    assert.equal(r.cellErrors.get(2)?.code, "expr-division-by-zero");
    assert.equal(r.value(2), undefined);
    const t = results.get(weapons.id, twice)!;
    assert.equal(t.cellErrors.get(2)?.code, "expr-input-error");
    assert.equal(t.cellErrors.get(2)?.params?.column, "Ratio");
    assert.equal(t.value(0), 39);
  });

  it("requires whole numbers in int columns", () => {
    const { project, weapons, newId } = sample();
    const raw = newId();
    const rounded = newId();
    let p = withColumn(project, weapons.id, { id: raw, name: "Raw", type: { kind: "int" }, formula: "Base * 1.15" });
    p = withColumn(p, weapons.id, { id: rounded, name: "Rounded", type: { kind: "int" }, formula: "round(Base * 1.15)" });
    const results = evaluateFormulas(p);
    assert.equal(results.get(weapons.id, raw)!.cellErrors.get(0)?.code, "expr-not-integer");
    assert.deepEqual(columnValues(results, weapons.id, rounded), [12, 23, 2]);
  });

  it("gives the whole column an error for type mismatches, unknown names and unsupported columns", () => {
    const { project, weapons, newId } = sample();
    const cases: [string, string, string][] = [
      ["float", '"text"', "expr-type"],
      ["bool", "Base", "expr-type"],
      ["float", "Nope * 2", "expr-unknown-name"],
      ["float", "Mat.Nope", "expr-unknown-column"],
      ["float", "Base.Mult", "expr-not-reference"],
      ["float", "Level.Mult", "expr-not-reference"],
      ["float", "Mat", "expr-needs-column"],
      ["float", "Tags", "expr-unsupported-column"],
    ];
    let p = withColumn(project, weapons.id, { id: newId(), name: "Tags", type: { kind: "list", item: { kind: "string" } } });
    const ids = cases.map(([kind, formula]) => {
      const id = newId();
      p = withColumn(p, weapons.id, { id, name: `C${id.slice(-4)}`, type: { kind: kind as "float" | "bool" }, formula });
      return id;
    });
    const results = evaluateFormulas(p);
    cases.forEach(([, formula, code], i) => {
      const r = results.get(weapons.id, ids[i]!)!;
      assert.equal(r.error?.code, code, formula);
      assert.equal(r.value(0), undefined);
    });
    const unknown = results.get(weapons.id, ids[2]!)!.error!;
    assert.deepEqual([unknown.start, unknown.end, unknown.params?.table], [0, 4, "Weapons"]);
  });

  it("finds cycles, including self-references and cycles through references", () => {
    const { project, materials, weapons, newId } = sample();
    const a = newId();
    const b = newId();
    const c = newId();
    const self = newId();
    let p = withColumn(project, weapons.id, { id: a, name: "A", type: { kind: "float" }, formula: "B + 1" });
    p = withColumn(p, weapons.id, { id: b, name: "B", type: { kind: "float" }, formula: "A + 1" });
    p = withColumn(p, weapons.id, { id: c, name: "C", type: { kind: "float" }, formula: "A * 2" });
    p = withColumn(p, materials.id, { id: self, name: "Self", type: { kind: "float" }, formula: "Self + 1" });
    const results = evaluateFormulas(p);
    assert.equal(results.get(weapons.id, a)!.error?.code, "expr-cycle");
    assert.equal(results.get(weapons.id, a)!.error?.params?.column, "B");
    assert.equal(results.get(weapons.id, b)!.error?.code, "expr-cycle");
    assert.equal(results.get(weapons.id, c)!.error?.code, "expr-input-error");
    assert.equal(results.get(materials.id, self)!.error?.params?.column, "Self");
  });

  it("ignores formulas on columns that cannot have one", () => {
    const { project, weapons, newId } = sample();
    const tags = newId();
    const p = withColumn(project, weapons.id, { id: tags, name: "Tags", type: { kind: "list", item: { kind: "string" } }, formula: "1" });
    assert.equal(evaluateFormulas(p).get(weapons.id, tags), undefined);
    const issues = validateProject(p);
    assert.ok(issues.some((i) => i.code === "formula-column-type"));
  });

  it("checks drafts without saving them", () => {
    const { project, weapons } = sample();
    const t = table(project, weapons.id);
    assert.ok(checkFormula(project, t, "float", "Base * 2").ok);
    const bad = checkFormula(project, t, "float", "Base * ");
    assert.equal(!bad.ok && bad.error.code, "expr-unexpected-token");
  });
});

describe("formula engine: recalculating after edits", () => {
  /** Damage (reads Materials), Doubled (own row only), Label (string), and a Materials formula. */
  function rich() {
    const s = sample();
    const doubled = s.newId();
    const label = s.newId();
    const power = s.newId();
    let p = withColumn(s.project, s.weapons.id, { id: doubled, name: "Doubled", type: { kind: "float" }, formula: "Base * 2 + Damage" });
    p = withColumn(p, s.weapons.id, { id: label, name: "Label", type: { kind: "string" }, formula: 'if(Base > 5, "big", "small")' });
    p = withColumn(p, s.materials.id, { id: power, name: "Power", type: { kind: "float" }, formula: "Mult * Level" });
    return { ...s, project: p, doubled, label, power };
  }

  it("keeps results of untouched columns and recomputes only changed rows of own-row formulas", () => {
    const { project, weapons, materials, w, doubled, label, power } = rich();
    const engine = new FormulaEngine();
    const r1 = engine.evaluate(project);
    // Edit Base of the last weapon: Materials results stay the same objects.
    const p2 = apply(project, setCell(project, weapons.id, weapons.rows[2]!.id, w.base, 8));
    const r2 = engine.evaluate(p2);
    assert.equal(r2.get(materials.id, power), r1.get(materials.id, power));
    assert.notEqual(r2.get(weapons.id, doubled), r1.get(weapons.id, doubled));
    assert.deepEqual(snapshot(r2), snapshot(evaluateFormulas(p2)));
    assert.deepEqual(columnValues(r2, weapons.id, label), ["big", "big", "big"]);
    // No change at all: every result is reused.
    const r3 = engine.evaluate(p2);
    for (const c of r3.columns) assert.equal(c, r2.get(c.table, c.column));
  });

  it("matches a fresh evaluation through a sequence of edits, row changes, undo and renames", () => {
    const s = rich();
    const engine = new FormulaEngine();
    let p = s.project;
    const undo: Change[] = [];
    const step = (change: Change | null) => {
      assert.ok(change !== null);
      const applied = applyPatches(p, change.patches);
      undo.push({ label: "undo", patches: applied.inverse });
      p = applied.value;
      assert.deepEqual(snapshot(engine.evaluate(p)), snapshot(evaluateFormulas(p)));
    };
    engine.evaluate(p);
    const weapons = () => table(p, s.weapons.id);
    const materials = () => table(p, s.materials.id);
    step(setCell(p, s.weapons.id, weapons().rows[0]!.id, s.w.base, 11));
    step(setCell(p, s.materials.id, materials().rows[0]!.id, s.m.mult, 3));
    step(addRow(p, s.weapons.id, { id: s.newId(), name: "Bow", cells: { [s.w.base]: 7, [s.w.mat]: materials().rows[1]!.id } }));
    step(removeRows(p, s.weapons.id, new Set([weapons().rows[1]!.id])));
    step(setCell(p, s.weapons.id, weapons().rows[1]!.id, s.w.mat, materials().rows[0]!.id));
    step(updateVariable(p, { ...s.level, default: 10 }));
    step(setColumnFormula(p, s.weapons.id, s.doubled, "Damage - Base"));
    step(renameColumn(p, s.materials.id, s.m.mult, "Factor"));
    step(setColumnFormula(p, s.materials.id, s.power, "Damage", undefined));
    step(setColumnFormula(p, s.materials.id, s.power, "Factor + 1"));
    while (undo.length > 0) {
      p = applyPatches(p, undo.pop()!.patches).value;
      assert.deepEqual(snapshot(engine.evaluate(p)), snapshot(evaluateFormulas(p)));
    }
    assert.deepEqual(snapshot(engine.evaluate(p)), snapshot(evaluateFormulas(s.project)));
  });

  it("recomputes everything that reads a changed table through a reference", () => {
    const { project, weapons, materials, w, m } = rich();
    const engine = new FormulaEngine();
    engine.evaluate(project);
    const p2 = apply(project, setCell(project, materials.id, materials.rows[1]!.id, m.mult, 4));
    const values = columnValues(engine.evaluate(p2), weapons.id, w.damage);
    assert.ok(Math.abs((values[1] as number) - 104) < 1e-9);
  });
});

describe("formula edits", () => {
  it("clears stored cells when a column gets a formula and keeps computed values when it is removed", () => {
    const { project, weapons, w } = sample();
    // Base gets a formula: its stored values go.
    const p1 = apply(project, setColumnFormula(project, weapons.id, w.base, " 4 * 2 "));
    const t1 = table(p1, weapons.id);
    assert.equal(t1.columns[0]!.formula, "4 * 2");
    assert.ok(t1.rows.every((r) => r.cells[w.base] === undefined));
    // Removing it writes the computed values back as plain values.
    const p2 = apply(p1, setColumnFormula(p1, weapons.id, w.base, "", evaluateFormulas(p1)));
    const t2 = table(p2, weapons.id);
    assert.equal(t2.columns[0]!.formula, undefined);
    assert.ok(!("formula" in t2.columns[0]!));
    assert.deepEqual(t2.rows.map((r) => r.cells[w.base]), [8, 8, 8]);
  });

  it("refuses columns that cannot have a formula and unchanged formulas", () => {
    const { project, weapons, w, newId } = sample();
    assert.equal(setColumnFormula(project, weapons.id, w.mat, "1"), null);
    assert.equal(setColumnFormula(project, weapons.id, w.damage, "Base * Mat.Mult * (1 + Level * 0.1)"), null);
    assert.equal(setColumnFormula(project, weapons.id, w.base, "x".repeat(10_001)), null);
    const items: TableAsset = { id: newId(), kind: "table", name: "R", role: { kind: "machines", speed: "01KDVDNA0000000000000000SP" }, columns: [{ id: "01KDVDNA0000000000000000SP", name: "Speed", type: { kind: "float" } }], rows: [] };
    const p = { ...project, assets: [...project.assets, items] };
    assert.equal(setColumnFormula(p, items.id, "01KDVDNA0000000000000000SP", "2"), null);
  });

  it("rewrites formulas when a column is renamed, here and through references", () => {
    const { project, materials, weapons, m, w, newId } = sample();
    // A Weapons column named Mult and a variable Tier must not be renamed.
    const own = newId();
    let p = withColumn(project, weapons.id, { id: own, name: "Mult", type: { kind: "float" } });
    const mix = newId();
    p = withColumn(p, weapons.id, { id: mix, name: "Mix", type: { kind: "float" }, formula: "Mult + Mat.Mult * mat.mult" });
    const inner = newId();
    p = withColumn(p, materials.id, { id: inner, name: "Inner", type: { kind: "float" }, formula: "mult * 2" });
    p = apply(p, renameColumn(p, materials.id, m.mult, "Factor"));
    assert.equal(table(p, weapons.id).columns.find((c) => c.id === mix)!.formula, "Mult + Mat.Factor * mat.Factor");
    assert.equal(table(p, weapons.id).columns.find((c) => c.id === w.damage)!.formula, "Base * Mat.Factor * (1 + Level * 0.1)");
    assert.equal(table(p, materials.id).columns.find((c) => c.id === inner)!.formula, "Factor * 2");
    // Renaming the reference column itself.
    p = apply(p, renameColumn(p, weapons.id, w.mat, "Material"));
    assert.equal(table(p, weapons.id).columns.find((c) => c.id === mix)!.formula, "Mult + Material.Factor * Material.Factor");
    assert.equal(evaluateFormulas(p).get(weapons.id, w.damage)!.error, undefined);
  });

  it("rewrites formulas when a variable is renamed, unless a column shadows it or it follows a dot", () => {
    const { project, materials, weapons, level, newId } = sample();
    const shadow = newId();
    let p = withColumn(project, materials.id, { id: newId(), name: "Level", type: { kind: "int" } });
    p = withColumn(p, materials.id, { id: shadow, name: "Shadow", type: { kind: "int" }, formula: "Level + 1" });
    const dotted = newId();
    p = withColumn(p, weapons.id, { id: dotted, name: "Dotted", type: { kind: "float" }, formula: "Mat.Level + Level" });
    p = apply(p, updateVariable(p, { ...level, name: "PlayerLevel" }));
    assert.equal(table(p, weapons.id).columns.find((c) => c.name === "Damage")!.formula, "Base * Mat.Mult * (1 + PlayerLevel * 0.1)");
    assert.equal(table(p, weapons.id).columns.find((c) => c.id === dotted)!.formula, "Mat.Level + PlayerLevel");
    assert.equal(table(p, materials.id).columns.find((c) => c.id === shadow)!.formula, "Level + 1");
  });
});

describe("formula columns in the grid, CSV and validation", () => {
  it("copies computed values; paste, clear and fill leave formula cells alone", () => {
    const { project, weapons, w } = sample();
    const t = table(project, weapons.id);
    const names = rowNames(project);
    const results = evaluateFormulas(project);
    const damageCol = t.columns.findIndex((c) => c.id === w.damage) + 1;
    const copied = copyRange(t, { top: 0, left: damageCol, bottom: 1, right: damageCol }, names, results);
    assert.ok(copied.ok);
    assert.equal(copied.value, "19.5\n52\n");
    const pasted = pasteGrid(project, weapons.id, { top: 0, left: damageCol, bottom: 0, right: damageCol }, [["5"]], names, () => "01KDVDNA0000000000000000ZZ");
    assert.ok(pasted.ok);
    assert.equal(pasted.value.change, null);
    assert.equal(pasted.value.skipped, 1);
    const cleared = clearRange(project, weapons.id, { top: 0, left: damageCol, bottom: 2, right: damageCol });
    assert.ok(cleared.ok);
    assert.equal(cleared.value, null);
  });

  it("exports computed values and skips formula columns on import", () => {
    const { project, weapons, newId } = sample();
    const t = table(project, weapons.id);
    const csv = exportTableCsv(project, t);
    const lines = csv.trim().split("\n");
    assert.equal(lines[0], "Name,Base,Mat,Rarity,Title,Damage");
    assert.ok(lines[1]!.endsWith(",19.5"));
    assert.ok(lines[3]!.endsWith(",0"));
    const imported = importTableCsv(project, t, "Name,Base,Damage\nSword,1,999\n", newId);
    assert.ok(imported.ok);
    assert.deepEqual(imported.value.issues, [{ code: "formula-column", column: "Damage" }]);
    assert.equal(imported.value.rows[0]!.cells[t.columns[4]!.id], undefined);
    assert.equal(imported.value.rows[0]!.cells[t.columns[0]!.id], 1);
  });

  it("reports column errors, failing rows and constraint violations once per column", () => {
    const { project, weapons, w, newId } = sample();
    const ratio = newId();
    const capped = newId();
    const code = newId();
    let p = withColumn(project, weapons.id, { id: ratio, name: "Ratio", type: { kind: "float" }, formula: "Base / Mat.Tier" });
    p = withColumn(p, weapons.id, { id: capped, name: "Capped", type: { kind: "int", min: 0, max: 10 }, formula: "round(Base)" });
    p = withColumn(p, weapons.id, { id: code, name: "Code", type: { kind: "string", unique: true }, formula: '"same"' });
    p = withColumn(p, weapons.id, { id: newId(), name: "Broken", type: { kind: "float" }, formula: "1 +" });
    // A leftover stored value in a formula column.
    const index = p.assets.findIndex((a) => a.id === weapons.id);
    p = applyPatches(p, [{ op: "set", path: ["assets", index, "rows", 0, "cells", w.damage], value: 1 }]).value;
    const issues = validateProject(p);
    const byCode = (c: string) => issues.filter((i) => i.code === c);
    assert.equal(byCode("formula-cell-errors").length, 1);
    assert.deepEqual(byCode("formula-cell-errors")[0]!.path, ["assets", index, "rows", 2, "cells", ratio]);
    assert.equal(byCode("out-of-range")[0]!.params?.count, 1);
    assert.deepEqual(byCode("duplicate-value")[0]!.params, { firstRow: 0, count: 2 });
    assert.equal(byCode("expr-unexpected-token")[0]!.path.at(-1), "formula");
    assert.equal(byCode("formula-stored-values")[0]!.params?.count, 1);
    // Unknown stored values do not produce type errors for the formula column.
    assert.equal(byCode("type-mismatch").length, 0);
  });

  it("reuses formula findings through the validation cache", async () => {
    const { createValidationCache } = await import("../../src/core/index.ts");
    const { project, materials, m } = sample();
    const engine = new FormulaEngine();
    const cache = createValidationCache();
    validateProject(project, undefined, cache, engine.evaluate(project));
    const p2 = apply(project, setCell(project, materials.id, materials.rows[0]!.id, m.tier, 5));
    assert.deepEqual(validateProject(p2, undefined, cache, engine.evaluate(p2)), validateProject(p2));
  });

  it("round-trips formulas through the project file", () => {
    const { project, weapons, w } = sample();
    const loaded = loadProject(saveProject(project));
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.issues, []);
    assert.equal(table(loaded.value.project, weapons.id).columns.find((c) => c.id === w.damage)!.formula, "Base * Mat.Mult * (1 + Level * 0.1)");
  });
});
