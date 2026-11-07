# Browser Test Matrix

Storage and file APIs behave differently per browser, and differently again when the app
runs from a local file (`file://`) instead of a static host. This matrix records what was
verified. See [ROADMAP.md](ROADMAP.md) §2.4 and §6.

Legend: ✅ verified working · ❌ verified not available · ⏳ not yet tested ·
➖ not applicable

## How to test

1. `npm run build`, then use `dist/GameDevTool.html`.
2. **Offline file:** open the file directly (double-click or drag into the browser).
3. **Hosted:** serve `dist/` from any static server on `localhost` (a secure context).
4. Open DevTools and keep the console visible: there must be **no CSP violation** other
   than the deliberate check in step "Network blocked".
5. Go through every row below and record the result, the browser version and the date.

| # | Check | How |
|---|---|---|
| 1 | App renders | Title, toolbar and empty asset list appear |
| 2 | Network blocked | Console: `fetch("https://example.com")` rejects with a CSP error |
| 3 | No CSP violations | Console shows none after steps 4–9 |
| 4 | Save (download) | Add an asset, Ctrl/⌘+S → `.json` downloads (before 2026-11-07: `.gdtproj`), status shows "Saved" |
| 5 | Open file | Open… → pick the downloaded file → assets are back |
| 6 | Crash recovery | Edit, wait 2 s, reload → "Restore" banner → Restore brings the edit back |
| 7 | Recovery after moving the file | Move/rename the HTML file, open it → is the banner still there? (expected to differ per browser) |
| 8 | `navigator.storage.persist()` | Not implemented yet (planned together with a backup reminder) |
| 9 | Folder mode | "Open folder…" visible; "Save to folder…" into an empty folder → `gamedevtool.json` + `assets/*.json` written; edit one asset + save → one file rewritten; reopen → round-trips |
| 10 | Folder mode, external change | With the folder open, edit an asset file from outside, then edit the same asset in the app and save → "changed outside GameDevTool" confirmation appears |
| 11 | Touch | Buttons ≥ 44 px, no hover-only UI, layout fits a 360 px wide screen |
| 12 | Keyboard only | Tab reaches skip link, toolbar, asset list, details; focus ring always visible; arrow keys + Enter select in the asset list |
| 13 | Production chain + worker | "Example chain" → canvas shows 6 nodes with rates; Supply-driven marks MineIronOre as bottleneck; Simulate finishes with a P10/P50/P90 table (Web Worker from a Blob URL, no CSP violation) |
| 14 | CSV round trip | Recipes table → Export CSV (both formats) → Import CSV of the same file → no changes, no problems reported |

## Results

### Desktop

| Check | Chromium 153 file | Chromium 153 hosted | Chrome / Edge (stable) | Firefox file | Firefox hosted | Safari file | Safari hosted |
|---|---|---|---|---|---|---|---|
| 1 App renders | ✅ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 2 Network blocked | ✅ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 3 No CSP violations | ✅ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 4 Save (download) | ✅ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 5 Open file | ✅ | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 6 Crash recovery | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 7 Recovery after move | ⏳ | ➖ | ⏳ | ⏳ | ➖ | ⏳ | ➖ |
| 8 `storage.persist` | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| 9 Folder mode | API present, picker ⏳ | ✅ (picker simulated) | ⏳ | ❌ expected | ❌ expected | ❌ expected | ❌ expected |
| 10 External change | ⏳ | ✅ (picker simulated) | ⏳ | ➖ | ➖ | ➖ | ➖ |
| 11 Touch | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| 12 Keyboard only | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 13 Production chain + worker | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 14 CSV round trip | ⏳ (core tests ✅) | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

### Mobile (hosted mode only, see ROADMAP §6)

| Check | iOS Safari | Android Chrome |
|---|---|---|
| 1–3 | ⏳ | ⏳ |
| 4 Save via share sheet / download | ⏳ | ⏳ |
| 5 Open file | ✅ | ✅ |
| 6 Crash recovery | ⏳ | ⏳ |
| 8 `storage.persist` | ➖ | ➖ |
| 9 Folder mode | ❌ expected | ❌ expected |
| 11 Touch | ⏳ | ⏳ (Pixel 7 emulation ✅) |

## Notes

- **2026-11-07, Chromium (headless, Playwright outside the repo), file://:** checks 4 and
  5 with the `.json` extension: the picker accepts `.json,.gdtproj,application/json`; a
  legacy `.gdtproj` opens and Save downloads it as `.json` with identical content; the
  `.json` download opens again; a project named "GameDevTool" downloads as
  `GameDevTool-project.json`; a folder's `gamedevtool.json` picked with Open… shows the
  folder-manifest message and leaves the open project as it was. Also verified: the
  issues panel with 3,000 capped issues (badge, 100 listed, hidden count, capped note) and
  the row/table delete confirmations against the reference index, including after cell
  edits, undo and redo.

- **2026-11-05, Chromium (headless, Playwright outside the repo), file://:** check 13:
  example chain renders 6 nodes with rate labels, supply-driven mode marks MineIronOre as
  the bottleneck, the Monte Carlo worker starts from a Blob URL and returns P10/P50/P90
  (Slag 78 / 90 / 101 per hour). Table cell edit + Ctrl+Z works. Zero console messages,
  so no CSP violations.

- **2026-11-04, Chromium 153 (Chrome for Testing), headless, automated with the
  pre-installed Playwright 1.63 outside the repo** (Playwright is not a project
  dependency, see DEPENDENCIES.md):
  - `file://` is a secure context in Chromium and `showDirectoryPicker` is exposed, so
    the "Open folder…" button appears. The native picker cannot be driven headless:
    checking it from a local file with a real folder is still open (row 9, file).
  - The Origin Private File System (`navigator.storage.getDirectory()`) throws
    `SecurityError` on `file://`. The app does not use it.
  - Folder mode was verified on `http://127.0.0.1` with the picker replaced by an
    OPFS directory (same `FileSystemDirectoryHandle` API): first save writes
    `gamedevtool.json` + one file per asset, renaming an asset rewrites exactly one file,
    deleting an asset deletes its file, saving without changes writes nothing, an asset
    file edited from outside triggers the "changed outside GameDevTool" confirmation
    before it is overwritten, a file with Git conflict markers is named in the error,
    reopening round-trips, no horizontal scroll at 375 px.
  - Crash recovery on `file://` works across a reload of the same file.
  - Keyboard: every Tab stop shows a focus ring, the skip link comes first, the asset
    listbox works with arrow keys + Enter (`aria-activedescendant`).
  - Pixel 7 emulation (412 px, coarse pointer): no horizontal scroll, every visible
    button is at least 44×44 px. Emulation only; real devices are still open.
- Folder mode detects outside changes only in the files a save is about to write or
  delete. Outside edits to other files (e.g. from a Git pull) are not overwritten, but
  they are not loaded either: reopen the folder after pulling. See
  [PROJECT_FORMAT.md](PROJECT_FORMAT.md).
