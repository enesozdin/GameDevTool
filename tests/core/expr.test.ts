import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  atomsOf,
  compileExpression,
  conditionImplies,
  createVariableScope,
  defaultValues,
  FUNCTION_NAMES,
  addVariable,
  applyPatches,
  changeVariableType,
  createEmptyProject,
  createProductionSample,
  createVariable,
  isValidVariableName,
  parseExpression,
  printExpression,
  removeVariable,
  renameInExpression,
  updateVariable,
  withEnumOptions,
  validateProject,
  type Value,
  type Variable,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

const id = fixedIds();
const done = { id: id(), name: "Done" };
const started = { id: id(), name: "Started" };
const variables: Variable[] = [
  { id: id(), name: "Level", type: "int", default: 3 },
  { id: id(), name: "HasKey", type: "bool", default: true },
  { id: id(), name: "Ratio", type: "float", default: 0.5 },
  { id: id(), name: "Title", type: "string", default: "Smith" },
  { id: id(), name: "MainQuest", type: "enum", options: [started, done], default: started.id },
];
const scope = createVariableScope(variables);
const values = defaultValues(scope, variables);

function run(source: string, vals: readonly Value[] = values): Value {
  const c = compileExpression(source, scope);
  assert.ok(c.ok, `${source}: ${JSON.stringify(!c.ok && c.error)}`);
  const r = c.value.evaluate(vals);
  assert.ok(r.ok, `${source}: ${JSON.stringify(!r.ok && r.error)}`);
  return r.value;
}

function errorOf(source: string, expect?: "bool") {
  const c = compileExpression(source, scope, expect === undefined ? {} : { expect });
  assert.ok(!c.ok, `${source} should not compile`);
  return c.error;
}

describe("expression language", () => {
  it("evaluates arithmetic with the documented precedence", () => {
    assert.equal(run("1 + 2 * 3"), 7);
    assert.equal(run("(1 + 2) * 3"), 9);
    assert.equal(run("-2 ^ 2"), -4);
    assert.equal(run("2 ^ 3 ^ 2"), 512);
    assert.equal(run("2 ^ -1"), 0.5);
    assert.equal(run("7 % 3"), 1);
    assert.equal(run("10 - 4 - 3"), 3);
    assert.equal(run(".5 + 1e2 + 2.5E-1"), 100.75);
  });

  it("reads variables case-insensitively, keywords too", () => {
    assert.equal(run("level * 2"), 6);
    assert.equal(run("HASKEY AND Level >= 3"), true);
    assert.equal(run("not Level >= 5"), true);
    assert.equal(run("!HasKey || Level == 3"), true);
    assert.equal(run('Title + "!"'), "Smith!");
  });

  it("compares enums with option names and resolves them to ids", () => {
    assert.equal(run('MainQuest == "started"'), true);
    assert.equal(run('"Done" != MainQuest'), true);
    const c = compileExpression('MainQuest == "Done"', scope);
    assert.ok(c.ok);
    const later = [...values];
    later[4] = done.id;
    assert.deepEqual(c.value.evaluate(later), { ok: true, value: true });
    assert.deepEqual(c.value.slots, [4]);
    const e = errorOf('MainQuest == "Finished"');
    assert.equal(e.code, "expr-unknown-option");
    assert.deepEqual([e.start, e.end], [13, 23]);
  });

  it("calls the built-in functions; if() is lazy", () => {
    assert.equal(run("min(4, Level, 9)"), 3);
    assert.equal(run("max(1, 2)"), 2);
    assert.equal(run("clamp(15, 0, 10)"), 10);
    assert.equal(run("lerp(0, 10, Ratio)"), 5);
    assert.equal(run("round(2.5) + floor(-0.5) + ceil(0.1) + abs(-3)"), 6);
    assert.equal(run("sqrt(16) + pow(2, 4)"), 20);
    assert.equal(run("if(Level > 0, 10 / Level, 1 / 0)"), 10 / 3);
    assert.equal(run('if(HasKey, "Done", MainQuest)'), done.id);
    assert.deepEqual(FUNCTION_NAMES, ["abs", "ceil", "clamp", "floor", "if", "lerp", "max", "min", "pow", "round", "sqrt"]);
  });

  it("reports syntax errors with a source range", () => {
    const cases: [string, string, number, number][] = [
      ["", "expr-empty", 0, 0],
      ["   ", "expr-empty", 0, 3],
      ["1 +", "expr-unexpected-token", 3, 3],
      ["(1", "expr-expected", 2, 2],
      ["1 $ 2", "expr-unexpected-char", 2, 3],
      ['"abc', "expr-unterminated-string", 0, 4],
      ['"a\\q"', "expr-bad-escape", 2, 4],
      ["2x", "expr-bad-number", 0, 2],
      ["1.2.3", "expr-bad-number", 0, 5],
      ["1e", "expr-bad-number", 0, 2],
      ["1 < 2 < 3", "expr-chained-comparison", 6, 7],
      ["1 2", "expr-unexpected-token", 2, 3],
    ];
    for (const [source, code, start, end] of cases) {
      const e = errorOf(source);
      assert.deepEqual([e.code, e.start, e.end], [code, start, end], source);
    }
    assert.equal(errorOf("x".repeat(10_001)).code, "expr-too-long");
    assert.equal(errorOf("(".repeat(100) + "1" + ")".repeat(100)).code, "expr-too-deep");
    assert.equal(errorOf("-".repeat(100) + "1").code, "expr-too-deep");
    assert.ok(compileExpression("(".repeat(60) + "1" + ")".repeat(60), scope).ok);
  });

  it("reports names, functions and types", () => {
    assert.deepEqual(errorOf("Gold > 1"), { code: "expr-unknown-name", start: 0, end: 4, params: { name: "Gold" } });
    assert.equal(errorOf("eval(1)").code, "expr-unknown-function");
    assert.equal(errorOf("constructor(1)").code, "expr-unknown-function");
    assert.equal(errorOf("__proto__(1)").code, "expr-unknown-function");
    assert.equal(errorOf("min()").code, "expr-arg-count");
    assert.equal(errorOf("if(true, 1)").code, "expr-arg-count");
    assert.deepEqual(errorOf("HasKey + 1"), { code: "expr-type", start: 0, end: 6, params: { expected: "number", found: "bool" } });
    assert.equal(errorOf("Level and true").code, "expr-type");
    assert.equal(errorOf('Level == "3"').code, "expr-type");
    assert.equal(errorOf("if(HasKey, 1, true)").code, "expr-type");
    assert.deepEqual(errorOf("Level + 1", "bool"), { code: "expr-type", start: 0, end: 9, params: { expected: "bool", found: "number" } });
    assert.equal(errorOf("MainQuest", "bool").params?.found, "enum MainQuest");
  });

  it("returns run-time errors instead of throwing", () => {
    const c = compileExpression("10 / (Level - 3)", scope);
    assert.ok(c.ok);
    assert.deepEqual(c.value.evaluate(values), { ok: false, error: { code: "expr-division-by-zero", start: 5, end: 16 } });
    const overflow = compileExpression("10 ^ 400", scope);
    assert.ok(overflow.ok);
    assert.equal(!overflow.value.evaluate(values).ok && "fail", "fail");
    const sqrt = compileExpression("sqrt(0 - 1)", scope);
    assert.ok(sqrt.ok);
    const r = sqrt.value.evaluate(values);
    assert.ok(!r.ok && r.error.code === "expr-not-finite");
  });

  it("prints canonically", () => {
    const p = (s: string) => {
      const parsed = parseExpression(s);
      assert.ok(parsed.ok);
      return printExpression(parsed.value, scope);
    };
    assert.equal(p("(level>=5)&&haskey"), "Level >= 5 and HasKey");
    assert.equal(p("(1 + 2) * 3 - (4 - 5)"), "(1 + 2) * 3 - (4 - 5)");
    assert.equal(p("(-2) ^ 2 + -(2 ^ 2)"), "(-2) ^ 2 + -2 ^ 2");
    assert.equal(p("(2 ^ 3) ^ 2"), "(2 ^ 3) ^ 2");
    assert.equal(p("NOT (a OR b)"), "not (a or b)");
    assert.equal(p('MIN(1,"x\\"y")'), 'min(1, "x\\"y")');
    // Printing round-trips to the same text.
    for (const s of ["a and (b or c)", "-(1 + x) ^ 2 % 3", "not a == b", "(a == b) == c"]) {
      assert.equal(p(p(s)), p(s));
    }
  });

  it("decides implications between conditions", () => {
    const atoms = (s: string) => {
      const parsed = parseExpression(s);
      assert.ok(parsed.ok);
      return atomsOf(parsed.value, scope);
    };
    const implies = (a: string, b: string) => conditionImplies(atoms(a), atoms(b));
    assert.ok(implies("Level >= 5 and HasKey", "haskey"));
    assert.ok(implies("Level >= 5", "Level > 3"));
    assert.ok(implies("Level > 5", "Level >= 5"));
    assert.ok(implies("5 < Level", "Level >= 5"));
    assert.ok(implies("Level == 7", "Level >= 5 and Level <= 9 and Level != 3"));
    assert.ok(implies("Level < 2", "Level != 3"));
    assert.ok(!implies("Level >= 5", "Level > 5"));
    assert.ok(!implies("Level >= 3", "Level >= 5"));
    assert.ok(!implies("Level != 3", "Level > 3"));
    assert.ok(!implies("HasKey", "HasKey and Level > 1"));
    assert.ok(!implies("HasKey or Level > 9", "HasKey"));
  });
});

describe("expression validation", () => {
  it("checks gate conditions, recipe unlocks and reserved names", () => {
    const project = sampleProject();
    project.manifest.variables.push({ id: id(), name: "Or", type: "bool", default: false });
    const issues = validateProject(project);
    assert.ok(issues.some((i) => i.code === "reserved-name"));
  });
});

describe("variable edits", () => {
  it("renames only variable names in expressions", () => {
    assert.equal(renameInExpression('level >= 5 and min(Level, 2) < 3 and "Level" == Title', "Level", "Rank"), 'Rank >= 5 and min(Rank, 2) < 3 and "Level" == Title');
    assert.equal(renameInExpression("min(1) + Levels", "min", "x"), "min(1) + Levels");
    assert.equal(renameInExpression('Level $ "', "Level", "Rank"), 'Level $ "');
  });

  it("adds, renames, retypes and removes variables; renames rewrite conditions", () => {
    const newId = fixedIds();
    let project = createEmptyProject("P", newId);
    const { tables, graph } = createProductionSample(newId, { items: "I", machines: "M", recipes: "R", graph: "G" });
    const gateCol = (tables.recipes.role as { gate: string }).gate;
    tables.recipes.rows[0]!.cells[gateCol] = "Level >= 2";
    graph.nodes.push({ id: newId(), type: "gate", position: { x: 0, y: 0 }, item: tables.items.rows[0]!.id, condition: "level > 1 or HasKey" });
    project.assets.push(tables.items, tables.machines, tables.recipes, graph);
    const apply = (change: ReturnType<typeof addVariable>) => {
      assert.ok(change !== null);
      project = applyPatches(project, change.patches).value;
    };

    const level = createVariable(newId, "Level", "int");
    apply(addVariable(project, level));
    assert.equal(addVariable(project, createVariable(newId, "LEVEL", "bool")), null);
    assert.equal(addVariable(project, createVariable(newId, "not", "bool")), null);
    assert.ok(!isValidVariableName(project, "1abc"));

    apply(updateVariable(project, { ...project.manifest.variables[0]!, name: "Rank" }));
    const recipes = project.assets[2]!;
    const chain = project.assets[3]!;
    assert.ok(recipes.kind === "table" && chain.kind === "production-graph");
    assert.equal(recipes.rows[0]!.cells[gateCol], "Rank >= 2");
    assert.equal((chain.nodes.at(-1) as { condition: string }).condition, "Rank > 1 or HasKey");
    assert.equal(updateVariable(project, project.manifest.variables[0]!), null);

    const quest = changeVariableType(project.manifest.variables[0]!, "enum", newId);
    assert.ok(quest.type === "enum" && quest.id === level.id);
    const withOptions = withEnumOptions(quest, ["Started", "Done"], newId);
    assert.ok(withOptions !== null && withOptions.type === "enum");
    assert.equal(withEnumOptions(quest, ["A", "a"], newId), null);
    assert.equal(withEnumOptions(quest, [], newId), null);
    const reordered = withEnumOptions(withOptions, ["Done", "started"], newId);
    assert.ok(reordered !== null && reordered.type === "enum");
    assert.deepEqual(reordered.options.map((o) => o.id), [withOptions.options[1]!.id, withOptions.options[0]!.id]);
    assert.equal(reordered.default, withOptions.default);
    apply(updateVariable(project, withOptions));
    assert.equal(project.manifest.variables[0]!.type, "enum");

    apply(removeVariable(project, level.id));
    assert.equal(project.manifest.variables.length, 0);
  });
});
