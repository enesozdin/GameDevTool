import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPatches,
  clearRange,
  copyRange,
  createEmptyProject,
  fillDown,
  gridRange,
  MAX_GRID_WRITE_CELLS,
  parseClipboardText,
  pasteGrid,
  rowNames,
  setBoolRange,
  textToCell,
  validateProject,
  type Change,
  type GridRange,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

/** Items(Ore, Bar) and a Stats table: Hp int, Speed float, Name text, Flying bool, Rarity enum, Drop reference, Path curve. */
function sample() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const items: TableAsset = {
    id: newId(),
    kind: "table",
    name: "Items",
    columns: [],
    rows: [
      { id: newId(), name: "Ore", cells: {} },
      { id: newId(), name: "Bar", cells: {} },
    ],
  };
  const col = { hp: newId(), speed: newId(), name: newId(), flying: newId(), rarity: newId(), drop: newId(), path: newId() };
  const common = { id: newId(), name: "Common" };
  const rare = { id: newId(), name: "Rare" };
  const stats: TableAsset = {
    id: newId(),
    kind: "table",
    name: "Stats",
    columns: [
      { id: col.hp, name: "Hp", type: { kind: "int", min: 0 } },
      { id: col.speed, name: "Speed", type: { kind: "float" } },
      { id: col.name, name: "Title", type: { kind: "text" } },
      { id: col.flying, name: "Flying", type: { kind: "bool" } },
      { id: col.rarity, name: "Rarity", type: { kind: "enum", options: [common, rare] } },
      { id: col.drop, name: "Drop", type: { kind: "reference", table: items.id } },
      { id: col.path, name: "Path", type: { kind: "curve" } },
    ],
    rows: [
      { id: newId(), name: "Goblin", cells: { [col.hp]: 10, [col.speed]: 1.5, [col.name]: { key: "k.goblin", source: "Goblin" }, [col.flying]: false, [col.rarity]: common.id, [col.drop]: items.rows[0]!.id } },
      { id: newId(), name: "Bat", cells: { [col.hp]: 4, [col.flying]: true } },
      { id: newId(), name: "Troll", cells: { [col.hp]: 40 } },
    ],
  };
  project.assets.push(items, stats);
  return { project, newId, items, stats, col, common, rare };
}

function apply(project: Project, change: Change | null): Project {
  assert.ok(change !== null, "expected a change");
  return applyPatches(project, change.patches).value;
}

function stats(project: Project): TableAsset {
  return project.assets.find((a) => a.kind === "table" && a.name === "Stats") as TableAsset;
}

const all = (t: TableAsset): GridRange => ({ top: 0, left: 0, bottom: t.rows.length - 1, right: t.columns.length });

describe("table grid: copy", () => {
  it("copies a range as TSV with names, enum names and reference names", () => {
    const { project, stats: t } = sample();
    const tsv = copyRange(t, { top: 0, left: 0, bottom: 1, right: 6 }, rowNames(project));
    assert.equal(tsv, "Goblin\t10\t1.5\tGoblin\tfalse\tCommon\tOre\nBat\t4\t\t\ttrue\t\t");
  });

  it("quotes fields with tabs, quotes and line breaks, and the text parses back", () => {
    const { project, stats: t, col } = sample();
    const sources = ["a\tb", 'say "hi"', "line1\nline2"];
    const table: TableAsset = { ...t, rows: t.rows.map((r, i) => ({ ...r, cells: { [col.name]: { key: `k${i}`, source: sources[i]! } } })) };
    const tsv = copyRange(table, { top: 0, left: 0, bottom: 2, right: 3 }, rowNames(project));
    assert.deepEqual(parseClipboardText(tsv), [
      ["Goblin", "", "", sources[0]],
      ["Bat", "", "", sources[1]],
      ["Troll", "", "", sources[2]],
    ]);
  });

  it("clamps ranges to the table", () => {
    const { project, stats: t } = sample();
    assert.equal(copyRange(t, { top: 2, left: 0, bottom: 99, right: 1 }, rowNames(project)), "Troll\t40");
  });
});

describe("table grid: clipboard text", () => {
  it("reads spreadsheet TSV with CRLF and a trailing newline", () => {
    assert.deepEqual(parseClipboardText("a\tb\r\nc\td\r\n"), [["a", "b"], ["c", "d"]]);
  });

  it("falls back to a plain split when a quote is never closed", () => {
    assert.deepEqual(parseClipboardText('"open\tx\ny'), [['"open', "x"], ["y"]]);
  });

  it("never returns an empty grid", () => {
    assert.deepEqual(parseClipboardText(""), [[""]]);
  });
});

describe("table grid: paste", () => {
  it("places a block at the top-left of the selection, reading each column's syntax", () => {
    const { project, newId, stats: t, col, rare, items } = sample();
    const res = pasteGrid(project, t.id, gridRange({ row: 1, col: 1 }, { row: 1, col: 1 }), [["7", "2,5", "Bat!", "TRUE", "rare", "bar"]], rowNames(project), newId);
    assert.ok(res.ok);
    assert.equal(res.value.invalid, 0);
    const bat = stats(apply(project, res.value.change)).rows[1]!;
    assert.equal(bat.cells[col.hp], 7);
    assert.equal(bat.cells[col.speed], 2.5);
    assert.equal((bat.cells[col.name] as { source: string }).source, "Bat!");
    assert.equal(bat.cells[col.flying], true);
    assert.equal(bat.cells[col.rarity], rare.id);
    assert.equal(bat.cells[col.drop], items.rows[1]!.id);
  });

  it("fills the whole selection with a single value, as one undo step", () => {
    const { project, newId, stats: t, col } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 1, bottom: 2, right: 1 }, [["99"]], rowNames(project), newId);
    assert.ok(res.ok && res.value.change !== null);
    assert.equal(res.value.change.patches.length, 3);
    assert.deepEqual(stats(apply(project, res.value.change)).rows.map((r) => r.cells[col.hp]), [99, 99, 99]);
  });

  it("repeats a block whose size divides the selection", () => {
    const { project, newId, stats: t, col } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 1, bottom: 1, right: 2 }, [["1", "2"]], rowNames(project), newId);
    assert.ok(res.ok);
    const rows = stats(apply(project, res.value.change)).rows;
    assert.deepEqual(rows.slice(0, 2).map((r) => [r.cells[col.hp], r.cells[col.speed]]), [[1, 2], [1, 2]]);
    assert.equal(rows[2]!.cells[col.hp], 40);
  });

  it("leaves invalid fields unchanged and counts them", () => {
    const { project, newId, stats: t, col } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 1, bottom: 0, right: 1 }, [["1.5", "fast", "", "maybe", "Epic"]], rowNames(project), newId);
    assert.ok(res.ok);
    assert.equal(res.value.invalid, 4); // 1.5 is not an int; "fast", "maybe", "Epic" do not parse
    const goblin = stats(apply(project, res.value.change)).rows[0]!;
    assert.equal(goblin.cells[col.hp], 10);
    assert.equal(goblin.cells[col.name], undefined); // the empty field cleared the text
  });

  it("appends rows past the end and takes their names from the name column", () => {
    const { project, newId, stats: t, col } = sample();
    const res = pasteGrid(project, t.id, { top: 2, left: 0, bottom: 2, right: 0 }, [["Troll", "50"], ["Dragon", "500"], ["Bad name", "1"], ["Dragon", "2"]], rowNames(project), newId);
    assert.ok(res.ok);
    assert.equal(res.value.addedRows, 3);
    assert.equal(res.value.invalid, 1);
    const after = apply(project, res.value.change);
    assert.deepEqual(stats(after).rows.map((r) => [r.name, r.cells[col.hp]]), [
      ["Goblin", 10],
      ["Bat", 4],
      ["Troll", 50],
      ["Dragon", 500],
      ["NewRow", 1],
      ["Dragon_2", 2],
    ]);
    assert.deepEqual(validateProject(after), []);
  });

  it("can swap two row names without suffixes", () => {
    const { project, newId, stats: t } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 0, bottom: 1, right: 0 }, [["Bat"], ["Goblin"]], rowNames(project), newId);
    assert.ok(res.ok);
    assert.deepEqual(stats(apply(project, res.value.change)).rows.map((r) => r.name), ["Bat", "Goblin", "Troll"]);
  });

  it("pastes into an empty table", () => {
    const newId = fixedIds();
    const project = createEmptyProject("P", newId);
    const hp = newId();
    const t: TableAsset = { id: newId(), kind: "table", name: "T", columns: [{ id: hp, name: "Hp", type: { kind: "int" } }], rows: [] };
    project.assets.push(t);
    const res = pasteGrid(project, t.id, { top: 0, left: 0, bottom: 0, right: 0 }, parseClipboardText("A\t1\nB\t2\n"), rowNames(project), newId);
    assert.ok(res.ok);
    const rows = (apply(project, res.value.change).assets[0] as TableAsset).rows;
    assert.deepEqual(rows.map((r) => [r.name, r.cells[hp]]), [["A", 1], ["B", 2]]);
  });

  it("skips fields past the last column and curve cells", () => {
    const { project, newId, stats: t } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 7, bottom: 0, right: 7 }, [["x", "y", "z"]], rowNames(project), newId);
    assert.ok(res.ok);
    assert.equal(res.value.change, null);
    assert.equal(res.value.skipped, 3);
  });

  it("gives every pasted localizable text its own key", () => {
    const { project, newId, stats: t, col } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 3, bottom: 2, right: 3 }, [["Same"]], rowNames(project), newId);
    assert.ok(res.ok);
    const after = apply(project, res.value.change);
    const keys = stats(after).rows.map((r) => (r.cells[col.name] as { key: string }).key);
    assert.equal(keys[0], "k.goblin"); // existing keys are kept
    assert.equal(new Set(keys).size, 3);
    assert.deepEqual(validateProject(after), []);
  });

  it("refuses writes larger than the limit", () => {
    const { project, newId, stats: t } = sample();
    const res = pasteGrid(project, t.id, { top: 0, left: 1, bottom: MAX_GRID_WRITE_CELLS, right: 1 }, [["1"]], rowNames(project), newId);
    assert.deepEqual(res, { ok: false, error: { code: "too-many-cells", limit: MAX_GRID_WRITE_CELLS } });
  });
});

describe("table grid: fill, clear, Yes/No", () => {
  it("fills the top row down, keeping each target's localization key, and keeps row names", () => {
    const { project, newId, stats: t, col } = sample();
    t.rows[1]!.cells[col.name] = { key: "k.bat", source: "Bat" };
    const res = fillDown(project, t.id, all(t), newId);
    assert.ok(res.ok);
    const after = apply(project, res.value);
    const rows = stats(after).rows;
    assert.deepEqual(rows.map((r) => r.name), ["Goblin", "Bat", "Troll"]);
    assert.deepEqual(rows.map((r) => r.cells[col.hp]), [10, 10, 10]);
    assert.deepEqual(rows.map((r) => r.cells[col.flying]), [false, false, false]);
    const keys = rows.map((r) => (r.cells[col.name] as { key: string }).key);
    assert.equal(keys[1], "k.bat"); // translations of Bat's title stay linked
    assert.equal(new Set(keys).size, 3);
    assert.deepEqual(rows.map((r) => (r.cells[col.name] as { source: string }).source), ["Goblin", "Goblin", "Goblin"]);
    assert.deepEqual(validateProject(after), []);
  });

  it("fills a single row from the row above", () => {
    const { project, newId, stats: t, col } = sample();
    const res = fillDown(project, t.id, { top: 2, left: 1, bottom: 2, right: 1 }, newId);
    assert.ok(res.ok);
    assert.equal(stats(apply(project, res.value)).rows[2]!.cells[col.hp], 4);
    const first = fillDown(project, t.id, { top: 0, left: 1, bottom: 0, right: 1 }, newId);
    assert.deepEqual(first, { ok: true, value: null });
  });

  it("clears data cells but not names", () => {
    const { project, stats: t } = sample();
    const res = clearRange(project, t.id, all(t));
    assert.ok(res.ok);
    const rows = stats(apply(project, res.value)).rows;
    assert.deepEqual(rows.map((r) => r.name), ["Goblin", "Bat", "Troll"]);
    assert.ok(rows.every((r) => Object.keys(r.cells).length === 0));
    assert.deepEqual(clearRange(apply(project, res.value), t.id, all(t)), { ok: true, value: null });
  });

  it("sets only Yes/No cells", () => {
    const { project, stats: t, col } = sample();
    const res = setBoolRange(project, t.id, all(t), true);
    assert.ok(res.ok);
    const rows = stats(apply(project, res.value)).rows;
    assert.deepEqual(rows.map((r) => r.cells[col.flying]), [true, true, true]);
    assert.equal(rows[0]!.cells[col.hp], 10);
  });
});

describe("cell text", () => {
  it("reads spreadsheet booleans", () => {
    const names = rowNames(createEmptyProject("P", fixedIds()));
    const id = fixedIds();
    assert.equal(textToCell({ kind: "bool" }, "TRUE", names, undefined, id), true);
    assert.equal(textToCell({ kind: "bool" }, "0", names, undefined, id), false);
    assert.equal(textToCell({ kind: "bool" }, "yes", names, undefined, id), undefined);
  });
});
