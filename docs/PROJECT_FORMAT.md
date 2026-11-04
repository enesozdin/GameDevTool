# Project Format

A project is stored in one of two equivalent forms. Both hold the same data, and both
are validated against [`schema/project.v1.schema.json`](../schema/project.v1.schema.json).

| Form | Use | Browsers |
|---|---|---|
| **Project file** (`.gdtproj`) | Save / Open, sharing, backups | All |
| **Project folder** | Working with Git: one file per asset | Chromium desktop (File System Access API) |

All JSON is written deterministically: keys sorted, 2-space indent, `\n` line endings,
trailing newline. Saving the same data always produces the same bytes.

## Project file

One JSON document: `{ "manifest": { … }, "assets": [ … ] }`.

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

The folder is untrusted input, exactly like a `.gdtproj`. The size, nesting and value
limits apply to the folder as a whole, measured as if it were one project file. Errors
name the file they occurred in, so a merge conflict left in a file is easy to find.

### Git tips

- Commit the whole folder. Nothing in it is generated or machine-specific.
- Recommended `.gitattributes` line, so line endings never cause diffs:

      *.json text eol=lf

### Why folder access is not remembered

The app does not store the folder handle between sessions. When the app runs from a
local file, Chrome gives every local HTML file the same storage area, so another local
page could pick up the handle. The folder picker reopens in the last-used location instead.
