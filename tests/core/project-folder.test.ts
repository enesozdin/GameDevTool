import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAsset,
  applyPatches,
  assetFilePath,
  createDocument,
  createEmptyProject,
  DEFAULT_JSON_LIMITS,
  FOLDER_MANIFEST_FILE,
  openProjectFolder,
  readFolderSession,
  removeAsset,
  renameAsset,
  saveProject,
  saveProjectFolder,
  stableStringify,
  type FolderIo,
  type FolderSession,
  type Project,
} from "../../src/core/index.ts";
import { fixedIds, sampleProject } from "../helpers.ts";

/** In-memory folder. Stamps change on every write, like a last-modified time. */
class MemoryFolder implements FolderIo {
  readonly files = new Map<string, { text: string; stamp: string }>();
  writes: string[] = [];
  removes: string[] = [];
  private clock = 0;
  /** Paths whose next write throws. */
  failOn = new Set<string>();

  put(path: string, text: string): void {
    this.files.set(path, { text, stamp: `t${++this.clock}` });
  }
  async list(dir: string): Promise<readonly string[]> {
    const prefix = `${dir}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length));
  }
  async file(path: string) {
    const f = this.files.get(path);
    return f === undefined ? null : { size: Buffer.byteLength(f.text), stamp: f.stamp, text: async () => f.text };
  }
  async write(path: string, text: string): Promise<string> {
    if (this.failOn.has(path)) throw new Error("disk full");
    this.put(path, text);
    this.writes.push(path);
    return this.files.get(path)!.stamp;
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removes.push(path);
  }
  resetLog(): void {
    this.writes = [];
    this.removes = [];
  }
}

const emptySession: FolderSession = { manifest: null, assets: new Map() };

async function saveNew(project: Project): Promise<{ folder: MemoryFolder; session: FolderSession }> {
  const folder = new MemoryFolder();
  const result = await saveProjectFolder(folder, emptySession, project);
  assert.equal(result.status, "saved");
  assert.ok(result.status === "saved");
  folder.resetLog();
  return { folder, session: result.session };
}

async function open(folder: MemoryFolder) {
  const opened = await openProjectFolder(folder);
  assert.ok(opened.ok, JSON.stringify(!opened.ok && opened.error));
  return opened.value;
}

describe("project folder", () => {
  it("writes one canonical file per asset plus the manifest", async () => {
    const project = sampleProject();
    const { folder } = await saveNew(project);
    assert.deepEqual([...folder.files.keys()].sort(), [FOLDER_MANIFEST_FILE, ...project.assets.map((a) => assetFilePath(a.id))].sort());
    assert.equal(folder.files.get(FOLDER_MANIFEST_FILE)!.text, stableStringify(project.manifest));
    for (const a of project.assets) assert.equal(folder.files.get(assetFilePath(a.id))!.text, stableStringify(a));
  });

  it("round-trips: folder → project equals the single-file save", async () => {
    const project = sampleProject();
    const { folder } = await saveNew(project);
    const opened = await open(folder);
    assert.deepEqual(opened.loaded.issues, []);
    assert.equal(saveProject(opened.loaded.project), saveProject(project));
    // Every file was canonical, so the session knows all of them.
    assert.equal(opened.session.manifest!.value, opened.loaded.project.manifest);
    for (const a of opened.loaded.project.assets) assert.equal(opened.session.assets.get(a.id)!.value, a);
  });

  it("orders assets by id (creation order) regardless of listing order", async () => {
    const project = sampleProject();
    const shuffled = { ...project, assets: [...project.assets].reverse() };
    const { folder } = await saveNew(shuffled);
    const opened = await open(folder);
    assert.deepEqual(
      opened.loaded.project.assets.map((a) => a.id),
      project.assets.map((a) => a.id).sort(),
    );
  });

  it("saving again without changes does no I/O", async () => {
    const { folder } = await saveNew(sampleProject());
    const opened = await open(folder);
    const result = await saveProjectFolder(folder, opened.session, opened.loaded.project);
    assert.equal(result.status, "saved");
    assert.deepEqual(folder.writes, []);
    assert.deepEqual(folder.removes, []);
  });

  it("rewrites only the changed asset", async () => {
    const { folder } = await saveNew(sampleProject());
    const { loaded, session } = await open(folder);
    const target = loaded.project.assets[2]!;
    const change = renameAsset(loaded.project, target.id, "Renamed");
    assert.ok(change !== null);
    const edited = applyPatches(loaded.project, change.patches).value;

    const result = await saveProjectFolder(folder, session, edited);
    assert.ok(result.status === "saved");
    assert.deepEqual(folder.writes, [assetFilePath(target.id)]);
    assert.equal(result.written, 1);

    // Undo returns the original object: saving that rewrites the same file once more.
    folder.resetLog();
    const back = await saveProjectFolder(folder, result.session, loaded.project);
    assert.ok(back.status === "saved");
    assert.deepEqual(folder.writes, [assetFilePath(target.id)]);
  });

  it("adds and deletes asset files, manifest written last", async () => {
    const ids = fixedIds(1_800_000_000_000);
    const { folder } = await saveNew(sampleProject());
    const { loaded, session } = await open(folder);
    const removed = loaded.project.assets[0]!;
    const doc = createDocument(ids, "New page");
    let project = applyPatches(loaded.project, removeAsset(loaded.project, removed.id)!.patches).value;
    project = applyPatches(project, addAsset(project, doc)!.patches).value;
    // A manifest change too, so the order is visible.
    project = { ...project, manifest: { ...project.manifest, name: "Renamed project" } };

    const result = await saveProjectFolder(folder, session, project);
    assert.ok(result.status === "saved");
    assert.deepEqual(folder.writes, [assetFilePath(doc.id), FOLDER_MANIFEST_FILE]);
    assert.deepEqual(folder.removes, [assetFilePath(removed.id)]);
    assert.equal(result.removed, 1);
    assert.equal(saveProject((await open(folder)).loaded.project), saveProject(project));
  });

  it("refuses to overwrite files changed outside the app until confirmed", async () => {
    const { folder } = await saveNew(sampleProject());
    const { loaded, session } = await open(folder);
    const target = loaded.project.assets[1]!;
    const path = assetFilePath(target.id);
    folder.put(path, folder.files.get(path)!.text); // e.g. touched by `git pull`

    const edited = applyPatches(loaded.project, renameAsset(loaded.project, target.id, "Mine")!.patches).value;
    const result = await saveProjectFolder(folder, session, edited);
    assert.deepEqual(result, { status: "conflict", paths: [path] });
    assert.deepEqual(folder.writes, []);

    const forced = await saveProjectFolder(folder, session, edited, { overwrite: true });
    assert.equal(forced.status, "saved");
    assert.deepEqual(folder.writes, [path]);
  });

  it("does not flag outside changes to files it is not writing", async () => {
    const { folder } = await saveNew(sampleProject());
    const { loaded, session } = await open(folder);
    const other = assetFilePath(loaded.project.assets[0]!.id);
    folder.put(other, folder.files.get(other)!.text);
    const target = loaded.project.assets[1]!;
    const edited = applyPatches(loaded.project, renameAsset(loaded.project, target.id, "Mine")!.patches).value;
    assert.equal((await saveProjectFolder(folder, session, edited)).status, "saved");
  });

  it("first save into a folder with another project replaces it and removes stale assets", async () => {
    const { folder } = await saveNew(sampleProject());
    const stale = [...folder.files.keys()].filter((p) => p !== FOLDER_MANIFEST_FILE);
    folder.put("README.md", "keep me");
    folder.put("assets/notes.txt", "keep me too");

    const other = createEmptyProject("Other", fixedIds(1_900_000_000_000));
    const session = await readFolderSession(folder);
    assert.ok(session.ok);
    assert.notEqual(session.value.manifest, null); // the UI asks before replacing
    const result = await saveProjectFolder(folder, session.value, other);
    assert.ok(result.status === "saved");
    assert.deepEqual(folder.removes.sort(), stale.sort());
    assert.deepEqual([...folder.files.keys()].sort(), ["README.md", "assets/notes.txt", FOLDER_MANIFEST_FILE]);
  });

  it("keeps partial progress when a write fails", async () => {
    const project = sampleProject();
    const folder = new MemoryFolder();
    const failing = assetFilePath(project.assets[3]!.id);
    folder.failOn.add(failing);
    const result = await saveProjectFolder(folder, emptySession, project);
    assert.ok(result.status === "failed");
    assert.equal(result.path, failing);
    assert.match(result.message, /disk full/);
    // The manifest is written last, so it was not written.
    assert.equal(folder.files.has(FOLDER_MANIFEST_FILE), false);

    folder.failOn.clear();
    folder.resetLog();
    const retry = await saveProjectFolder(folder, result.session, project);
    assert.ok(retry.status === "saved");
    assert.deepEqual(folder.writes, [failing, FOLDER_MANIFEST_FILE]);
  });

  it("refuses to save assets with duplicate ids", async () => {
    const project = sampleProject();
    const dup = { ...project, assets: [...project.assets, { ...project.assets[0]!, name: "Copy" }] };
    const result = await saveProjectFolder(new MemoryFolder(), emptySession, dup);
    assert.deepEqual(result, { status: "duplicate-id", id: project.assets[0]!.id });
  });

  it("marks non-canonical files for rewrite without making the project dirty", async () => {
    const project = sampleProject();
    const { folder } = await saveNew(project);
    const path = assetFilePath(project.assets[0]!.id);
    const raw = JSON.parse(folder.files.get(path)!.text);
    raw.unknownKey = 1;
    folder.put(path, JSON.stringify(raw)); // minified, with an extra key
    folder.put(FOLDER_MANIFEST_FILE, folder.files.get(FOLDER_MANIFEST_FILE)!.text.replace(/\n/g, "\r\n"));

    const opened = await open(folder);
    assert.equal(saveProject(opened.loaded.project), saveProject(project));
    assert.equal(opened.session.assets.get(project.assets[0]!.id)!.value, null);
    assert.notEqual(opened.session.manifest!.value, null); // CRLF only: still canonical

    const result = await saveProjectFolder(folder, opened.session, opened.loaded.project);
    assert.ok(result.status === "saved");
    assert.deepEqual(folder.writes, [path]);
    assert.equal(folder.files.get(path)!.text, stableStringify(project.assets[0]));
  });

  it("ignores files that are not project files", async () => {
    const { folder } = await saveNew(sampleProject());
    folder.put("assets/readme.json", "not json at all");
    folder.put("assets/sub/01ARZ3NDEKTSV4RRFFQ69G5FAV.json", "{");
    folder.put("other.json", "{");
    assert.equal((await open(folder)).loaded.project.assets.length, sampleProject().assets.length);
  });

  describe("errors", () => {
    it("reports a folder without a project", async () => {
      const opened = await openProjectFolder(new MemoryFolder());
      assert.deepEqual(!opened.ok && opened.error, { code: "no-project" });
    });

    it("names the file with invalid JSON (e.g. Git conflict markers)", async () => {
      const project = sampleProject();
      const { folder } = await saveNew(project);
      const path = assetFilePath(project.assets[1]!.id);
      folder.put(path, `<<<<<<< HEAD\n${folder.files.get(path)!.text}=======\n>>>>>>> branch\n`);
      const opened = await openProjectFolder(folder);
      assert.deepEqual(!opened.ok && opened.error, { code: "invalid-json", file: path });
    });

    it("names the file with a schema error", async () => {
      const project = sampleProject();
      const { folder } = await saveNew(project);
      const path = assetFilePath(project.assets[2]!.id);
      const raw = JSON.parse(folder.files.get(path)!.text);
      raw.name = "";
      folder.put(path, JSON.stringify(raw));
      const opened = await openProjectFolder(folder);
      assert.ok(!opened.ok && opened.error.code === "schema");
      assert.equal("file" in opened.error && opened.error.file, path);
    });

    it("rejects an asset whose id does not match its file name", async () => {
      const project = sampleProject();
      const { folder } = await saveNew(project);
      const copy = "assets/01ARZ3NDEKTSV4RRFFQ69G5FAV.json";
      folder.put(copy, folder.files.get(assetFilePath(project.assets[0]!.id))!.text);
      const opened = await openProjectFolder(folder);
      assert.deepEqual(!opened.ok && opened.error, { code: "asset-file-mismatch", file: copy });
    });

    it("rejects forbidden keys in any file", async () => {
      const project = sampleProject();
      const { folder } = await saveNew(project);
      const path = assetFilePath(project.assets[0]!.id);
      folder.put(path, folder.files.get(path)!.text.replace('"cells": {', '"cells": {"__proto__": {},'));
      const opened = await openProjectFolder(folder);
      assert.deepEqual(!opened.ok && opened.error, { code: "forbidden-key", key: "__proto__", file: path });
    });

    it("applies size, value and depth limits to the folder as a whole", async () => {
      const project = sampleProject();
      const { folder } = await saveNew(project);
      const total = [...folder.files.values()].reduce((n, f) => n + Buffer.byteLength(f.text), 0);
      const single = JSON.parse(saveProject(project));

      const tooLarge = await openProjectFolder(folder, { limits: { ...DEFAULT_JSON_LIMITS, maxChars: total - 1 } });
      assert.deepEqual(!tooLarge.ok && tooLarge.error, { code: "too-large", limit: total - 1, actual: total });
      assert.ok((await openProjectFolder(folder, { limits: { ...DEFAULT_JSON_LIMITS, maxChars: total } })).ok);

      // Count values and depth of the equivalent single file.
      let values = 0;
      let depth = 0;
      const walk = (v: unknown, d: number): void => {
        values++;
        if (v !== null && typeof v === "object") {
          depth = Math.max(depth, d);
          for (const c of Object.values(v)) walk(c, d + 1);
        }
      };
      walk(single, 1);
      assert.ok((await openProjectFolder(folder, { limits: { ...DEFAULT_JSON_LIMITS, maxValues: values, maxDepth: depth } })).ok);
      const fewer = await openProjectFolder(folder, { limits: { ...DEFAULT_JSON_LIMITS, maxValues: values - 1 } });
      assert.ok(!fewer.ok && fewer.error.code === "too-many-values");
      const shallower = await openProjectFolder(folder, { limits: { ...DEFAULT_JSON_LIMITS, maxDepth: depth - 1 } });
      assert.ok(!shallower.ok && shallower.error.code === "too-deep");
    });

    it("reports a newer schema version against the manifest", async () => {
      const { folder } = await saveNew(sampleProject());
      const raw = JSON.parse(folder.files.get(FOLDER_MANIFEST_FILE)!.text);
      raw.schemaVersion = 99;
      folder.put(FOLDER_MANIFEST_FILE, JSON.stringify(raw));
      const opened = await openProjectFolder(folder);
      assert.ok(!opened.ok && opened.error.code === "unsupported-version");
      assert.equal("file" in opened.error && opened.error.file, FOLDER_MANIFEST_FILE);
    });
  });
});
