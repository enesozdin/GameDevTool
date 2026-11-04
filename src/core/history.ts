/**
 * Undo/redo for every tool. Edits are commands that produce patches; patches are applied
 * immutably with structural sharing (only containers on the edited path are copied).
 * Unchanged assets keep their object identity, so "what changed since the last save" is
 * an identity check, not a deep diff. `applyPatches` also returns the inverse patches,
 * for callers that need to replay or transmit changes.
 */

export type PatchPath = readonly (string | number)[];

export type Patch =
  /** Sets a property or an existing array index. `value: undefined` deletes an object property. */
  | { readonly op: "set"; readonly path: PatchPath; readonly value: unknown }
  /** Inserts into the array at `path`. `index` may equal the length (append). */
  | { readonly op: "insert"; readonly path: PatchPath; readonly index: number; readonly value: unknown }
  /** Removes one element from the array at `path`. */
  | { readonly op: "remove"; readonly path: PatchPath; readonly index: number };

const FORBIDDEN_KEYS: ReadonlySet<string | number> = new Set(["__proto__", "constructor", "prototype"]);

type Container = Record<string | number, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return value !== null && typeof value === "object";
}

/**
 * Applies patches in order without mutating `root`. Containers copied during this call are
 * tracked, so a batch of many patches (bulk edit, paste) copies each container once.
 * Throws on an invalid path; patches come from code, so that is a programming error.
 */
export function applyPatches<T>(root: T, patches: readonly Patch[]): { value: T; inverse: Patch[] } {
  const owned = new WeakSet<object>();
  const own = (c: Container): Container => {
    if (owned.has(c)) return c;
    const copy: Container = Array.isArray(c) ? c.slice() : { ...c };
    owned.add(copy);
    return copy;
  };

  let current: unknown = root;
  const inverse: Patch[] = [];

  for (const patch of patches) {
    const containerPath = patch.op === "set" ? patch.path.slice(0, -1) : patch.path;
    if (patch.op === "set" && patch.path.length === 0) throw new Error("applyPatches: empty set path");
    if (!isContainer(current)) throw new Error("applyPatches: root is not a container");

    const newRoot = own(current);
    let parent: Container = newRoot;
    for (const key of containerPath) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`applyPatches: forbidden key ${String(key)}`);
      const child = (parent as Record<string | number, unknown>)[key];
      if (!isContainer(child)) throw new Error(`applyPatches: no container at ${patch.path.join("/")}`);
      const copy = own(child);
      (parent as Record<string | number, unknown>)[key] = copy;
      parent = copy;
    }

    switch (patch.op) {
      case "set": {
        const key = patch.path[patch.path.length - 1]!;
        if (FORBIDDEN_KEYS.has(key)) throw new Error(`applyPatches: forbidden key ${String(key)}`);
        if (Array.isArray(parent)) {
          if (typeof key !== "number" || key < 0 || key >= parent.length || patch.value === undefined) {
            throw new Error(`applyPatches: invalid array set at ${patch.path.join("/")}`);
          }
          inverse.push({ op: "set", path: patch.path, value: parent[key] });
          parent[key] = patch.value;
        } else {
          const had = Object.hasOwn(parent, key);
          inverse.push({ op: "set", path: patch.path, value: had ? parent[key] : undefined });
          if (patch.value === undefined) delete parent[key];
          else parent[key] = patch.value;
        }
        break;
      }
      case "insert":
        if (!Array.isArray(parent) || patch.index < 0 || patch.index > parent.length) {
          throw new Error(`applyPatches: invalid insert at ${patch.path.join("/")}[${patch.index}]`);
        }
        parent.splice(patch.index, 0, patch.value);
        inverse.push({ op: "remove", path: patch.path, index: patch.index });
        break;
      case "remove": {
        if (!Array.isArray(parent) || patch.index < 0 || patch.index >= parent.length) {
          throw new Error(`applyPatches: invalid remove at ${patch.path.join("/")}[${patch.index}]`);
        }
        const [old] = parent.splice(patch.index, 1);
        inverse.push({ op: "insert", path: patch.path, index: patch.index, value: old });
        break;
      }
    }
    current = newRoot;
  }

  inverse.reverse();
  return { value: current as T, inverse };
}

// ---------------------------------------------------------------------------------------

/** One user action. `label` is a stable code the UI turns into "Undo <action>". */
export interface Change {
  readonly label: string;
  readonly patches: readonly Patch[];
  /**
   * Consecutive changes with the same key within COALESCE_MS merge into one undo step
   * (e.g. typing into a name field).
   */
  readonly coalesceKey?: string;
}

/**
 * The states before and after the change. They share structure with each other and with
 * the present, so keeping them costs about the same as inverse patches, and undo/redo
 * return the exact same objects. That makes "back at the saved state" a reference check.
 */
interface Entry<T> {
  readonly label: string;
  readonly before: T;
  readonly after: T;
  readonly coalesceKey: string | undefined;
  readonly time: number;
}

export interface History<T> {
  readonly present: T;
  /** Oldest first; the last entry is the next undo. */
  readonly past: readonly Entry<T>[];
  /** The last entry is the next redo. */
  readonly future: readonly Entry<T>[];
}

export const HISTORY_LIMIT = 500;
export const COALESCE_MS = 1_000;

export function createHistory<T>(present: T): History<T> {
  return { present, past: [], future: [] };
}

export function commit<T>(history: History<T>, change: Change, now: number, limit = HISTORY_LIMIT): History<T> {
  if (change.patches.length === 0) return history;
  const { value } = applyPatches(history.present, change.patches);

  const last = history.past[history.past.length - 1];
  if (last !== undefined && change.coalesceKey !== undefined && last.coalesceKey === change.coalesceKey && now - last.time <= COALESCE_MS) {
    // A typing burst stays one step: keep the first `before`, move `after` forward.
    const merged: Entry<T> = { ...last, after: value, time: now };
    return { present: value, past: [...history.past.slice(0, -1), merged], future: [] };
  }

  const entry: Entry<T> = { label: change.label, before: history.present, after: value, coalesceKey: change.coalesceKey, time: now };
  const past = history.past.length >= limit ? history.past.slice(history.past.length - limit + 1) : history.past.slice();
  past.push(entry);
  return { present: value, past, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  const entry = history.past[history.past.length - 1];
  if (entry === undefined) return history;
  // A coalesced entry must not keep merging after an undo/redo round trip.
  const settled: Entry<T> = { ...entry, coalesceKey: undefined };
  return { present: entry.before, past: history.past.slice(0, -1), future: [...history.future, settled] };
}

export function redo<T>(history: History<T>): History<T> {
  const entry = history.future[history.future.length - 1];
  if (entry === undefined) return history;
  return { present: entry.after, past: [...history.past, entry], future: history.future.slice(0, -1) };
}

export function undoLabel(history: History<unknown>): string | undefined {
  return history.past[history.past.length - 1]?.label;
}

export function redoLabel(history: History<unknown>): string | undefined {
  return history.future[history.future.length - 1]?.label;
}
