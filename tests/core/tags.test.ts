import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  billOfMaterials,
  canConnect,
  compileCatalog,
  compileNetwork,
  createEmptyProject,
  createProductionSample,
  defaultRecipeChoice,
  importTableCsv,
  inputKeyFor,
  loadProject,
  planRates,
  saveProject,
  solveNetwork,
  UNREAL_CSV,
  validateProject,
  type GraphNode,
  type Id,
  type ProductionGraphAsset,
  type Project,
  type TableAsset,
} from "../../src/core/index.ts";
import { fixedIds } from "../helpers.ts";

/** The sample chain: SmeltIronBar takes IronOre*2 and #Fuel*1; Coal is tagged Fuel. */
function setup() {
  const newId = fixedIds();
  const project = createEmptyProject("P", newId);
  const { tables, graph } = createProductionSample(newId, { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Chain" });
  project.assets.push(tables.items, tables.machines, tables.recipes, graph);
  const item = (name: string): Id => tables.items.rows.find((r) => r.name === name)!.id;
  const recipe = (name: string) => tables.recipes.rows.find((r) => r.name === name)!;
  return { project, newId, tables, graph, item, recipe };
}

const tagsColumn = (items: TableAsset): Id => (items.role as { tags: Id }).tags;
const inputsColumn = (recipes: TableAsset): Id => (recipes.role as { inputs: Id }).inputs;
const outputsColumn = (recipes: TableAsset): Id => (recipes.role as { outputs: Id }).outputs;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

describe("tag inputs", () => {
  it("routes any tagged item into the tag port and splits demand between suppliers", () => {
    const { project, newId, tables, graph, item } = setup();
    // Add Charcoal (also Fuel) with its own source next to the coal source.
    const charcoal = newId();
    tables.items.rows.push({ id: charcoal, name: "Charcoal", cells: { [tagsColumn(tables.items)]: ["fuel"] } });
    const smelt = graph.nodes[2]!;
    const source: GraphNode = { id: newId(), type: "source", position: { x: 0, y: 0 }, item: charcoal, rate: 1 };
    graph.nodes.push(source);
    graph.edges.push({ id: newId(), source: source.id, target: smelt.id, item: charcoal });

    const catalog = compileCatalog(project, graph.recipes, graph.items);
    const net = compileNetwork(graph, catalog);
    const s = net.nodeIndex.get(smelt.id)!;
    const ports = net.inItem.slice(net.inStart[s]!, net.inStart[s + 1]!);
    assert.deepEqual(ports, [item("IronOre"), "#Fuel"]);
    const fuelPort = net.inStart[s]! + 1;
    // Coal (sample edge) and Charcoal (tag "fuel", other case) both feed the fuel port.
    assert.equal(net.inEdgeStart[fuelPort + 1]! - net.inEdgeStart[fuelPort]!, 2);

    const result = solveNetwork(net, "target");
    // 1 sword/min → 3 bars/min → 3 fuel/min = 0.05/s, shared by the two suppliers.
    close(result.inSupplied[fuelPort]!, 3 / 60);
    assert.deepEqual(validateProject(project).filter((i) => i.severity === "error"), []);
  });

  it("checks connections live: own port first, then a tag the item carries", () => {
    const { project, graph, item } = setup();
    const catalog = compileCatalog(project, graph.recipes, graph.items);
    const [mine, coal, smelt, forge] = graph.nodes as [GraphNode, GraphNode, GraphNode, GraphNode];
    assert.equal(inputKeyFor(smelt, catalog, item("Coal")), "#Fuel");
    assert.equal(inputKeyFor(smelt, catalog, item("IronOre")), item("IronOre"));
    assert.equal(inputKeyFor(smelt, catalog, item("Slag")), undefined);
    // Existing coal → smelt connection is a duplicate; forge does not take coal.
    assert.equal(canConnect(graph, catalog, coal.id, smelt.id, item("Coal")), false);
    assert.equal(canConnect(graph, catalog, coal.id, forge.id, item("Coal")), false);
    const withoutCoalEdge: ProductionGraphAsset = { ...graph, edges: graph.edges.filter((e) => e.source !== coal.id) };
    assert.equal(canConnect(withoutCoalEdge, catalog, coal.id, smelt.id, item("Coal")), true);
    assert.equal(canConnect(graph, catalog, mine.id, smelt.id, item("IronOre")), false); // already connected
  });

  it("resolves tags in the rate calculator and bill of materials", () => {
    const { project, newId, tables, graph, item } = setup();
    let catalog = compileCatalog(project, graph.recipes, graph.items);
    let plan = planRates(defaultRecipeChoice(catalog), item("IronSword"), 1 / 60);
    // Coal is the only Fuel item and has no recipe: bought raw.
    close(plan.raw.get(item("Coal"))!, 3 / 60);

    // A craftable fuel later in the table wins over a raw one.
    const charcoal = newId();
    tables.items.rows.push({ id: charcoal, name: "Charcoal", cells: { [tagsColumn(tables.items)]: ["Fuel"] } });
    const recipes = tables.recipes;
    recipes.rows.push({ id: newId(), name: "BurnWood", cells: { [inputsColumn(recipes)]: [], [outputsColumn(recipes)]: [{ item: charcoal, count: 1 }], [(recipes.role as { time: Id }).time]: 1 } });
    catalog = compileCatalog(project, graph.recipes, graph.items);
    const choice = defaultRecipeChoice(catalog);
    plan = planRates(choice, item("IronSword"), 1 / 60);
    assert.equal(plan.raw.has(item("Coal")), false);
    close(plan.lines.find((l) => l.item === charcoal)!.rate, 3 / 60);
    const bom = billOfMaterials(choice, item("IronBar"));
    assert.deepEqual(bom.root.children.map((c) => c.item), [item("IronOre"), charcoal]);

    // No item has the tag: it stays a raw "#tag" entry.
    recipes.rows.find((r) => r.name === "SmeltIronBar")!.cells[inputsColumn(recipes)] = [{ tag: "Plasma", count: 1 }];
    const none = planRates(defaultRecipeChoice(compileCatalog(project, graph.recipes, graph.items)), item("IronBar"), 1);
    close(none.raw.get("#Plasma")!, 1);
  });

  it("validates where tags may appear and whether any item carries them", () => {
    const { project, tables, recipe } = setup();
    const r = recipe("SmeltIronBar");
    r.cells[outputsColumn(tables.recipes)] = [{ tag: "Fuel", count: 1 }];
    r.cells[inputsColumn(tables.recipes)] = [
      { tag: "Fuel", count: 1 },
      { tag: "FUEL", count: 2 },
      { tag: "Unobtainium", count: 1 },
    ];
    const codes = validateProject(project).map((i) => i.code);
    assert.ok(codes.includes("stack-tag-not-allowed"));
    assert.ok(codes.includes("duplicate-stack-item"));
    assert.ok(codes.includes("tag-no-items"));
  });

  it("warns about item tags that no tag input could name", () => {
    const { project, tables, item } = setup();
    const tagsColumn = tables.items.columns[0]!.id;
    assert.deepEqual(validateProject(project).filter((i) => i.code === "tag-invalid"), []);
    const row = tables.items.rows.find((r) => r.id === item("Coal"))!;
    row.cells[tagsColumn] = ["Fuel", "Fuel Source", "Hot!"];
    const bad = validateProject(project).filter((i) => i.code === "tag-invalid");
    assert.deepEqual(bad.map((i) => i.params?.["tag"]), ["Fuel Source", "Hot!"]);
    assert.ok(bad.every((i) => i.severity === "warning"));
  });

  it("round-trips through the project file and rejects malformed tags", () => {
    const { project, recipe, tables } = setup();
    const loaded = loadProject(saveProject(project));
    assert.ok(loaded.ok);
    assert.deepEqual(validateProject(loaded.value.project), []);

    const text = saveProject(project).replace('"tag": "Fuel"', '"tag": "Fu el"');
    assert.notEqual(text, saveProject(project));
    assert.equal(loadProject(text).ok, false);
    assert.ok(recipe("SmeltIronBar").cells[inputsColumn(tables.recipes)]);
  });

  it("imports tag stacks from Unreal CSV, also next to an empty Item", () => {
    const { project, tables }: { project: Project; tables: { recipes: TableAsset } } = setup();
    const csv = '---,Inputs,Time\nSmeltAny,"((Item="""",Tag=""Fuel"",Count=2),(Tag=""Ore"",Count=1))",1\n';
    const result = importTableCsv(project, tables.recipes, csv, fixedIds(99), { format: UNREAL_CSV });
    assert.ok(result.ok);
    assert.deepEqual(result.value.issues, []);
    assert.deepEqual(result.value.rows[0]!.cells[inputsColumn(tables.recipes)], [
      { tag: "Fuel", count: 2 },
      { tag: "Ore", count: 1 },
    ]);
    const bad = importTableCsv(project, tables.recipes, '---,Inputs\nX,"((Tag=""no good"",Count=1))"\n', fixedIds(99), { format: UNREAL_CSV });
    assert.ok(bad.ok);
    assert.deepEqual(bad.value.issues.map((i) => i.code), ["invalid-value"]);
  });
});
