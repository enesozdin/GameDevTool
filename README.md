# GameDevTool

An engine-agnostic, local-first toolkit for game designers: write the design document,
balance data, build dialogue and quests, and simulate economies in one place, then
export clean JSON/CSV to Unreal, Unity, Godot or a custom engine.

- **One HTML file.** Open it in a browser and it runs. No install, no server, no account.
- **Your data stays on your device.** The app makes no network requests, and its
  security policy blocks network APIs and remote resources.
- **Small, vetted dependency set.** Pinned versions, no automatic updates.

**Status:** Phase 0 (Foundation) in progress. See [docs/ROADMAP.md](docs/ROADMAP.md),
[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) and [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md).

## Planned tools (MVP)
- **Production Chain Editor**: node-based crafting and resource chains with typed
  inputs/outputs, rate calculation, bottlenecks and bill of materials
- **Data Tables & Balancing**: typed tables, formulas, curves, spreadsheet copy/paste
- **Economy / Loot Simulator**: loot tables, currency flows, Monte Carlo simulation
- **Game Design Document**: Markdown docs with images and live links to game data
- **Dialogue / Quest Graph**: node-based branching with variables, conditions and speakers

## Development

Requires Node.js 26 LTS (see `.nvmrc`). Dependencies are pinned and install scripts are
disabled (`.npmrc`); see [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) before adding or
updating a package.

```bash
npm ci
```

```bash
npm run check
```

| Script | What it does |
|---|---|
| `npm run build` | Builds `dist/GameDevTool.html` (+ `.sha256`) and prints the bundle size report |
| `npm run typecheck` | Type-checks `src/core` (no DOM), `src/ui` + `src/app` (DOM), and build/tests (Node) |
| `npm test` | Runs the unit tests with the Node test runner |
| `npm run schema` | Regenerates `schema/project.v1.schema.json` from the zod schemas |
| `npm run check` | typecheck + test + build |
