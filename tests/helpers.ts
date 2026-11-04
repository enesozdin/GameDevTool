import { createIdGenerator, createEmptyProject, type IdGenerator, type Project } from "../src/core/index.ts";

/** Deterministic ids: fixed clock + zero random bytes, so ids increment monotonically. */
export function fixedIds(now = 1_767_225_600_000): IdGenerator {
  return createIdGenerator({ now: () => now, fillRandom: (bytes) => bytes.fill(0) });
}

/**
 * A small project that exercises every column kind, a reference between tables,
 * a document tree, variables and characters. Valid: validateProject returns [].
 */
export function sampleProject(): Project {
  const id = fixedIds();
  const project = createEmptyProject("Sample", id);

  const questState = { id: id(), name: "QuestState" };
  const done = { id: id(), name: "Done" };
  project.manifest.variables.push(
    { id: id(), name: "HasKey", type: "bool", default: false },
    { id: id(), name: "Gold", type: "int", default: 100 },
    { id: id(), name: "MainQuest", type: "enum", options: [questState, done], default: questState.id },
  );
  project.manifest.characters.push({ id: id(), name: "Blacksmith" });

  const itemsId = id();
  const colItemName = id();
  const colWeight = id();
  const ironOre = id();
  const ironBar = id();
  project.assets.push({
    id: itemsId,
    kind: "table",
    name: "Items",
    columns: [
      { id: colItemName, name: "DisplayName", required: true, type: { kind: "text" } },
      { id: colWeight, name: "Weight", type: { kind: "float", min: 0 } },
    ],
    rows: [
      { id: ironOre, name: "IronOre", cells: { [colItemName]: { key: "item.iron_ore", source: "Iron Ore" }, [colWeight]: 1 } },
      { id: ironBar, name: "IronBar", cells: { [colItemName]: { key: "item.iron_bar", source: "Iron Bar" }, [colWeight]: 0.5 } },
    ],
  });

  const rarityCommon = { id: id(), name: "Common" };
  const rarityRare = { id: id(), name: "Rare" };
  const colOutput = id();
  const colInputs = id();
  const colTime = id();
  const colTier = id();
  const colRarity = id();
  const colAuto = id();
  const colCurve = id();
  const colCode = id();
  project.assets.push({
    id: id(),
    kind: "table",
    name: "Recipes",
    columns: [
      { id: colOutput, name: "Output", required: true, type: { kind: "reference", table: itemsId } },
      { id: colInputs, name: "Inputs", type: { kind: "list", item: { kind: "reference", table: itemsId } } },
      { id: colTime, name: "CycleSeconds", type: { kind: "float", min: 0 } },
      { id: colTier, name: "Tier", type: { kind: "int", min: 1, max: 10 } },
      { id: colRarity, name: "Rarity", type: { kind: "enum", options: [rarityCommon, rarityRare] } },
      { id: colAuto, name: "Automatable", type: { kind: "bool" } },
      { id: colCurve, name: "Yield", type: { kind: "curve" } },
      { id: colCode, name: "Code", type: { kind: "string", maxLength: 16, unique: true } },
    ],
    rows: [
      {
        id: id(),
        name: "SmeltIron",
        cells: {
          [colOutput]: ironBar,
          [colInputs]: [ironOre, ironOre],
          [colTime]: 2.5,
          [colTier]: 1,
          [colRarity]: rarityCommon.id,
          [colAuto]: true,
          [colCurve]: { interp: "linear", keys: [{ x: 1, y: 1 }, { x: 10, y: 3 }] },
          [colCode]: "SMELT_IRON",
        },
      },
    ],
  });

  const rootDoc = id();
  project.assets.push(
    { id: rootDoc, kind: "document", name: "Core Loop", markdown: "# Core loop\n\nMine, smelt, craft.\n" },
    { id: id(), kind: "document", name: "Crafting", parent: rootDoc, markdown: "See [[Items/IronBar]].\n" },
  );
  return project;
}
