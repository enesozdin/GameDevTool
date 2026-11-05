import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addColumn, applyPatches, columnTypeFromSpec, createEmptyProject, createProductionSample, parseEnumOptions, validateProject, type Change, type Project, type TableAsset } from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

function sample() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" });
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  return { project, newId, items: tables.items, recipes: tables.recipes, graph };
}

describe("column types from the add-column form", () => {
  it("parses enum options: trimmed, comma or newline separated, unique identifiers", () => {
    assert.deepEqual(parseEnumOptions(" Common, Rare\nEpic ,, "), { ok: true, value: ["Common", "Rare", "Epic"] });
    assert.deepEqual(parseEnumOptions(" , "), { ok: false, error: { code: "enum-empty" } });
    assert.deepEqual(parseEnumOptions("Rare, rare"), { ok: false, error: { code: "enum-duplicate", name: "rare" } });
    assert.deepEqual(parseEnumOptions("Rare, 2nd"), { ok: false, error: { code: "enum-invalid-name", name: "2nd" } });
    assert.deepEqual(parseEnumOptions(Array.from({ length: 1_001 }, (_, i) => `O${i}`).join(",")), { ok: false, error: { code: "enum-too-many" } });
  });

  it("builds enum, reference, stacks and list types that validate", () => {
    const { project: p0, newId, items, recipes } = sample();
    let project: Project = p0;
    const apply = (change: Change | null) => {
      assert.ok(change !== null);
      project = applyPatches(project, change.patches).value;
    };
    const specs = [
      { name: "Rarity", spec: { kind: "enum", options: "Common, Rare" } },
      { name: "Upgrade", spec: { kind: "reference", table: items.id } },
      { name: "Salvage", spec: { kind: "stacks", table: items.id } },
      { name: "Labels", spec: { kind: "list", item: { kind: "string" } } },
      { name: "Slots", spec: { kind: "list", item: { kind: "enum", options: "Head, Body" } } },
      { name: "Unlocks", spec: { kind: "list", item: { kind: "reference", table: recipes.id } } },
      { name: "Lore", spec: { kind: "text" } },
    ] as const;
    for (const { name, spec } of specs) {
      const type = columnTypeFromSpec(project, spec, newId);
      assert.ok(type.ok, name);
      apply(addColumn(project, items.id, { id: newId(), name, type: type.value }));
    }
    const table = project.assets.find((a) => a.id === items.id) as TableAsset;
    const rarity = table.columns.find((c) => c.name === "Rarity")!.type;
    assert.equal(rarity.kind, "enum");
    assert.deepEqual(rarity.kind === "enum" && rarity.options.map((o) => o.name), ["Common", "Rare"]);
    const slots = table.columns.find((c) => c.name === "Slots")!.type;
    assert.ok(slots.kind === "list" && slots.item.kind === "enum" && slots.item.options.length === 2);
    assert.deepEqual(validateProject(project), []);
  });

  it("rejects targets that are not tables", () => {
    const { project, newId, graph } = sample();
    assert.deepEqual(columnTypeFromSpec(project, { kind: "reference", table: graph.id }, newId), { ok: false, error: { code: "table-missing" } });
    assert.deepEqual(columnTypeFromSpec(project, { kind: "stacks", table: "" }, newId), { ok: false, error: { code: "table-missing" } });
    assert.deepEqual(columnTypeFromSpec(project, { kind: "list", item: { kind: "enum", options: "" } }, newId), { ok: false, error: { code: "enum-empty" } });
  });
});
