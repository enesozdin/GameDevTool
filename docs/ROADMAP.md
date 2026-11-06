# GameDevTool Roadmap

## 1. Vision & Principles

GameDevTool collects the tools a game designer needs from concept to handoff in one
app. It does not depend on any single engine.

| Principle | What it means in practice |
|---|---|
| Designer-first | No code needed. Forms, tables and graphs instead of config files. Undo/redo and spreadsheet-style editing everywhere. |
| Engine-agnostic | All data exports to a documented JSON Schema + CSV. |
| Local-first & private | Works offline. The app makes no network requests; its Content Security Policy (CSP) blocks network APIs and remote resources. |
| Runs anywhere | A single HTML file runs from disk on desktop; the same file can be hosted statically for mobile. |
| Git-friendly | Stable key order, stable IDs, small diffs. |
| Hardware efficient | Runs smoothly on low-end laptops, tablets and phones. |
| Pragmatic dependencies | Proven libraries for hard problems; own code only where no trustworthy library exists or the code is small. Pinned versions, no automatic updates. See [DEPENDENCIES.md](DEPENDENCIES.md). |
| Zero cost by default | Free tools and services only. Any step that costs money (paid services, plans, CI runners, quotas that could be exceeded) is raised with the developer before it is taken. See [CLAUDE.md](../CLAUDE.md). |

## 2. Architecture

### 2.1 Tech Stack

| Concern | Choice |
|---|---|
| UI | React 19 |
| Node graphs (production chains, dialogue, quests) | React Flow (`@xyflow/react`), one shared graph layer for all graph tools |
| Tables | TanStack Table (sorting, filtering, columns) + TanStack Virtual (row virtualization) |
| Charts | uPlot |
| Markdown | `marked` lexer only. Tokens are rendered to React elements by our code, so no HTML strings are ever produced. |
| Validation & types | Zod (`zod/mini` import for small bundle size) |
| Expression language | Own, **one language** shared by table formulas, production gates, dialogue conditions and loot rules: tokenizer → parser → AST → compiled closures (no `eval`). Published spec + function list: [EXPRESSIONS.md](EXPRESSIONS.md). |
| Undo/redo | Own command/patch-based history in `core`, used by every tool |
| Storage | Own thin wrappers over the File System Access API, IndexedDB and Save/Open file |
| CSV/TSV, IDs (ULID), seeded PRNG (xoshiro128**) | Own, small |
| Build | TypeScript + esbuild → single `GameDevTool.html` (IIFE, all code inlined) |
| Runtime for tooling | Node.js 26 LTS, pinned via `.nvmrc` and `engines` |
| Tests | Node built-in test runner (`node --test`, TypeScript via type stripping with `erasableSyntaxOnly`) |

### 2.2 Repository Layout

    src/
      core/     Pure TypeScript, no DOM, no React: data model, validation,
                expression language, undo/redo history, reference index,
                exporters, simulation. Compiled with a tsconfig that has no
                DOM types.
      ui/       React components, one folder per tool.
      app/      App shell, storage adapters, workers.
    build/      Build script (esbuild API) → dist/GameDevTool.html
    tests/      Unit tests (mostly core)
    schema/     Published JSON Schema files
    docs/       ROADMAP.md, DEPENDENCIES.md, PROJECT_FORMAT.md, EXPRESSIONS.md (expression language spec)

### 2.3 Data Model

    Project (.gdtproj — a single JSON file, or a folder in folder mode)
     ├─ manifest       name, schema version, settings, project variables
     ├─ assets[]       each with a stable ULID id
     │    ├─ Document       GDD pages
     │    ├─ Table          typed rows/columns, including the built-in
     │    │                 Items, Recipes and Machines tables
     │    ├─ ProductionGraph  production chain layout: sources, recipe
     │    │                 nodes (referencing Recipe rows), storages,
     │    │                 sinks, splitters/mergers, gates
     │    ├─ Graph          dialogue / quest graphs
     │    ├─ LootTable      weighted drop tables
     │    └─ EconomyModel   sources, sinks, sim configs
     └─ attachments/   images used by GDD pages (stored as files, not base64 in JSON)

- **Typed references** connect assets: a loot entry points to an item row, a dialogue
  node checks a quest state, a GDD page embeds a table row.
- A **reference index** finds broken links, builds "used by" lists, and supports safe
  rename/delete.
- **Project variables** (flags, counters, quest states) and a **character/speaker
  list** are shared by the dialogue, quest and simulation tools.
- **Localizable text** is a first-class type: every player-facing string gets a stable
  localization key.
- Every file carries a **schema version**; migrations upgrade old projects automatically.

### 2.4 Distribution & Runtime Modes

The app is **one HTML file**: `dist/GameDevTool.html`, with all JS and CSS inlined.
Hosted mode adds two small files next to it: `manifest.json` and `sw.js`.

| Mode | How it's used | Platforms |
|---|---|---|
| **Offline file** | Double-click `GameDevTool.html`. No server, no install. | Desktop: Chrome, Edge, Firefox, Safari |
| **Static hosted (optional)** | Upload the HTML file plus `manifest.json` and `sw.js` to any static host (e.g. GitHub Pages). There is no backend; data stays on the device. "Add to Home Screen", works offline after the first load. | Mobile (iOS, Android) + desktop |

**Persistence. The project file or folder is always the source of truth:**
1. **Folder mode** (Chromium desktop): open a real project folder via the File System
   Access API. One JSON file per asset, so it works directly with Git. Layout and save
   rules: [PROJECT_FORMAT.md](PROJECT_FORMAT.md).
2. **Save / Open project file** (`.gdtproj` download/upload). **Always works**, on every
   browser and in both modes.
3. **Autosave** to IndexedDB is **only a crash-recovery cache**, not storage:
   - Chrome gives every local HTML file the same storage area, so other local pages
     can read it.
   - Firefox ties it to the exact file path, so moving or re-downloading the file
     loses it.

**Running from a local file has some limits:**
- Service workers and PWA install don't work there. They aren't needed, since the file
  is already local.
- Workers are started from inlined code via Blob URLs. This requires `worker-src blob:`
  in the CSP (see 2.5).
- Storage behaviour on local files differs between browsers. Phase 0 includes a test
  matrix per browser to confirm what works: [BROWSER_MATRIX.md](BROWSER_MATRIX.md).

### 2.5 Security

**Content Security Policy.** It is generated at build time and covers both modes:

    default-src 'none';
    script-src 'sha256-…';      (hash of the exact inlined bundle)
    style-src 'sha256-…';
    img-src data: blob:;
    font-src data:;
    worker-src blob: 'self';    ('self' only needed for sw.js in hosted mode)
    manifest-src 'self';
    form-action 'none';
    base-uri 'none'

- `default-src 'none'` blocks network APIs (fetch, XHR, WebSocket) **and** remote
  images, fonts and styles.
- CSP cannot block link navigation. That's why Markdown links only allow
  `http`, `https` and `mailto`, and links open only when the user clicks them.
  Remote images are never loaded.
- `worker-src blob:` is a small concession. Creating a blob worker already
  requires script execution, which the hash-based `script-src` prevents.
- Blob/data URLs are read with `Blob.text()` / `FileReader`, never `fetch()`.

**Other rules:**
- **User text never becomes HTML.** Markdown is tokenized and rendered as React
  elements; there is no `dangerouslySetInnerHTML`.
- **Expressions** (formulas, conditions, loot rules) are parsed by our own parser.
  User input is never executed as JavaScript.
- **Project files are untrusted input:** loading a file never executes it.
  - Keys `__proto__`, `constructor` and `prototype` are rejected.
  - Zod strips unknown keys.
  - Size and depth limits are enforced.
- **Supply chain and releases:** see [DEPENDENCIES.md](DEPENDENCIES.md).

### 2.6 Performance Rules
- Virtualize every list and table. DOM size stays constant regardless of row count.
- Simulations run in a **Web Worker** with typed arrays (`Float64Array`, `Uint32Array`)
  and the seeded PRNG. Runs are reproducible and the UI never blocks.
- The expression engine keeps a **dependency graph**: editing a cell recalculates only
  its dependents.
- Graphs render only visible nodes and edges (`onlyRenderVisibleElements`); large
  dialogues are split into sub-graphs.
- A tool's components mount only when that tool is opened. All code is still in the
  single file, so this saves work at runtime, not download size.
- Saves are debounced and batched. Only changed assets are rewritten.
- Bundle size is reported in CI. As of 2026-11-04 the libraries alone measure 574 KB
  minified / 186 KB gzip.
- No background work while the tab is hidden; idle workers are terminated.

## 3. Export & Interop

| Data | Format | Engine notes |
|---|---|---|
| Tables | CSV (UTF-8, row name in first column) + JSON | Unreal DataTable-compatible CSV for a matching USTRUCT; complex columns (enums, lists, references, bools) use Unreal's text format. Unity/Godot via a small importer |
| Curves | CSV in Unreal CurveTable layout + JSON | |
| Production chains | Items / Recipes / Machines CSV + production graph JSON | Recipe CSV uses Unreal struct-array text format for inputs/outputs, e.g. `((Item="IronOre",Count=2),(Item="Coal",Count=1))` |
| Bill of materials / rate report | CSV | For spreadsheets and design reviews |
| Dialogue / Quest | JSON: nodes, edges, speakers, conditions as expression strings, localization keys | Runtime-agnostic; reference interpreter documented |
| VO script | CSV (key, speaker, line, context) | For voice-over recording |
| Loot / Economy | JSON | Same weights and rules as the simulator, so the game matches the sim |
| Localization | CSV export **and re-import** (key, context, source, translations...) | Works with common loc pipelines |
| Everything | Versioned JSON Schema in `schema/` | Any engine/tool can validate imports |

Engine-specific adapters are planned for Phase 6. They generate the matching engine
types, which are needed for one-click import (an Unreal DataTable needs its USTRUCT
first). They are code generators that produce text, so they need no dependencies:
- Unreal: USTRUCT + DataTable header
- Unity: C# ScriptableObject
- Godot: Resource script

## 4. Tool Specs (MVP Scope)

### 4.1 Production Chain Editor

The first tool. Designers build in-game crafting and resource chains as a node graph.
Each node processes inputs into outputs, and outputs connect to the inputs of other
nodes.

**Standards alignment**

| Standard | Used for |
|---|---|
| IDEF0, ISO/IEC/IEEE 31320-1:2012 | Node layout. Inputs enter left, requirements/unlocks top, outputs leave right, machine/worker bottom. Sub-chains can be collapsed into one node and opened again (hierarchical decomposition). |
| ISA-95, IEC 62264 | Data model terms: **Material Definition** (item), **Process Segment** (recipe), **Equipment Class** (machine), **Bill of Materials** |
| SI / ISO 80000 | Units: time stored in seconds; rates shown per second, minute or hour |
| Machinations (de facto game-economy notation) | Node semantics (Source, Converter, Pool, Drain, Gate), shared with the Economy simulator |

**Node types**

| Node | Machinations equivalent | Purpose |
|---|---|---|
| Source | Source | Raw resources: mining, harvesting, drops, spawn rates |
| Recipe | Converter | Inputs × count → outputs × count, cycle time, machine |
| Storage | Pool | Buffers and inventories with optional capacity |
| Sink | Drain | Consumption: player use, selling, decay |
| Splitter / Merger | n/a | Divide or combine item flows by ratio |
| Gate | Gate | Unlock conditions: tech, level, quest state (expression language) |

**Typed connections**
- Every port carries an item from the Items table.
- A connection is only allowed between matching items, or an item and a matching
  tag (e.g. "Any Fuel").
- The rule is checked live in the editor.

**Recipes and machines** (stored as rows in the Recipes and Machines tables, so they
also export as engine data)
- Recipes have inputs and outputs with counts.
- Outputs can be by-products or chance-based (e.g. 10% Rare Gem).
- Each recipe has a cycle time, a machine and an optional unlock gate.
- Machines have a speed multiplier, an optional energy use and a build cost
  (references to items).

**Calculations** (steady state, recalculated live)
- **Target-driven:** "1 Iron Sword per minute" → required rate of every upstream item,
  number of machines per recipe, raw resources per minute.
- **Supply-driven:** given source rates → maximum output, the bottleneck node
  highlighted, surplus or deficit per item.
- **Bill of materials:** total raw cost of one unit, as a tree.
- **Time to first unit:** critical path through the chain.
- **Chance-based outputs and random sources:** Monte Carlo runs in a worker and gives
  output per hour as P10/P50/P90. The simulation engine is shared with the Economy
  simulator (4.3).

**Validation**
- Unconnected required inputs and item type mismatches.
- Loops with no source.
- Products that can't be reached.
- Recipes that use items before those items are unlocked.

**MVP limits**
- One selected recipe per item. Loops (e.g. catalyst recycling) are solved
  iteratively.
- Optimizing across alternative recipes (linear programming) is in the backlog.

**Editor**
- Drag items and recipes from a library.
- Automatic left-to-right layout.
- Rate labels on connections; deficit/surplus colors.
- Group nodes for sub-chains.

### 4.2 Data Tables & Balancing
- Column types: int, float, string, localizable text, bool, enum, reference, curve, list.
- Per-column validation (min/max, required, unique, pattern).
- **Spreadsheet workflow:**
  - Copy/paste to and from Excel / Google Sheets (TSV).
  - Fill-down, bulk edit of selected cells.
  - Keyboard navigation.
- Formulas: column-level (`damage = base * (1 + level * 0.1)`) and cross-table lookups.
- Curve editor: XP per level, damage scaling, spawn rates. Presets (linear, exponential,
  S-curve) plus hand-tuned keys.
- CSV import with column-type detection; compare two versions of a table.

### 4.3 Economy / Loot Simulator
- Loot tables: weighted, nested, guaranteed drops, pity counters, level-gated entries.
- Economy model: currency sources (production chains, drops, sales, quest rewards) and
  sinks (shops, upgrades, repairs) per session. Until the Quest tool exists (Phase 5),
  quest rewards are entered as manual source nodes; afterwards they link automatically.
- Monte Carlo: N simulated players × M sessions, in a worker, cancellable, seeded.
- Reports: drop-rate histograms, P10/P50/P90 time-to-item, currency balance over
  time, inflation warnings.

### 4.4 Game Design Document
- Markdown pages in a tree, with templates: core loop, mechanics, characters, levels,
  monetization, one-page pitch.
- Images: drag & drop or paste, stored as project attachments.
- Plain text editor with live preview in the MVP. A richer editor is added later, only
  if designers ask for it.
- Live embeds: `[[Items/Sword]]` links and inline table-row cards that update when the
  data changes.
- Outline view and full-text search across the project.
- Export to Markdown / HTML / PDF (via print).

### 4.5 Dialogue / Quest Graph
- Node types: Line, Choice, Condition, Set Variable, Jump, Random, Quest State, Event,
  Comment.
- Every line has a speaker from the project's character list.
- Quest graphs reuse the same engine: states, objectives, prerequisites, rewards
  (rewards reference table rows).
- **Playthrough runner**: play the dialogue in-editor and watch variables change live.
- Every line gets a stable localization key automatically.
- Reports: word count per speaker; VO script export.
- Search across all graphs.
- Validation: unreachable nodes, dead ends, undefined variables.

## 5. Phases

Each phase ends with something usable that ships. Estimates are for one developer.

| Phase | Content | Estimate | Why this order |
|---|---|---|---|
| **0 – Foundation** | Repo setup, build → single HTML with CSP, `core`/`ui` separation, tests + CI (typecheck, tests, `npm audit`, bundle size report), data model + validation + migrations, **undo/redo history**, storage adapters + per-browser test matrix, Save/Open project file, responsive app shell, **UI strings externalized + keyboard/accessibility basics** | ~23 days | Every tool depends on it; undo and i18n are expensive to retrofit |
| **1 – Production Chain Editor** | Section 4.1, plus basic Items / Recipes / Machines tables (typed columns, validation, CSV import/export), the shared graph layer and the simulation worker | ~41 days | Top priority; builds the graph and simulation infrastructure that later tools reuse |
| **2 – Data Tables & Balancing** | Section 4.2: full spreadsheet features on top of the Phase 1 tables (formulas, curves, copy/paste, bulk edit, compare) | ~30 days | Extends tables every tool references |
| **3 – Economy / Loot** | Section 4.3 | ~17 days | Natural continuation of production chains; completes a full "balancing" release (production + tables + economy) |
| **4 – GDD** | Section 4.4 | ~22 days | Can embed real data, production chains and balance reports |
| **5 – Dialogue / Quest** | Section 4.5 | ~25 days | Reuses the shared graph layer; quest rewards then link into the economy model |
| **6 – Hardening** | Hosted mode (manifest + service worker with versioned cache and "update available" prompt), tablet/phone UX pass, engine adapters, UI translations (EN/TR), accessibility pass | n/a | Polish after the core loop is proven |

**MVP total (Phases 0–5): ~158 days planned.** A realistic range is **155–190 days**;
the production rate solver, spreadsheet-grade editing and the expression engine are
where overruns are most likely. The first usable tool, the Production Chain Editor, is
ready after ~64 days.

### Phase 1 progress

| Part | Status |
|---|---|
| Items / Recipes / Machines tables (table roles, `stacks` column type), typed grid editing | ✅ |
| CSV / TSV import + export, engine-neutral with `generic` and `unreal` formats ([CSV.md](CSV.md)) | ✅ |
| Production graph asset, reference index, typed connections checked live | ✅ |
| Steady-state solver: target-driven, supply-driven, machine counts, bottlenecks, surplus/deficit, loops | ✅ |
| Rate calculator, bill of materials, time to first unit | ✅ (core; BOM + first unit shown for the selected node) |
| Monte Carlo (seeded xoshiro128**) in a Web Worker, P10/P50/P90 | ✅ |
| Validation: mismatches, unconnected inputs, loops with no source, unreachable nodes | ✅ |
| Editor: library with drag & drop, auto layout, rate labels, deficit/bottleneck colors | ✅ |
| Group nodes for sub-chains (IDEF0 decomposition): nested groups, collapse/expand, boundary ports, merged connections | ✅ |
| Tag-matched ports ("Any Fuel"): tag inputs in recipe data, live connection check, calculator, CSV (`(Tag="Fuel",Count=1)`) | ✅ |
| Expression language: tokenizer, parser, type checker, closure compiler, spec ([EXPRESSIONS.md](EXPRESSIONS.md)) | ✅ |
| Project variables editor (bool, int, float, string, enum); renames rewrite conditions | ✅ |
| Gate conditions (live errors in the inspector) and "used before unlocked" validation | ✅ |
| Gates in the solver / Monte Carlo: conditions evaluated against a scenario of variable values, locked nodes run at 0 | ✅ |
| Rate calculator view: target item + rate, recipe choice per item (saved with the chain, also used by the bill of materials), machines, raw totals; default view on phones | ✅ |
| Creating enum / reference / list / stacks / localizable text columns from the UI (enum options, target table, list item type) | ✅ |
| Monte Carlo histograms (uPlot): binned in the worker, one chart for the chosen sink, P10/P50/P90 lines, light/dark | ✅ |

### Phase 2 progress

| Part | Status |
|---|---|
| Spreadsheet grid: rows and columns virtualized, sticky row names, one editor in the active cell, 44 px rows on touch | ✅ |
| Keyboard navigation (arrows, Ctrl+arrows, Home/End, PageUp/PageDown), range selection (Shift, mouse drag), Enter/F2/typing edits | ✅ |
| Copy/paste with Excel / Google Sheets (TSV): one value fills the selection, blocks repeat over it, rows past the end are appended; invalid fields are counted and left unchanged | ✅ |
| Fill-down (Ctrl+D; localizable text keeps each cell's key), bulk edit of selected cells (Ctrl+Enter), clear (Delete), Yes/No toggle (Space), delete selected rows; each one undo step | ✅ |
| Per-column validation: min/max, required, unique, pattern; editing column constraints in the UI | |
| Formulas: column-level and cross-table lookups, dependency graph | |
| Curve editor with presets | |
| CSV import with column-type detection | |
| Compare two versions of a table | |
| Sorting and filtering (TanStack Table) | |

### Backlog (post-MVP)
- Production chain optimizer: choose between alternative recipes with linear programming
- Level / flow diagrams (level progression, gating, metroidvania maps)
- Narrative timeline & character relationship maps
- Playtest feedback collection & analytics import
- Task board linked to GDD sections
- Asset / art / audio tracker
- Collaboration beyond Git: needs a sync layer, which would conflict with "no network".
  To be evaluated later.

## 6. Mobile Suitability

**Recommendation: one responsive UI. Tablets get the full editor; phones get review and
light editing. On mobile, the app is used through static hosting.**

Opening a local HTML file directly on a phone is unreliable, especially on iOS. That's
why mobile uses the hosted mode. The hosted page is the same single file, has no
backend, and keeps all data on the device.

### 6.1 Per-tool fit

| Tool | Tablet | Phone |
|---|---|---|
| Production Chain Editor | ✅ Full (touch + pen) | ⚠️ View, rate calculator (set a target, see requirements), single-node edits |
| GDD | ✅ Full | ✅ Read + edit |
| Data Tables | ✅ Full grid | ⚠️ Card/row view, single-cell edits |
| Dialogue / Quest Graph | ✅ Full (touch + pen) | ⚠️ View, pan, playthrough; complex node editing limited |
| Economy / Loot Sim | ✅ Full | ✅ Run sims, read charts |

### 6.2 Constraints & solutions

| Constraint | Solution |
|---|---|
| No File System Access API on iOS/Android | Save/Open project file via the share sheet; IndexedDB as recovery cache |
| Browser may evict storage | `navigator.storage.persist()` + "last backup" reminder |
| No hover on touch | No hover-only UI; long-press context menus |
| Small touch targets | Minimum 44×44 px on touch layouts |
| Limited RAM/CPU | Simulations run in chunks with a capped player count; graphs render only visible nodes |
| Battery | No work while hidden; idle workers terminated |
| Offline | Service worker caches the app in hosted mode; all data is already local |
| Stale app versions | Versioned service worker cache + "update available" prompt |

### 6.3 Native apps
Native wrappers (Tauri, Capacitor) are not planned. They will be reconsidered only if a
store release becomes a hard requirement.

## 7. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| A dependency gets a vulnerability or a hijacked release | Pinned versions, `npm audit` + `npm audit signatures` in CI, 14-day cooldown, CSP limits impact |
| Breaking major versions (e.g. TanStack Table v8 → v9) | Versions pinned; upgrades only on purpose, with tests |
| Browser differences when running from a local file | Project file/folder is the source of truth; per-browser test matrix in Phase 0 |
| XSS or data leaks through user content | User text never becomes HTML; link scheme allowlist; no remote images; strict CSP |
| A tampered copy of the HTML file is shared | SHA-256 checksum + GitHub attestation for every release; reproducible build |
| Git merge conflicts (folder mode) | One file per asset, stable ordering, ULIDs instead of indices |
| Production rate solver complexity (loops, by-products, alternative recipes) | MVP: one recipe per item + iterative loop solving; LP optimization in backlog |
| Expression language scope creep | One shared language with a fixed MVP function list; extend on real needs |
| Schema changes breaking old projects | Versioned schemas + automatic migrations + a test fixture per version |
| Estimates too optimistic | Realistic range stated (155–190 days); re-estimate after Phase 1 with real velocity |

**Open questions**
- **License (decide before the repository is made public):** open source (e.g. MIT) or
  closed? Without a license file, the code is "all rights reserved".
- Should the dialogue export match an existing runtime format or stay custom?
