import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  createTable,
  guardFormula,
  unguardFormula,
  createProductionSample,
  createRandom,
  exportTableCsv,
  importTableCsv,
  parseCsv,
  GENERIC_CSV,
  parseUnrealValue,
  UNREAL_CSV,
  sampleBinomial,
  writeCsv,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

describe("csv", () => {
  it("round-trips quotes, delimiters, newlines and surrounding spaces", () => {
    const rows = [["a", 'he said "hi"', "x,y"], ["multi\nline", " padded ", ""]];
    const text = writeCsv(rows);
    const parsed = parseCsv(text);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, rows);
  });

  it("accepts CRLF, a BOM and TSV", () => {
    const parsed = parseCsv("﻿a\tb\r\nc\td\r\n", "\t");
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, [["a", "b"], ["c", "d"]]);
    const empty = parseCsv("");
    assert.ok(empty.ok);
    assert.deepEqual(empty.value, []);
  });

  it("reports an unclosed quote with its line", () => {
    const parsed = parseCsv('a\n"b,c\nd');
    assert.ok(!parsed.ok && parsed.error.code === "unclosed-quote" && parsed.error.line === 2);
  });

  it("enforces the cell limit", () => {
    const parsed = parseCsv("a,b,c\nd,e,f", ",", { maxChars: 100, maxCells: 4 });
    assert.ok(!parsed.ok && parsed.error.code === "too-many-cells");
  });
});

describe("unreal text format", () => {
  it("parses nested structs with quoted strings", () => {
    const v = parseUnrealValue('((Item="Iron \\"Ore\\"",Count=2),(Item="Coal",Count=1,Chance=0.5))');
    assert.deepEqual(v, [
      { Item: 'Iron "Ore"', Count: "2" },
      { Item: "Coal", Count: "1", Chance: "0.5" },
    ]);
    assert.equal(parseUnrealValue("((a)"), null);
    assert.equal(parseUnrealValue("(a=1,2)"), null);
    assert.equal(parseUnrealValue("(__proto__=1)"), null);
  });
});

function sampleProject(): { project: Project; recipes: TableAsset; items: TableAsset } {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" });
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  return { project, recipes: tables.recipes, items: tables.items };
}

describe("table csv", () => {
  it("exports engine-neutral CSV by default (JSON cells)", () => {
    const { project, recipes } = sampleProject();
    const lines = exportTableCsv(project, recipes).split("\n");
    assert.equal(lines[0], "Name,Inputs,Outputs,Time,Machine,Gate");
    assert.equal(
      lines[2],
      'SmeltIronBar,"[{""item"":""IronOre"",""count"":2},{""tag"":""Fuel"",""count"":1}]","[{""item"":""IronBar"",""count"":1},{""item"":""Slag"",""count"":1,""chance"":0.1}]",4,Furnace,',
    );
  });

  it("exports in Unreal DataTable layout with the unreal format", () => {
    const { project, recipes } = sampleProject();
    const lines = exportTableCsv(project, recipes, { format: UNREAL_CSV }).split("\n");
    assert.equal(lines[0], "---,Inputs,Outputs,Time,Machine,Gate");
    assert.equal(lines[2], 'SmeltIronBar,"((Item=""IronOre"",Count=2),(Tag=""Fuel"",Count=1))","((Item=""IronBar"",Count=1),(Item=""Slag"",Count=1,Chance=0.1))",4,Furnace,');
  });

  for (const format of [GENERIC_CSV, UNREAL_CSV]) {
    for (const delimiter of [",", "\t"]) {
      it(`re-imports its own ${format.id} export unchanged (delimiter ${JSON.stringify(delimiter)})`, () => {
        const { project, recipes, items } = sampleProject();
        for (const table of [recipes, items]) {
          const options = { format, delimiter };
          const result = importTableCsv(project, table, exportTableCsv(project, table, options), fixedIds(99), options);
          assert.ok(result.ok);
          assert.deepEqual(result.value.issues, []);
          assert.equal(result.value.removed, 0);
          assert.deepEqual(result.value.rows, table.rows);
        }
      });
    }
  }

  it("reads case-insensitive field names and missing counts", () => {
    const { project, recipes, items } = sampleProject();
    const csv = 'Name,Outputs,Time\nMakeCoal,"[{""Item"":""coal""}]",1\n';
    const result = importTableCsv(project, recipes, csv, fixedIds(99));
    assert.ok(result.ok);
    assert.deepEqual(result.value.issues, []);
    const coal = items.rows.find((r) => r.name === "Coal")!.id;
    assert.deepEqual(Object.values(result.value.rows[0]!.cells), [[{ item: coal, count: 1 }], 1]);
  });

  it("reports unreadable cells and unknown headers", () => {
    const { project, recipes } = sampleProject();
    const csv = "---,Time,Machine,Bogus\nNew_Recipe,fast,Nope,1\n1bad,2,,\n";
    const result = importTableCsv(project, recipes, csv, fixedIds(99));
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.issues.map((i) => i.code),
      ["unknown-header", "invalid-value", "invalid-value", "invalid-row-name"],
    );
    assert.equal(result.value.rows.length, 1);
    assert.equal(result.value.removed, 3);
  });
});

describe("random", () => {
  it("is deterministic per seed and roughly uniform", () => {
    const a = createRandom(1);
    const b = createRandom(1);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = a.next();
      assert.equal(x, b.next());
      assert.ok(x >= 0 && x < 1);
      sum += x;
    }
    assert.ok(Math.abs(sum / 10_000 - 0.5) < 0.02);
    assert.notEqual(createRandom(2).next(), createRandom(1).next());
  });

  it("binomial samples have the right mean on every code path", () => {
    const random = createRandom(7);
    for (const [n, p] of [
      [20, 0.3],
      [1_000, 0.5],
      [10_000, 0.0005],
      [10_000, 0.9995],
      [10.5, 0.4],
    ] as const) {
      let sum = 0;
      const runs = 4_000;
      for (let i = 0; i < runs; i++) sum += sampleBinomial(random, n, p);
      const mean = n * p;
      const sd = Math.sqrt(n * p * (1 - p) + 0.25);
      assert.ok(Math.abs(sum / runs - mean) < (5 * sd) / Math.sqrt(runs) + 1e-9, `n=${n} p=${p} mean=${sum / runs}`);
    }
  });
});

describe("spreadsheet-safe text", () => {
  it("guards formula starts and undoes exactly that, for any text", () => {
    for (const text of ["", "plain", "=1+1", "+10% speed", "-5", "@SUM(A1)", "\tTab", "'quoted", "'=x", "''-y", "a=b", "x'=y"]) {
      assert.equal(unguardFormula(guardFormula(text)), text, JSON.stringify(text));
    }
    assert.equal(guardFormula("=1+1"), "'=1+1");
    assert.equal(guardFormula("plain"), "plain");
    // Foreign CSV that already has the apostrophe (typed in Excel) reads back as the text.
    assert.equal(unguardFormula("'=1+1"), "=1+1");
  });

  it("exports string and text cells guarded, only when asked, and imports them back", () => {
    const newId = fixedIds();
    const project = createEmptyProject("P", newId);
    const table = createTable(newId, "T");
    const column = { id: newId(), name: "Note", type: { kind: "string" as const } };
    const number = { id: newId(), name: "Delta", type: { kind: "float" as const } };
    table.columns.push(column, number);
    table.rows.push({ id: newId(), name: "A", cells: { [column.id]: "=HYPERLINK(\"x\")", [number.id]: -5 } });
    table.rows.push({ id: newId(), name: "B", cells: { [column.id]: "'=odd", [number.id]: 2 } });
    project.assets.push(table);

    const plain = exportTableCsv(project, table);
    assert.ok(plain.includes("=HYPERLINK"));
    // Unguarded: the formula text is written as is, and row B's own `'=odd` is untouched.
    assert.ok(!plain.includes("''="));
    assert.ok(plain.includes(",'=odd"));

    const safe = exportTableCsv(project, table, { spreadsheetSafe: true });
    const parsed = parseCsv(safe);
    assert.ok(parsed.ok);
    assert.equal(parsed.value[1]![1], "'=HYPERLINK(\"x\")");
    assert.equal(parsed.value[2]![1], "''=odd");
    // Numbers stay numbers: a negative value is not a formula in a number column.
    assert.equal(parsed.value[1]![2], "-5");

    const back = importTableCsv(project, table, safe, newId, { spreadsheetSafe: true });
    assert.ok(back.ok);
    assert.deepEqual(back.value.issues, []);
    assert.equal(back.value.rows[0]!.cells[column.id], "=HYPERLINK(\"x\")");
    assert.equal(back.value.rows[1]!.cells[column.id], "'=odd");
    assert.equal(back.value.rows[0]!.cells[number.id], -5);
  });
});
