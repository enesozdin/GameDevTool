import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildReferenceIndex,
  createEmptyProject,
  CURRENT_SCHEMA_VERSION,
  FOLDER_MANIFEST_FILE,
  loadProject,
  migrateProject,
  projectFileName,
  savedFileName,
  saveProject,
  stableStringify,
  validateProject,
  type Migration,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

const codes = (project: Project): string[] => validateProject(project).map((i) => i.code);
const table = (project: Project, name: string): TableAsset => {
  const asset = project.assets.find((a) => a.kind === "table" && a.name === name);
  assert.ok(asset?.kind === "table");
  return asset;
};

describe("project model", () => {
  it("an empty project is valid", () => {
    assert.deepEqual(validateProject(createEmptyProject("Empty", fixedIds())), []);
  });

  it("the sample project is valid", () => {
    assert.deepEqual(validateProject(sampleProject()), []);
  });

  it("save → load round-trips byte for byte", () => {
    const text = saveProject(sampleProject());
    const loaded = loadProject(text);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.issues, []);
    assert.equal(loaded.value.migratedFrom, undefined);
    assert.equal(saveProject(loaded.value.project), text);
  });

  it(`loads the v${CURRENT_SCHEMA_VERSION} fixture unchanged`, async () => {
    const text = await readFile(new URL(`../fixtures/project.v${CURRENT_SCHEMA_VERSION}.json`, import.meta.url), "utf8");
    const loaded = loadProject(text);
    assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.error));
    assert.deepEqual(loaded.value.issues, []);
    assert.equal(saveProject(loaded.value.project), text);
  });

  it("strips unknown keys", () => {
    const raw = JSON.parse(saveProject(sampleProject()));
    raw.extra = 1;
    raw.manifest.settings.unknown = "x";
    const loaded = loadProject(JSON.stringify(raw));
    assert.ok(loaded.ok);
    assert.equal(saveProject(loaded.value.project), saveProject(sampleProject()));
  });

  it("reports schema errors with paths", () => {
    const raw = JSON.parse(saveProject(sampleProject()));
    raw.assets[0].rows[0].id = "not-a-ulid";
    const loaded = loadProject(JSON.stringify(raw));
    assert.ok(!loaded.ok && loaded.error.code === "schema");
    assert.deepEqual(loaded.error.issues[0]?.path, ["assets", 0, "rows", 0, "id"]);
  });

  it("rejects prototype pollution keys inside a project", () => {
    const text = saveProject(sampleProject()).replace('"cells": {', '"cells": {\n"__proto__": {"x": 1},');
    const loaded = loadProject(text);
    assert.ok(!loaded.ok && loaded.error.code === "forbidden-key");
  });

  it("rejects files that are not projects", () => {
    const loaded = loadProject('{"hello": "world"}');
    assert.ok(!loaded.ok && loaded.error.code === "not-a-project");
  });

  it("recognizes a project folder's manifest opened as a project file", () => {
    const manifest = stableStringify(sampleProject().manifest);
    const loaded = loadProject(manifest);
    assert.ok(!loaded.ok && loaded.error.code === "folder-manifest");
  });
});

describe("project file names", () => {
  it("derives a safe .json name from the project name", () => {
    assert.equal(projectFileName("Sample"), "Sample.json");
    assert.equal(projectFileName('a/b:c*?"<>|d'), "a_b_c______d.json");
    assert.equal(projectFileName("  ..  "), "project.json");
  });

  it("never names a project like a folder manifest", () => {
    assert.equal(FOLDER_MANIFEST_FILE, "gamedevtool.json");
    assert.equal(projectFileName("GameDevTool"), "GameDevTool-project.json");
    assert.equal(projectFileName("gamedevtool"), "gamedevtool-project.json");
  });

  it("saves a project opened from a legacy .gdtproj file as .json", () => {
    assert.equal(savedFileName("Old.gdtproj"), "Old.json");
    assert.equal(savedFileName("Old.GDTPROJ"), "Old.json");
    assert.equal(savedFileName("Game.json"), "Game.json");
    assert.equal(savedFileName(".gdtproj"), ".gdtproj");
  });

  it("never saves an opened project under the folder manifest's name", () => {
    // The old default name of a project called "GameDevTool".
    assert.equal(savedFileName("GameDevTool.gdtproj"), "GameDevTool-project.json");
    assert.equal(savedFileName("gamedevtool.json"), "gamedevtool-project.json");
  });
});

describe("semantic validation", () => {
  it("detects duplicate ids and case-insensitive duplicate names", () => {
    const p = sampleProject();
    const items = table(p, "Items");
    items.rows[1]!.id = items.rows[0]!.id;
    items.rows[1]!.name = "ironore";
    // IronBar's old id is gone, so the recipe output that pointed to it is broken too.
    assert.deepEqual(codes(p).sort(), ["broken-reference", "duplicate-id", "duplicate-name"]);
  });

  it("checks cells against column types and constraints", () => {
    const p = sampleProject();
    const recipes = table(p, "Recipes");
    const row = recipes.rows[0]!;
    const col = (name: string) => recipes.columns.find((c) => c.name === name)!.id;
    row.cells[col("Tier")] = 1.5; // int expected
    row.cells[col("CycleSeconds")] = -1; // below min
    row.cells[col("Rarity")] = "01ZZZZZZZZZZZZZZZZZZZZZZZZ"; // not an option
    row.cells[col("Automatable")] = "yes"; // bool expected
    row.cells[col("Yield")] = { interp: "linear", keys: [{ x: 2, y: 0 }, { x: 1, y: 0 }] };
    row.cells[col("Code")] = "THIS_IS_FAR_TOO_LONG";
    delete row.cells[col("Output")]; // required
    row.cells["01ZZZZZZZZZZZZZZZZZZZZZZZZ"] = 1; // unknown column
    assert.deepEqual(codes(p).sort(), [
      "curve-keys-unsorted",
      "out-of-range",
      "required-missing",
      "too-long",
      "type-mismatch",
      "type-mismatch",
      "unknown-column",
      "unknown-option",
    ]);
  });

  it("detects duplicate values in unique columns and duplicate localization keys", () => {
    const p = sampleProject();
    const recipes = table(p, "Recipes");
    recipes.rows.push({ ...structuredClone(recipes.rows[0]!), id: fixedIds(1)(), name: "SmeltIron2" });
    const items = table(p, "Items");
    const textCol = items.columns[0]!.id;
    items.rows[1]!.cells[textCol] = { key: "item.iron_ore", source: "Copy" };
    assert.deepEqual(codes(p).sort(), ["duplicate-loc-key", "duplicate-value"]);
  });

  it("detects document parent cycles", () => {
    const p = sampleProject();
    const [a, b] = p.assets.filter((x) => x.kind === "document");
    assert.ok(a?.kind === "document" && b?.kind === "document");
    a.parent = b.id;
    assert.deepEqual(codes(p), ["parent-cycle"]);
  });
});

describe("reference index", () => {
  it("lists what uses a row and finds broken references", () => {
    const p = sampleProject();
    const items = table(p, "Items");
    const ironOre = items.rows[0]!;
    const index = buildReferenceIndex(p);
    assert.equal(index.broken.length, 0);
    // Used twice as an input of SmeltIron.
    assert.deepEqual(index.usedBy(ironOre.id).map((r) => r.path.at(-1)), [0, 1]);

    items.rows.shift(); // delete IronOre
    const after = buildReferenceIndex(p);
    assert.equal(after.broken.length, 2);
    assert.ok(after.broken.every((r) => r.kind === "cell-row" && r.target === ironOre.id));
    assert.deepEqual(codes(p), ["broken-reference", "broken-reference"]);
  });

  it("flags reference columns that point to a non-table asset", () => {
    const p = sampleProject();
    const doc = p.assets.find((a) => a.kind === "document")!;
    const recipes = table(p, "Recipes");
    const output = recipes.columns[0]!;
    assert.ok(output.type.kind === "reference");
    output.type.table = doc.id;
    const broken = buildReferenceIndex(p).broken.map((r) => r.kind);
    assert.deepEqual(broken, ["column-table", "cell-row"]);
  });
});

describe("migrations", () => {
  const v1 = (): Record<string, unknown> => JSON.parse(saveProject(sampleProject()));

  it("runs each step in order and bumps the version", () => {
    const steps: Migration[] = [
      { from: 2, migrate: (p) => ({ ...p, step2: true }) },
      { from: 1, migrate: (p) => ({ ...p, step1: true }) },
    ];
    const r = migrateProject(v1(), steps, 3);
    assert.ok(r.ok);
    assert.equal(r.value.fromVersion, 1);
    assert.deepEqual([r.value.project["step1"], r.value.project["step2"]], [true, true]);
    assert.equal((r.value.project["manifest"] as Record<string, unknown>)["schemaVersion"], 3);
  });

  it("refuses files from a newer version", () => {
    const raw = v1();
    (raw["manifest"] as Record<string, unknown>)["schemaVersion"] = CURRENT_SCHEMA_VERSION + 1;
    const r = loadProject(JSON.stringify(raw));
    assert.ok(!r.ok && r.error.code === "unsupported-version");
  });

  it("reports a missing step and a throwing step", () => {
    const missing = migrateProject(v1(), [], 2);
    assert.ok(!missing.ok && missing.error.code === "missing-migration");
    const failing = migrateProject(v1(), [{ from: 1, migrate: () => { throw new Error("boom"); } }], 2);
    assert.ok(!failing.ok && failing.error.code === "migration-failed" && failing.error.message === "boom");
  });
});
