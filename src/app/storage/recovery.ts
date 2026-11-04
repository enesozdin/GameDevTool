/**
 * Crash-recovery cache in IndexedDB. NOT storage: the project file is the source of truth.
 *
 * - Chrome gives every local HTML file the same storage area, so other local pages can
 *   read and write this database. Entries are therefore untrusted and always go through
 *   loadProject (limits, forbidden keys, schema) before use.
 * - Best effort: if IndexedDB is unavailable (private mode, blocked storage), every call
 *   quietly does nothing.
 */

const DB_NAME = "gamedevtool";
const DB_VERSION = 1;
const STORE = "recovery";
/** Keep only the most recent entries so the cache cannot grow without bound. */
const MAX_ENTRIES = 5;

export interface RecoveryEntry {
  readonly projectId: string;
  readonly projectName: string;
  /** ms since epoch */
  readonly savedAt: number;
  readonly text: string;
}

let dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "projectId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (db === null) return resolve(undefined);
        try {
          const tx = db.transaction(STORE, mode);
          const request = body(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(request ? request.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

function isEntry(value: unknown): value is RecoveryEntry {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["projectId"] === "string" && typeof v["projectName"] === "string" && typeof v["savedAt"] === "number" && typeof v["text"] === "string";
}

async function readAll(): Promise<RecoveryEntry[]> {
  const all = await run<unknown[]>("readonly", (store) => store.getAll());
  return (all ?? []).filter(isEntry).sort((a, b) => b.savedAt - a.savedAt);
}

/** The most recent entry, if any. */
export async function readLatestRecovery(): Promise<RecoveryEntry | null> {
  return (await readAll())[0] ?? null;
}

export async function writeRecovery(entry: RecoveryEntry): Promise<void> {
  await run("readwrite", (store) => {
    store.put(entry);
  });
  const stale = (await readAll()).slice(MAX_ENTRIES);
  if (stale.length > 0) {
    await run("readwrite", (store) => {
      for (const e of stale) store.delete(e.projectId);
    });
  }
}

export async function clearRecovery(projectId: string): Promise<void> {
  await run("readwrite", (store) => {
    store.delete(projectId);
  });
}
