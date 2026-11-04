# Dependencies

Audit date: 2026-11-04. Sources: npm registry metadata and the npm advisory database
(GitHub Advisory DB), all published versions checked; dependency trees resolved from
real lockfiles; bundle sizes measured with esbuild (minified).

## Policy

**Installing**
- **Exact versions only:** no `^`/`~` ranges, lockfile committed. The lockfile's
  integrity hashes guarantee the same code on every install.
- **`.npmrc` in the repo:**
  - `save-exact=true`
  - `ignore-scripts=true`
  - `registry=https://registry.npmjs.org/`
- **Node.js 26 LTS**, pinned via `.nvmrc` and `engines`.

**Updating**
- **No automatic updates:** no Dependabot/Renovate version-update PRs, no auto-merge.
  GitHub security *alerts* stay on.
- **Updates are manual**, for a real need:
  1. Resolve with `npm install --before=<date 14 days ago>`. This applies the 14-day
     cooldown to transitive packages too.
  2. Read the changelog.
  3. Run all tests.
  4. Log the change below.
- **Security fast track:** for a published vulnerability in a pinned version, the
  14-day cooldown may be skipped. The fixed version still needs a changelog read and
  a full test run.

**CI checks**
- `npm audit` and `npm audit signatures`.
- A small script verifies every `resolved` URL in the lockfile points to
  `https://registry.npmjs.org/`.
- GitHub Actions hardening:
  - Actions pinned by commit SHA.
  - `permissions: contents: read`.
  - No `pull_request_target`, no secrets needed.

**Releases**
- `GameDevTool.html` ships with a SHA-256 checksum and a GitHub artifact attestation.
- The build is reproducible: same commit, same file.
- Third-party license notices are kept: esbuild `legalComments` plus a
  `THIRD_PARTY_NOTICES` file.

## Admission criteria for new libraries
1. Permissive license (MIT, BSD, ISC, Apache-2.0).
2. Maintained (release within the last 12 months), **or** feature-complete with no
   open advisories. Not deprecated.
3. No unpatched advisories; advisory history reviewed.
4. No install scripts *required* (must work with `ignore-scripts=true`); a small
   dependency tree.
5. Reputable maintainers or organization; npm provenance (signed CI publish) preferred.

Exceptions are listed in the Notes column of the table below.

## Approved

### Runtime

| Package | Version | Purpose | Publisher | Provenance | Notes |
|---|---|---|---|---|---|
| react, react-dom (+ scheduler) | 19.3.1 | UI | Meta | ✅ | Advisories only in very old versions (<16.4.2) |
| @xyflow/react | 12.12.0 | Production chains, dialogue / quest graphs | xyflow | ✅ | Brings @xyflow/system, zustand, classcat, d3 modules |
| @tanstack/react-table | 9.3.1 | Table logic (sorting, filtering, columns) | TanStack | ✅ | v9 API (`useTable`) differs from v8; stay pinned |
| @tanstack/react-virtual | 3.14.21 | Row virtualization | TanStack | ✅ | |
| uplot | 1.6.32 | Charts | Leon Sorokin | ❌ | **Exception to criterion 2:** last release 2025-03. Feature-complete, zero dependencies, widely used (Grafana), no open advisories; prototype-pollution fix included (≥1.6.31). Single maintainer. |
| marked | 18.1.1 | Markdown tokenizing (lexer only) | marked org | ✅ | Its HTML output is never used |
| zod | 4.6.7 | Validation + TypeScript types | Colin McDonnell | ✅ | Import `zod/mini`: 14 KB vs 445 KB minified for the full import. Memory-DoS fix included (≥4.6.6) |

### Dev only

| Package | Version | Purpose | Publisher | Provenance | Notes |
|---|---|---|---|---|---|
| typescript | 7.0.2 | Type checking | Microsoft | ❌ | Native compiler; platform binary installed as an optional package |
| esbuild | 0.28.2 | Bundling | Evan Wallace | ✅ | **Exception to criterion 4:** has a `postinstall` script, but is verified to work with `ignore-scripts=true`. Its dev server is never used (all known advisories concern it). |
| @types/react, @types/react-dom | 19.3.0 | React type definitions | DefinitelyTyped | ❌ | @types/react brings `csstype` |
| @types/node | 26.6.5 | Node type definitions (build scripts, tests) | DefinitelyTyped | ❌ | Brings `undici-types` |

Playwright is **not** included: it downloads browser binaries. The per-browser test
matrix is run manually in Phase 0; automated E2E is reconsidered later.

### Resolved runtime tree

| Metric | Value |
|---|---|
| Packages | 32 |
| npm accounts with publish rights | 20 |
| With provenance | 23 |
| Install scripts | 0 |
| `npm audit` | 0 vulnerabilities |
| Bundle | 574 KB minified / 186 KB gzip |

## Rejected

| Package | Reason |
|---|---|
| expr-eval | Unpatched critical code-execution + prototype pollution advisories; unmaintained since 2019 |
| mathjs | 9 dependencies, ~170 KB |
| hyperformula | GPL-3.0 license |
| handsontable | Commercial license |
| @comfyorg/litegraph | Deprecated |
| litegraph.js, drawflow | No releases since 2024; single maintainer / 0.0.x |
| DOMPurify | Not needed: user text is never rendered as HTML (37 advisories in its history) |
| Dexie | 100 KB minified for what a ~150-line wrapper does |
| CodeMirror | ~12 packages, ~400 KB minified; plain editor is enough for MVP, reconsider later |
| Playwright | Downloads browser binaries; manual browser matrix for now |
| Preact | Technically sound, but the team prefers React's larger maintainer base and ecosystem |

## Stack comparison (why this set)

| | Popular stack (first draft) | Minimal (mostly own code) | **Chosen: balanced** |
|---|---|---|---|
| Runtime packages | 57 | 3–6 | **32** |
| Bundle, minified | 1,662 KB | 45 KB without a graph library, ~650 KB with one | **574 KB** |
| MVP effort (same scope) | ~155 days | ~180–205 days | **~158 days** |
| Main issue | Heavy (full Zod import, CodeMirror, Dexie) | Rebuilding solved problems; slow | none significant |

## Change log
- 2026-11-04: Initial approved set.
