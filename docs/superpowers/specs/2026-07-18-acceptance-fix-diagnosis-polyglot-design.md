# Design — Polyglot Acceptance Fix-Diagnosis Source Loader

> Date: 2026-07-18
> Origin: Gap Analysis 2026-07-18 §3.3 / §6 item #10 (sub-area A).
> Scope: `src/acceptance/fix-diagnosis.ts` + new `src/acceptance/import-resolution.ts`.

## Problem

`loadSourceFilesForDiagnosis` loads source files referenced by a failing acceptance
test so the LLM diagnosis op (`acceptanceDiagnoseOp`) has real source context. Its
import parser (`parseImportStatements`) matches **only** ES `import … from "x"`
syntax. For Python/Go/Rust packages it extracts nothing, so non-TS acceptance
failures reach the diagnosis LLM with **zero source files** — a direct contributor
to hallucinated-signature fixes. The sibling stub-detector in `heuristics.ts` is
already multi-language, making this an internal inconsistency.

A secondary weakness: the existing TS path is itself lossy. Resolution is a literal
`${workdir}/${importString}` read, so an import that omits its extension
(`./math` for `./math.ts`) silently resolves to nothing.

## Contract (unchanged)

Best-effort source-context enrichment, **not** a compiler:

- Cap **5 files**, **500 lines** each (`MAX_SOURCE_FILES`, `MAX_FILE_LINES` preserved).
- Every unresolvable/unreadable import degrades to `null` → filtered out. No throws.
- First-level **local** imports only. No transitive following.

## Approach

Detect the package language once, then dispatch to a per-language parse+resolve
function. Rule-conformant with `monorepo-awareness.md` §B (language-specific logic
gated by `detectLanguage()`, documented scope, graceful empty for other languages).

### Components

**1. New module `src/acceptance/import-resolution.ts`** — isolates the testable
per-language logic; keeps `fix-diagnosis.ts` a thin orchestrator. Exports
`resolveSourceFiles(opts): Promise<Array<{ path: string; content: string }>>`.

Per-language parse + candidate-path generation (all best-effort, all capped):

| Lang | Parse | Candidate paths |
|------|-------|-----------------|
| ts/js | `import … from "x"`, relative (`.`-prefixed) only | `x`; if no source ext, try `x.{ts,tsx,js,jsx}`, `x/index.{ts,tsx,js,jsx}` |
| python | `from a.b import …`, `import a.b` | dotted→slash: `a/b.py`, `a/b/__init__.py`; leading dots = relative parent levels |
| rust | `use crate::a::b`, `use super::…`, `use self::…`, grouped `use a::{b, c}` (prefix path only) | `src/a/b.rs`, `src/a/b/mod.rs`, `src/a/mod.rs` |
| go | single `import "x"` + grouped `import ( … )` block | read `go.mod` `module <prefix>`; imports under `<prefix>/` → local dir; load its non-`_test.go` `.go` files (cap-bounded) |

**2. `fix-diagnosis.ts`** — `loadSourceFilesForDiagnosis` takes an options object and
delegates to `resolveSourceFiles`:

```ts
loadSourceFilesForDiagnosis({
  testFileContent: string;
  packageDir: string;      // = today's workdir argument
  testFilePath?: string;   // = acceptanceTestPath — cheap ext-based language detect
  language?: ProjectProfile["language"];  // optional explicit override
}): Promise<Array<{ path: string; content: string }>>
```

**3. Language detection** — cheap sync path first: infer from `testFilePath`
extension (`.py`→python, `.rs`→rust, `.go`→go, `.ts/.tsx/.mts/.cts`→typescript,
`.js/.jsx/.mjs/.cjs`→javascript). Fallback `detectLanguage(packageDir)` (async,
memoized). **Undefined → typescript** (preserves historical behavior; documented).

**4. Caller** (`src/execution/lifecycle/acceptance-fix.ts:117`) — pass
`acceptanceTestPath` and `packageDir` into the new options object. `diagnosisOpts`
already carries both (`workdir` = packageDir, `acceptanceTestPath`).

### Error handling

Each read wrapped, returns `null` → filtered (as today). `go.mod` missing → Go
resolver returns `[]`. Unknown/undetected language → typescript default. No throws
escape the module.

### Testing

- New `test/unit/acceptance/import-resolution.test.ts` — per language, real fixtures
  via `withTempDir()` (real files on disk, no `Bun.file` mocking, per
  `test-architecture.md`):
  - resolves correct local source files from imports,
  - respects the 5-file cap,
  - degrades to `[]` for missing / external / stdlib imports,
  - Go: `go.mod` module-prefix stripping + `_test.go` exclusion,
  - `clearLanguageCache()` in teardown when `detectLanguage` fallback is exercised.
- Existing `test/unit/acceptance/fix-diagnosis.test.ts` — updated to the
  options-object signature; its `[]`-for-missing-files assertions still hold.

## Non-goals (YAGNI)

- No transitive / multi-hop import resolution.
- No `require()` / dynamic `import()` / re-export following.
- No external-dependency loading (`node_modules`, Go non-module imports, Python
  site-packages, Cargo registry crates).
- No AST parsing — regex extraction matches the existing depth and the
  `heuristics.ts` precedent.

## Sub-areas B & C (out of scope here)

Gap item #10 also covers test-output parser parity (`test-runners/parser.ts`) and
mutation-operator parity (`verification/mutation/operators.ts` — note: Python/Go
tables are empty stubs, not just Rust-absent). Each is an independent spec, to be
tackled separately after this ships.
