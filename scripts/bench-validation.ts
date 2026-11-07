/**
 * Measures validation and reference-index cost per edit on a large table, without caches
 * and the way the editor runs them after every edit (src/app/Shell.tsx, with caches).
 *
 *   node scripts/bench-validation.ts [rows]
 */
import {
  addRow,
  applyPatches,
  buildReferenceIndex,
  createEmptyProject,
  createIdGenerator,
  createReferenceIndexCache,
  createValidationCache,
  removeRows,
  setCell,
  validateProject,
  type Change,
  type Project,
  type ReferenceIndex,
  type TableAsset,
} from "../src/core/index.ts";

const ROWS = Number(process.argv[2] ?? 200_000);
const EDITS = 20;

let counter = 0;
const newId = createIdGenerator({ now: () => 1_767_225_600_000, fillRandom: (bytes) => bytes.fill(0) });
const project = createEmptyProject("Bench", newId);

const items: TableAsset = {
  id: newId(),
  kind: "table",
  name: "Items",
  columns: [{ id: newId(), name: "Weight", type: { kind: "float", min: 0 } }],
  rows: Array.from({ length: 1_000 }, (_, i) => ({ id: newId(), name: `Item_${i}`, cells: {} })),
};
const colName = newId();
const colItem = newId();
const colLevel = newId();
const colCode = newId();
const big: TableAsset = {
  id: newId(),
  kind: "table",
  name: "Big",
  columns: [
    { id: colName, name: "DisplayName", required: true, type: { kind: "text" } },
    { id: colItem, name: "Item", type: { kind: "reference", table: items.id } },
    { id: colLevel, name: "Level", type: { kind: "int", min: 0, max: 1_000_000 } },
    { id: colCode, name: "Code", type: { kind: "string", unique: true } },
  ],
  rows: Array.from({ length: ROWS }, (_, i) => ({
    id: newId(),
    name: `Row_${i}`,
    cells: {
      [colName]: { key: `big.row_${i}`, source: `Row ${i}` },
      [colItem]: items.rows[i % items.rows.length]!.id,
      [colLevel]: i,
      [colCode]: `C${i}`,
    },
  })),
};
project.assets.push(items, big);

const apply = (p: Project, change: Change | null): Project => {
  if (change === null) throw new Error("no change");
  return applyPatches(p, change.patches).value;
};

const time = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const validationCache = createValidationCache();
const indexCache = createReferenceIndexCache();
let current = project;
validateProject(current, buildReferenceIndex(current, indexCache), validationCache);

/** Median cost of `edit` for a full build and for the editor's cached path. */
function measure(label: string, edit: (p: Project, e: number) => Change | null): void {
  const full: number[] = [];
  const index: number[] = [];
  const validate: number[] = [];
  for (let e = 0; e < EDITS; e++) {
    current = apply(current, edit(current, e));
    full.push(time(() => validateProject(current, buildReferenceIndex(current))));
    let built: ReferenceIndex | undefined;
    index.push(time(() => (built = buildReferenceIndex(current, indexCache))));
    validate.push(time(() => validateProject(current, built!, validationCache)));
  }
  const total = median(index) + median(validate);
  console.log(`${label.padEnd(24)} full ${median(full).toFixed(1).padStart(7)} | cached: index ${median(index).toFixed(2).padStart(6)} + validate ${median(validate).toFixed(2).padStart(6)} = ${total.toFixed(2).padStart(6)}`);
}

const bigRows = (p: Project) => (p.assets[1] as TableAsset).rows;
console.log(`rows: ${ROWS}, edits per case: ${EDITS}, median ms`);
measure("edit one cell", (p, e) => setCell(p, big.id, bigRows(p)[(e * 7_919) % ROWS]!.id, colLevel, 10 + e + counter++));
// Removals first: 200,000 rows is the table limit, so appending needs room.
measure("remove the last row", (p) => removeRows(p, big.id, new Set([bigRows(p).at(-1)!.id])));
measure("remove a middle row", (p) => removeRows(p, big.id, new Set([bigRows(p)[Math.floor(bigRows(p).length / 2)]!.id])));
measure("insert a middle row", (p, e) => ({
  label: "insert-row",
  patches: [{ op: "insert", path: ["assets", 1, "rows"], index: Math.floor(bigRows(p).length / 2), value: { id: newId(), name: `Inserted_${e}`, cells: { [colLevel]: e } } }],
}));
measure("append a row", (p, e) => addRow(p, big.id, { id: newId(), name: `Added_${e}`, cells: { [colLevel]: e } }));
