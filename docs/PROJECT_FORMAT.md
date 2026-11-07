# Project Format

A project is stored in one of two equivalent forms. Both hold the same data, and both
are validated against [`schema/project.v1.schema.json`](../schema/project.v1.schema.json).

| Form | Use | Browsers |
|---|---|---|
| **Project file** (`.json`) | Save / Open, sharing, backups | All |
| **Project folder** | Working with Git: one file per asset | Chromium desktop (File System Access API) |

All JSON is written deterministically: keys sorted, 2-space indent, `\n` line endings,
trailing newline. Saving the same data always produces the same bytes.

## Project file

One JSON document: `{ "manifest": { … }, "assets": [ … ] }`.

- **Extension: `.json`**, so every OS and editor treats it as plain text. The content
  identifies a project (`manifest.format` is `"gamedevtool.project"`), never the name.
- **Name:** the project name, made safe for every file system: characters Windows forbids
  become `_`, and Windows device names (`CON`, `NUL`, `COM1`, `CONIN$`, …) get `_` after
  them (`CON` → `CON_.json`). Long names are cut to 100 UTF-16 units and 200 UTF-8 bytes
  at a character boundary, so an emoji is never split. It is never `gamedevtool.json`
  (that name gets a `-project` suffix), so a downloaded project cannot pass for a folder
  manifest.
- **Legacy `.gdtproj`:** the extension used before 2026-11. Such files still open (the
  content is the same); saving one writes `.json`.
- **Mix-ups are reported:** opening a folder's `gamedevtool.json` as a project file, or a
  folder whose `gamedevtool.json` is a whole project file, fails with a message that says
  which one it is. Exports (CSV now, JSON later) are never project files.

## Production data

The Production Chain Editor stores its data in ordinary assets:

- **Table roles.** A table can have a `role` (`items`, `recipes`, `machines`) that maps
  meanings to column ids, e.g. `{ "kind": "recipes", "inputs": "<col>", "outputs": "<col>",
  "time": "<col>", "machine": "<col>" }`. Columns can be renamed and extra columns added
  freely; validation checks that each mapped column exists and has a suitable type.
- **`stacks` columns** hold item amounts: `[{ "item": "<row id>", "count": 2, "chance": 0.1 }]`.
  `chance` (0–1, default 1) marks by-products and rare outputs. A recipe input can name a
  tag instead of an item, `{ "tag": "Fuel", "count": 1 }` ("any item tagged Fuel"; tags are
  identifiers, matched case-insensitively against the items table's tags column). Tags are
  only allowed in the recipes table's inputs column. Connections still carry one concrete
  item: it goes into the node's port for that item, else into the first tag port it fits.
  Adding tag stacks was backward compatible (schema version 1).
- **`production-graph` assets** name their items and recipes tables and hold `nodes`
  (source, recipe, storage, sink, splitter, merger, gate; each with a position) and
  `edges` (`source`, `target`, `item`, optional `ratio`). Rates are stored in items per
  second; the project's `rateUnit` setting only changes the display.
- **Conditions** (gate node `condition`, the recipe role's `gate` column) are stored as
  source text in the [expression language](EXPRESSIONS.md). They refer to
  `manifest.variables` by name; enum variables store option ids.
- **`scenario`** (optional, on `production-graph` assets): what-if values the chain is
  calculated with, `{ "values": { "<variable id>": 5 }, "allOpen": true }`. Variables not
  listed use their start value; enum values are option ids. Deleting a variable or changing
  its type removes values that no longer fit. Engine exports ignore it. Adding the field was
  backward compatible (schema version 1).

- **`calculator`** (optional, on `production-graph` assets): rate calculator settings,
  `{ "target": "<item row id>", "rate": 0.0167, "recipes": { "<item row id>": "<recipe row id>" } }`.
  `rate` is in items per second. `recipes` picks the recipe that makes an item when several
  recipes output it; items not listed use the first such recipe (table order). The ids are
  indexed as references ("used by", broken links); a choice whose recipe no longer outputs
  its item is a warning and is ignored. Unset keys and an empty object are left out.
  Engine exports ignore it. Adding the field was backward compatible (schema version 1).

- **`groups`** (optional, on `production-graph` assets): sub-chains,
  `[{ "id": "<ULID>", "label": "Smelting", "parent": "<group id>", "collapsed": true }]`.
  A node joins a group with its optional `group` field. Groups nest through `parent` (at
  most 16 levels) and only change how the chain is drawn: the calculation and engine
  exports use the flat node list. The field is left out when a chain has no groups, and an
  expanded group stores no `collapsed` field. Adding it was backward compatible (schema
  version 1).

Adding these kinds was backward compatible: schema version 1 files stay valid.

Tables export to engine-neutral CSV; see [CSV.md](CSV.md).

## Column formulas

A column can carry a `formula` (expression source text, at most 10 000 characters):
`{ "id": "<ULID>", "name": "Damage", "type": { "kind": "float" }, "formula": "Base * (1 + Level * 0.1)" }`.
Only `int`, `float`, `string` and `bool` columns use it, and not columns a table role uses.
The cells of a formula column are computed and **not stored**: rows hold no key for it.
Stored values left in a formula column (for example after a hand edit) are ignored and
reported as a warning. Formulas name columns and variables by name; renames in the app
rewrite them. See [EXPRESSIONS.md](EXPRESSIONS.md#table-formulas). Adding the field was
backward compatible (schema version 1).

## Project folder

    MyGame/
      gamedevtool.json            the manifest object (format, schemaVersion, name, settings,
                                  variables, characters)
      assets/
        01JC3…ZK.json             one asset object per file, named by its ULID
        01JC3…ZM.json

- **File names are asset ids**, never asset names, so renaming an asset changes one line
  in one file and never renames a file.
- **Asset order** is id order (ULIDs sort by creation time). There is no index file, so
  adding assets on two branches does not conflict.
- **Everything else is ignored** and never modified: `.git`, READMEs, engine exports,
  and any file in `assets/` whose name is not `<ULID>.json`.
- A file whose name does not match the `id` inside it (for example a copied file) stops
  the folder from opening, because two assets would share an id.

### Saving

- Only assets that changed since the last save are written; deleted assets have their
  file removed. The manifest is written last.
- Each file is replaced atomically. If a save is interrupted, the project stays marked
  "unsaved" and the next save writes the remaining files.
- Before writing, the app checks whether the files it is about to replace were changed
  by another program (for example `git pull`) since it read or wrote them, and asks before
  overwriting. Outside changes to files it is not writing are not detected; reopen the
  folder to load them.
- Files that open correctly but are not in canonical form (hand-edited, merged, or with
  unknown keys) are rewritten in canonical form on the next save. CRLF line endings alone
  do not count as a change.

### Opening

The folder is untrusted input, exactly like a project file. The size, nesting and value
limits apply to the folder as a whole, measured as if it were one project file. The size
limit (64 MiB) is checked in bytes on disk before any file is read, so non-ASCII text can
hit it a little earlier than its character count alone would. Errors name the file they
occurred in, so a merge conflict left in a file is easy to find.

### Git tips

- Commit the whole folder. Nothing in it is generated or machine-specific.
- Recommended `.gitattributes` line, so line endings never cause diffs:

      *.json text eol=lf

### Why folder access is not remembered

The app does not store the folder handle between sessions. When the app runs from a
local file, Chrome gives every local HTML file the same storage area, so another local
page could pick up the handle. The folder picker reopens in the last-used location instead.
