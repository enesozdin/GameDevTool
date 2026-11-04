/**
 * All user-facing UI text lives in string tables, never inline in components.
 * English is the source table; others (e.g. Turkish) are added in Phase 6 and must
 * satisfy the same `UiStrings` shape. Core returns codes (issue codes, change labels,
 * error codes); this file turns them into text.
 */
export const en = {
  appName: "GameDevTool",
  version: (v: string) => `Version ${v}`,
  privacyNote: "Your data stays on this device. This app makes no network requests.",
  skipToContent: "Skip to content",

  untitledProject: "Untitled project",
  untitledDocument: "Untitled document",
  untitledTable: "Untitled table",

  toolbar: {
    label: "Project",
    new: "New",
    open: "Open…",
    openFolder: "Open folder…",
    save: "Save",
    saveToFolder: "Save to folder…",
    downloadCopy: "Download copy",
    downloadCopyHint: "Download the project as a single .gdtproj file",
    folderHint: "Folder mode: one file per asset, for use with Git",
    undo: "Undo",
    redo: "Redo",
    undoAction: (action: string) => `Undo ${action}`,
    redoAction: (action: string) => `Redo ${action}`,
    withShortcut: (label: string, keys: string) => `${label} (${keys})`,
  },

  status: {
    unsaved: "Unsaved changes",
    saved: "Saved",
    neverSaved: "Not saved yet",
    opened: (file: string) => `Opened ${file}`,
    savedFile: (file: string) => `Saved ${file}`,
    openedFolder: (folder: string) => `Opened folder ${folder}`,
    savedFolder: (folder: string, written: number, removed: number) => {
      const parts: string[] = [];
      if (written > 0) parts.push(`${written} ${written === 1 ? "file" : "files"} written`);
      if (removed > 0) parts.push(`${removed} ${removed === 1 ? "file" : "files"} removed`);
      return parts.length === 0 ? `Saved to ${folder}. No files changed.` : `Saved to ${folder}: ${parts.join(", ")}.`;
    },
    downloaded: (file: string) => `Downloaded ${file}`,
    saving: "Saving…",
    notSaved: "Not saved.",
    migrated: (from: number, to: number) => `Upgraded from schema version ${from} to ${to}. Save to keep the upgrade.`,
    recovered: "Recovered unsaved changes. Save to keep them.",
  },

  confirm: {
    discardChanges: "Discard unsaved changes?",
    replaceFolderProject: (folder: string) =>
      `"${folder}" already contains a GameDevTool project. Replace it with this project? Other files in the folder are not touched.`,
    overwriteChanged: (count: number, example: string) =>
      `${count === 1 ? "A file was" : `${count} files were`} changed outside GameDevTool since the project was opened (for example by Git): ${example}${count > 1 ? ", …" : ""}\n\nOverwrite with your version?`,
    deleteAsset: (name: string) => `Delete "${name}"?`,
    deleteReferenced: (name: string, count: number) =>
      `Delete "${name}"? ${count} ${count === 1 ? "reference" : "references"} to it will break. You can undo this.`,
  },

  recovery: {
    found: (name: string, when: string) => `Unsaved changes to "${name}" from ${when} were found.`,
    restore: "Restore",
    discard: "Discard",
  },

  assets: {
    heading: "Assets",
    listLabel: "Assets",
    empty: "No assets yet. Add a document or a table.",
    addDocument: "New document",
    addTable: "New table",
    kind: { document: "Document", table: "Table" } as Record<string, string>,
  },

  details: {
    project: "Project",
    asset: "Asset",
    name: "Name",
    nameInvalid: "Enter a name (1–200 characters).",
    kind: "Type",
    id: "ID",
    schemaVersion: "Schema version",
    location: "Location",
    locationFolder: (folder: string) => `${folder} (folder)`,
    assetCount: "Assets",
    usedBy: "Used by",
    references: (n: number) => `${n} ${n === 1 ? "reference" : "references"}`,
    delete: "Delete",
    backToProject: "Project overview",
    comingLater: {
      document: "The document editor arrives in Phase 4.",
      table: "The table editor arrives in Phases 1–2.",
    } as Record<string, string>,
  },

  issues: {
    heading: "Validation",
    none: "No problems found.",
    count: (n: number) => `${n} ${n === 1 ? "problem" : "problems"}`,
    moreHidden: (n: number) => `${n} more not shown.`,
    severity: { error: "Error", warning: "Warning" } as Record<string, string>,
    codes: {
      "duplicate-id": "Duplicate ID",
      "duplicate-name": "Duplicate name",
      "unknown-option": "Unknown enum option",
      "invalid-range": "Minimum is greater than maximum",
      "required-missing": "Required value missing",
      "duplicate-value": "Value must be unique",
      "unknown-column": "Value for a column that does not exist",
      "type-mismatch": "Value has the wrong type",
      "out-of-range": "Value out of range",
      "too-long": "Text too long",
      "too-many-items": "Too many list items",
      "curve-keys-unsorted": "Curve keys must be sorted by x",
      "duplicate-loc-key": "Duplicate localization key",
      "parent-cycle": "Page is its own ancestor",
      "broken-reference": "Broken reference",
    } as Record<string, string>,
  },

  /** Change labels from core (history entries). */
  changes: {
    "rename-project": "rename project",
    "rename-asset": "rename asset",
    "add-document": "add document",
    "add-table": "add table",
    "remove-asset": "delete asset",
  } as Record<string, string>,

  /** Open/load error codes. */
  loadErrors: {
    "read-failed": "The file could not be read.",
    "too-large": "The file is too large.",
    "invalid-json": "This is not a valid project file (invalid JSON).",
    "too-deep": "The file is nested too deeply.",
    "too-many-values": "The file contains too many values.",
    "forbidden-key": "The file contains a forbidden key and was not opened.",
    "not-a-project": "This is not a GameDevTool project file.",
    "unsupported-version": "This project was saved by a newer version of GameDevTool.",
    "missing-migration": "This project's schema version cannot be upgraded.",
    "migration-failed": "Upgrading this project failed.",
    schema: "The project file is damaged or invalid.",
    "no-project": "This folder does not contain a GameDevTool project (gamedevtool.json is missing).",
    "too-many-files": "The folder contains too many asset files.",
    "asset-file-mismatch": "An asset file's name does not match the asset id inside it (was it copied or renamed?).",
  } as Record<string, string>,
  inFile: (file: string) => `File: ${file}`,
  openFailed: (reason: string) => `Could not open the file. ${reason}`,
  openFolderFailed: (reason: string) => `Could not open the folder. ${reason}`,

  saveErrors: {
    permission: "Permission to write to the folder was denied.",
    "duplicate-id": "Two assets share the same ID, so they cannot be saved as separate files. Fix the duplicate ID first.",
    failed: (file: string, message: string) => `Could not write ${file || "the folder"} (${message}). Files written so far are kept; save again to retry.`,
    folderUnavailable: (message: string) => `The folder could not be accessed (${message}).`,
  },
};

export type UiStrings = typeof en;
