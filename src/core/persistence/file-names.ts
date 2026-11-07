/**
 * File names of saved projects. A project file is plain JSON and uses the `.json`
 * extension, so every OS and editor recognizes it. What makes it a project is its content
 * (`manifest.format`), never its name.
 */

export const PROJECT_FILE_EXTENSION = ".json";

/** The extension used before 2026-11. Such files still open; saving them writes `.json`. */
export const LEGACY_PROJECT_FILE_EXTENSION = ".gdtproj";

/** The manifest of a project folder (folder mode). */
export const FOLDER_MANIFEST_FILE = "gamedevtool.json";

/**
 * File name for saving a project, derived from its name: safe on Windows, macOS and Linux,
 * and never FOLDER_MANIFEST_FILE, so a downloaded project cannot pass for a folder manifest.
 */
export function projectFileName(projectName: string): string {
  const base = projectName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
  return notManifest(`${base.length > 0 ? base : "project"}${PROJECT_FILE_EXTENSION}`);
}

/**
 * File name for saving a project opened from `openedName`: a legacy extension becomes
 * `.json`, and the result is never FOLDER_MANIFEST_FILE either.
 */
export function savedFileName(openedName: string): string {
  const legacy = openedName.length - LEGACY_PROJECT_FILE_EXTENSION.length;
  const name =
    legacy > 0 && openedName.slice(legacy).toLowerCase() === LEGACY_PROJECT_FILE_EXTENSION
      ? `${openedName.slice(0, legacy)}${PROJECT_FILE_EXTENSION}`
      : openedName;
  return notManifest(name);
}

/** `gamedevtool.json` (any case: Windows and macOS file systems ignore it) gets a `-project` suffix. */
function notManifest(name: string): string {
  return name.toLowerCase() === FOLDER_MANIFEST_FILE ? `${name.slice(0, -PROJECT_FILE_EXTENSION.length)}-project${PROJECT_FILE_EXTENSION}` : name;
}
