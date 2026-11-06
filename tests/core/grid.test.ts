import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPatches,
  clearRange,
  copyRange,
  fillDown,
  pasteText,
  rangeOf,
  rowNames,
  setRangeText,
  validateProject,
  type Change,
  type GridRange,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

function items(project: Project): TableAsset {
  return project.assets.find((a) => a.kind === "table" && a.name === "Items") as TableAsset;
}

function recipes(project: Project): TableAsset {
  return project.assets.find((a) => a.kind === "table" && a.name === "Recipes") as TableAsset;
}

function apply(project: Project, change: Change | null): Project {
  assert.ok(change !== null);
  return applyPatches(project, change.patches).value;
}

const all = (table: TableAsset): GridRange => rangeOf(table, { row: 0, col: 0 }, { row: table.rows.length - 1, col: table.columns.length })!;

describe("grid", () => {
  it("clamps and normalizes ranges", () => {
    const table = items(sampleProject());
    assert.deepEqual(rangeOf(table, { row: 5, col: 9 }, { row: -1, col: 1 }), { row0: 0, row1: 1, col0: 1, col1: 2 });
    assert.equal(rangeOf({ ...table, rows: [] }, { row: 0, col: 0 }), null);
  });

  it("copies a range as TSV in the cell syntax, and pasting it back changes nothing", () => {
    const project = sampleProject();
    const table = recipes(project);
    const names = rowNames(project);
    const text = copyRange(table, all(table), names);
    assert.equal(text, "SmeltIron\tIronBar\tIronOre, IronOre\t2.5\t1\tCommon\ttrue\t\tSMELT_IRON\n");
    const pasted = pasteText(project, table.id, all(table), text, names, fixedIds(2e12));
    assert.ok(pasted.ok);
    assert.equal(pasted.value.change, null);
    assert.equal(pasted.value.invalid, 0);
    assert.equal(pasted.value.dropped, 1); // the curve cell is never pasted
  });

  it("pastes a block from a spreadsheet, appending rows and keeping names unique", () => {
    const project = sampleProject();
    const table = items(project);
    const names = rowNames(project);
    const text = "IronOre\tIron ore\t2\nCopperOre\tCopper\t1,5\nironore\tDup\t3\n\tUnnamed\tx\n";
    const pasted = pasteText(project, table.id, { row0: 0, col0: 0, row1: 0, col1: 0 }, text, names, fixedIds(2e12));
    assert.ok(pasted.ok);
    const { change, addedRows, invalid, range } = pasted.value;
    assert.equal(addedRows, 2);
    assert.equal(invalid, 2); // "ironore" is taken, "x" is not a number
    assert.deepEqual(range, { row0: 0, col0: 0, row1: 3, col1: 2 });
    const next = items(apply(project, change));
    assert.deepEqual(
      next.rows.map((r) => r.name),
      ["IronOre", "CopperOre", "Row", "Row_2"],
    );
    const [display, weight] = next.columns;
    assert.deepEqual(next.rows[0]!.cells[display!.id], { key: "item.iron_ore", source: "Iron ore" });
    assert.equal(next.rows[1]!.cells[weight!.id], 1.5);
    assert.equal(next.rows[3]!.cells[weight!.id], undefined);
    assert.notEqual((next.rows[2]!.cells[display!.id] as { key: string }).key, (next.rows[3]!.cells[display!.id] as { key: string }).key);
    assert.deepEqual(validateProject(apply(project, change)).filter((i) => i.severity === "error"), []);
  });

  it("repeats one copied value over the whole selection and drops columns past the end", () => {
    const project = sampleProject();
    const table = items(project);
    const names = rowNames(project);
    const weight = table.columns[1]!.id;
    const fill = pasteText(project, table.id, { row0: 0, col0: 2, row1: 1, col1: 2 }, "7\n", names, fixedIds(2e12));
    assert.ok(fill.ok);
    const next = items(apply(project, fill.value.change));
    assert.deepEqual(next.rows.map((r) => r.cells[weight]), [7, 7]);

    const wide = pasteText(project, table.id, { row0: 1, col0: 2, row1: 1, col1: 2 }, "4\t5\t6\n", names, fixedIds(2e12));
    assert.ok(wide.ok);
    assert.equal(wide.value.dropped, 2);
    assert.equal(items(apply(project, wide.value.change)).rows[1]!.cells[weight], 4);
  });

  it("fills down with fresh localization keys", () => {
    const project = sampleProject();
    const table = items(project);
    const change = fillDown(project, table.id, all(table), fixedIds(2e12));
    const next = items(apply(project, change));
    const [display, weight] = next.columns;
    assert.equal(next.rows[1]!.cells[weight!.id], 1);
    assert.deepEqual(next.rows[1]!.cells[display!.id], { key: "item.iron_bar", source: "Iron Ore" });
    assert.equal(next.rows[1]!.name, "IronBar");
  });

  it("clears and bulk-edits a range as one change each", () => {
    const project = sampleProject();
    const table = items(project);
    const names = rowNames(project);
    const cleared = clearRange(project, table.id, all(table));
    assert.ok(cleared !== null);
    assert.equal(cleared.patches.length, 4);
    assert.equal(items(apply(project, cleared)).rows[0]!.name, "IronOre");
    assert.equal(clearRange(apply(project, cleared), table.id, all(table)), null);

    const bulk = setRangeText(project, table.id, all(table), "3", names, fixedIds(2e12));
    assert.equal(bulk.invalid, 0);
    const next = items(apply(project, bulk.change));
    assert.deepEqual(next.rows.map((r) => r.cells[next.columns[1]!.id]), [3, 3]);
    assert.deepEqual(next.rows.map((r) => (r.cells[next.columns[0]!.id] as { source: string }).source), ["3", "3"]);

    const bad = setRangeText(project, table.id, { row0: 0, col0: 2, row1: 1, col1: 2 }, "heavy", names, fixedIds(2e12));
    assert.equal(bad.invalid, 2);
    assert.equal(bad.change, null);
  });

  it("rejects pastes over the cell limit and unclosed quotes", () => {
    const project = sampleProject();
    const table = items(project);
    const names = rowNames(project);
    const quoted = pasteText(project, table.id, { row0: 0, col0: 1, row1: 0, col1: 1 }, '"open', names, fixedIds(2e12));
    assert.ok(!quoted.ok);
    assert.equal(quoted.error.code, "unclosed-quote");
    const huge = pasteText(project, table.id, { row0: 0, col0: 1, row1: 1999, col1: 1999 }, "1\n", names, fixedIds(2e12));
    assert.ok(!huge.ok);
    assert.equal(huge.error.code, "too-many-cells");
  });
});
