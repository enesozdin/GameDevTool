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
    save: "Save",
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
    migrated: (from: number, to: number) => `Upgraded from schema version ${from} to ${to}. Save to keep the upgrade.`,
    recovered: "Recovered unsaved changes. Save to keep them.",
  },

  confirm: {
    discardChanges: "Discard unsaved changes?",
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
  } as Record<string, string>,
  openFailed: (reason: string) => `Could not open the file. ${reason}`,
};

export type UiStrings = typeof en;
