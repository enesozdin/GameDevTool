/**
 * Folder mode adapter: binds core's FolderIo to the File System Access API.
 * Available in Chromium desktop browsers (also from file://). Elsewhere the folder actions
 * are hidden and Save/Open project file is used.
 *
 * Directory handles are deliberately NOT persisted (e.g. in IndexedDB for "reopen last
 * folder"): from file:// Chrome shares IndexedDB between all local HTML files, so any
 * other local page could pick up the handle. The picker remembers the last location
 * instead (`id` option), so reopening is still one click.
 */
import type { FolderFile, FolderIo } from "../../core/index.ts";

type PermissionMode = "read" | "readwrite";

/** Parts of the File System Access API that TypeScript's DOM lib does not declare yet. */
interface DirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: PermissionMode }): Promise<PermissionState>;
}

interface DirectoryPickerWindow {
  showDirectoryPicker?(options?: { id?: string; mode?: PermissionMode }): Promise<FileSystemDirectoryHandle>;
}

export function isFolderModeSupported(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function" && window.isSecureContext;
}

/** Opens the system folder picker with read/write access. Resolves null when the user cancels. */
export async function pickProjectFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as DirectoryPickerWindow).showDirectoryPicker!({ id: "gamedevtool-project", mode: "readwrite" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

/**
 * Makes sure the page may still write to the folder (the browser can revoke access, e.g.
 * after the tab was in the background). Must run inside a user gesture (click, Ctrl+S).
 */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as DirectoryHandle;
  if (h.queryPermission === undefined || h.requestPermission === undefined) return true;
  const mode = { mode: "readwrite" } as const;
  if ((await h.queryPermission(mode)) === "granted") return true;
  return (await h.requestPermission(mode)) === "granted";
}

const isNotFound = (e: unknown) => e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError");

/** last-modified alone can collide within one millisecond; size makes that unlikely to matter. */
const stampOf = (file: File) => `${file.lastModified}:${file.size}`;

export function createFolderIo(root: FileSystemDirectoryHandle): FolderIo {
  // Subfolder handles are reused across calls (thousands of asset files share one folder).
  // A cached handle goes stale if the folder is deleted outside the app; it is dropped on
  // the first error so the next call looks it up again.
  const dirs = new Map<string, FileSystemDirectoryHandle>();

  const dirOf = async (path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string; key: string } | null> => {
    const parts = path.split("/");
    const name = parts.pop()!;
    const key = parts.join("/");
    let dir = dirs.get(key);
    if (dir === undefined) {
      dir = root;
      try {
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
      dirs.set(key, dir);
    }
    return { dir, name, key };
  };

  const withDir = async <T,>(path: string, create: boolean, missing: T, body: (dir: FileSystemDirectoryHandle, name: string) => Promise<T>): Promise<T> => {
    const target = await dirOf(path, create);
    if (target === null) return missing;
    try {
      return await body(target.dir, target.name);
    } catch (e) {
      dirs.delete(target.key);
      if (isNotFound(e) && !create) return missing;
      throw e;
    }
  };

  return {
    async list(dir) {
      const target = await dirOf(`${dir}/_`, false);
      if (target === null) return [];
      const names: string[] = [];
      try {
        for await (const entry of target.dir.values()) if (entry.kind === "file") names.push(entry.name);
      } catch (e) {
        dirs.delete(target.key);
        if (isNotFound(e)) return [];
        throw e;
      }
      return names;
    },

    file(path) {
      return withDir<FolderFile | null>(path, false, null, async (dir, name) => {
        const file = await (await dir.getFileHandle(name)).getFile();
        return { size: file.size, stamp: stampOf(file), text: () => file.text() };
      });
    },

    write(path, text) {
      return withDir(path, true, "", async (dir, name) => {
        const handle = await dir.getFileHandle(name, { create: true });
        // createWritable writes to a temporary file that replaces the original on close(),
        // so a failed or interrupted write leaves the old file intact.
        const stream = await handle.createWritable();
        try {
          await stream.write(text);
          await stream.close();
        } catch (e) {
          await stream.abort().catch(() => undefined);
          throw e;
        }
        return stampOf(await handle.getFile());
      });
    },

    remove(path) {
      return withDir(path, false, undefined, (dir, name) => dir.removeEntry(name));
    },
  };
}
