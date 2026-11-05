/**
 * Reads the Items / Recipes / Machines tables (table roles) into plain lookups for the
 * solver, validation and editor. Bad cells are skipped here; validate.ts reports them.
 */
import type { Id } from "../model/primitives.ts";
import type { Asset } from "../model/project.ts";
import { isTagStack, type CellValue, type ItemStack, type Row, type Stack, type TableAsset } from "../model/table.ts";

export interface CatalogItem {
  readonly id: Id;
  readonly name: string;
  readonly tags: readonly string[];
}

export interface CatalogMachine {
  readonly id: Id;
  readonly name: string;
  /** Speed multiplier, > 0. Defaults to 1 when the cell is empty or invalid. */
  readonly speed: number;
  readonly power: number | undefined;
  readonly buildCost: readonly ItemStack[];
}

export interface CatalogRecipe {
  readonly id: Id;
  readonly name: string;
  /** Cycle time in seconds as written; undefined if missing or not > 0. */
  readonly time: number | undefined;
  readonly machine: CatalogMachine | undefined;
  /** Item stacks and tag stacks ("any Fuel"). */
  readonly inputs: readonly Stack[];
  readonly outputs: readonly ItemStack[];
  /** Unlock condition source (expression language), if any. */
  readonly gate: string | undefined;
}

export interface Catalog {
  readonly itemsTable: TableAsset | undefined;
  readonly recipesTable: TableAsset | undefined;
  readonly machinesTable: TableAsset | undefined;
  /** In table row order. */
  readonly items: ReadonlyMap<Id, CatalogItem>;
  readonly recipes: ReadonlyMap<Id, CatalogRecipe>;
  readonly machines: ReadonlyMap<Id, CatalogMachine>;
  /** Lower-cased tag → items carrying it, in table row order. */
  readonly tagged: ReadonlyMap<string, readonly Id[]>;
}

/**
 * Port key of a stack: the item id, or "#" + tag for tag stacks. Item ids are ULIDs, so
 * the "#" prefix cannot collide with them.
 */
export function stackKey(stack: Stack): string {
  return isTagStack(stack) ? tagKey(stack.tag) : stack.item;
}

export const tagKey = (tag: string): string => `#${tag}`;

/** The tag of a port key, or undefined for an item key. */
export function tagOfKey(key: string): string | undefined {
  return key.startsWith("#") ? key.slice(1) : undefined;
}

/** Whether `item` carries `tag` (case-insensitive). */
export function hasTag(catalog: Catalog, item: Id, tag: string): boolean {
  const lower = tag.toLowerCase();
  return catalog.items.get(item)?.tags.some((t) => t.toLowerCase() === lower) === true;
}

/** Whether `item` can feed the port `key`: the same item, or an item with the port's tag. */
export function keyAccepts(catalog: Catalog, key: string, item: Id): boolean {
  const tag = tagOfKey(key);
  return tag === undefined ? key === item : hasTag(catalog, item, tag);
}

/** Seconds per cycle on the recipe's machine, or undefined if the recipe has no valid time. */
export function cycleSeconds(recipe: CatalogRecipe): number | undefined {
  return recipe.time === undefined ? undefined : recipe.time / (recipe.machine?.speed ?? 1);
}

/** Expected output count per cycle (count × chance). */
export function expectedCount(stack: ItemStack): number {
  return stack.count * (stack.chance ?? 1);
}

function findTable(assets: readonly Asset[], id: Id | undefined): TableAsset | undefined {
  if (id === undefined) return undefined;
  const asset = assets.find((a) => a.id === id);
  return asset?.kind === "table" ? asset : undefined;
}

const num = (value: CellValue | undefined): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Item stacks only (outputs, build costs): tag stacks there are invalid and skipped. */
function stacks(value: CellValue | undefined): ItemStack[] {
  if (!Array.isArray(value)) return [];
  const out: ItemStack[] = [];
  for (const v of value) if (v !== null && typeof v === "object" && !isTagStack(v)) out.push(v);
  return out;
}

function inputStacks(value: CellValue | undefined): Stack[] {
  if (!Array.isArray(value)) return [];
  const out: Stack[] = [];
  for (const v of value) if (v !== null && typeof v === "object") out.push(v);
  return out;
}

function cell(row: Row, column: Id | undefined): CellValue | undefined {
  return column === undefined ? undefined : row.cells[column];
}

/**
 * Compiles the catalog for a recipes table (and the items table it points to). `itemsId`
 * overrides the items table, e.g. the one a production graph names. Only the assets are
 * read, so a caller that has just the tables (the Monte Carlo worker) needs no full project.
 */
export function compileCatalog(project: { readonly assets: readonly Asset[] }, recipesId: Id | undefined, itemsId?: Id): Catalog {
  const recipesTable = findTable(project.assets, recipesId);
  const recipeRole = recipesTable?.role?.kind === "recipes" ? recipesTable.role : undefined;

  const inputsColumn = recipeRole && recipesTable!.columns.find((c) => c.id === recipeRole.inputs);
  const itemsTable = findTable(project.assets, itemsId ?? (inputsColumn?.type.kind === "stacks" ? inputsColumn.type.table : undefined));
  const machineColumn = recipeRole?.machine === undefined ? undefined : recipesTable!.columns.find((c) => c.id === recipeRole.machine);
  const machinesTable = findTable(project.assets, machineColumn?.type.kind === "reference" ? machineColumn.type.table : undefined);

  const items = new Map<Id, CatalogItem>();
  const tagged = new Map<string, Id[]>();
  if (itemsTable !== undefined) {
    const tagsColumn = itemsTable.role?.kind === "items" ? itemsTable.role.tags : undefined;
    for (const row of itemsTable.rows) {
      const cellTags = cell(row, tagsColumn);
      const tags = Array.isArray(cellTags) ? cellTags.filter((t): t is string => typeof t === "string") : [];
      items.set(row.id, { id: row.id, name: row.name, tags });
      for (const t of new Set(tags.map((x) => x.toLowerCase()))) {
        const list = tagged.get(t);
        if (list === undefined) tagged.set(t, [row.id]);
        else list.push(row.id);
      }
    }
  }

  const machines = new Map<Id, CatalogMachine>();
  if (machinesTable !== undefined && machinesTable.role?.kind === "machines") {
    const role = machinesTable.role;
    for (const row of machinesTable.rows) {
      const speed = num(cell(row, role.speed));
      machines.set(row.id, {
        id: row.id,
        name: row.name,
        speed: speed !== undefined && speed > 0 ? speed : 1,
        power: num(cell(row, role.power)),
        buildCost: stacks(cell(row, role.buildCost)),
      });
    }
  }

  const recipes = new Map<Id, CatalogRecipe>();
  if (recipeRole !== undefined) {
    for (const row of recipesTable!.rows) {
      const time = num(cell(row, recipeRole.time));
      const machineId = cell(row, recipeRole.machine);
      const gate = cell(row, recipeRole.gate);
      recipes.set(row.id, {
        id: row.id,
        name: row.name,
        time: time !== undefined && time > 0 ? time : undefined,
        machine: typeof machineId === "string" ? machines.get(machineId) : undefined,
        inputs: inputStacks(cell(row, recipeRole.inputs)),
        outputs: stacks(cell(row, recipeRole.outputs)),
        gate: typeof gate === "string" && gate.trim() !== "" ? gate : undefined,
      });
    }
  }

  return { itemsTable, recipesTable, machinesTable, items, recipes, machines, tagged };
}
