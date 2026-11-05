# CSV Import / Export

Tables export to CSV (or TSV) and import back. The converter is **engine-neutral**: it
turns every cell into a neutral value, and a **format** decides how those values are
written as text. Adding an engine means adding a format in
[`src/core/export/csv-formats.ts`](../src/core/export/csv-formats.ts), not touching the
converter.

## Layout (all formats)

- First column: the row name (an identifier, unique per table, case-insensitive).
- One column per table column, headed by the column name.
- RFC 4180 quoting, UTF-8, `\n` line endings. Import also accepts CRLF and a BOM.

## Neutral values

| Column type | Neutral value |
|---|---|
| int, float, string | as is |
| bool | boolean |
| enum | option name |
| reference | name of the referenced row |
| list | array of the above |
| stacks (item amounts) | array of `{ item, count, chance? }` (item = row name); a tag input ("any Fuel") is `{ tag, count }` |
| curve | array of `{ x, y }` |
| text (localizable) | source text; the format decides whether the key is written |

## Formats

| | `generic` (default) | `unreal` |
|---|---|---|
| Use | Unity, Godot, custom engines, spreadsheets, scripts | Unreal DataTable import |
| Row name header | `Name` | `---` |
| Booleans | `true` / `false` | `True` / `False` |
| Lists, stacks, curves | JSON: `[{"item":"IronOre","count":2}]` | Struct text: `((Item="IronOre",Count=2))` |
| Tag inputs | `{"tag":"Fuel","count":1}` | `(Tag="Fuel",Count=1)`: give the stack USTRUCT an `FName Tag` next to `Item`; on import an empty `Item` next to a `Tag` is ignored |
| Localizable text | source text (keys travel in the localization export) | `NSLOCTEXT("<table>", "<key>", "<source>")` |

## Import rules

- The first column is the row name, whatever its header.
- Columns are matched by header name, case-insensitively; unknown headers are reported
  and ignored. Columns missing from the file keep their current values.
- Record fields match case-insensitively (`Item`, `item`); a missing `count` means 1.
- Rows whose name already exists keep their id, so references and Git diffs stay stable.
  Existing rows that are not in the file are removed (the app asks first; undo works).
- Cells that cannot be read are reported with their line and column and left empty.
- Imports are one undo step.

## Spreadsheet-safe text (optional)

Excel and Google Sheets run a cell as a formula when its text starts with `=`, `+`, `-` or
`@` (or a tab or carriage return). A project from an untrusted source could use that in a
string or text cell, so the table toolbar has a **Spreadsheet-safe text** switch, off by
default.

- On export, string and text cells that start like that get a leading `'`, which the
  spreadsheet shows as plain text. Number columns are not touched: `-5` stays `-5`.
- A cell that already starts with `'` followed by such a character gets one more `'`, so
  the round trip is lossless: `=x` ↔ `'=x`, `'=x` ↔ `''=x`.
- On import with the switch on, exactly one leading `'` is removed again in those cells.
- It is off by default because engines importing the CSV would see the extra `'`, and
  text like `+10% speed` is legitimate game data. Turn it on only for files you open in a
  spreadsheet.
