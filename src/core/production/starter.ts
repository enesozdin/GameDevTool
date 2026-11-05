/**
 * Creates the built-in Items / Machines / Recipes tables (with their roles) and an empty
 * or sample production graph. Table and asset names come from the caller (UI strings);
 * column names are identifiers used in engine exports, so they stay fixed English.
 */
import type { IdGenerator } from "../ids.ts";
import type { Id } from "../model/primitives.ts";
import type { GraphEdge, GraphNode, ProductionGraphAsset } from "../model/production-graph.ts";
import type { Column, ItemStack, Row, TableAsset } from "../model/table.ts";
import { autoLayout } from "./layout.ts";

export interface ProductionTables {
  readonly items: TableAsset;
  readonly machines: TableAsset;
  readonly recipes: TableAsset;
}

export interface ProductionNames {
  readonly items: string;
  readonly machines: string;
  readonly recipes: string;
  readonly graph: string;
}

export function createProductionTables(newId: IdGenerator, names: ProductionNames): ProductionTables {
  const itemsId = newId();
  const machinesId = newId();
  const tags = newId();
  const items: TableAsset = {
    id: itemsId,
    kind: "table",
    name: names.items,
    role: { kind: "items", tags },
    columns: [{ id: tags, name: "Tags", type: { kind: "list", item: { kind: "string", maxLength: 64 } } }],
    rows: [],
  };

  const speed = newId();
  const power = newId();
  const buildCost = newId();
  const machines: TableAsset = {
    id: machinesId,
    kind: "table",
    name: names.machines,
    role: { kind: "machines", speed, power, buildCost },
    columns: [
      { id: speed, name: "Speed", required: true, type: { kind: "float", min: 0 } },
      { id: power, name: "Power", type: { kind: "float", min: 0 } },
      { id: buildCost, name: "BuildCost", type: { kind: "stacks", table: itemsId } },
    ],
    rows: [],
  };

  const inputs = newId();
  const outputs = newId();
  const time = newId();
  const machine = newId();
  const gate = newId();
  const recipes: TableAsset = {
    id: newId(),
    kind: "table",
    name: names.recipes,
    role: { kind: "recipes", inputs, outputs, time, machine, gate },
    columns: [
      { id: inputs, name: "Inputs", type: { kind: "stacks", table: itemsId } },
      { id: outputs, name: "Outputs", required: true, type: { kind: "stacks", table: itemsId } },
      { id: time, name: "Time", description: "Cycle time in seconds", required: true, type: { kind: "float", min: 0 } },
      { id: machine, name: "Machine", type: { kind: "reference", table: machinesId } },
      { id: gate, name: "Gate", description: "Unlock condition", type: { kind: "string", maxLength: 10_000 } },
    ],
    rows: [],
  };
  return { items, machines, recipes };
}

export function createProductionGraph(newId: IdGenerator, name: string, tables: Pick<ProductionTables, "items" | "recipes">): ProductionGraphAsset {
  return { id: newId(), kind: "production-graph", name, items: tables.items.id, recipes: tables.recipes.id, nodes: [], edges: [] };
}

/**
 * A small working example: ore and coal are smelted into bars (10% chance of slag), bars
 * are forged into swords. Target: one sword per minute.
 */
export function createProductionSample(newId: IdGenerator, names: ProductionNames): { tables: ProductionTables; graph: ProductionGraphAsset } {
  const tables = createProductionTables(newId, names);
  const { items, machines, recipes } = tables;
  const itemRow = (name: string, tags: string[] = []): Row => ({ id: newId(), name, cells: tags.length > 0 ? { [items.columns[0]!.id]: tags } : {} });
  const ore = itemRow("IronOre");
  const coal = itemRow("Coal", ["Fuel"]);
  const bar = itemRow("IronBar");
  const sword = itemRow("IronSword");
  const slag = itemRow("Slag");
  items.rows.push(ore, coal, bar, sword, slag);

  const [speedCol, powerCol] = machines.columns as [Column, Column];
  const machineRow = (name: string, speed: number, power: number): Row => ({ id: newId(), name, cells: { [speedCol.id]: speed, [powerCol.id]: power } });
  const drill = machineRow("Drill", 1, 90);
  const furnace = machineRow("Furnace", 1, 120);
  const anvil = machineRow("Anvil", 1, 0);
  machines.rows.push(drill, furnace, anvil);

  const [inputsCol, outputsCol, timeCol, machineCol] = recipes.columns as [Column, Column, Column, Column];
  const recipeRow = (name: string, inputs: ItemStack[], outputs: ItemStack[], time: number, machine: Id): Row => ({
    id: newId(),
    name,
    cells: { [inputsCol.id]: inputs, [outputsCol.id]: outputs, [timeCol.id]: time, [machineCol.id]: machine },
  });
  const mine = recipeRow("MineIronOre", [], [{ item: ore.id, count: 1 }], 2, drill.id);
  const smelt = recipeRow(
    "SmeltIronBar",
    [
      { item: ore.id, count: 2 },
      { item: coal.id, count: 1 },
    ],
    [
      { item: bar.id, count: 1 },
      { item: slag.id, count: 1, chance: 0.1 },
    ],
    4,
    furnace.id,
  );
  const forge = recipeRow("ForgeIronSword", [{ item: bar.id, count: 3 }], [{ item: sword.id, count: 1 }], 10, anvil.id);
  recipes.rows.push(mine, smelt, forge);

  const at = { x: 0, y: 0 };
  const nodes: GraphNode[] = [
    { id: newId(), type: "recipe", position: at, recipe: mine.id },
    { id: newId(), type: "source", position: at, item: coal.id, rate: 0.5 },
    { id: newId(), type: "recipe", position: at, recipe: smelt.id },
    { id: newId(), type: "recipe", position: at, recipe: forge.id },
    { id: newId(), type: "sink", position: at, item: sword.id, rate: 1 / 60 },
    { id: newId(), type: "sink", position: at, item: slag.id },
  ];
  const [mineN, coalN, smeltN, forgeN, swordN, slagN] = nodes as [GraphNode, GraphNode, GraphNode, GraphNode, GraphNode, GraphNode];
  const edge = (from: GraphNode, to: GraphNode, item: Id): GraphEdge => ({ id: newId(), source: from.id, target: to.id, item });
  const edges = [
    edge(mineN, smeltN, ore.id),
    edge(coalN, smeltN, coal.id),
    edge(smeltN, forgeN, bar.id),
    edge(smeltN, slagN, slag.id),
    edge(forgeN, swordN, sword.id),
  ];
  const graph: ProductionGraphAsset = { ...createProductionGraph(newId, names.graph, tables), nodes, edges };
  const layout = autoLayout(graph);
  return { tables, graph: { ...graph, nodes: nodes.map((node) => ({ ...node, position: layout.get(node.id) ?? at })) } };
}
