/**
 * All user-facing UI text lives in string tables, never inline in components.
 * English is the source table; others (e.g. Turkish) are added in Phase 6 and must
 * satisfy the same `UiStrings` shape. Core returns codes (issue codes, change labels,
 * error codes); this file turns them into text.
 */
const EXPR_TYPE_NAMES: Readonly<Record<string, string>> = { bool: "true/false", number: "a number", string: "text" };

export const en = {
  appName: "GameDevTool",
  version: (v: string) => `Version ${v}`,
  privacyNote: "Your data stays on this device. This app makes no network requests.",
  skipToContent: "Skip to content",

  untitledProject: "Untitled project",
  untitledDocument: "Untitled document",
  untitledTable: "Untitled table",
  untitledProduction: "Production chain",
  productionTableNames: { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Production chain" },
  exampleProductionNames: { items: "Items", machines: "Machines", recipes: "Recipes", graph: "Example: Iron sword" },

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

  crash: {
    title: "Something went wrong",
    body: "The app hit an unexpected error and stopped to protect your data. Unsaved changes are kept in the recovery cache; reload to restore them.",
    reload: "Reload",
    details: "Error details",
  },

  recovery: {
    found: (name: string, when: string) => `Unsaved changes to "${name}" from ${when} were found.`,
    restore: "Restore",
    discard: "Discard",
  },

  assets: {
    heading: "Assets",
    listLabel: "Assets",
    empty: "No assets yet. Add a document, a table or a production chain.",
    addDocument: "New document",
    addTable: "New table",
    addProduction: "New production chain",
    addExample: "Example chain",
    kind: { document: "Document", table: "Table", "production-graph": "Chain" } as Record<string, string>,
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
    } as Record<string, string>,
  },

  variables: {
    heading: "Variables",
    hint: "Flags, counters and quest states. Gates and unlock conditions refer to them by name, e.g. Level >= 5 and HasForge.",
    empty: "No variables yet.",
    /** Bool values as written in expressions (shown in the start value picker). */
    boolValues: { false: "false", true: "true" },
    add: "Add variable",
    defaultName: "NewVariable",
    search: "Search variables",
    moreHidden: (n: number) => `${n} more not shown. Use the search.`,
    name: "Name",
    nameInvalid: "Use letters, digits and _ (not starting with a digit), unique, not and/or/not/true/false.",
    type: "Type",
    types: { bool: "Yes/No", int: "Integer", float: "Number", string: "Text", enum: "Choice (enum)" } as Record<string, string>,
    defaultValue: "Start value",
    options: "Options (comma-separated)",
    optionsInvalid: "Enter unique option names: letters, digits and _.",
    remove: (name: string) => `Delete variable ${name}`,
  },

  issues: {
    heading: "Validation",
    none: "No problems found.",
    count: (n: number) => `${n} ${n === 1 ? "problem" : "problems"}`,
    moreHidden: (n: number) => `${n} more not shown.`,
    capped: (n: number) => `Only the first ${n} problems of each kind are listed.`,
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
      "duplicate-stack-item": "The same item is listed twice",
      "role-column-missing": "A built-in column is missing",
      "role-column-type": "A built-in column has the wrong type",
      "role-mismatch": "Points to a table of the wrong kind",
      "role-items-mismatch": "Recipe inputs and outputs use different item tables",
      "graph-items-mismatch": "The chain's items table differs from its recipes' items table",
      "edge-node-missing": "Connection to a node that does not exist",
      "edge-self": "Connection from a node to itself",
      "duplicate-edge": "Duplicate connection",
      "port-mismatch": "Connection carries an item the node does not take or make",
      "recipe-time-invalid": "Recipe has no valid cycle time",
      "recipe-no-outputs": "Recipe has no outputs",
      "input-unconnected": "Input is not connected",
      "loop-without-source": "Loop with no source",
      unreachable: "No source reaches this node",
      "gate-condition-empty": "Gate has no condition",
      "used-before-unlocked": "Recipe can be unlocked before one of its inputs",
      "scenario-unknown-variable": "Scenario value for a variable that does not exist",
      "scenario-type-mismatch": "Scenario value does not fit its variable",
      "calculator-recipe-mismatch": "Rate calculator: the chosen recipe no longer makes this item",
      "stack-tag-not-allowed": "Tags (#Tag) are only allowed in recipe inputs",
      "tag-no-items": "No item has this tag",
      "tag-invalid": "Item tags must be an identifier (letters, digits, _), or no recipe input can use them",
      "group-missing": "Refers to a group that does not exist",
      "group-cycle": "Group is inside itself",
      "group-too-deep": "Groups are nested too deeply",
      "group-empty": "Group contains no nodes",
      "reserved-name": "Name is a reserved word (and, or, not, true, false)",
      "expr-empty": "Expression is empty",
      "expr-too-long": "Expression is too long",
      "expr-too-deep": "Expression is nested too deeply",
      "expr-unexpected-char": "Expression contains an invalid character",
      "expr-unterminated-string": "Text in quotes is not closed",
      "expr-bad-escape": "Unknown escape sequence in text",
      "expr-bad-number": "Invalid number",
      "expr-unexpected-token": "Expression syntax error",
      "expr-expected": "Expression syntax error",
      "expr-chained-comparison": "Comparisons cannot be chained",
      "expr-unknown-name": "Unknown variable in expression",
      "expr-unknown-function": "Unknown function in expression",
      "expr-arg-count": "Wrong number of function arguments",
      "expr-type": "Expression has the wrong type",
      "expr-unknown-option": "Unknown enum option in expression",
    } as Record<string, string>,
  },

  /** Expression language messages (docs/EXPRESSIONS.md). */
  expression: {
    at: (position: number) => `(at character ${position})`,
    noVariables: "No project variables yet. Conditions can only use constants.",
    variables: (names: string, more: number) => `Variables: ${names}${more > 0 ? ` and ${more} more` : ""}`,
    message(code: string, p: Readonly<Record<string, string | number>>): string {
      const typeName = (t: string | number | undefined) => {
        const name = String(t ?? "");
        return name.startsWith("enum ") ? `a ${name.slice(5)} value` : (EXPR_TYPE_NAMES[name] ?? name);
      };
      switch (code) {
        case "expr-empty":
          return "Enter a condition.";
        case "expr-too-long":
          return `The expression is longer than ${p.limit} characters.`;
        case "expr-too-deep":
          return `The expression is nested more than ${p.limit} levels deep.`;
        case "expr-unexpected-char":
          return `"${p.char}" is not allowed here.`;
        case "expr-unterminated-string":
          return "The text in quotes is missing its closing quote.";
        case "expr-bad-escape":
          return 'Unknown escape. Use \\, \", \n or \t.';
        case "expr-bad-number":
          return "This is not a valid number.";
        case "expr-unexpected-token":
          return p.found === "" ? "The expression ends too early." : `"${p.found}" is not expected here.`;
        case "expr-expected":
          return `"${p.expected}" is missing.`;
        case "expr-chained-comparison":
          return "Comparisons cannot be chained. Use and: a < b and b < c.";
        case "expr-unknown-name":
          return `There is no variable named ${p.name}.`;
        case "expr-unknown-function":
          return `There is no function named ${p.name}.`;
        case "expr-arg-count":
          return p.min === p.max
            ? `${p.name}() takes ${p.min} ${p.min === 1 ? "argument" : "arguments"}.`
            : p.max === -1
              ? `${p.name}() takes at least ${p.min} ${p.min === 1 ? "argument" : "arguments"}.`
              : `${p.name}() takes at most ${p.max} arguments.`;
        case "expr-type":
          return `Expected ${typeName(p.expected)}, found ${typeName(p.found)}.`;
        case "expr-unknown-option":
          return `${p.enum} has no option "${p.value}".`;
        case "expr-division-by-zero":
          return "Division by zero.";
        case "expr-not-finite":
          return "The result is too large or not a number.";
        default:
          return code;
      }
    },
  },

  /** Change labels from core (history entries). */
  changes: {
    "rename-project": "rename project",
    "rename-asset": "rename asset",
    "add-document": "add document",
    "add-table": "add table",
    "remove-asset": "delete asset",
    "add-production-graph": "add production chain",
    "add-node": "add node",
    "edit-node": "edit node",
    "move-nodes": "move nodes",
    "auto-layout": "auto layout",
    connect: "connect",
    "edit-connection": "edit connection",
    "remove-graph-elements": "delete nodes",
    "add-row": "add row",
    "remove-rows": "delete row",
    "rename-row": "rename row",
    "edit-cell": "edit cell",
    "edit-cells": "edit cells",
    "paste-cells": "paste",
    "clear-cells": "clear cells",
    "fill-down": "fill down",
    "add-column": "add column",
    "rename-column": "rename column",
    "remove-column": "delete column",
    "import-rows": "import CSV",
    "add-variable": "add variable",
    "remove-variable": "delete variable",
    "edit-variable": "edit variable",
    "rename-variable": "rename variable",
    "edit-scenario": "edit scenario",
    "reset-scenario": "reset scenario",
    "edit-calculator": "edit rate calculator",
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

  production: {
    canvasLabel: "Production chain canvas",
    mode: "Calculation",
    modeTarget: "Target-driven",
    modeTargetHint: "Sink rates are targets; shows what the chain needs",
    modeSupply: "Supply-driven",
    modeSupplyHint: "Source rates are fixed; shows what the chain can make",
    autoLayout: "Auto layout",
    fitView: "Fit view",
    library: "Library",
    search: "Search",
    recipesHeading: "Recipes",
    itemsHeading: "Items",
    libraryHint: "Click to add, or drag onto the canvas.",
    addSource: "Source",
    addSink: "Sink",
    addStorage: "Storage",
    addSplitter: "Splitter",
    addMerger: "Merger",
    addGate: "Gate",
    noTables: "This chain's Items or Recipes table is missing.",
    nodeType: {
      source: "Source",
      recipe: "Recipe",
      storage: "Storage",
      sink: "Sink",
      splitter: "Splitter",
      merger: "Merger",
      gate: "Gate",
      group: "Sub-chain",
    } as Record<string, string>,
    group: "Group",
    groupHint: "Put the selected nodes into a sub-chain (Ctrl+G)",
    groupMixedHint: "Select nodes that are in the same sub-chain",
    ungroup: "Ungroup",
    ungroupHint: "Dissolve the selected sub-chain; its nodes stay (Ctrl+Shift+G)",
    collapse: "Collapse",
    expand: "Expand",
    collapseHint: (name: string) => `Collapse ${name} into one node`,
    expandHint: (name: string) => `Expand ${name} to show its nodes`,
    groupDefault: (n: number) => `Sub-chain ${n}`,
    fieldGroupName: "Name",
    groupNodes: (n: number) => `${n} ${n === 1 ? "node" : "nodes"}`,
    anyTag: (tag: string) => `Any ${tag}`,
    unknownItem: "(missing item)",
    unknownRecipe: "(missing recipe)",
    perUnit: { second: "/s", minute: "/min", hour: "/h" } as Record<string, string>,
    unitName: { second: "per second", minute: "per minute", hour: "per hour" } as Record<string, string>,
    machines: (n: string, whole: number) => `${n} machines (build ${whole})`,
    deficit: (rate: string) => `Deficit ${rate}`,
    surplus: (rate: string) => `Surplus ${rate}`,
    bottleneck: "Bottleneck",
    limitedBy: (what: string) => `Limited by ${what}`,
    limitMachines: "machine count",
    reportMoreHidden: (n: number) => `${n} smaller ${n === 1 ? "entry" : "entries"} not shown.`,
    notConverged: "The calculation did not settle: a loop produces more than it consumes.",
    inspector: "Selected",
    inspectorEmpty: "Select a node, sub-chain or connection to edit it.",
    fieldItem: "Item",
    fieldRecipe: "Recipe",
    fieldRate: (unit: string) => `Rate (${unit})`,
    fieldTarget: (unit: string) => `Target rate (${unit}, empty = none)`,
    fieldMachines: "Built machines (empty = unlimited)",
    fieldCapacity: "Capacity (empty = unlimited)",
    fieldCondition: "Unlock condition",
    scenario: "Scenario",
    scenarioHint: "Variable values to calculate with, saved with this chain. Start values stay unchanged.",
    scenarioChanged: (name: string) => `${name} (changed)`,
    scenarioReset: "Reset to start values",
    allGatesOpen: "Treat all gates as open",
    lockedCount: (n: number) => `${n} locked`,
    gateOpen: "Open",
    gateClosed: "Closed",
    gateError: "Condition invalid: closed",
    recipeLocked: "Locked",
    fieldDistribution: "Monte Carlo",
    distributionFixed: "Fixed rate",
    distributionPoisson: "Random arrivals (Poisson)",
    fieldRatio: "Share (relative weight)",
    deleteSelected: "Delete selected",
    report: "Report",
    rawResources: "Raw resources",
    machineCounts: "Machines",
    targets: "Output",
    noFlow: "Nothing flows yet. Connect a source to a recipe and a sink.",
    bom: (item: string) => `Bill of materials for 1 ${item}`,
    bomTruncated: (rows: number) => `Only the first ${rows} items are listed; the chain is larger.`,
    firstUnit: (seconds: string) => `Time to first unit: ${seconds} s`,
    cycle: "(loop)",
    simulate: "Simulate",
    simulateHint: "Monte Carlo: random outputs and sources, per hour",
    simulating: (done: number, total: number) => `Simulating… ${done} / ${total}`,
    cancel: "Cancel",
    simNoRandomness: "Nothing in this chain is random; the steady-state numbers are exact.",
    simResult: (runs: number) => `Monte Carlo, ${runs} runs, per hour`,
    simInterrupted: "The simulation was interrupted (the tab was hidden, or it failed). Run it again.",
    simUnconverged: (count: number, runs: number) => `${count} of ${runs} runs did not settle (a loop amplifies itself); their numbers are approximate.`,
    simColumns: { sink: "Sink", p10: "P10", p50: "P50", p90: "P90", mean: "Mean" },
    simChartSink: "Distribution of",
    simChartX: "Items per hour",
    simChartY: "Runs",
    simChartLabel: (sink: string, p10: string, p50: string, p90: string) => `Distribution of ${sink} per hour: P10 ${p10}, P50 ${p50}, P90 ${p90}`,
    simChartHint: "Dashed lines: P10, P50, P90.",
    view: "View",
    viewCanvas: "Canvas",
    viewCalculator: "Rate calculator",
    calculator: "Rate calculator",
    calcHint: "Pick an item and a rate to see every upstream item, recipe and machine. Uses the recipe data only, not the canvas. Saved with this chain.",
    calcItems: "Items",
    calcTarget: (item: string) => `Making: ${item}`,
    calcNoTarget: "Pick an item to plan for.",
    calcRate: (unit: string) => `Rate (${unit})`,
    calcLines: "Needed",
    calcRecipeFor: (item: string) => `Recipe for ${item}`,
    calcDefault: (recipe: string) => `${recipe} (first recipe)`,
    calcRaw: "Raw resource",
    calcRawFrom: "Raw resource (no recipe)",
    calcMachines: (n: string, whole: number) => `${n} machines (${whole})`,
    calcChanged: (n: number) => `${n} recipe ${n === 1 ? "choice" : "choices"} changed`,
    calcReset: "Reset recipe choices",
    calcRawTotal: "Raw resources",
    calcAlternatives: (n: number) => `${n} recipes`,
  },

  tables: {
    addRow: "Add row",
    addColumn: "Add column",
    columnName: "New column name",
    columnType: "Type",
    rowName: "Name",
    deleteRow: (name: string) => `Delete row ${name}`,
    deleteColumn: (name: string) => `Delete column ${name}`,
    builtIn: "Built-in column",
    importCsv: "Import CSV…",
    exportCsv: "Export CSV",
    format: "CSV format",
    formats: { generic: "Generic (JSON cells)", unreal: "Unreal DataTable" } as Record<string, string>,
    rowsCount: (n: number) => `${n} ${n === 1 ? "row" : "rows"}`,
    empty: "No rows yet. Add a row, or paste rows from a spreadsheet.",
    deleteSelectedRow: "Delete row",
    deleteSelectedRows: (n: number) => `Delete ${n} rows`,
    fillDown: "Fill down",
    fillDownHint: "Copies the first selected row into the selected rows below it (Ctrl+D). With one row selected, copies the row above.",
    rowActions: "Row actions",
    clipboardArea: "Clipboard",
    confirmDeleteRows: (n: number, used: number) =>
      `Delete ${n} ${n === 1 ? "row" : "rows"}?${used > 0 ? ` They are used in ${used} ${used === 1 ? "place" : "places"}, which will be left broken.` : ""} You can undo this.`,
    gridHelp: "Arrows move, Shift+arrows select. Enter, F2 or typing edits; Ctrl+Enter writes the edit into every selected cell. Space toggles Yes/No. Delete clears, Ctrl+D fills down, Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste with spreadsheets.",
    pasted: (invalid: number, skipped: number) =>
      [
        invalid > 0 ? `${invalid} pasted ${invalid === 1 ? "value does" : "values do"} not fit ${invalid === 1 ? "its column" : "their columns"} and ${invalid === 1 ? "was" : "were"} left out.` : "",
        skipped > 0 ? `${skipped} ${skipped === 1 ? "value had" : "values had"} no cell to go to.` : "",
      ]
        .filter((t) => t !== "")
        .join(" "),
    pastedRows: (n: number) => `Added ${n} ${n === 1 ? "row" : "rows"}.`,
    tooManyCells: (limit: number) => `Too many cells at once (at most ${limit.toLocaleString("en")}). Select a smaller range.`,
    yes: "Yes",
    no: "No",
    noValue: "–",
    invalidValue: "Invalid value",
    curveSummary: (n: number) => `${n} keys`,
    stacksHint: "e.g. IronOre*2, Slag*1@0.1, #Fuel*1 (any item tagged Fuel)",
    listHint: "Comma-separated",
    imported: (rows: number, removed: number, problems: number) =>
      `Imported ${rows} ${rows === 1 ? "row" : "rows"}${removed > 0 ? `, removed ${removed}` : ""}${problems > 0 ? `; ${problems} ${problems === 1 ? "cell" : "cells"} could not be read` : ""}.`,
    spreadsheetSafe: "Spreadsheet-safe text",
    spreadsheetSafeHint: "Marks text that starts with = + - or @ with a leading ' so Excel and Sheets do not run it as a formula. Leave off for engine import.",
    confirmDeleteRow: (name: string, used: number) => `${name} is used in ${used} ${used === 1 ? "place" : "places"}. Deleting it breaks ${used === 1 ? "that reference" : "those references"}. You can undo this. Delete anyway?`,
    importFailed: (reason: string) => `Could not import the CSV (${reason}).`,
    confirmImport: (removed: number) => `${removed} ${removed === 1 ? "row is" : "rows are"} not in the CSV and will be removed. You can undo this. Continue?`,
    kinds: {
      int: "Integer",
      float: "Number",
      string: "Text (plain)",
      bool: "Yes/No",
      text: "Text (localizable)",
      enum: "Choice (enum)",
      reference: "Row of a table",
      list: "List",
      stacks: "Item amounts",
    } as Record<string, string>,
    listOf: "List of",
    enumOptions: "Options (comma-separated)",
    enumOptionsPlaceholder: "Common, Rare, Epic",
    targetTable: "Target table",
    noTables: "No table to point to yet.",
    specErrors: {
      "enum-empty": "Enter at least one option.",
      "enum-invalid-name": "Option names start with a letter or _ and use letters, digits and _ (at most 64).",
      "enum-duplicate": "Option names must be unique.",
      "enum-too-many": "Too many options (at most 1000).",
      "table-missing": "Pick a table.",
    } as Record<string, string>,
    specErrorName: (message: string, name: string) => `${message} (${name})`,
    kindLabel: {
      int: "int",
      float: "float",
      string: "string",
      bool: "bool",
      enum: "enum",
      reference: "reference",
      text: "text",
      curve: "curve",
      list: "list",
      stacks: "items",
    } as Record<string, string>,
  },

  saveErrors: {
    permission: "Permission to write to the folder was denied.",
    "duplicate-id": "Two assets share the same ID, so they cannot be saved as separate files. Fix the duplicate ID first.",
    failed: (file: string, message: string) => `Could not write ${file || "the folder"} (${message}). Files written so far are kept; save again to retry.`,
    folderUnavailable: (message: string) => `The folder could not be accessed (${message}).`,
  },
};

export type UiStrings = typeof en;
