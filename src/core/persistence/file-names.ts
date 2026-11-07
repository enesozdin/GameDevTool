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
 * Longest stem (name without `.json`). With the extension and a suffix added, the name stays
 * well under the limits of NTFS (255 UTF-16 units) and ext4 / APFS (255 UTF-8 bytes).
 */
const MAX_STEM_UNITS = 100;
const MAX_STEM_BYTES = 200;

/**
 * Device names Windows reserves. The part before the first dot counts, so "CON.json" and
 * "nul.backup.json" are reserved too.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * File name for saving a project, derived from its name: safe on Windows, macOS and Linux,
 * and never FOLDER_MANIFEST_FILE, so a downloaded project cannot pass for a folder manifest.
 */
export function projectFileName(projectName: string): string {
  const trim = (text: string) => text.replace(/^[.\s]+|[.\s]+$/g, "");
  // Trimmed again after the cut: it can end the stem with a dot or a space.
  const stem = trim(cutStem(trim(projectName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_"))));
  return safeName(`${stem.length > 0 ? stem : "project"}${PROJECT_FILE_EXTENSION}`);
}

/**
 * File name for saving a project opened from `openedName`: a legacy extension becomes
 * `.json`, and the result is never FOLDER_MANIFEST_FILE or a reserved Windows name either
 * (a file from Linux or macOS can be named "CON.json").
 */
export function savedFileName(openedName: string): string {
  const legacy = openedName.length - LEGACY_PROJECT_FILE_EXTENSION.length;
  const name =
    legacy > 0 && openedName.slice(legacy).toLowerCase() === LEGACY_PROJECT_FILE_EXTENSION
      ? `${openedName.slice(0, legacy)}${PROJECT_FILE_EXTENSION}`
      : openedName;
  return safeName(name);
}

/**
 * The last step for every name: a reserved Windows device name gets "_" after it ("CON.json"
 * becomes "CON_.json"), and `gamedevtool.json` gets a `-project` suffix. Both comparisons
 * ignore case, as Windows and macOS file systems do.
 */
function safeName(name: string): string {
  const dot = name.indexOf(".");
  const first = dot < 0 ? name : name.slice(0, dot);
  if (WINDOWS_RESERVED.test(first.trimEnd())) name = `${first}_${name.slice(first.length)}`;
  return name.toLowerCase() === FOLDER_MANIFEST_FILE ? `${name.slice(0, -PROJECT_FILE_EXTENSION.length)}-project${PROJECT_FILE_EXTENSION}` : name;
}

/**
 * Cuts `text` to MAX_STEM_UNITS and MAX_STEM_BYTES at a grapheme boundary, so an emoji
 * (including ZWJ sequences and flags) or a letter with combining marks is kept whole or
 * dropped whole, never split. Short names return at once; only long ones are segmented.
 */
function cutStem(text: string): string {
  if (text.length <= MAX_STEM_UNITS && utf8Length(text) <= MAX_STEM_BYTES) return text;
  let out = "";
  let bytes = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const size = utf8Length(segment);
    if (out.length + segment.length > MAX_STEM_UNITS || bytes + size > MAX_STEM_BYTES) break;
    out += segment;
    bytes += size;
  }
  return out;
}

/** UTF-8 byte length, without an encoder. A lone surrogate counts as 3 bytes (U+FFFD). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
