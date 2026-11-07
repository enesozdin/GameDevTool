/**
 * Folder mode: a project stored as a folder with one JSON file per asset, so it works
 * directly with Git (small diffs, few merge conflicts). See docs/PROJECT_FORMAT.md.
 *
 *     <folder>/
 *       gamedevtool.json        the manifest
 *       assets/<ULID>.json      one file per asset, named by its id
 *
 * Everything else in the folder (.git, README, exports, ...) is ignored and never touched.
 *
 * File access goes through `FolderIo`, so this module stays free of DOM APIs and is tested
 * in Node; the browser adapter (File System Access API) lives in src/app/storage.
 *
 * Saving is incremental: edits share structure (see history.ts), so an asset whose object
 * is still the one last written is unchanged and is not rewritten. A save also refuses to
 * overwrite files that changed on disk since they were read or written (e.g. by `git pull`),
 * unless the caller confirms.
 */
import { ULID_PATTERN } from "../ids.ts";
import { DEFAULT_JSON_LIMITS, isJsonObject, parseUntrustedJsonCounted, stableStringify, type JsonLimits, type JsonValue } from "../json.ts";
import type { Id } from "../model/primitives.ts";
import { MAX_ASSETS, type Asset, type Manifest, type Project } from "../model/project.ts";
import { err, ok, type Result } from "../result.ts";
import { FOLDER_MANIFEST_FILE } from "./file-names.ts";
import { loadProjectJson, type LoadedProject, type LoadError, type LoadOptions } from "./project-file.ts";
export const FOLDER_ASSETS_DIR = "assets";

const ASSET_FILE_PATTERN = new RegExp(`^(${ULID_PATTERN.source.slice(1, -1)})\\.json$`);

/** Parallel file operations. Enough to hide per-file latency without flooding the browser. */
const IO_CONCURRENCY = 8;

export function assetFilePath(id: Id): string {
  return `${FOLDER_ASSETS_DIR}/${id}.json`;
}

// ---------------------------------------------------------------------------------------
// I/O abstraction
// ---------------------------------------------------------------------------------------

export interface FolderFile {
  /** Size in bytes. */
  readonly size: number;
  /** Opaque change marker (e.g. last-modified time + size). Different content → different stamp. */
  readonly stamp: string;
  text(): Promise<string>;
}

/** Paths are relative to the project folder and use "/" (e.g. "assets/01J….json"). */
export interface FolderIo {
  /** Names of the files (not directories) directly inside `dir`; empty if `dir` does not exist. */
  list(dir: string): Promise<readonly string[]>;
  /** The file at `path`, or null if it does not exist. */
  file(path: string): Promise<FolderFile | null>;
  /** Creates or replaces a file, creating missing parent folders. Returns the new stamp. */
  write(path: string, text: string): Promise<string>;
  /** Deletes a file. Succeeds if it is already gone. */
  remove(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Session: what is on disk, as far as this app knows
// ---------------------------------------------------------------------------------------

export interface FolderEntry<T> {
  /**
   * The object whose canonical text is in the file, or null if the file's content is not
   * known to match anything in memory (written by another program, not canonical, or from
   * an older schema). A null entry is always rewritten (or deleted) on the next save.
   */
  readonly value: T | null;
  /** Stamp when this app last read or wrote the file; used to detect outside changes. */
  readonly stamp: string;
}

export interface FolderSession {
  /** null: there is no manifest file in the folder. */
  readonly manifest: FolderEntry<Manifest> | null;
  /** Asset files present in the folder, by asset id. */
  readonly assets: ReadonlyMap<Id, FolderEntry<Asset>>;
}

/** An error that happened in one file of the folder. `file` is its folder-relative path. */
export type FolderLoadError =
  | (LoadError & { readonly file?: string })
  | { readonly code: "no-project" }
  /** FOLDER_MANIFEST_FILE holds a whole project file, not a manifest (e.g. a renamed download). */
  | { readonly code: "single-file-project"; readonly file: string }
  | { readonly code: "read-failed"; readonly file?: string }
  | { readonly code: "too-many-files"; readonly limit: number }
  /** The asset id inside the file does not match the file name (e.g. a copied file). */
  | { readonly code: "asset-file-mismatch"; readonly file: string };

export interface OpenedFolder {
  readonly loaded: LoadedProject;
  readonly session: FolderSession;
}

// ---------------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------------

/**
 * Reads a project folder. Files are untrusted, exactly like a project file: the same limits
 * apply to the folder as a whole (total size, total value count, nesting depth measured as
 * if the files were one document), followed by the same migrate → schema → validate steps.
 * Assets are ordered by id, which is creation order.
 */
export async function openProjectFolder(io: FolderIo, options: LoadOptions = {}): Promise<Result<OpenedFolder, FolderLoadError>> {
  const limits = options.limits ?? DEFAULT_JSON_LIMITS;

  let manifestFile: FolderFile | null;
  let names: string[];
  try {
    manifestFile = await io.file(FOLDER_MANIFEST_FILE);
    if (manifestFile === null) return err({ code: "no-project" });
    names = (await io.list(FOLDER_ASSETS_DIR)).filter((n) => ASSET_FILE_PATTERN.test(n)).sort();
  } catch {
    return err({ code: "read-failed" });
  }
  if (names.length > MAX_ASSETS) return err({ code: "too-many-files", limit: MAX_ASSETS });
  const paths = names.map((n) => `${FOLDER_ASSETS_DIR}/${n}`);

  // Sizes first: refuse oversized folders before reading any content.
  const files: FolderFile[] = [];
  let totalBytes = manifestFile.size;
  try {
    const found = await mapLimited(paths, IO_CONCURRENCY, (p) => io.file(p));
    for (let i = 0; i < found.length; i++) {
      const f = found[i]!;
      // Deleted between listing and opening.
      if (f === null) return err({ code: "read-failed", file: paths[i]! });
      totalBytes += f.size;
      files.push(f);
    }
  } catch {
    return err({ code: "read-failed" });
  }
  // A size limit on disk, checked before any content is read. UTF-8 text has at least as
  // many bytes as UTF-16 code units, so a folder under the limit always passes the parser's
  // character limit. Non-ASCII folders over it are refused although their character count
  // would fit; that is deliberate, the limit is a size.
  if (totalBytes > limits.maxChars) return err({ code: "too-large", limit: limits.maxChars, actual: totalBytes });

  let manifestText: string;
  let assetTexts: string[];
  try {
    manifestText = await manifestFile.text();
    assetTexts = await mapLimited(files, IO_CONCURRENCY, (f) => f.text());
  } catch {
    return err({ code: "read-failed" });
  }

  // One value budget for the whole folder. The root object and the assets array of the
  // equivalent single file count as 2 values.
  let budget = limits.maxValues - 2;
  const parse = (text: string, depth: number, file: string): Result<JsonValue, FolderLoadError> => {
    const fileLimits: JsonLimits = { maxChars: limits.maxChars, maxDepth: limits.maxDepth - depth, maxValues: budget };
    const parsed = parseUntrustedJsonCounted(text, fileLimits);
    if (!parsed.ok) return err({ ...parsed.error, file });
    budget -= parsed.value.values;
    return ok(parsed.value.value);
  };

  // Depth offsets: in a single file the manifest sits at depth 2 and each asset at depth 3.
  const manifestRaw = parse(manifestText, 1, FOLDER_MANIFEST_FILE);
  if (!manifestRaw.ok) {
    // A whole project file at the single-file depth limit is one level too deep for the
    // manifest's place, so it fails here before the shape check below. Parse it once more
    // with the single-file limits, only to say what it is: this branch always returns an
    // error, the value is never loaded and the folder's value budget is not touched.
    if (manifestRaw.error.code === "too-deep") {
      const asFile = parseUntrustedJsonCounted(manifestText, limits);
      if (asFile.ok && isSingleFileProject(asFile.value.value)) return err({ code: "single-file-project", file: FOLDER_MANIFEST_FILE });
    }
    return manifestRaw;
  }
  if (isSingleFileProject(manifestRaw.value)) return err({ code: "single-file-project", file: FOLDER_MANIFEST_FILE });
  const assetsRaw: JsonValue[] = [];
  for (let i = 0; i < assetTexts.length; i++) {
    const raw = parse(assetTexts[i]!, 2, paths[i]!);
    if (!raw.ok) return raw;
    assetsRaw.push(raw.value);
  }

  const loaded = loadProjectJson({ manifest: manifestRaw.value, assets: assetsRaw }, options.migrations);
  if (!loaded.ok) {
    const error = loaded.error;
    if (error.code === "schema") {
      const path = error.issues[0]?.path;
      const file = path?.[0] === "assets" && typeof path[1] === "number" ? paths[path[1]] : path?.[0] === "manifest" ? FOLDER_MANIFEST_FILE : undefined;
      return err(file === undefined ? error : { ...error, file });
    }
    return err(error.code === "not-a-project" || error.code === "unsupported-version" ? { ...error, file: FOLDER_MANIFEST_FILE } : error);
  }

  const { project } = loaded.value;
  const assets = new Map<Id, FolderEntry<Asset>>();
  for (let i = 0; i < project.assets.length; i++) {
    const asset = project.assets[i]!;
    if (`${asset.id}.json` !== names[i]) return err({ code: "asset-file-mismatch", file: paths[i]! });
    assets.set(asset.id, { value: isCanonical(asset, assetTexts[i]!) ? asset : null, stamp: files[i]!.stamp });
  }
  const manifest = { value: isCanonical(project.manifest, manifestText) ? project.manifest : null, stamp: manifestFile.stamp };
  return ok({ loaded: loaded.value, session: { manifest, assets } });
}

/** Whether a parsed manifest file is in fact a whole project file (`manifest` + `assets`). */
function isSingleFileProject(value: JsonValue): boolean {
  return isJsonObject(value) && isJsonObject(value["manifest"]) && "assets" in value;
}

/**
 * True if `text` is exactly what saving `value` would write. Files that were hand-edited,
 * merged, migrated or contained unknown keys are not, and get rewritten on the next save.
 * CRLF is accepted: Git may check files out with Windows line endings.
 */
function isCanonical(value: unknown, text: string): boolean {
  return stableStringify(value) === (text.includes("\r") ? text.replace(/\r\n/g, "\n") : text);
}

/**
 * Describes a folder before saving a project into it for the first time. Existing project
 * files become null entries, so the first save replaces them and deletes stale asset files.
 * `session.manifest !== null` means the folder already holds a project: ask before saving.
 */
export async function readFolderSession(io: FolderIo): Promise<Result<FolderSession, { readonly code: "read-failed" }>> {
  try {
    const manifestFile = await io.file(FOLDER_MANIFEST_FILE);
    const names = (await io.list(FOLDER_ASSETS_DIR)).filter((n) => ASSET_FILE_PATTERN.test(n));
    const files = await mapLimited(names, IO_CONCURRENCY, (n) => io.file(`${FOLDER_ASSETS_DIR}/${n}`));
    const assets = new Map<Id, FolderEntry<Asset>>();
    for (let i = 0; i < names.length; i++) {
      const f = files[i];
      if (f) assets.set(names[i]!.slice(0, -".json".length), { value: null, stamp: f.stamp });
    }
    return ok({ manifest: manifestFile === null ? null : { value: null, stamp: manifestFile.stamp }, assets });
  } catch {
    return err({ code: "read-failed" });
  }
}

// ---------------------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------------------

export interface FolderSaveOptions {
  /** Overwrite files that changed outside this app. Set after the user confirmed. */
  readonly overwrite?: boolean;
}

export type FolderSaveResult =
  | { readonly status: "saved"; readonly session: FolderSession; readonly written: number; readonly removed: number }
  /** Nothing was written: these files changed on disk since they were read or written. */
  | { readonly status: "conflict"; readonly paths: readonly string[] }
  /** Nothing was written: two assets share an id, so they would share a file. */
  | { readonly status: "duplicate-id"; readonly id: Id }
  /**
   * Writing stopped at `path`. `session` records what was written before that, so the next
   * save continues from there. The project is not fully saved.
   */
  | { readonly status: "failed"; readonly session: FolderSession; readonly path: string; readonly message: string };

type SaveOp =
  | { readonly kind: "asset"; readonly path: string; readonly asset: Asset }
  | { readonly kind: "remove"; readonly path: string; readonly id: Id }
  | { readonly kind: "manifest"; readonly path: string };

/**
 * Writes the changes since `session` to the folder: changed and new assets, deleted assets,
 * then the manifest (last, so an interrupted save never leaves a manifest that is newer than
 * its assets). Unchanged assets cost one identity check each and no I/O.
 *
 * Files are written one by one (each write is atomic in the File System Access API), so a
 * crash mid-save can leave a mix of old and new files; the unsaved project is still in the
 * crash-recovery cache and stays "unsaved" until a save completes.
 */
export async function saveProjectFolder(io: FolderIo, session: FolderSession, project: Project, options: FolderSaveOptions = {}): Promise<FolderSaveResult> {
  const ids = new Set<Id>();
  const ops: SaveOp[] = [];
  for (const asset of project.assets) {
    if (ids.has(asset.id)) return { status: "duplicate-id", id: asset.id };
    ids.add(asset.id);
    if (session.assets.get(asset.id)?.value !== asset) ops.push({ kind: "asset", path: assetFilePath(asset.id), asset });
  }
  for (const id of session.assets.keys()) {
    if (!ids.has(id)) ops.push({ kind: "remove", path: assetFilePath(id), id });
  }
  if (session.manifest?.value !== project.manifest) ops.push({ kind: "manifest", path: FOLDER_MANIFEST_FILE });
  if (ops.length === 0) return { status: "saved", session, written: 0, removed: 0 };

  if (options.overwrite !== true) {
    const expected = (op: SaveOp): string | null =>
      (op.kind === "manifest" ? session.manifest : session.assets.get(op.kind === "asset" ? op.asset.id : op.id))?.stamp ?? null;
    let current: (string | null)[];
    try {
      current = await mapLimited(ops, IO_CONCURRENCY, async (op) => (await io.file(op.path))?.stamp ?? null);
    } catch (e) {
      return { status: "failed", session, path: "", message: errorMessage(e) };
    }
    const conflicts: string[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      // A file we are deleting that is already gone is not a conflict.
      if (current[i] !== expected(op) && !(op.kind === "remove" && current[i] === null)) conflicts.push(op.path);
    }
    if (conflicts.length > 0) return { status: "conflict", paths: conflicts };
  }

  const assets = new Map(session.assets);
  let manifest = session.manifest;
  let written = 0;
  let removed = 0;
  const done = (): FolderSession => ({ manifest, assets });

  const run = async (op: SaveOp): Promise<void> => {
    try {
      if (op.kind === "asset") {
        assets.set(op.asset.id, { value: op.asset, stamp: await io.write(op.path, stableStringify(op.asset)) });
        written++;
      } else if (op.kind === "remove") {
        await io.remove(op.path);
        assets.delete(op.id);
        removed++;
      } else {
        manifest = { value: project.manifest, stamp: await io.write(op.path, stableStringify(project.manifest)) };
        written++;
      }
    } catch (e) {
      throw new OpError(op.path, errorMessage(e));
    }
  };

  try {
    await runLimited(
      ops.filter((op) => op.kind === "asset"),
      IO_CONCURRENCY,
      run,
    );
    await runLimited(
      ops.filter((op) => op.kind === "remove"),
      IO_CONCURRENCY,
      run,
    );
    const manifestOp = ops.find((op) => op.kind === "manifest");
    if (manifestOp) await run(manifestOp);
  } catch (e) {
    const failure = e instanceof OpError ? e : new OpError("", errorMessage(e));
    return { status: "failed", session: done(), path: failure.path, message: failure.message };
  }
  return { status: "saved", session: done(), written, removed };
}

class OpError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ---------------------------------------------------------------------------------------
// Bounded parallelism
// ---------------------------------------------------------------------------------------

/** Maps with at most `limit` tasks in flight; results keep input order. Rejects on the first error. */
async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  await runLimited(Array.from(items, (_, i) => i), limit, async (i) => {
    results[i] = await task(items[i]!);
  });
  return results;
}

/**
 * Runs tasks with at most `limit` in flight. After the first failure no new task starts;
 * tasks already running finish (so their effects are known), then the first error is thrown.
 */
async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch (e) {
        if (!failed) {
          failed = true;
          failure = e;
        }
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  if (failed) throw failure;
}
