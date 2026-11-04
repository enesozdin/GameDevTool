# GameDevTool: rules for AI assistants

Read [docs/ROADMAP.md](docs/ROADMAP.md) (scope, architecture, phases) and
[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) (dependency policy) before changing anything.

## Zero cost by default

This project avoids paid services and paid steps wherever possible.

- **Prefer free options:** open-source tools, the npm registry, local tooling, and GitHub
  features that are free for public repositories (Pages, security alerts).
- **Never take a step that costs money, or may start costing money, without telling the
  developer first.** That includes:
  - paid SaaS, APIs, licenses or plan upgrades;
  - larger or paid CI runners, paid storage or bandwidth;
  - anything that only stays free under a quota, when the work could exceed it.

  Stop, explain the cost and the free alternatives, and wait for a decision.
- **No CI for now.** The developer decided against GitHub Actions; checks run locally
  with `npm run check`. Do not add workflows without asking.

## Working rules
- Exact dependency versions, `ignore-scripts=true`, manual updates with a 14-day
  cooldown (DEPENDENCIES.md). New libraries must meet the admission criteria.
- `src/core` has no DOM and no React; UI text lives only in `src/ui/strings.ts`.
- Hardware efficient: virtualize lists, keep work off the main thread, no background work
  while the tab is hidden.
- Run `npm run check` before every commit. Requires Node.js 26 (`.nvmrc`).
- Commit messages, code, comments and command lines are in English.
