import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAsset,
  applyPatches,
  COALESCE_MS,
  commit,
  createDocument,
  createHistory,
  createTable,
  redo,
  removeAsset,
  renameAsset,
  renameProject,
  saveProject,
  undo,
  undoLabel,
  validateProject,
  type Change,
  type Project,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

const apply = (h: ReturnType<typeof createHistory<Project>>, change: Change | null, now = 0) => {
  assert.ok(change !== null);
  return commit(h, change, now);
};

describe("applyPatches", () => {
  it("does not mutate the input and shares unchanged branches", () => {
    const root = { a: { x: 1 }, b: { y: [1, 2, 3] } };
    const frozen = JSON.stringify(root);
    const { value, inverse } = applyPatches(root, [
      { op: "set", path: ["a", "x"], value: 2 },
      { op: "insert", path: ["b", "y"], index: 3, value: 4 },
      { op: "remove", path: ["b", "y"], index: 0 },
      { op: "set", path: ["a", "z"], value: "new" },
    ]);
    assert.equal(JSON.stringify(root), frozen);
    assert.deepEqual(value, { a: { x: 2, z: "new" }, b: { y: [2, 3, 4] } });
    assert.deepEqual(applyPatches(value, inverse).value, root);
  });

  it("keeps identity of untouched subtrees", () => {
    const root = { a: { x: 1 }, b: { y: 1 } };
    const { value } = applyPatches(root, [{ op: "set", path: ["a", "x"], value: 2 }]);
    assert.equal(value.b, root.b);
    assert.notEqual(value.a, root.a);
  });

  it("copies each container once per batch", () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => ({ v: i }));
    const root = { rows };
    const patches = rows.map((_, i) => ({ op: "set" as const, path: ["rows", i, "v"], value: -i }));
    const { value, inverse } = applyPatches(root, patches);
    assert.equal(value.rows[999]!.v, -999);
    assert.equal(rows[999]!.v, 999);
    assert.deepEqual(applyPatches(value, inverse).value, root);
  });

  it("deletes a property with value undefined and restores it on inverse", () => {
    const root: Record<string, unknown> = { a: 1, b: 2 };
    const { value, inverse } = applyPatches(root, [{ op: "set", path: ["a"], value: undefined }]);
    assert.deepEqual(value, { b: 2 });
    assert.deepEqual(applyPatches(value, inverse).value, root);
  });

  it("rejects invalid paths and forbidden keys", () => {
    assert.throws(() => applyPatches({ a: 1 }, [{ op: "set", path: ["a", "b"], value: 1 }]));
    assert.throws(() => applyPatches({ a: [] }, [{ op: "remove", path: ["a"], index: 0 }]));
    assert.throws(() => applyPatches({ a: [] }, [{ op: "insert", path: ["a"], index: 2, value: 1 }]));
    assert.throws(() => applyPatches({}, [{ op: "set", path: ["__proto__"], value: { polluted: true } }]));
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});

describe("history", () => {
  it("undoes and redoes back to the exact same objects", () => {
    const start = sampleProject();
    let h = createHistory(start);
    h = apply(h, renameProject(h.present, "Renamed"));
    assert.equal(h.present.manifest.name, "Renamed");
    assert.equal(undoLabel(h), "rename-project");

    const renamed = h.present;
    assert.equal(h.present.assets, start.assets); // untouched branch keeps identity
    h = undo(h);
    assert.equal(h.present, start);
    h = redo(h);
    assert.equal(h.present, renamed);
  });

  it("a new commit clears the redo stack", () => {
    let h = createHistory(sampleProject());
    h = apply(h, renameProject(h.present, "A"));
    h = undo(h);
    assert.equal(h.future.length, 1);
    h = apply(h, renameProject(h.present, "B"));
    assert.equal(h.future.length, 0);
  });

  it("coalesces typing into one undo step", () => {
    let h = createHistory(sampleProject());
    let t = 0;
    for (const name of ["S", "Sa", "Sam", "Samp"]) {
      h = apply(h, renameProject(h.present, name), (t += 100));
    }
    assert.equal(h.past.length, 1);
    assert.equal(undo(h).present.manifest.name, "Sample");

    // After a pause the next edit is a new step.
    h = apply(h, renameProject(h.present, "Sampler"), t + COALESCE_MS + 1);
    assert.equal(h.past.length, 2);
  });

  it("does not coalesce after an undo/redo round trip", () => {
    let h = createHistory(sampleProject());
    h = apply(h, renameProject(h.present, "A"), 0);
    h = redo(undo(h));
    h = apply(h, renameProject(h.present, "AB"), 10);
    assert.equal(h.past.length, 2);
  });

  it("respects the history limit", () => {
    let h = createHistory(sampleProject());
    for (let i = 0; i < 10; i++) h = commit(h, renameProject(h.present, `N${i}`)!, i * 10_000, 3);
    assert.equal(h.past.length, 3);
    assert.equal(h.present.manifest.name, "N9");
  });
});

describe("edits", () => {
  it("add, rename and remove assets keep the project valid and saveable", () => {
    const ids = fixedIds(1_800_000_000_000);
    let h = createHistory(sampleProject());
    const doc = createDocument(ids, "Lore");
    const table = createTable(ids, "Enemies");
    h = apply(h, addAsset(h.present, doc));
    h = apply(h, addAsset(h.present, table));
    h = apply(h, renameAsset(h.present, doc.id, "World lore"));
    h = apply(h, removeAsset(h.present, table.id));
    assert.deepEqual(validateProject(h.present), []);
    assert.equal(h.present.assets.at(-1)!.name, "World lore");

    for (let i = 0; i < 4; i++) h = undo(h);
    assert.equal(saveProject(h.present), saveProject(sampleProject()));
  });

  it("rejects invalid or no-op edits", () => {
    const p = sampleProject();
    assert.equal(renameProject(p, ""), null);
    assert.equal(renameProject(p, "x".repeat(201)), null);
    assert.equal(renameProject(p, p.manifest.name), null);
    assert.equal(renameAsset(p, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "X"), null);
    assert.equal(removeAsset(p, "01ZZZZZZZZZZZZZZZZZZZZZZZZ"), null);
  });
});
