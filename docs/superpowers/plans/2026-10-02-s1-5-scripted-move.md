# S1-5 Scripted Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR S1-5. `packages/nax-agent` (`@nathapp/nax-agent`) exists and holds the 188 manifest files plus the 142 tests that test only them. nax consumes it through `@nathapp/nax-agent` and `@nathapp/nax-agent/internal` and bundles it into `dist/nax.js`. The S1 ratchet is replaced by `check-package-boundaries`. Behaviour-neutral: same tests, same coverage measurement, same bundle layout.

**Architecture:** A move script (`packages/nax/scripts/s1-move.ts`, with pure modules under `scripts/lib/s1-move/`) computes the whole move against the original layout before touching anything. Then it `git mv`s the files and rewrites every specifier. Moved files get `#src/` and `#test/` package imports. Staying files get one of the two entries, chosen by a fixed rule. The script also generates the two entry files, writes the package scaffold and runs `bun install`. The gates that guard moved code stay in `packages/nax/scripts` and learn `--package=<dir>`, so nax-agent runs the same implementation over itself. The script, the manifest and the ratchet are deleted in the same PR once the move has run.

**Tech Stack:** TypeScript (ESM), Bun 1.4.0 workspaces (isolated linker), `bun:test`, Biome 2.5.10, TypeScript 7.0.2.

**Spec:** `docs/superpowers/specs/2026-10-01-s1-nax-agent-carve-out-design.md`: section 4.1 (package), 4.4 (public surface), 6 (S1-5 row), 7 (gates), 8 (tests), 9 (acceptance). Read it first. This plan takes **five spec deviations**, each measured (Decisions 3, 6, 7, 8 and 13 below).

**Base:** `main` @ `ce87ea571` (S1-4 #2322 merged; ratchet reads 0). Branch: `feat/s1-5-scripted-move`. Line numbers refer to that commit.

## Measured before planning (prototype on `ce87ea571`)

Every piece of code in this plan was run, before this plan was written, in a throwaway worktree of `ce87ea571`: the move script, the gate changes, the new gate and the post-move fixes. Results the executor should reproduce:

| Check | Result |
|---|---|
| Plan | 188 sources, **142 tests**, 13 helpers, 1 fixture; 446 staying files rewritten (451 on the branch: the script also rewrites five of this plan's own new script and test files, deleted in Task 10); 68 modules re-exported by `/internal`; 9 namespace re-exports |
| Typecheck | nax (src + test + scripts) and nax-agent green after one `EXPLICIT_REEXPORTS` entry (`NO_OP_INTERACTION_HANDLER`, TS2308) and one preload fix, both folded into this plan's code |
| nax-agent suite under its own preload | unit 2116 pass / 138 files; integration 30 pass / 4 files; 0 fail |
| nax suite | unit 19808 tests / 1304 files on `main`'s base (19853 / 1312 at the move commit and 19819 / 1309 after Task 10, counting this plan's new gate tests); integration 1547 (1509 pass, 38 skip) / 144 files; ui 98 / 10; e2e 33 / 11 |
| Test conservation vs `main` | unit 21924 / 1442 files on main = 19808 + 2116 / 1304 + 138; integration 1577 / 148 = 1547 + 30 / 144 + 4 |
| Combined coverage run (nax gate, widened) | 23599 tests / 1600 files; lines 96.80%, functions 94.26% (S1-4's PR: 96.80 / 94.28). nax-agent sources alone in that run: 98.74% lines |
| nax-agent's own tests alone | **77.54% lines, 54 files below 80%** (why Decision 7 exists) |
| Build | `dist/nax.js` 5.17 MB, runs; `npm pack --dry-run`: 5 files, `dependencies` unchanged, `workspace:*` only in devDependencies |
| Complexity baseline | the 18 rows that left nax's baseline are exactly nax-agent's initial baseline, rekeyed |
| Gates after the post-move task | every nax gate and every nax-agent gate green; `check-package-boundaries` green and seen to fail on planted violations |

Unexpected findings the plan absorbs:
- **Two staying tests grow past the 800-line cap.** Biome merges the rewritten imports into one wrapped statement, which adds 3-4 lines. The files are `adapter-complete-rates.test.ts` (800 -> 803) and `adapter.test.ts` (797 -> 801). Task 1 splits each by concern before the move.
- **`export *` collisions are silent at runtime.** Bun drops an ambiguous name without an error. `tsc` reports TS2308, so typecheck is the guard (Task 8).
- **Bun rejects a type re-exported with `export { T }`.** It fails with "export 'T' not found". The entries therefore use `export *` (Decision 4).
- **A staying test reads a moved file by path.** `test/unit/tools/run-command-exec.test.ts:114` reads `src/tools/run-command-exec.ts` (Task 10).

## Global Constraints

- Behaviour-neutral: no change to `nax run` output, log lines, cost rows, `metrics.json`, `nax config` output, stream events, tool-audit ledgers, sandbox policies or CLI text. The published tarball's `dependencies`, `files` and `bin` stay as they are.
- Run nax commands from `packages/nax` and nax-agent commands from `packages/nax-agent`. Never run bare `bun test` (no path); run a single file as `bun test <path> --timeout=60000`. Never `bun run nax`.
- Full verification, nax: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run test:coverage`. nax-agent: `bun run typecheck`, `bun run check:all`, `bun run test`. Repo root: `bun run check:all`.
- No test is edited to pass unless its subject moved, its file had to split because the move grew it past the cap (Task 1), or it tests a gate this PR changes. Every test edit must be traceable to one of those.
- Source files stay at or under 600 lines and test files at or under 800 (`check:file-sizes`, both packages).
- **Complexity ratchet**, strict limit 20 for new functions; it scans `scripts/` too. Every function in the code below is under 20 as written (measured: `--update-baseline` after the prototype added no row). Do not inline helpers into bigger functions.
- **Test ratchets** (`check:all`): new tests add no `as unknown as` and no `as <Capital>` cast. The loose-cast counter also matches `import { X as Y }` with a capital `Y`. The code below has none: typed assignments replace casts, and namespace rewrites produce lowercase aliases. New test files are named by concern, never by ticket.
- Code blocks show content, not final formatting. Before every commit run `bun x biome check --write <files you touched>`, then `bun run lint` in each package you touched.
- Commit locally as the steps say. **Push and open the PR only after the user approves.** No billed `nax run` / `nax plan` (the spec's billed smoke is approved separately, at launch).
- nax is a public repo: commit messages and PR text never name private projects.
- Conventional commit prefixes (`refactor:`, `feat:`, `test:`, `chore:`, `ci:`, `docs:`), no emojis.
- zsh users: `$var:u` is a modifier. Quote script names (`"check:${g}:update"`) or run loops under `bash -c`.

## Decisions this plan takes (flag in review if you disagree)

1. **One PR, as D15 rules, with a reviewable commit sequence:** prep (Tasks 1-5), the script (6-7), one generated move commit (9), post-move fixes (10), CI/config/rules (11). The generated commit is mechanical (renames plus rewritten specifiers). Every hand-written change sits in its own commit around it. **The move commit itself is red by design**: 3 nax tests and several baselines go stale until Task 10. Every other commit is green. The PR text asks for a squash merge, or explicitly accepts one red commit in `main`'s history (bisect).
2. **Which tests move is computed, not listed.** A test moves when three things hold: it imports at least one moving source; it imports no staying source; every test helper it reaches is free of nax imports. Tests that read the disk need an explicit ruling (`STAY_IN_NAX` / `MOVE_DESPITE_DISK`, Task 6). The result is 142 files. The other 177 test files that exercise moved code stay in nax as wiring tests. That includes 8 tests blocked only by a nax-bound helper. Porting them is a carried item. They stay in nax as wiring tests, with their imports rewritten:

| Test (stays in nax) | Blocking helper | nax module it reaches |
|---|---|---|
| `test/unit/tools/runtime-command-shadow-executed.test.ts` | `mock-logger` | `logger/index` |
| `test/unit/tools/runtime-sandbox-argv.test.ts` | `mock-logger` | `logger/index` |
| `test/unit/tools/tool-audit.test.ts` | `warn-spy` | `logger/index` |
| `test/unit/sandbox/launcher-session-tmp.test.ts` | `warn-spy` | `logger/index` |
| `test/unit/tools/scratchpad.test.ts` | `assert-nax-error` | `errors.ts` |
| `test/unit/utils/bun-deps.test.ts` | `assert-nax-error` | `errors.ts` |
| `test/unit/agents/native/tier-providers.test.ts` | `mock-nax-config` | `config/index` |
| `test/integration/tools/tool-audit-partial-close.test.ts` | `runtime` | `agents/index`, `config/index` and 10 more |
3. **Spec deviation (section 8): shared test helpers live once in nax-agent and are reached through a package subpath, not a tsconfig alias.** The 13 helpers the moved tests reach are all used by staying tests too, `temp` by 418 of them. They move to `packages/nax-agent/test/helpers/`. nax keeps a one-line shim at each old path (`export * from "@nathapp/nax-agent/test/helpers/<name>"`), so nax's barrel and its 1400+ tests are untouched. nax-agent exports `"./test/helpers/*"`. The spec's `@agent-test/*` alias was rejected on measurement for two reasons. Bun reads `paths` only from `tsconfig.json`, not `tsconfig.test.json`. And `tsc -p tsconfig.test.json` fails with TS6059 for every helper outside `rootDir`, which the subpath avoids because package-resolved files count as external. `check-package-boundaries` allows the subpath only from nax's `test/`.
4. **The entries are generated with `export *`, routed by a fixed rule.**
   - **`.`** (`src/index.ts`) re-exports the contract directory `session/`, the native, tools, permissions, sandbox and command-safety barrels, and the cost core. It also exports `configureCredentials` / `setAgentLogger` and the slot types explicitly.
   - **`/internal`** (`src/internal.ts`) re-exports every module a staying nax file reaches outside that list. That covers deep modules and statements that import a `_` seam.
   - **Namespace imports.** Every namespace import a staying file uses becomes `export * as <name>Module`. A spy on it then patches the real module (probed). There are 9, all in staying tests.
   - **Why not named lists.** Explicit name lists would need type-versus-value detection, because Bun rejects `export { T }` for a type. `export *` needs none.
   - **Collisions.** An ambiguous name is dropped silently at runtime, but tsc reports it (TS2308) on the entry file. That happens in both packages' typecheck, because nax's program reaches the entries. One ambiguity exists and is settled in `EXPLICIT_REEXPORTS`: `NO_OP_INTERACTION_HANDLER` from `session/interaction-handler`, the `InteractionHandler`-typed alias.
   - **Seams on `.`.** The `_` seams of the public barrels are also reachable through `.`. S2, which publishes the package, prunes the public surface.
5. **`/internal` is not a lightweight entry.** The spec wanted `NaxError` through `/internal` "so loading `NaxError` does not load the whole agent". With `export *` over 68 modules, `/internal` loads most of the agent. This costs nothing in S1: nax bundles everything, and nax-agent never imports nax, so no cycle is possible. S2 revisits entry granularity together with publishing.
6. **Spec deviation (section 7): gates that guard moved code are widened, not copied.** `check-nax-error`, `check-file-sizes`, `check-complexity`, `check-import-cycles` (which learns `#src/`), `check-test-as-unknown-as` and `check-test-escape-hatches` each take `--package=<dir>`. The baseline then lives in `<package>/scripts/baselines/`. Eight more already take a root or use the cwd: `check-git-spawn-env`, `check-sandbox-imports`, `check-nax-ai-imports`, `check-no-control-bytes`, `check-no-real-global-nax`, `check-permission-mode-ssot`, `check-feature-dir-ssot` and `check-package-frame-derivation`. The last four were added by the final review, which ran them from packages/nax-agent: the moved code passes all four, and without them it would silently leave their scan. nax-agent's `lint:checks` runs all fourteen from `../nax/scripts`. This keeps one implementation per gate, and each baseline moves with its files.

Three gates stay nax-only on purpose, and none loses coverage:
- `check-logger-storyid` scans only `pipeline/stages` and `review`; moved code logs through the `AgentLogger` slot.
- `check-op-tool-capability` loads nax's `src/operations`.
- `check-bash-dispatch-ask` counts the same 14 nax call sites after the move.

Deferred to the arc (carried): `check-alias-internals`, `check-test-satellites` and `check-worktree-id-ssot` for nax-agent (none is path-parameterised; the last one's two moved allow-list entries are deleted in Task 10), and moving the gate scripts into a shared tooling location (S2).
7. **Spec deviation (section 4.1): nax-agent's coverage is gated by nax's coverage job, which runs nax-agent's tests too.** nax-agent's own 142 test files reach 77.54% lines and leave 54 files below the 80% per-file floor. The rest of their coverage comes from the 177 nax tests that stay. A nax-agent-only gate would either fail or need its floors lowered. Instead, `check-coverage` adds `../nax-agent/test/unit/` and `../nax-agent/test/integration/` to its single invocation, under nax's preload, which those tests ran under until now. It also counts `../nax-agent/src/` records. The gate therefore measures exactly what it measured before the move: 96.80% lines on the prototype, against 96.80% in S1-4's PR. A self-hosted nax-agent coverage gate becomes possible once the wiring tests are ported. That is carried to S2, which needs it for Node CI anyway.
8. **Spec deviation (section 4.1): Biome rules are not hoisted.** Measured on Biome 2.5.10:
   - `"root": false` inherits nothing.
   - `"extends": "//"` inherits rules but re-roots the root's `files.includes` (`packages/**`), so a nested package checks 0 files.
   - The complexity cap is not common (nax 60, nax-ai 176), and `noRestrictedImports` exists only in nax.
   - Six tests under `test/unit/scripts/biome-*` pin nax's own config file.

   Instead, the script derives nax-agent's `biome.json` from nax's. It keeps the same `linter` and `formatter` blocks, references the plugin files from `../nax/biome-plugins/`, and drops the overrides that name nax-only paths. A parity test (Task 10) pins the copy. Hoisting is a follow-up chore.
9. **`check-adapter-no-config-import.sh` drops `src/agents/native/`.** Its greps end in `|| true`, so with the directory gone it would scan nothing and still print OK. In nax-agent, `check-package-boundaries` forbids every import of nax, plugins included. The script keeps scanning nax's shells (`acp/`, `native-agent/`). Its plugin-rule tests plant fixtures under `native-agent/`.
10. **Moved tests land where their subject landed.** A test's directory mirrors the manifest move of the source it tests: `test/unit/agents/native/session/x.test.ts` -> `test/unit/native/session/x.test.ts`, and `test/unit/utils/bun-deps.test.ts` -> `test/unit/internal/bun-deps.test.ts`. A test with no mirrored source keeps its path. The depth is preserved, so `corpus-fixture.test.ts`'s `import.meta.dir` read stays valid.
11. **nax-agent's preload is its own:** a temp `NAX_GLOBAL_CONFIG_DIR`; the credentials slot filled the way nax's CLI fills it, reading `<dir>/config.json`'s `auth` with the schema defaults; `*_API_KEY` scrubbed; console silenced; the `_clientDeps.build` sentinel. nax's preload also does ACP, Telegram, trust and precheck work, which stays in nax. All 142 moved files pass under both preloads.
12. **CI: a `nax-agent` job runs typecheck, `check:all`, unit and integration tests.** It has no build step (nothing is published in S1) and no coverage step (Decision 7). It installs bubblewrap like nax's job, because the sandbox unit tests probe for it. Branch protection's required checks are configured outside the repo, so the user adds the new job there.
13. **Spec deviation (section 6): docs.** The live agent guidance is updated in this PR: `.nax/context.md`, the `.nax/mono/packages/*/context.md` sources and their generated files, and the `.nax/rules` frontmatter and text. `docs/architecture/*`, ADRs and guides keep the old paths. They describe history (ADRs) or need a rewrite rather than a path swap (architecture). That is carried.

## Review Focus

1. **A staying nax test that spies on a moved module through a namespace import** (`spyOn(transcriptStore, "retainTranscript")` in `adapter-close-physical-session.test.ts`, created by Task 1). Expected: the spy still intercepts the agent's own call. It patches the real module's namespace, which `/internal` re-exports with `export * as`. Pinned by that test passing after the move (Task 9, step 4). Bun 1.4 also behaved this way in a standalone probe.
2. **A moved test that silently depended on nax's preload** (credentials slot, env scrub, client sentinel). Expected: it passes under nax-agent's own preload and under nax's. Pinned by Task 9, steps 4 and 5: nax-agent's `bun run test`, and nax's coverage run, which executes the same files under nax's preload.
3. **Two modules exporting the same name through `export *`.** Expected: a typecheck failure, never a silently missing export. Pinned by Task 9, step 3 (both typechecks), and by the `EXPLICIT_REEXPORTS` entry. If it were removed, TS2308 would return on `src/index.ts`.
4. **A fresh clone or CI run** (`bun install --frozen-lockfile`). Expected: the install succeeds and nax-ai's `prepare` builds its `dist/`, which nax-agent's typecheck reads. Pinned by Task 9, step 2 (the script runs `bun install`, and the lockfile is committed with the move) and Task 12, step 2.
5. **`npm i -g @nathapp/nax` from the published tarball.** Expected: no `workspace:` spec in `dependencies`, nax-agent bundled, every nax-agent runtime dependency declared by nax. Pinned by `check-bundle-externals` invariant 4 (Task 10, step 4) and `npm pack --dry-run` (Task 12, step 3).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/verification/index.ts` | 1 | name `shellQuoteArg` instead of `export *` |
| `test/unit/agents/native/adapter-close-physical-session.test.ts`, `adapter-credential-probe.test.ts` | 1 | split out of the two tests the move would push past 800 lines |
| `scripts/lib/import-specifiers.ts` | 2 | find and rewrite import specifiers (shared) |
| `scripts/lib/package-root.ts` | 3 | `--package=<dir>` for gates; per-package baseline path |
| `scripts/check-{nax-error,file-sizes,complexity,import-cycles,test-as-unknown-as,test-escape-hatches}.ts` | 3 | scan another package |
| `scripts/check-coverage.ts` | 4 | count nax-agent's suites and sources |
| `scripts/check-package-boundaries.ts` | 5 | the section 7 gate |
| `scripts/lib/s1-move/{resolve,plan}.ts` | 6 | what moves, and where |
| `scripts/lib/s1-move/{entries,rewrite,scaffold}.ts`, `scripts/s1-move.ts` | 7 | rewrites, entries, package files; the orchestrator |
| `packages/nax-agent/**` | 9 | generated by the script |
| `scripts/lib/agent-bundling.ts`, `scripts/check-{bundle-externals,nax-ai-pin,nax-ai-imports}.ts`, `scripts/check-adapter-no-config-import.sh`, `scripts/check-worktree-id-ssot.ts` | 10 | post-move gate updates |
| `test/unit/scripts/nax-agent-biome-parity.test.ts` | 10 | pins nax-agent's copied rule set |
| `.github/workflows/ci.yml`, `.nax/**`, `.claude/rules/**`, `packages/*/{CLAUDE,AGENTS,GEMINI,codex}.md` | 11 | CI job, nax config, rules, generated agent files |

Deleted in Task 10: `scripts/s1-move.ts`, `scripts/lib/s1-move/`, `scripts/s1-move-manifest.json`, `scripts/lib/agent-move-manifest.ts`, `scripts/check-agent-boundary.ts`, `scripts/baselines/agent-boundary-baseline.json` and their tests.

---

### Task 1: Pre-move prep (behaviour-neutral)

Two edits the move needs and cannot make itself. The script refuses `export * from <moved module>` in a staying file, because routing it would re-export all of `/internal` from nax's verification barrel. And two tests that stay in nax would cross the 800-line cap once their imports are rewritten.

**Files:**
- Modify: `src/verification/index.ts:16`
- Create: `test/unit/agents/native/adapter-close-physical-session.test.ts`, `test/unit/agents/native/adapter-credential-probe.test.ts`
- Modify: `test/unit/agents/native/adapter-complete-rates.test.ts` (remove lines 706-800 and nine imports), `test/unit/agents/native/adapter.test.ts` (remove lines 433-481)

- [ ] **Step 1: Name the shell-quote export.** In `src/verification/index.ts` replace line 16:

```ts
export * from "./shell-quote";
```
with
```ts
export { shellQuoteArg } from "./shell-quote";
```
`src/verification/shell-quote.ts` exports exactly that one function (4 lines).

- [ ] **Step 2: Split the close-physical-session block out of `adapter-complete-rates.test.ts`.** Cut lines 706-800, from `// RE-ARCH: keep` through the end of the final `describe("native closePhysicalSession ...")`, into a new file. Create `test/unit/agents/native/adapter-close-physical-session.test.ts` with this header and imports, followed by the cut lines unchanged:

```ts
/**
 * Native session teardown: a physical close, reached from the run's story close
 * or from a failing transcript retain, clears every module-level session map
 * and removes a successful session's transcript.
 *
 * Split out of adapter-complete-rates.test.ts (S1-5) by concern; the cases are
 * unchanged.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import * as sessionState from "@/agents/native/session/session";
import { openNativeSession } from "@/agents/native/session/session";
import * as transcriptStore from "@/agents/native/session/transcript-store";
import { NativeAgentAdapter } from "@/agents/native-agent";
import type { OpenSessionOpts } from "@/agents/session-types";
import { closeStorySessions } from "@/execution/session-manager-runtime";
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import { SessionManager } from "@/session/manager";
import { byCodePoint } from "@/utils/sort";
```

Then remove from `adapter-complete-rates.test.ts` the imports only the cut block used (measured on `ce87ea571`):
- `beforeEach` and `spyOn` from `bun:test`;
- `rm` from `node:fs/promises` (keep `mkdtemp`);
- `makeNaxConfig`;
- `* as sessionState`, `* as transcriptStore`, `closeStorySessions`, `DEFAULT_SPIN_BREAKER_SETTINGS`, `byCodePoint`;
- `openNativeSession` and `import type { OpenSessionOpts }` (final review: unused after the cut).

Keep `saveTranscript` and `SessionManager`, which the remaining cases use. `bun x biome check test/unit/agents/native/adapter-complete-rates.test.ts` must report no unused import.

- [ ] **Step 3: Split the credential-probe blocks out of `adapter.test.ts`.** Cut lines 433-481, the `describe("isInstalled")` and `describe("hasCredentials")` blocks. Create `test/unit/agents/native/adapter-credential-probe.test.ts` with this header and the cut lines unchanged:

```ts
/**
 * The native adapter's install and credential probes: always installed (in
 * process), credentialed when a credential is stored or ambient, and fail-open
 * when the store cannot be read.
 *
 * Split out of adapter.test.ts (S1-5) by concern; the cases are unchanged.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _adapterDeps } from "@/agents/native/adapter-deps";
import { NativeAgentAdapter } from "@/agents/native-agent";

const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});
```

`adapter.test.ts` keeps all its imports, because every one is used elsewhere in it.

- [ ] **Step 4: Verify.**

```bash
bun test test/unit/agents/native/adapter-complete-rates.test.ts test/unit/agents/native/adapter-close-physical-session.test.ts test/unit/agents/native/adapter.test.ts test/unit/agents/native/adapter-credential-probe.test.ts --timeout=60000
wc -l test/unit/agents/native/adapter-complete-rates.test.ts test/unit/agents/native/adapter.test.ts
bun run typecheck && bun run lint
```
Expected: the same number of passing tests as the two original files had (split, not dropped), and both originals well under 790 lines.

- [ ] **Step 5: Commit.**

```bash
git add src/verification/index.ts test/unit/agents/native/
git commit -m "refactor: prepare packages/nax for the S1-5 move"
```

---

### Task 2: A shared import-specifier library

`check-agent-boundary.ts:34-36,49-58` already finds specifiers. The move script and `check-package-boundaries` also need each site's offset (to rewrite it) and its statement prelude (to see `import * as` and `export *`). One library serves all three.

**Files:**
- Create: `scripts/lib/import-specifiers.ts`, `test/unit/scripts/import-specifiers.test.ts`
- Modify: `scripts/check-agent-boundary.ts:34-36,49-58`

**Interfaces:**
- Produces: `specifierSites(source): SpecifierSite[]` (`{ spec, start, kind: "static" | "side-effect" | "dynamic", prelude }`), `specifiersOf(source): string[]`, `rewriteSpecifiers(source, map: (site) => SiteRewrite): string`, where `SiteRewrite = string | { statement: string } | null`.

- [ ] **Step 1: Write the failing test** `test/unit/scripts/import-specifiers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { rewriteSpecifiers, specifierSites } from "@scripts/lib/import-specifiers";

describe("specifierSites", () => {
  test("finds static, type-only, multi-line, side-effect, dynamic and inline type sites in source order", () => {
    const src = [
      'import { a } from "./a";',
      'import type { B } from "@/b";',
      "import {",
      "  c,",
      "  d,",
      '} from "../cd";',
      'import "./side";',
      'export * as ns from "./ns";',
      'type E = import("./e").E;',
      'const f = await import("@/f");',
    ].join("\n");
    expect(specifierSites(src).map((s) => [s.spec, s.kind])).toEqual([
      ["./a", "static"],
      ["@/b", "static"],
      ["../cd", "static"],
      ["./side", "side-effect"],
      ["./ns", "static"],
      ["./e", "dynamic"],
      ["@/f", "dynamic"],
    ]);
  });

  test("records the statement prelude of a static site", () => {
    const [site] = specifierSites('  import * as tools from "@/tools";\n');
    expect(site?.prelude).toBe("  import * as tools from ");
  });

  test("ignores specifiers inside comments", () => {
    expect(specifierSites('// import { x } from "./x";\n/* import("./y") */\n')).toEqual([]);
  });
});

describe("rewriteSpecifiers", () => {
  test("replaces only the sites the map changes, leaving the rest of the text alone", () => {
    const src = 'import { a } from "./a";\nimport { b } from "./b";\nconst c = import("./a");\n';
    const out = rewriteSpecifiers(src, (site) => (site.spec === "./a" ? "#src/a" : null));
    expect(out).toBe('import { a } from "#src/a";\nimport { b } from "./b";\nconst c = import("#src/a");\n');
  });

  test("replaces a whole statement and keeps its indentation", () => {
    const src = '  import * as ts from "@/tools/x";\nexport const y = 1;\n';
    const out = rewriteSpecifiers(src, () => ({ statement: 'import { xModule as ts } from "pkg/internal"' }));
    expect(out).toBe('  import { xModule as ts } from "pkg/internal";\nexport const y = 1;\n');
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `bun test test/unit/scripts/import-specifiers.test.ts --timeout=60000` fails with "Cannot find module".

- [ ] **Step 3: Implement** `scripts/lib/import-specifiers.ts`:

```ts
/**
 * Import specifiers in TypeScript source, found and rewritten by regex.
 *
 * Used by the package-boundary gates and the S1-5 move script. Matches run on
 * comment-stripped text (stripComments keeps every offset), so a specifier
 * inside a comment is never reported or rewritten.
 *
 * Covered forms: `import ... from "x"` and `export ... from "x"` (type-only and
 * multi-line included), side-effect `import "x"`, dynamic `import("x")` and
 * inline type references `import("x").T`.
 */
import { stripComments } from "../check-import-cycles";

const STATIC_RE = /^[ \t]*(?:import|export)\s+(?:type\s+)?[A-Za-z0-9_$*,{}\s]*?from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** One specifier occurrence. `prelude` is the statement text before the quote (empty for `import("x")`). */
export interface SpecifierSite {
  readonly spec: string;
  /** Offset of the first character of the specifier (inside the quotes). */
  readonly start: number;
  readonly kind: "static" | "side-effect" | "dynamic";
  readonly prelude: string;
}

export function specifierSites(source: string): SpecifierSite[] {
  const text = stripComments(source);
  const sites: SpecifierSite[] = [];
  const add = (re: RegExp, kind: SpecifierSite["kind"]) => {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec === undefined || m.index === undefined) continue;
      const at = m[0].lastIndexOf(spec);
      sites.push({ spec, start: m.index + at, kind, prelude: kind === "dynamic" ? "" : m[0].slice(0, at - 1) });
    }
  };
  add(STATIC_RE, "static");
  add(SIDE_EFFECT_RE, "side-effect");
  add(DYNAMIC_RE, "dynamic");
  return sites.sort((a, b) => a.start - b.start);
}

export function specifiersOf(source: string): string[] {
  return specifierSites(source).map((s) => s.spec);
}

/** A rewrite of one site: a new specifier, or a replacement for the whole statement up to the closing quote. */
export type SiteRewrite = string | { readonly statement: string } | null;

function statementStart(site: SpecifierSite): number {
  return site.start - 1 - site.prelude.length;
}

/**
 * Replaces specifiers. `map` returns the new specifier, a whole-statement
 * replacement (static sites only), or `null` to keep the site unchanged.
 * Offsets are applied back to front, so earlier ones stay valid.
 */
export function rewriteSpecifiers(source: string, map: (site: SpecifierSite) => SiteRewrite): string {
  let out = source;
  for (const site of [...specifierSites(source)].reverse()) {
    const next = map(site);
    if (next === null || next === site.spec) continue;
    if (typeof next === "string") {
      out = out.slice(0, site.start) + next + out.slice(site.start + site.spec.length);
      continue;
    }
    const indent = site.prelude.match(/^[ \t]*/)?.[0] ?? "";
    out = out.slice(0, statementStart(site)) + indent + next.statement + out.slice(site.start + site.spec.length + 1);
  }
  return out;
}
```

- [ ] **Step 4: Point the ratchet at the library.** In `scripts/check-agent-boundary.ts`, delete the three regex constants (lines 34-36) and the `specifiersOf` function (lines 49-58), each with its trailing blank line. Keep `BoundaryEdge` and `Baseline` (lines 38-47). Add `import { specifiersOf } from "./lib/import-specifiers";` and keep the name exported for `test/unit/scripts/check-agent-boundary.test.ts`: `export { specifiersOf } from "./lib/import-specifiers";`. Remove `stripComments` from its `./check-import-cycles` import if nothing else in the file uses it.

- [ ] **Step 5: Verify and commit.**

```bash
bun test test/unit/scripts/import-specifiers.test.ts test/unit/scripts/check-agent-boundary.test.ts --timeout=60000
bun run check:agent-boundary && bun run typecheck && bun run lint
git add scripts/lib/import-specifiers.ts scripts/check-agent-boundary.ts test/unit/scripts/import-specifiers.test.ts
git commit -m "refactor: share import-specifier parsing between the boundary scripts"
```
Expected: `[OK] agent-boundary edges: 0`.

---

### Task 3: Gates scan another package (`--package=<dir>`)

After the move, nax-agent runs these gates from `../nax/scripts` over itself (Decision 6). Run without the flag, each gate behaves exactly as today.

**Files:**
- Create: `scripts/lib/package-root.ts`, `test/unit/scripts/package-root.test.ts`
- Modify: `scripts/check-nax-error.ts:26-27`, `scripts/check-file-sizes.ts:27-28`, `scripts/check-complexity.ts:66-69`, `scripts/check-import-cycles.ts:49-50,201-205`, `scripts/check-test-as-unknown-as.ts:28,30`, `scripts/check-test-escape-hatches.ts:90,92`

**Interfaces:**
- Produces: `gatePackageRoot(scriptDir, argv = process.argv): string`, `gateBaselinePath(packageRoot, file): string`.

- [ ] **Step 1: Write the failing test** `test/unit/scripts/package-root.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { gateBaselinePath, gatePackageRoot } from "@scripts/lib/package-root";

describe("gatePackageRoot", () => {
  test("defaults to the package the script lives in", () => {
    expect(gatePackageRoot("/repo/packages/nax/scripts", ["bun", "check.ts"])).toBe(join("/repo/packages/nax"));
  });

  test("resolves a relative --package against the cwd", () => {
    expect(gatePackageRoot("/repo/packages/nax/scripts", ["bun", "check.ts", "--package=."])).toBe(
      resolve(process.cwd(), "."),
    );
  });

  test("takes an absolute --package as is", () => {
    expect(gatePackageRoot("/x/scripts", ["bun", "check.ts", "--package=/repo/packages/nax-agent"])).toBe(
      "/repo/packages/nax-agent",
    );
  });
});

describe("gateBaselinePath", () => {
  test("puts the baseline under the scanned package's scripts/baselines", () => {
    expect(gateBaselinePath("/repo/packages/nax-agent", "complexity-baseline.json")).toBe(
      "/repo/packages/nax-agent/scripts/baselines/complexity-baseline.json",
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail** (module not found).

- [ ] **Step 3: Implement** `scripts/lib/package-root.ts`:

```ts
/**
 * Which package a gate scans. A gate in packages/nax/scripts scans packages/nax
 * by default; `--package=<dir>` (relative to the cwd) points it at another
 * package, which is how packages/nax-agent runs nax's gates over its own code
 * (S1 spec section 7). A baseline lives with the package it describes.
 */
import { isAbsolute, join, resolve } from "node:path";

const FLAG = "--package=";

export function gatePackageRoot(scriptDir: string, argv: readonly string[] = process.argv): string {
  const flag = argv.find((a) => a.startsWith(FLAG));
  if (flag === undefined) return join(scriptDir, "..");
  const dir = flag.slice(FLAG.length);
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}

export function gateBaselinePath(packageRoot: string, file: string): string {
  return join(packageRoot, "scripts", "baselines", file);
}
```

- [ ] **Step 4: Apply the same two-line edit to six gates.** Add `import { gateBaselinePath, gatePackageRoot } from "./lib/package-root";`. Replace `const ROOT = join(import.meta.dir, "..");` with `const ROOT = gatePackageRoot(import.meta.dir);`. Replace the baseline constant's `join(import.meta.dir, "baselines", "<file>")` with `gateBaselinePath(ROOT, "<file>")`:

| Script | Lines | Baseline file |
|---|---|---|
| `check-nax-error.ts` | 26-27 | `nax-error-baseline.json` |
| `check-file-sizes.ts` | 27-28 | `file-sizes-baseline.json` |
| `check-complexity.ts` | 66-67 (`DEFAULT_BASELINE_FILE`) | `complexity-baseline.json` |
| `check-import-cycles.ts` | 49-50 | `import-cycles-baseline.json` |
| `check-test-as-unknown-as.ts` | 28, 30 | `test-as-unknown-as-baseline.json` |
| `check-test-escape-hatches.ts` | 90, 92 | `test-escape-hatches-baseline.json` |

For nax the result is identical: `join(scriptDir, "..", "scripts", "baselines")` is the old `join(import.meta.dir, "baselines")`. Two more edits:
- `check-complexity.ts:69`. nax-agent has no `bin/` and no `scripts/` sources, and Biome errors on a missing path. Replace the line with:
  ```ts
  /** Directories this package has; packages/nax-agent has no bin/ or scripts sources. */
  const SCAN_DIRS = ["src/", "bin/", "test/", "scripts/"].filter((dir) => existsSync(join(ROOT, dir)));
  ```
  `existsSync` is already imported at line 61.
- `check-import-cycles.ts`, in `resolveSpecifier` (line 203). nax-agent writes `#src/`. After `if (spec.startsWith("@/")) base = join(rootDir, "src", spec.slice(2));` add:
  ```ts
  else if (spec.startsWith("#src/")) base = join(rootDir, "src", spec.slice(5));
  ```
  Add to `test/unit/scripts/check-import-cycles.test.ts`, inside `describe("resolveSpecifier")` after the `@/` case:
  ```ts
  test("resolves a #src/ package import to src/ (nax-agent's form; it does no index resolution)", () => {
    const from = join(root, "src/a/leaf.ts");
    expect(resolveSpecifier(root, from, "#src/a/index")).toBe(join(root, "src/a/index.ts"));
  });
  ```

- [ ] **Step 5: Verify and commit.**

```bash
bun test test/unit/scripts/package-root.test.ts test/unit/scripts/check-import-cycles.test.ts test/unit/scripts/check-complexity.test.ts --timeout=60000
bun run lint
git add scripts/ test/unit/scripts/
git commit -m "refactor: let the source and test gates scan another package"
```
Expected: `bun run lint` runs every gate against nax with unchanged results.

---

### Task 4: The coverage gate counts nax-agent's suites and sources

Decision 7. Before the move this changes nothing: the suite paths are filtered by existence and no lcov record starts with `../nax-agent/`.

**Files:**
- Modify: `scripts/check-coverage.ts:73-98,211-269,393,452`
- Test: `test/unit/scripts/check-coverage.test.ts` (two new cases)

- [ ] **Step 1: Write the failing tests.** In `test/unit/scripts/check-coverage.test.ts`, add inside `describe("parseLcov")`, before `"the scope prefix is injectable"`:

```ts
  test("counts nax-agent's sources, as lcov names them from nax", () => {
    const totals = parseLcov(
      lcovWithFns([
        ["src/a.ts", 9, 10, 4, 5],
        ["../nax-agent/src/b.ts", 10, 10, 5, 5],
        ["../nax-agent/test/helpers/temp.ts", 0, 40, 0, 8],
      ]),
    );

    expect(totals).toEqual({ linesFound: 20, linesHit: 19, fnFound: 10, fnHit: 9 });
  });
```
and inside `describe("parsePerFileLines")`:
```ts
  test("reports nax-agent's files under their lcov path", () => {
    const perFile = parsePerFileLines(lcov([["../nax-agent/src/tools/git.ts", 9, 10]]));
    expect([...perFile.keys()]).toEqual(["../nax-agent/src/tools/git.ts"]);
  });
```

- [ ] **Step 2: Run to see both fail.** `bun test test/unit/scripts/check-coverage.test.ts --timeout=60000`

- [ ] **Step 3: Implement.** In `scripts/check-coverage.ts`, after line 73 (`const AGGREGATE_SCOPE_PREFIX = "src/";`) add:

```ts

/**
 * nax-agent's sources, as lcov names them from this package (`../nax-agent/src/...`).
 * nax's own tests still exercise them, and nax-agent's tests run in the same
 * invocation (AGENT_SUITES), so the gate measures exactly the union it measured
 * before the S1-5 move. nax-agent's own tests alone do not reach the floor yet.
 */
const AGENT_SCOPE_PREFIX = "../nax-agent/src/";
const SCOPE_PREFIXES: readonly string[] = [AGGREGATE_SCOPE_PREFIX, AGENT_SCOPE_PREFIX];

function inScope(file: string, prefixes: string | readonly string[]): boolean {
  return (typeof prefixes === "string" ? [prefixes] : prefixes).some((p) => file.startsWith(p));
}
```
Then:
- rename `PER_FILE_SCOPE_PREFIX` to `PER_FILE_SCOPE_PREFIXES` at lines 77, 253, 269 and 393; line 77 becomes `const PER_FILE_SCOPE_PREFIXES = SCOPE_PREFIXES;`
- line 98:
  ```ts
  const AGENT_SUITES = ["../nax-agent/test/unit/", "../nax-agent/test/integration/"];
  const GATED_SUITES = ["test/unit/", "test/integration/", "test/ui/", ...AGENT_SUITES.filter((s) => existsSync(join(ROOT, s)))];
  ```
- `parseLcov`: the signature becomes `(text: string, scopePrefixes: string | readonly string[] = SCOPE_PREFIXES)`. Rename the local `inScope` flag to `included`, set it with `included = inScope(line.slice(colon + 1), scopePrefixes);`, and update its doc comment to name `SCOPE_PREFIXES`.
- `parsePerFileLines` (line 269): `if (file !== null && inScope(file, PER_FILE_SCOPE_PREFIXES)) result.set(file, pct(lh, lf));`.
- The two report lines (393, 452): print `PER_FILE_SCOPE_PREFIXES.join(", ")` and `SCOPE_PREFIXES.join(", ")`.

The existing test `"the scope prefix is injectable"` still passes a single string. That is why `inScope` accepts both forms.

- [ ] **Step 4: Verify and commit.**

```bash
bun test test/unit/scripts/check-coverage.test.ts --timeout=60000
bun run lint
git add scripts/check-coverage.ts test/unit/scripts/check-coverage.test.ts
git commit -m "refactor: let the coverage gate count nax-agent's suites and sources"
```
Do not run `test:coverage` here. It is unchanged until nax-agent exists and runs in Task 9.

---

### Task 5: `check-package-boundaries`

Spec section 7. Before the move it passes vacuously: no nax-agent package exists, and nax imports no `@nathapp/nax-agent`.

**Files:**
- Create: `scripts/check-package-boundaries.ts`, `test/unit/scripts/check-package-boundaries.test.ts`
- Modify: `package.json` (`check:package-boundaries`, and its entry in `lint:checks`)

**Interfaces:**
- Consumes: `specifierSites` (Task 2), `findRepoRoot` (`scripts/lib/repo-root.ts`).
- Produces: `findBoundaryViolations(repoRoot): BoundaryViolation[]` (`{ file, spec, why }`).

- [ ] **Step 1: Write the failing test** `test/unit/scripts/check-package-boundaries.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBoundaryViolations } from "@scripts/check-package-boundaries";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** A clean three-package workspace; each test adds one violation. */
function workspace(): void {
  root = makeTempDir("package-boundaries-");
  write("packages/nax/package.json", JSON.stringify({ name: "@nathapp/nax" }));
  write(
    "packages/nax-agent/package.json",
    JSON.stringify({ name: "@nathapp/nax-agent", dependencies: { zod: "^4", "@nathapp/nax-ai": "0.1.16" } }),
  );
  write("packages/nax-ai/package.json", JSON.stringify({ name: "@nathapp/nax-ai" }));
  write(
    "packages/nax/src/a.ts",
    'import { x } from "@nathapp/nax-agent";\nimport { y } from "@nathapp/nax-agent/internal";\n',
  );
  write("packages/nax/test/a.test.ts", 'import { t } from "@nathapp/nax-agent/test/helpers/temp";\n');
  write(
    "packages/nax-agent/src/tools/index.ts",
    'import { z } from "zod";\nimport { join } from "node:path";\nimport { s } from "#src/internal/sort";\nimport { r } from "./runtime";\n',
  );
  write(
    "packages/nax-agent/test/unit/a.test.ts",
    'import { test } from "bun:test";\nimport { h } from "#test/helpers/temp";\n',
  );
  write("packages/nax-ai/src/index.ts", 'import { p } from "@earendil-works/pi-ai";\n');
}

function whys(): string[] {
  return findBoundaryViolations(root).map((v) => `${v.file} ${v.spec} ${v.why}`);
}

describe("check-package-boundaries", () => {
  test("a clean workspace passes", () => {
    workspace();
    expect(whys()).toEqual([]);
  });

  test("nax-agent may not use a tsconfig alias, import nax, or import an undeclared package", () => {
    workspace();
    write(
      "packages/nax-agent/src/bad.ts",
      'import { a } from "@/config";\nimport { n } from "@nathapp/nax";\nimport { c } from "chalk";\n',
    );
    expect(whys()).toEqual([
      "packages/nax-agent/src/bad.ts @/config tsconfig alias",
      "packages/nax-agent/src/bad.ts @nathapp/nax imports nax",
      "packages/nax-agent/src/bad.ts chalk undeclared dependency chalk",
    ]);
  });

  test("nax-agent's src may not import a devDependency; its tests may", () => {
    workspace();
    write(
      "packages/nax-agent/package.json",
      JSON.stringify({ name: "@nathapp/nax-agent", dependencies: { zod: "^4" }, devDependencies: { chalk: "^5" } }),
    );
    write("packages/nax-agent/src/bad.ts", 'import { c } from "chalk";\n');
    write("packages/nax-agent/test/unit/ok.test.ts", 'import { c } from "chalk";\n');
    expect(whys()).toEqual(["packages/nax-agent/src/bad.ts chalk devDependency chalk imported outside test/"]);
  });

  test("nax-agent may not reach out of the package by a relative path", () => {
    workspace();
    write("packages/nax-agent/src/bad.ts", 'import { a } from "../../nax/src/config";\n');
    expect(whys()).toEqual(["packages/nax-agent/src/bad.ts ../../nax/src/config relative import leaves the package"]);
  });

  test("nax may use only the two entries, and the test helpers only from test/", () => {
    workspace();
    write(
      "packages/nax/src/bad.ts",
      'import { g } from "@nathapp/nax-agent/src/tools/git";\nimport { t } from "@nathapp/nax-agent/test/helpers/temp";\n',
    );
    expect(whys()).toHaveLength(2);
  });

  test("nax may not reach nax-agent by a relative path", () => {
    workspace();
    write("packages/nax/src/bad.ts", 'import { g } from "../../nax-agent/src/tools/git";\n');
    expect(whys()).toEqual([
      "packages/nax/src/bad.ts ../../nax-agent/src/tools/git relative import leaves the package",
    ]);
  });

  test("nax-ai imports neither nax nor nax-agent", () => {
    workspace();
    write("packages/nax-ai/src/bad.ts", 'import { a } from "@nathapp/nax-agent";\nimport { n } from "@nathapp/nax";\n');
    expect(whys()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to see it fail** (module not found).

- [ ] **Step 3: Implement** `scripts/check-package-boundaries.ts`:

```ts
#!/usr/bin/env bun
/**
 * Gate: the workspace package boundaries (S1 spec section 7). Replaces the S1
 * move ratchet (check-agent-boundary) once nax-agent is a package.
 *
 * - packages/nax-agent imports only node:/bun builtins, its declared
 *   dependencies, `#src/` and `#test/`, relative paths that stay inside the
 *   package, and itself. Never `@nathapp/nax`, never a tsconfig alias (`@/`).
 * - packages/nax-ai imports neither @nathapp/nax nor @nathapp/nax-agent.
 * - packages/nax reaches nax-agent only through `@nathapp/nax-agent` or
 *   `@nathapp/nax-agent/internal`, plus `@nathapp/nax-agent/test/helpers/*`
 *   from its own tests. Never a relative path into another package.
 *
 * Scans src/, test/, bin/ and scripts/ of every package.
 *
 * Usage:
 *   bun scripts/check-package-boundaries.ts            # check the repo this script lives in
 *   bun scripts/check-package-boundaries.ts <repoRoot>  # check another tree (tests)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { byCodePoint } from "../src/utils/sort";
import { specifierSites } from "./lib/import-specifiers";
import { findRepoRoot } from "./lib/repo-root";

export interface BoundaryViolation {
  readonly file: string;
  readonly spec: string;
  readonly why: string;
}

interface PackageInfo {
  readonly dir: string;
  readonly name: string;
  /** Runtime dependencies: importable from anywhere in the package. */
  readonly deps: ReadonlySet<string>;
  /** devDependencies: importable from test/ only (nax bundles src/, so src/ may need only what nax ships). */
  readonly devDeps: ReadonlySet<string>;
}

const CODE = /\.(?:ts|tsx|mts|cts)$/;
const SCAN_DIRS = ["src", "test", "bin", "scripts"];
const AGENT = "@nathapp/nax-agent";
const NAX_ALLOWED_AGENT_SPECS = new Set([AGENT, `${AGENT}/internal`]);
const NAX_TEST_HELPERS = `${AGENT}/test/helpers/`;

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return codeFiles(full);
    return CODE.test(name) ? [full] : [];
  });
}

function loadPackage(dir: string): PackageInfo {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    dir,
    name: pkg.name,
    deps: new Set(Object.keys(pkg.dependencies ?? {})),
    devDeps: new Set(Object.keys(pkg.devDependencies ?? {})),
  };
}

function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:");
}

function leavesPackage(pkg: PackageInfo, file: string, spec: string): boolean {
  if (!spec.startsWith(".")) return false;
  const rel = relative(pkg.dir, resolve(dirname(file), spec));
  return rel === ".." || rel.startsWith(`..${sep}`);
}

function agentViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (isBuiltin(spec) || spec.startsWith("#src/") || spec.startsWith("#test/")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  if (spec.startsWith("@/") || spec.startsWith("@test/") || spec.startsWith("@scripts/")) return "tsconfig alias";
  const name = packageName(spec);
  if (name === "@nathapp/nax") return "imports nax";
  if (name === AGENT || pkg.deps.has(name)) return null;
  const inTests = relative(pkg.dir, file).startsWith(`test${sep}`);
  if (pkg.devDeps.has(name)) return inTests ? null : `devDependency ${name} imported outside test/`;
  return `undeclared dependency ${name}`;
}

function naxAiViolation(_pkg: PackageInfo, _file: string, spec: string): string | null {
  const name = packageName(spec);
  return name === "@nathapp/nax" || name === AGENT ? `nax-ai imports ${name}` : null;
}

function naxViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (leavesPackage(pkg, file, spec)) return "relative import leaves the package";
  if (packageName(spec) !== AGENT || NAX_ALLOWED_AGENT_SPECS.has(spec)) return null;
  const inTests = relative(pkg.dir, file).startsWith(`test${sep}`);
  if (inTests && spec.startsWith(NAX_TEST_HELPERS)) return null;
  return `only ${[...NAX_ALLOWED_AGENT_SPECS].join(" or ")} (and ${NAX_TEST_HELPERS}* from test/)`;
}

type Rule = (pkg: PackageInfo, file: string, spec: string) => string | null;

const RULES: Readonly<Record<string, Rule>> = {
  "@nathapp/nax-agent": agentViolation,
  "@nathapp/nax-ai": naxAiViolation,
  "@nathapp/nax": naxViolation,
};

export function findBoundaryViolations(repoRoot: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const packagesDir = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesDir).sort(byCodePoint)) {
    const dir = join(packagesDir, entry);
    if (!existsSync(join(dir, "package.json"))) continue;
    const pkg = loadPackage(dir);
    const rule = RULES[pkg.name];
    if (rule === undefined) continue;
    for (const file of SCAN_DIRS.flatMap((d) => codeFiles(join(dir, d)))) {
      for (const site of specifierSites(readFileSync(file, "utf8"))) {
        const why = rule(pkg, file, site.spec);
        if (why !== null) violations.push({ file: relative(repoRoot, file), spec: site.spec, why });
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const root = process.argv[2] ?? findRepoRoot(import.meta.dir);
  const violations = findBoundaryViolations(root);
  if (violations.length > 0) {
    console.error(`[FAIL] ${violations.length} package-boundary violation(s):`);
    for (const v of violations) console.error(`  ${v.file}: "${v.spec}" -- ${v.why}`);
    process.exit(1);
  }
  console.log("[OK] package boundaries hold");
}
```

`codeFiles` walks directories in `readdirSync` order. The test's ordered expectations come from a single planted file, whose sites `specifierSites` returns in source order.

- [ ] **Step 4: Wire it.** In `package.json`, add `"check:package-boundaries": "bun run scripts/check-package-boundaries.ts"` after `check:agent-boundary:update`. In `lint:checks`, add `&& bun run check:package-boundaries` right after `bun run check:agent-boundary`. `check:gate-reachability` fails on an unwired gate.

- [ ] **Step 5: Verify and commit.**

```bash
bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000
bun run check:package-boundaries && bun run lint
git add scripts/check-package-boundaries.ts test/unit/scripts/check-package-boundaries.test.ts package.json
git commit -m "feat: add check-package-boundaries for the workspace packages"
```
Expected: `[OK] package boundaries hold` on the repo.

---

### Task 6: The move script, part 1 — what moves, and where

**Files:**
- Create: `scripts/lib/s1-move/resolve.ts`, `scripts/lib/s1-move/plan.ts`, `test/unit/scripts/s1-move-plan.test.ts`

**Interfaces:**
- Consumes: `loadMoveManifest`, `isInMoveSet`, `destinationOf` (`scripts/lib/agent-move-manifest.ts`); `specifierSites` (Task 2).
- Produces:
  - `resolve.ts`: `isLocalSpecifier(spec)`, `resolveInPackage(root, fromRel, spec): string | null` (package-relative), `toRel(root, abs)`.
  - `plan.ts`:
    - `FileMove` (`{ from, to }`; `from` relative to packages/nax, `to` to packages/nax-agent) and `MovePlan` (`{ sources, tests, helpers, fixtures }`).
    - `buildMovePlan(root, manifest)`, `listFiles(root, dir)`, `barrelMap(root)`, `importsOf(root, rel, barrel)`, `makeHelperCheck(root, manifest, barrel)`, `helperClosure(root, seeds, barrel)`, `testDestination(manifest, rel)`, `classifyTest(...)`.
    - `exportedNames(clause)`, `importedNames(clause)`, `STAY_IN_NAX`, `MOVE_DESPITE_DISK`, `FIXTURES`.

- [ ] **Step 1: Write the failing test** `test/unit/scripts/s1-move-plan.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMoveManifest } from "@scripts/lib/agent-move-manifest";
import { barrelMap, buildMovePlan, exportedNames, importedNames, testDestination } from "@scripts/lib/s1-move/plan";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

const MANIFEST = parseMoveManifest({
  entries: [
    { from: "src/moving/", to: "lib/" },
    { from: "src/utils/one.ts", to: "internal/one.ts" },
  ],
});

/** A package where a.test.ts can move, b.test.ts needs a nax-bound helper, c.test.ts tests staying code. */
function fixture(): void {
  root = makeTempDir("s1-move-plan-");
  write("src/moving/a.ts", 'import { one } from "@/utils/one";\nexport const a = one;\n');
  write("src/moving/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
  write("src/utils/one.ts", "export const one = 1;\n");
  write("src/stays/c.ts", 'import { a } from "@/moving/a";\nexport const c = a;\n');
  write(
    "test/helpers/index.ts",
    'export { makeTemp } from "./temp";\nexport { type Cfg, makeConfig } from "./config";\n',
  );
  write("test/helpers/temp.ts", 'import { one } from "@/utils/one";\nexport const makeTemp = () => one;\n');
  write(
    "test/helpers/config.ts",
    'import { c } from "@/stays/c";\nexport type Cfg = 1;\nexport const makeConfig = () => c;\n',
  );
  write("test/unit/moving/a.test.ts", 'import { a } from "@/moving/a";\nimport { makeTemp } from "@test/helpers";\n');
  write("test/unit/moving/b.test.ts", 'import { b } from "@/moving/b";\nimport { makeConfig } from "@test/helpers";\n');
  write("test/unit/stays/c.test.ts", 'import { c } from "@/stays/c";\n');
  write("test/unit/utils/one.test.ts", 'import { one } from "../../../src/utils/one";\n');
}

describe("clause parsing", () => {
  test("exportedNames takes the alias, importedNames the original", () => {
    expect(exportedNames(" a, type B, c as d ")).toEqual(["a", "B", "d"]);
    expect(importedNames(" a, type B, c as d ")).toEqual(["a", "B", "c"]);
  });
});

describe("barrelMap", () => {
  test("maps every barrel name to its helper module", () => {
    fixture();
    expect([...barrelMap(root)]).toEqual([
      ["makeTemp", "test/helpers/temp.ts"],
      ["Cfg", "test/helpers/config.ts"],
      ["makeConfig", "test/helpers/config.ts"],
    ]);
  });

  test("refuses a barrel that uses export *", () => {
    fixture();
    write("test/helpers/index.ts", 'export * from "./temp";\n');
    expect(() => barrelMap(root)).toThrow("export *");
  });
});

describe("testDestination", () => {
  test("mirrors the manifest move of the tested source, file or directory", () => {
    expect(testDestination(MANIFEST, "test/unit/moving/a.test.ts")).toBe("test/unit/lib/a.test.ts");
    expect(testDestination(MANIFEST, "test/unit/moving/acs.test.ts")).toBe("test/unit/lib/acs.test.ts");
    expect(testDestination(MANIFEST, "test/unit/utils/one.test.ts")).toBe("test/unit/internal/one.test.ts");
    expect(testDestination(MANIFEST, "test/unit/other/x.test.ts")).toBe("test/unit/other/x.test.ts");
  });
});

describe("buildMovePlan", () => {
  test("moves the manifest sources, the clean tests and the helpers they reach", () => {
    fixture();
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.sources).toEqual([
      { from: "src/moving/a.ts", to: "src/lib/a.ts" },
      { from: "src/moving/b.ts", to: "src/lib/b.ts" },
      { from: "src/utils/one.ts", to: "src/internal/one.ts" },
    ]);
    expect(plan.tests).toEqual([
      { from: "test/unit/moving/a.test.ts", to: "test/unit/lib/a.test.ts" },
      { from: "test/unit/utils/one.test.ts", to: "test/unit/internal/one.test.ts" },
    ]);
    expect(plan.helpers).toEqual([{ from: "test/helpers/temp.ts", to: "test/helpers/temp.ts" }]);
  });

  test("a moving test that reads the disk needs an explicit ruling", () => {
    fixture();
    write("test/unit/moving/disk.test.ts", 'import { a } from "@/moving/a";\nconst here = import.meta.dir;\n');
    expect(() => buildMovePlan(root, MANIFEST)).toThrow("test/unit/moving/disk.test.ts");
  });

  test("a test whose helper reaches staying code stays", () => {
    fixture();
    rmSync(join(root, "test/unit/moving/a.test.ts"));
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.tests.map((t) => t.from)).toEqual(["test/unit/utils/one.test.ts"]);
    expect(plan.helpers).toEqual([]);
  });
});
```

The fixture declares no `FIXTURES` files. `buildMovePlan` lists them from the module constant, and this fixture's assertions never reach that list. A fixture file the tree lacks is caught when Task 7's `moveFiles` runs `git mv`.

- [ ] **Step 2: Run to see it fail** (module not found).

- [ ] **Step 3: Implement** `scripts/lib/s1-move/resolve.ts`:

```ts
/**
 * Resolves a specifier written in a packages/nax file to the file it names, as
 * a path relative to the package root. Covers the tsconfig aliases (`@/`,
 * `@test/`, `@scripts/`) and relative specifiers; a bare package specifier
 * resolves to null.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SUFFIXES = ["/index.ts", ".ts", ".tsx", "/index.tsx"] as const;
const ALIASES: Readonly<Record<string, string>> = { "@/": "src", "@test/": "test", "@scripts/": "scripts" };

/** True for a specifier that must resolve inside the package (alias or relative). */
export function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith(".") || Object.keys(ALIASES).some((a) => spec.startsWith(a));
}

function baseFor(root: string, fromRel: string, spec: string): string | null {
  for (const [alias, dir] of Object.entries(ALIASES)) {
    if (spec.startsWith(alias)) return join(root, dir, spec.slice(alias.length));
  }
  if (spec.startsWith("./") || spec.startsWith("../")) return resolve(dirname(join(root, fromRel)), spec);
  return null;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function resolveInPackage(root: string, fromRel: string, spec: string): string | null {
  const base = baseFor(root, fromRel, spec)?.replace(/\.js$/, "");
  if (base === undefined) return null;
  for (const suffix of SUFFIXES) {
    if (isFile(`${base}${suffix}`)) return toRel(root, `${base}${suffix}`);
  }
  return isFile(base) ? toRel(root, base) : null;
}
```

and `scripts/lib/s1-move/plan.ts`:

```ts
/**
 * S1-5 move plan: which files leave packages/nax for packages/nax-agent, and
 * where they land (S1 spec sections 6 and 8).
 *
 * - Sources: every file the manifest names.
 * - Tests: a test moves when it imports at least one moving source, imports no
 *   source that stays, and every test helper it reaches is free of nax imports.
 *   Tests that read files from disk need an explicit ruling (the two lists below).
 * - Helpers: every helper a moving test reaches. nax keeps a one-line shim at the
 *   old path, so its own tests and barrel are untouched.
 * - Fixtures: data files a moving test reads, listed by hand.
 *
 * Paths: `from` is relative to packages/nax, `to` to packages/nax-agent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { byCodePoint } from "@/utils/sort";
import { destinationOf, isInMoveSet, type MoveManifest } from "../agent-move-manifest";
import { specifierSites } from "../import-specifiers";
import { isLocalSpecifier, resolveInPackage } from "./resolve";

export interface FileMove {
  readonly from: string;
  readonly to: string;
}

export interface MovePlan {
  readonly sources: readonly FileMove[];
  readonly tests: readonly FileMove[];
  readonly helpers: readonly FileMove[];
  readonly fixtures: readonly FileMove[];
}

/** Read nax files from disk and must stay with them, although their imports would let them move. */
export const STAY_IN_NAX: ReadonlySet<string> = new Set(["test/unit/execution/command-interceptor.test.ts"]);
/**
 * Mention the disk but stay valid after the move: one reads a fixture relative to
 * its own location (the mirrored destination keeps the path), two only pass the
 * cwd as a harmless working directory.
 */
export const MOVE_DESPITE_DISK: ReadonlySet<string> = new Set([
  "test/unit/command-safety/corpus-fixture.test.ts",
  "test/unit/sandbox/srt-backend.test.ts",
  "test/unit/utils/argv-exec.test.ts",
]);
/** Data files that move with the tests that read them. */
export const FIXTURES: readonly string[] = ["test/fixtures/command-safety/corpus.jsonl"];

const BARREL = "test/helpers/index.ts";
const DISK_MARKER = /import\.meta\.(?:dir|url)|__dirname|process\.cwd\(\)/;
const TEST_FILE = /\.test\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;
const BARREL_EXPORT = /export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

export function listFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(root, child)).isDirectory()) visit(child);
      else out.push(child);
    }
  };
  visit(dir);
  return out.sort(byCodePoint);
}

/** `a`, `type B`, `c as d` -> the names as exported (`a`, `B`, `d`). */
export function exportedNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/).pop() ?? part);
}

/** `a`, `type B`, `c as d` -> the names as imported from the module (`a`, `B`, `c`). */
export function importedNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/)[0] ?? part);
}

/** Barrel name -> helper module (package-relative), from the barrel's named re-exports. */
export function barrelMap(root: string): Map<string, string> {
  const text = readFileSync(join(root, BARREL), "utf8");
  if (/^export\s*\*/m.test(text)) throw new Error(`${BARREL} uses export *; the move script maps names per module`);
  const map = new Map<string, string>();
  for (const m of text.matchAll(BARREL_EXPORT)) {
    const target = resolveInPackage(root, BARREL, m[2] ?? "");
    if (target === null) throw new Error(`${BARREL}: cannot resolve ${m[2]}`);
    for (const name of exportedNames(m[1] ?? "")) map.set(name, target);
  }
  return map;
}

interface TestImports {
  readonly sources: string[];
  readonly helpers: string[];
  readonly unresolved: string[];
}

function clauseOf(prelude: string): string | null {
  return prelude.match(/\{([^}]*)\}/)?.[1] ?? null;
}

function helpersFromBarrel(prelude: string, barrel: Map<string, string>): string[] {
  const clause = clauseOf(prelude);
  if (clause === null) return [...new Set(barrel.values())];
  return importedNames(clause).map((name) => barrel.get(name) ?? `${BARREL}#${name}`);
}

export function importsOf(root: string, rel: string, barrel: Map<string, string>): TestImports {
  const result: TestImports = { sources: [], helpers: [], unresolved: [] };
  for (const site of specifierSites(readFileSync(join(root, rel), "utf8"))) {
    if (!isLocalSpecifier(site.spec)) continue;
    const target = resolveInPackage(root, rel, site.spec);
    if (target === null) result.unresolved.push(site.spec);
    else if (target === BARREL) result.helpers.push(...helpersFromBarrel(site.prelude, barrel));
    else if (target.startsWith("src/")) result.sources.push(target);
    else result.helpers.push(target);
  }
  return result;
}

/** Memoised: does this non-test file under test/ reach only moving sources? */
export function makeHelperCheck(
  root: string,
  manifest: MoveManifest,
  barrel: Map<string, string>,
): (helper: string) => boolean {
  const memo = new Map<string, boolean>();
  const check = (helper: string): boolean => {
    const known = memo.get(helper);
    if (known !== undefined) return known;
    memo.set(helper, true); // optimistic while in progress: a cycle cannot make itself nax-bound
    if (!helper.startsWith("test/") || TEST_FILE.test(helper) || helper.includes("#")) {
      memo.set(helper, false);
      return false;
    }
    const imports = importsOf(root, helper, barrel);
    const free =
      imports.unresolved.length === 0 &&
      imports.sources.every((s) => isInMoveSet(manifest, s)) &&
      imports.helpers.every(check);
    memo.set(helper, free);
    return free;
  };
  return check;
}

export function helperClosure(root: string, seeds: Iterable<string>, barrel: Map<string, string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const helper = stack.pop();
    if (helper === undefined || seen.has(helper)) continue;
    seen.add(helper);
    stack.push(...importsOf(root, helper, barrel).helpers);
  }
  return seen;
}

/** Where a moving test lands: its directory mirrors the manifest move of the source it tests. */
export function testDestination(manifest: MoveManifest, rel: string): string {
  const m = rel.match(/^test\/([^/]+)\/(.*)$/);
  if (m === null) return rel;
  const [, suite, rest = ""] = m;
  const dir = dirname(rest);
  const file = basename(rest);
  const prefix = dir === "." ? "src" : `src/${dir}`;
  const mirrored =
    destinationOf(manifest, `${prefix}/${file.replace(TEST_FILE, ".ts")}`) ??
    destinationOf(manifest, `${prefix}/__mirror_probe__.ts`);
  if (mirrored === undefined) return rel;
  const destDir = dirname(mirrored);
  return destDir === "." ? `test/${suite}/${file}` : `test/${suite}/${destDir}/${file}`;
}

export type TestRuling = "move" | "stay" | "needs-ruling";

export function classifyTest(
  root: string,
  manifest: MoveManifest,
  rel: string,
  barrel: Map<string, string>,
  helperIsFree: (helper: string) => boolean,
): TestRuling {
  if (STAY_IN_NAX.has(rel)) return "stay";
  const imports = importsOf(root, rel, barrel);
  const movable =
    imports.sources.length > 0 &&
    imports.unresolved.length === 0 &&
    imports.sources.every((s) => isInMoveSet(manifest, s)) &&
    imports.helpers.every(helperIsFree);
  if (!movable) return "stay";
  const readsDisk = DISK_MARKER.test(readFileSync(join(root, rel), "utf8"));
  if (readsDisk && !MOVE_DESPITE_DISK.has(rel)) return "needs-ruling";
  return "move";
}

function assertNoCollisions(moves: readonly FileMove[]): void {
  const seen = new Map<string, string>();
  for (const move of moves) {
    const other = seen.get(move.to);
    if (other !== undefined) throw new Error(`${other} and ${move.from} both land at ${move.to}`);
    seen.set(move.to, move.from);
  }
}

export function buildMovePlan(root: string, manifest: MoveManifest): MovePlan {
  const sources = listFiles(root, "src")
    .filter((rel) => SOURCE_FILE.test(rel) && isInMoveSet(manifest, rel))
    .map((rel) => ({ from: rel, to: `src/${destinationOf(manifest, rel)}` }));
  const barrel = barrelMap(root);
  const helperIsFree = makeHelperCheck(root, manifest, barrel);
  const tests: FileMove[] = [];
  const needsRuling: string[] = [];
  for (const rel of listFiles(root, "test").filter((r) => TEST_FILE.test(r))) {
    const ruling = classifyTest(root, manifest, rel, barrel, helperIsFree);
    if (ruling === "move") tests.push({ from: rel, to: testDestination(manifest, rel) });
    if (ruling === "needs-ruling") needsRuling.push(rel);
  }
  if (needsRuling.length > 0) {
    throw new Error(
      `tests that read from disk need a ruling (STAY_IN_NAX or MOVE_DESPITE_DISK):\n  ${needsRuling.join("\n  ")}`,
    );
  }
  const seeds = tests.flatMap((t) => importsOf(root, t.from, barrel).helpers);
  const helpers = [...helperClosure(root, seeds, barrel)].sort(byCodePoint).map((rel) => ({ from: rel, to: rel }));
  const fixtures = FIXTURES.map((rel) => ({ from: rel, to: rel }));
  const plan = { sources, tests, helpers, fixtures };
  assertNoCollisions([...sources, ...tests, ...helpers, ...fixtures]);
  return plan;
}
```

`test/unit/tools/run-command-exec.test.ts` reads a moved file by path but stays: it also imports `@/quality`. That makes it a Task 10 path edit, not a `MOVE_DESPITE_DISK` entry.

- [ ] **Step 4: Verify and commit.**

```bash
bun test test/unit/scripts/s1-move-plan.test.ts --timeout=60000
bun run typecheck && bun run lint
git add scripts/lib/s1-move/ test/unit/scripts/s1-move-plan.test.ts
git commit -m "feat: S1-5 move script planning (what moves, and where)"
```

---

### Task 7: The move script, part 2 — entries, rewrites, scaffold, orchestrator

**Files:**
- Create: `scripts/lib/s1-move/entries.ts`, `scripts/lib/s1-move/rewrite.ts`, `scripts/lib/s1-move/scaffold.ts`, `scripts/s1-move.ts`, `test/unit/scripts/s1-move-rewrite.test.ts`, `test/unit/scripts/s1-move-entries.test.ts`

**Interfaces:**
- Consumes: Task 6's `buildMovePlan`, `listFiles`, `FileMove`, `MovePlan`, `resolveInPackage`, `isLocalSpecifier`; Task 2's `rewriteSpecifiers`, `SiteRewrite`, `SpecifierSite`.
- Produces:
  - `entries.ts`: `packageImportSpec(agentRel)`, `isPublicModule(agentRel)`, `namespaceExportName(agentRel)`, `renderIndex(movedSources)`, `renderInternal(modules, namespaces)`, `assertDistinctNamespaces(namespaces)`, `renderHelperBarrel(naxBarrel, movedHelpers)`, `renderHelperShim(helperRel)`, `EXPLICIT_REEXPORTS`.
  - `rewrite.ts`: `PUBLIC_ENTRY`, `INTERNAL_ENTRY`, `Destinations`, `InternalNeeds` (`{ modules: Set<string>; namespaces: Map<string, string> }`), `rewriteMovedFile(naxRoot, fromRel, source, dest)`, `rewriteStayingFile(naxRoot, fromRel, source, dest, needs)` (both return `{ text, errors }`).
  - `scaffold.ts`: `scaffoldFiles(naxPkg, naxBiome): Map<string, string>`, `agentPackageJson(naxPkg)`, `agentBiomeJson(naxBiome)`, `withAgentDevDependency(naxPackageJsonText)`.

- [ ] **Step 1: Write the failing tests.** `test/unit/scripts/s1-move-rewrite.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTERNAL_ENTRY,
  type InternalNeeds,
  PUBLIC_ENTRY,
  rewriteMovedFile,
  rewriteStayingFile,
} from "@scripts/lib/s1-move/rewrite";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content = "export const x = 1;\n"): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** nax paths -> nax-agent paths for the fixture below. */
const DEST = new Map([
  ["src/agents/native/client.ts", "src/native/client.ts"],
  ["src/agents/native/models.ts", "src/native/models.ts"],
  ["src/tools/index.ts", "src/tools/index.ts"],
  ["src/tools/git.ts", "src/tools/git.ts"],
  ["src/utils/sort.ts", "src/internal/sort.ts"],
  ["test/helpers/temp.ts", "test/helpers/temp.ts"],
  ["test/helpers/index.ts", "test/helpers/index.ts"],
]);

function fixture(): void {
  root = makeTempDir("s1-move-rewrite-");
  for (const rel of DEST.keys()) write(rel);
  write("src/config/index.ts");
}

function needs(): InternalNeeds {
  return { modules: new Set(), namespaces: new Map() };
}

describe("rewriteMovedFile", () => {
  test("keeps a relative specifier whose relation survives, aliases the rest", () => {
    fixture();
    const src = [
      'import { m } from "./models";',
      'import { t } from "@/tools";',
      'import { s } from "../../utils/sort";',
      'import { g } from "@/tools/git";',
    ].join("\n");
    const { text, errors } = rewriteMovedFile(root, "src/agents/native/client.ts", src, DEST);
    expect(errors).toEqual([]);
    expect(text).toBe(
      [
        'import { m } from "./models";',
        'import { t } from "#src/tools/index";',
        'import { s } from "#src/internal/sort";',
        'import { g } from "#src/tools/git";',
      ].join("\n"),
    );
  });

  test("points moved tests at nax-agent's helper barrel", () => {
    fixture();
    const src = 'import { makeTemp } from "@test/helpers";\nimport { t } from "../helpers/temp";\n';
    const { text } = rewriteMovedFile(root, "test/unit/x.test.ts", src, DEST);
    expect(text).toBe('import { makeTemp } from "#test/helpers/index";\nimport { t } from "../helpers/temp";\n');
  });

  test("reports an import of a file that stays in nax", () => {
    fixture();
    const { errors } = rewriteMovedFile(root, "src/tools/git.ts", 'import { c } from "@/config";\n', DEST);
    expect(errors).toEqual(['src/tools/git.ts: "@/config" reaches src/config/index.ts, which stays in nax']);
  });
});

describe("rewriteStayingFile", () => {
  test("routes a public module to the package entry and a deep module to /internal", () => {
    fixture();
    const n = needs();
    const src = 'import { getCodingTool } from "@/tools";\nimport { byCodePoint } from "./utils/sort";\n';
    const { text } = rewriteStayingFile(root, "src/stays.ts", src, DEST, n);
    expect(text).toBe(
      `import { getCodingTool } from "${PUBLIC_ENTRY}";\nimport { byCodePoint } from "${INTERNAL_ENTRY}";\n`,
    );
    expect([...n.modules]).toEqual(["src/internal/sort.ts"]);
  });

  test("routes a public-module import that names a _ seam to /internal", () => {
    fixture();
    const n = needs();
    const { text } = rewriteStayingFile(root, "src/stays.ts", 'import { _bashToolDeps, x } from "@/tools";\n', DEST, n);
    expect(text).toBe(`import { _bashToolDeps, x } from "${INTERNAL_ENTRY}";\n`);
    expect([...n.modules]).toEqual(["src/tools/index.ts"]);
  });

  test("turns a namespace import into the namespace /internal re-exports", () => {
    fixture();
    const n = needs();
    const { text } = rewriteStayingFile(root, "test/a.test.ts", 'import * as gitTool from "@/tools/git";\n', DEST, n);
    expect(text).toBe(`import { gitModule as gitTool } from "${INTERNAL_ENTRY}";\n`);
    expect([...n.namespaces]).toEqual([["src/tools/git.ts", "gitModule"]]);
  });

  test("refuses a wholesale re-export of a moved module", () => {
    fixture();
    const { errors } = rewriteStayingFile(root, "src/stays.ts", 'export * from "./tools/git";\n', DEST, needs());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("export *");
  });

  test("leaves imports of staying code and of the helpers barrel alone", () => {
    fixture();
    // The barrel, not a deep helper path: check-alias-internals flags `@test/<dir>/<file>` even inside a string.
    const src = 'import { c } from "@/config";\nimport { makeTemp } from "@test/helpers";\n';
    expect(rewriteStayingFile(root, "test/a.test.ts", src, DEST, needs()).text).toBe(src);
  });
});
```

`test/unit/scripts/s1-move-entries.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  assertDistinctNamespaces,
  isPublicModule,
  namespaceExportName,
  packageImportSpec,
  renderHelperBarrel,
  renderHelperShim,
  renderIndex,
  renderInternal,
} from "@scripts/lib/s1-move/entries";
import { agentBiomeJson, agentPackageJson, withAgentDevDependency } from "@scripts/lib/s1-move/scaffold";

describe("entries", () => {
  test("the public entry is the contract directory plus the listed barrels", () => {
    expect(isPublicModule("src/session/session-types.ts")).toBe(true);
    expect(isPublicModule("src/tools/index.ts")).toBe(true);
    expect(isPublicModule("src/tools/git.ts")).toBe(false);
    expect(isPublicModule("src/infra/index.ts")).toBe(false);
  });

  test("package import specifiers keep /index and drop the extension", () => {
    expect(packageImportSpec("src/tools/index.ts")).toBe("#src/tools/index");
    expect(packageImportSpec("test/helpers/temp.ts")).toBe("#test/helpers/temp");
  });

  test("namespace export names come from the file, or the directory of an index", () => {
    expect(namespaceExportName("src/native/session/transcript-store.ts")).toBe("transcriptStoreModule");
    expect(namespaceExportName("src/cost/core/index.ts")).toBe("coreModule");
  });

  test("renderIndex re-exports the public modules, the slots and the settled ambiguity", () => {
    const text = renderIndex(["src/tools/git.ts", "src/tools/index.ts", "src/session/session-types.ts"]);
    expect(text).toContain('export * from "#src/session/session-types";\nexport * from "#src/tools/index";\n');
    expect(text).not.toContain("#src/tools/git");
    expect(text).toContain('export { configureCredentials, setAgentLogger } from "#src/infra/index";');
    expect(text).toContain('export { NO_OP_INTERACTION_HANDLER } from "#src/session/interaction-handler";');
  });

  test("renderInternal re-exports the needed modules and namespaces", () => {
    const text = renderInternal(new Set(["src/internal/sort.ts"]), new Map([["src/tools/git.ts", "gitModule"]]));
    expect(text).toContain('export * from "#src/internal/sort";\nexport * as gitModule from "#src/tools/git";\n');
  });

  test("two modules cannot share a namespace export name", () => {
    const errors = assertDistinctNamespaces(
      new Map([
        ["src/a/git.ts", "gitModule"],
        ["src/b/git.ts", "gitModule"],
      ]),
    );
    expect(errors).toEqual(["namespace export gitModule would name both src/a/git.ts and src/b/git.ts"]);
  });

  test("the helper barrel keeps nax's statements for the helpers that moved", () => {
    const barrel = 'export { a } from "./temp";\nexport { type B, c } from "./config";\n';
    expect(renderHelperBarrel(barrel, ["test/helpers/temp.ts"])).toContain('export { a } from "./temp";\n');
    expect(renderHelperBarrel(barrel, ["test/helpers/temp.ts"])).not.toContain("config");
  });

  test("a helper shim re-exports the moved helper through the package", () => {
    expect(renderHelperShim("test/helpers/temp.ts")).toContain(
      'export * from "@nathapp/nax-agent/test/helpers/temp";',
    );
  });
});

describe("scaffold", () => {
  const nax = {
    dependencies: { "@anthropic-ai/sandbox-runtime": "0.0.77", "@nathapp/nax-ai": "0.1.16", zod: "^4.3.6", ink: "^6" },
    devDependencies: { "@biomejs/biome": "2.5.10", "@types/bun": "^1.3.8", "bun-types": "^1.3.9", typescript: "^7.0.2" },
  };

  test("nax-agent's package.json copies nax's versions and declares the entries", () => {
    const pkg = JSON.parse(agentPackageJson(nax));
    expect(pkg.name).toBe("@nathapp/nax-agent");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({
      "@anthropic-ai/sandbox-runtime": "0.0.77",
      "@nathapp/nax-ai": "0.1.16",
      zod: "^4.3.6",
    });
    expect(pkg.exports["./internal"]).toBe("./src/internal.ts");
    expect(pkg.imports).toEqual({ "#src/*": "./src/*.ts", "#test/*": "./test/*.ts" });
  });

  test("a dependency nax does not declare stops the scaffold", () => {
    expect(() => agentPackageJson({ dependencies: {}, devDependencies: nax.devDependencies })).toThrow(
      "declares no version",
    );
  });

  test("nax-agent's biome config is nax's rule set with nax-only overrides dropped", () => {
    const config = JSON.parse(
      agentBiomeJson({
        root: false,
        plugins: ["./biome-plugins/no-as-never.grit"],
        linter: { rules: { recommended: true } },
        overrides: [
          { includes: ["src/**", "!src/cli/**"], plugins: ["./biome-plugins/no-process-cwd.grit"] },
          { includes: ["bin/**", "scripts/**"], linter: {} },
          { includes: ["**/test/**"], plugins: ["./biome-plugins/no-absent-value.grit"] },
        ],
      }),
    );
    expect(config.plugins).toEqual(["../nax/biome-plugins/no-as-never.grit"]);
    expect(config.linter).toEqual({ rules: { recommended: true } });
    expect(config.overrides).toEqual([
      { includes: ["src/**"], plugins: ["../nax/biome-plugins/no-process-cwd.grit"] },
      { includes: ["**/test/**"], plugins: ["../nax/biome-plugins/no-absent-value.grit"] },
    ]);
  });

  test("nax takes nax-agent as a workspace devDependency, never a dependency", () => {
    const pkg = JSON.parse(withAgentDevDependency(JSON.stringify(nax)));
    expect(pkg.devDependencies["@nathapp/nax-agent"]).toBe("workspace:*");
    expect(pkg.dependencies["@nathapp/nax-agent"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see both fail** (modules not found).

- [ ] **Step 3: Implement `scripts/lib/s1-move/entries.ts`:**

```ts
/**
 * The two nax-agent entry points (S1 spec section 4.4) and the moved test
 * helpers' barrel.
 *
 * `.` (src/index.ts) re-exports a fixed list: the session contract, the native
 * barrel, the tool, permission, sandbox and command-safety barrels, the cost
 * core and the two slots. `/internal` (src/internal.ts) re-exports exactly the
 * modules nax reaches outside that list, plus the namespaces nax spies on.
 * Both use `export *` (Bun rejects `export { T }` for a type-only T). tsc reports
 * a name two modules export differently (TS2308); EXPLICIT_REEXPORTS settles one
 * by naming its module, which beats `export *`.
 */
import { basename, dirname } from "node:path";
import { byCodePoint } from "@/utils/sort";

const PUBLIC_FILES: ReadonlySet<string> = new Set([
  "src/native/index.ts",
  "src/tools/index.ts",
  "src/permissions/index.ts",
  "src/sandbox/index.ts",
  "src/command-safety/index.ts",
  "src/cost/core/index.ts",
  "src/cost/estimate.ts",
  "src/cost/usage-math.ts",
  "src/cost/standard-types.ts",
  "src/cost/model-spec.ts",
]);
const CONTRACT_DIR = "src/session";

/** A name `export *` would make ambiguous, re-exported explicitly from the module that owns it. */
export interface ExplicitReexport {
  readonly entry: "index" | "internal";
  readonly name: string;
  readonly module: string;
  readonly typeOnly: boolean;
}

/**
 * Measured on the trial run: `session/interaction-handler` re-declares the no-op
 * handler (typed InteractionHandler) over `session/no-op-interaction-handler`'s
 * constant, so the contract directory exports the name twice.
 */
export const EXPLICIT_REEXPORTS: readonly ExplicitReexport[] = [
  {
    entry: "index",
    name: "NO_OP_INTERACTION_HANDLER",
    module: "src/session/interaction-handler.ts",
    typeOnly: false,
  },
];

/** `src/tools/index.ts` -> `#src/tools/index`; `test/helpers/temp.ts` -> `#test/helpers/temp`. */
export function packageImportSpec(agentRel: string): string {
  return `#${agentRel.replace(/\.tsx?$/, "")}`;
}

export function isPublicModule(agentRel: string): boolean {
  return PUBLIC_FILES.has(agentRel) || dirname(agentRel) === CONTRACT_DIR;
}

function camel(name: string): string {
  return name.replace(/[-_.]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `src/native/session/transcript-store.ts` -> `transcriptStoreModule`; an index takes its directory's name. */
export function namespaceExportName(agentRel: string): string {
  const file = basename(agentRel).replace(/\.tsx?$/, "");
  const stem = file === "index" ? basename(dirname(agentRel)) : file;
  return `${camel(stem)}Module`;
}

function explicitLines(entry: ExplicitReexport["entry"]): string[] {
  return EXPLICIT_REEXPORTS.filter((r) => r.entry === entry).map(
    (r) => `export ${r.typeOnly ? "type " : ""}{ ${r.name} } from "${packageImportSpec(r.module)}";`,
  );
}

const INDEX_HEADER = `/**
 * @nathapp/nax-agent public entry (S1 spec section 4.4): the session contract,
 * the native session adapter, the tool, permission, sandbox and command-safety
 * barrels, the cost core and the process-wide slots.
 *
 * Written by the S1-5 move script; maintained by hand from here on.
 */
`;

const INTERNAL_HEADER = `/**
 * @nathapp/nax-agent/internal: what nax reaches below the public entry -- shared
 * helpers, NaxError, deep modules and the _*Deps test seams (S1 spec section 4.4).
 * Not covered by semver. It re-exports the same module instances, so patching a
 * seam here patches the object the agent reads.
 *
 * Written by the S1-5 move script; maintained by hand from here on.
 */
`;

const SLOTS = [
  'export { configureCredentials, setAgentLogger } from "#src/infra/index";',
  'export type { AgentLogger, CredentialAuthConfig, CredentialsConfig } from "#src/infra/index";',
];

export function renderIndex(movedSources: readonly string[]): string {
  const modules = movedSources.filter(isPublicModule).sort(byCodePoint);
  const stars = modules.map((m) => `export * from "${packageImportSpec(m)}";`);
  return `${INDEX_HEADER}\n${[...stars, ...SLOTS, ...explicitLines("index")].join("\n")}\n`;
}

export function renderInternal(modules: ReadonlySet<string>, namespaces: ReadonlyMap<string, string>): string {
  const stars = [...modules].sort(byCodePoint).map((m) => `export * from "${packageImportSpec(m)}";`);
  const spaces = [...namespaces.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([m, name]) => `export * as ${name} from "${packageImportSpec(m)}";`);
  return `${INTERNAL_HEADER}\n${[...stars, ...spaces, ...explicitLines("internal")].join("\n")}\n`;
}

/** Fails when two modules would share one namespace export name. */
export function assertDistinctNamespaces(namespaces: ReadonlyMap<string, string>): string[] {
  const owner = new Map<string, string>();
  const errors: string[] = [];
  for (const [module, name] of namespaces) {
    const other = owner.get(name);
    if (other !== undefined) errors.push(`namespace export ${name} would name both ${other} and ${module}`);
    owner.set(name, module);
  }
  return errors;
}

const BARREL_STATEMENT = /^export\s*(?:type\s*)?\{[^}]*\}\s*from\s*["']\.\/([^"']+)["'];?$/gm;

/** The moved helpers' barrel: nax's barrel statements whose module moved, unchanged. */
export function renderHelperBarrel(naxBarrel: string, movedHelpers: readonly string[]): string {
  const moved = new Set(movedHelpers.map((h) => basename(h).replace(/\.tsx?$/, "")));
  const lines = [...naxBarrel.matchAll(BARREL_STATEMENT)].filter((m) => moved.has(m[1] ?? "")).map((m) => m[0]);
  return `/** Barrel for nax-agent's test helpers (moved from packages/nax/test/helpers by S1-5). */\n\n${lines.join("\n")}\n`;
}

/** nax's shim at a moved helper's old path: its own tests and barrel keep importing it there. */
export function renderHelperShim(helperRel: string): string {
  const name = helperRel.replace(/^test\//, "").replace(/\.tsx?$/, "");
  return `/** Moved to @nathapp/nax-agent by S1-5; nax keeps this path for its own tests. */\nexport * from "@nathapp/nax-agent/test/${name}";\n`;
}
```

- [ ] **Step 4: Implement `scripts/lib/s1-move/rewrite.ts`:**

```ts
/**
 * Specifier rewrites for the S1-5 move.
 *
 * Moved files: a specifier that reached another moved file keeps its text when
 * the relative path between the two is unchanged; otherwise it becomes
 * `#src/<path>` or `#test/<path>` (package `imports`, which do no index
 * resolution, so an index module keeps its `/index`). A specifier that reaches
 * a file staying in nax is an error: the boundary would break.
 *
 * Staying files: a specifier that reached a moved source becomes
 * `@nathapp/nax-agent` when the module is part of the public entry and the
 * statement imports no `_` seam, otherwise `@nathapp/nax-agent/internal`. A
 * namespace import becomes a named import of the module's namespace, which the
 * internal entry re-exports with `export * as`, so spies still patch the real
 * module. Helpers that moved keep a shim at their old path, so specifiers that
 * reach them stay as they are.
 */
import { dirname, posix } from "node:path";
import { rewriteSpecifiers, type SiteRewrite, type SpecifierSite } from "../import-specifiers";
import { isPublicModule, namespaceExportName, packageImportSpec } from "./entries";
import { isLocalSpecifier, resolveInPackage } from "./resolve";

export const PUBLIC_ENTRY = "@nathapp/nax-agent";
export const INTERNAL_ENTRY = "@nathapp/nax-agent/internal";

/** nax-relative path -> nax-agent-relative destination, for every moved file. */
export type Destinations = ReadonlyMap<string, string>;

/** What the staying files need from the internal entry. Filled while rewriting. */
export interface InternalNeeds {
  readonly modules: Set<string>;
  readonly namespaces: Map<string, string>;
}

export interface RewriteResult {
  readonly text: string;
  readonly errors: readonly string[];
}

function withoutExtension(path: string): string {
  return path.replace(/\.tsx?$/, "");
}

function relativeSpec(fromFile: string, toFile: string): string {
  const rel = posix.relative(dirname(fromFile), withoutExtension(toFile));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function movedSpec(fromRel: string, targetRel: string, site: SpecifierSite, dest: Destinations): string {
  const newFrom = dest.get(fromRel) ?? fromRel;
  const newTarget = dest.get(targetRel) ?? targetRel;
  const keepsRelation = relativeSpec(fromRel, targetRel) === relativeSpec(newFrom, newTarget);
  if (site.spec.startsWith(".") && keepsRelation) return site.spec;
  return packageImportSpec(newTarget);
}

export function rewriteMovedFile(naxRoot: string, fromRel: string, source: string, dest: Destinations): RewriteResult {
  const errors: string[] = [];
  const text = rewriteSpecifiers(source, (site) => {
    if (!isLocalSpecifier(site.spec)) return null;
    const target = resolveInPackage(naxRoot, fromRel, site.spec);
    if (target === null) {
      errors.push(`${fromRel}: cannot resolve "${site.spec}"`);
      return null;
    }
    if (!dest.has(target)) {
      errors.push(`${fromRel}: "${site.spec}" reaches ${target}, which stays in nax`);
      return null;
    }
    return movedSpec(fromRel, target, site, dest);
  });
  return { text, errors };
}

const NAMESPACE_IMPORT = /^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s*$/;
const STAR_EXPORT = /^\s*export\s+\*/;

function importsSeam(prelude: string): boolean {
  const clause = prelude.match(/\{([^}]*)\}/)?.[1] ?? "";
  return /(?:^|[\s,{])(?:type\s+)?_[A-Za-z0-9_$]/.test(` ${clause}`);
}

function stayingRewrite(site: SpecifierSite, agentRel: string, needs: InternalNeeds, errors: string[]): SiteRewrite {
  const namespace = site.prelude.match(NAMESPACE_IMPORT);
  if (namespace !== null) {
    const exported = namespaceExportName(agentRel);
    needs.namespaces.set(agentRel, exported);
    const local = namespace[1] ?? exported;
    const binding = local === exported ? exported : `${exported} as ${local}`;
    return { statement: `import { ${binding} } from "${INTERNAL_ENTRY}"` };
  }
  if (STAR_EXPORT.test(site.prelude)) {
    errors.push(`export * from "${site.spec}" re-exports a moved module wholesale; list the names first`);
    return null;
  }
  if (isPublicModule(agentRel) && !importsSeam(site.prelude)) return PUBLIC_ENTRY;
  needs.modules.add(agentRel);
  return INTERNAL_ENTRY;
}

export function rewriteStayingFile(
  naxRoot: string,
  fromRel: string,
  source: string,
  dest: Destinations,
  needs: InternalNeeds,
): RewriteResult {
  const errors: string[] = [];
  const text = rewriteSpecifiers(source, (site) => {
    if (!isLocalSpecifier(site.spec)) return null;
    const target = resolveInPackage(naxRoot, fromRel, site.spec);
    if (target === null || !target.startsWith("src/")) return null;
    const agentRel = dest.get(target);
    if (agentRel === undefined) return null;
    return stayingRewrite(site, agentRel, needs, errors);
  });
  return { text, errors: errors.map((e) => `${fromRel}: ${e}`) };
}
```

- [ ] **Step 5: Implement `scripts/lib/s1-move/scaffold.ts`.** It holds the nax-agent `package.json`, `biome.json`, `tsconfig.json`, `bunfig.toml`, test preload (Decision 11) and ignore files:

```ts
/**
 * packages/nax-agent's own files (S1 spec section 4.1), derived from
 * packages/nax's where they must agree: dependency versions and the Biome rule
 * set. Returns path (relative to packages/nax-agent) -> content.
 */

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface BiomeOverride {
  includes?: string[];
  plugins?: string[];
  [key: string]: unknown;
}

interface BiomeConfig {
  plugins?: string[];
  overrides?: BiomeOverride[];
  [key: string]: unknown;
}

const RUNTIME_DEPS = ["@anthropic-ai/sandbox-runtime", "@nathapp/nax-ai", "zod"] as const;
const DEV_DEPS = ["@biomejs/biome", "@types/bun", "bun-types", "typescript"] as const;

/** Gates that guard moved code, run from nax's scripts against this package (spec section 7). */
const LINT_CHECKS = [
  "bun ../nax/scripts/check-nax-error.ts --package=.",
  "bun ../nax/scripts/check-file-sizes.ts --package=.",
  "bun ../nax/scripts/check-complexity.ts --package=.",
  "bun ../nax/scripts/check-import-cycles.ts --package=.",
  "bun ../nax/scripts/check-test-as-unknown-as.ts --package=.",
  "bun ../nax/scripts/check-test-escape-hatches.ts --package=.",
  "bun ../nax/scripts/check-no-control-bytes.ts",
  "bun ../nax/scripts/check-no-real-global-nax.ts",
  "bun ../nax/scripts/check-permission-mode-ssot.ts",
  "bun ../nax/scripts/check-feature-dir-ssot.ts",
  "bun ../nax/scripts/check-package-frame-derivation.ts",
  "bun ../nax/scripts/check-git-spawn-env.ts .",
  "bun ../nax/scripts/check-sandbox-imports.ts .",
  "bun ../nax/scripts/check-nax-ai-imports.ts .",
];

function pick(source: Record<string, string> | undefined, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const version = source?.[name];
    if (version === undefined) throw new Error(`packages/nax/package.json declares no version for ${name}`);
    out[name] = version;
  }
  return out;
}

export function agentPackageJson(nax: PackageJson): string {
  const pkg = {
    name: "@nathapp/nax-agent",
    version: "0.0.0",
    private: true,
    description: "nax's native coding agent: session contract, native loop, tools, permissions, sandbox, command-safety.",
    type: "module",
    exports: {
      ".": "./src/index.ts",
      "./internal": "./src/internal.ts",
      "./test/helpers/*": "./test/helpers/*.ts",
    },
    imports: { "#src/*": "./src/*.ts", "#test/*": "./test/*.ts" },
    scripts: {
      typecheck: "bun x tsc --noEmit",
      lint: "bun run lint:biome && bun run lint:checks",
      "lint:biome": "bun x biome check --error-on-warnings --diagnostic-level=warn src/ test/",
      "lint:fix": "bun x biome check --write src/ test/",
      "lint:checks": LINT_CHECKS.join(" && "),
      test: "bun test ./test/unit/ --timeout=60000 && bun test ./test/integration/ --timeout=60000",
      "check:all": "bun run --silent lint",
    },
    dependencies: pick(nax.dependencies, RUNTIME_DEPS),
    devDependencies: pick(nax.devDependencies, DEV_DEPS),
    license: "MIT",
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const REMAPPED_PLUGIN_DIR = "../nax/biome-plugins/";

function remapPlugins(plugins: string[] | undefined): string[] | undefined {
  return plugins?.map((p) => p.replace(/^\.\/biome-plugins\//, REMAPPED_PLUGIN_DIR));
}

function agentOverride(override: BiomeOverride): BiomeOverride | null {
  const includes = override.includes ?? [];
  if (includes.includes("bin/**")) return null; // nax's noConsole carve-outs: no such paths here
  const scoped = includes[0] === "src/**" ? ["src/**"] : includes; // nax's src exclusions name nax dirs
  return { ...override, includes: scoped, plugins: remapPlugins(override.plugins) };
}

/** nax's rule set, with plugin paths pointing at nax's .grit files and nax-only overrides dropped. */
export function agentBiomeJson(nax: BiomeConfig): string {
  const overrides = (nax.overrides ?? []).map(agentOverride).filter((o): o is BiomeOverride => o !== null);
  const config = { ...nax, plugins: remapPlugins(nax.plugins), overrides };
  return `${JSON.stringify(config, null, 2)}\n`;
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

const BUNFIG = `# Bun test configuration for nax-agent (mirrors packages/nax/bunfig.toml).

[test]
smol = true
root = "./test"
timeout = 5000
preload = ["./test/preload.ts"]
`;

const PRELOAD = `/**
 * Bun test preload for nax-agent: runs once before any test file.
 *
 * The parts of packages/nax/test/preload.ts the moved tests rely on: global state
 * redirected to a temp directory, the credentials slot filled the way nax's CLI
 * fills it, provider keys scrubbed from the environment, console silenced, and a
 * sentinel on the native client builder so no test caches a real nax-ai client.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CredentialAuthConfig, configureCredentials } from "#src/infra/index";
import { _clientDeps } from "#src/native/client";

const isolatedGlobalDir = mkdtempSync(join(tmpdir(), "nax-agent-test-global-"));
process.env.NAX_GLOBAL_CONFIG_DIR = isolatedGlobalDir;
delete process.env.NAX_RUNS_DIR;

const configDir = (): string => process.env.NAX_GLOBAL_CONFIG_DIR || isolatedGlobalDir;

/** nax's global auth section with its schema defaults (packages/nax/src/config/schemas-auth.ts). */
async function readAuthConfig(): Promise<CredentialAuthConfig> {
  const file = Bun.file(join(configDir(), "config.json"));
  const config: { auth?: Partial<CredentialAuthConfig> } = (await file.exists()) ? await file.json() : {};
  const auth = config.auth ?? {};
  const exec = auth.exec === undefined ? undefined : { ...auth.exec, timeoutMs: auth.exec.timeoutMs ?? 10_000 };
  return { source: auth.source ?? "file", onChange: auth.onChange ?? "warn", ...(exec === undefined ? {} : { exec }) };
}

configureCredentials({ configDir, readAuthConfig });

for (const key of Object.keys(process.env)) {
  if (/_API_KEY$/.test(key)) delete process.env[key];
}

console.log = () => {};
console.warn = () => {};
console.error = () => {};

_clientDeps.build = () => {
  throw new Error(
    "[test-preload] _clientDeps.build called without a mock: it would build a real nax-ai client " +
      "and cache it for the rest of the process. Mock it in your describe block and call _resetNativeClient() after.",
  );
};
`;

const GITIGNORE = "coverage/\ntest/tmp/\nnode_modules/\n";
const NAXIGNORE = "# nax - scanning exclusions\ncoverage/\nnode_modules/\n";

export function scaffoldFiles(nax: PackageJson, naxBiome: BiomeConfig): Map<string, string> {
  return new Map([
    ["package.json", agentPackageJson(nax)],
    ["biome.json", agentBiomeJson(naxBiome)],
    ["tsconfig.json", TSCONFIG],
    ["bunfig.toml", BUNFIG],
    ["test/preload.ts", PRELOAD],
    [".gitignore", GITIGNORE],
    [".naxignore", NAXIGNORE],
  ]);
}

/** nax's package.json with the workspace devDependency (spec section 4.1: never under dependencies). */
export function withAgentDevDependency(naxPackageJsonText: string): string {
  const pkg = JSON.parse(naxPackageJsonText) as PackageJson;
  const devDependencies = { ...pkg.devDependencies, "@nathapp/nax-agent": "workspace:*" };
  return `${JSON.stringify({ ...pkg, devDependencies }, null, 2)}\n`;
}
```

The preload's `exec` line sets `timeoutMs` after the spread. Writing the default before the spread fails typecheck with TS2783 (measured).

- [ ] **Step 6: Implement the orchestrator `scripts/s1-move.ts`:**

```ts
#!/usr/bin/env bun
/**
 * S1-5: moves the nax-agent move set (scripts/s1-move-manifest.json) out of
 * packages/nax into a new workspace package, packages/nax-agent (S1 spec
 * section 6). Deleted by the same PR once it has run.
 *
 * Usage, from packages/nax on a clean tree:
 *   bun scripts/s1-move.ts --dry-run   # print the plan and the rewrite errors, write nothing
 *   bun scripts/s1-move.ts             # move, rewrite, scaffold, `bun install`, format
 *
 * Every rewrite is computed against the original layout before anything moves.
 * Any boundary error (a moved file reaching a file that stays, a wholesale
 * re-export of a moved module) aborts the run with the tree untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadMoveManifest } from "./lib/agent-move-manifest";
import {
  assertDistinctNamespaces,
  renderHelperBarrel,
  renderHelperShim,
  renderIndex,
  renderInternal,
} from "./lib/s1-move/entries";
import { buildMovePlan, type FileMove, listFiles, type MovePlan } from "./lib/s1-move/plan";
import { type InternalNeeds, rewriteMovedFile, rewriteStayingFile } from "./lib/s1-move/rewrite";
import { scaffoldFiles, withAgentDevDependency } from "./lib/s1-move/scaffold";

const NAX = join(import.meta.dir, "..");
const REPO = join(NAX, "..", "..");
const AGENT = join(REPO, "packages", "nax-agent");
const STAYING_DIRS = ["src", "bin", "scripts", "test"];
const CODE_FILE = /\.tsx?$/;
/** Moved tests that import nax's helper barrel import nax-agent's generated one instead. */
const HELPER_BARREL = "test/helpers/index.ts";

interface Writes {
  readonly moved: Map<string, string>;
  readonly staying: Map<string, string>;
  readonly needs: InternalNeeds;
  readonly errors: string[];
  /** Staying files that name a moved source path in a string or comment (reported, not rewritten). */
  readonly mentions: string[];
}

function allMoves(plan: MovePlan): FileMove[] {
  return [...plan.sources, ...plan.tests, ...plan.helpers, ...plan.fixtures];
}

function mentionsOf(rel: string, source: string, plan: MovePlan): string[] {
  return plan.sources.filter((s) => source.includes(s.from)).map((s) => `${rel} mentions ${s.from}`);
}

function computeWrites(plan: MovePlan): Writes {
  const moves = allMoves(plan);
  const dest = new Map(moves.map((m) => [m.from, m.to]));
  const writes: Writes = {
    moved: new Map(),
    staying: new Map(),
    needs: { modules: new Set(), namespaces: new Map() },
    errors: [],
    mentions: [],
  };
  const movedDest = new Map([...dest, [HELPER_BARREL, HELPER_BARREL]]);
  for (const move of moves.filter((m) => CODE_FILE.test(m.from))) {
    const result = rewriteMovedFile(NAX, move.from, readFileSync(join(NAX, move.from), "utf8"), movedDest);
    writes.moved.set(move.to, result.text);
    writes.errors.push(...result.errors);
  }
  const staying = STAYING_DIRS.flatMap((d) => listFiles(NAX, d)).filter((f) => CODE_FILE.test(f) && !dest.has(f));
  for (const rel of staying) {
    const source = readFileSync(join(NAX, rel), "utf8");
    const result = rewriteStayingFile(NAX, rel, source, dest, writes.needs);
    if (result.text !== source) writes.staying.set(rel, result.text);
    writes.errors.push(...result.errors);
    writes.mentions.push(...mentionsOf(rel, source, plan));
  }
  writes.errors.push(...assertDistinctNamespaces(writes.needs.namespaces));
  return writes;
}

function run(argv: string[], cwd: string): void {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${proc.exitCode}`);
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function assertCleanTree(): void {
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO }).stdout.toString();
  if (status.trim() !== "") throw new Error(`the tree is not clean:\n${status}`);
}

function moveFiles(plan: MovePlan): void {
  for (const move of allMoves(plan)) {
    mkdirSync(dirname(join(AGENT, move.to)), { recursive: true });
    run(["git", "mv", join(NAX, move.from), join(AGENT, move.to)], REPO);
  }
}

function writeEverything(plan: MovePlan, writes: Writes): void {
  for (const [rel, text] of writes.moved) writeFile(join(AGENT, rel), text);
  for (const [rel, text] of writes.staying) writeFile(join(NAX, rel), text);
  for (const helper of plan.helpers) writeFile(join(NAX, helper.from), renderHelperShim(helper.from));
  writeFile(join(AGENT, "src/index.ts"), renderIndex(plan.sources.map((s) => s.to)));
  writeFile(join(AGENT, "src/internal.ts"), renderInternal(writes.needs.modules, writes.needs.namespaces));
  const naxBarrel = readFileSync(join(NAX, "test/helpers/index.ts"), "utf8");
  writeFile(join(AGENT, "test/helpers/index.ts"), renderHelperBarrel(naxBarrel, plan.helpers.map((h) => h.from)));
  const naxPkgText = readFileSync(join(NAX, "package.json"), "utf8");
  const naxBiome = JSON.parse(readFileSync(join(NAX, "biome.json"), "utf8"));
  for (const [rel, text] of scaffoldFiles(JSON.parse(naxPkgText), naxBiome)) writeFile(join(AGENT, rel), text);
  writeFile(join(NAX, "package.json"), withAgentDevDependency(naxPkgText));
}

function printPlan(plan: MovePlan, writes: Writes): void {
  const { sources, tests, helpers, fixtures } = plan;
  console.log(`sources ${sources.length}, tests ${tests.length}, helpers ${helpers.length}, fixtures ${fixtures.length}`);
  console.log(
    `staying files rewritten ${writes.staying.size}; internal modules ${writes.needs.modules.size}; namespaces ${writes.needs.namespaces.size}`,
  );
  for (const t of tests) console.log(`  test ${t.from} -> ${t.to}`);
  for (const h of helpers) console.log(`  helper ${h.from}`);
  for (const m of writes.mentions) console.log(`  mention ${m}`);
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const plan = buildMovePlan(NAX, loadMoveManifest(join(import.meta.dir, "s1-move-manifest.json")));
  const writes = computeWrites(plan);
  printPlan(plan, writes);
  if (writes.errors.length > 0) {
    console.error(`[FAIL] ${writes.errors.length} boundary error(s):\n  ${writes.errors.join("\n  ")}`);
    process.exit(1);
  }
  if (dryRun) return;
  assertCleanTree();
  moveFiles(plan);
  writeEverything(plan, writes);
  run(["bun", "install"], REPO);
  run(["bun", "x", "biome", "check", "--write", "src/", "test/"], AGENT);
  run(["bun", "x", "biome", "check", "--write", ...writes.staying.keys()], NAX);
  console.log("[OK] moved. Next: plan Task 9, step 3 (typecheck both packages).");
}

if (import.meta.main) main();
```

- [ ] **Step 7: Verify and commit.**

```bash
bun test test/unit/scripts/s1-move-plan.test.ts test/unit/scripts/s1-move-rewrite.test.ts test/unit/scripts/s1-move-entries.test.ts --timeout=60000
bun run typecheck && bun run lint
bun run check:complexity
git add scripts/ test/unit/scripts/
git commit -m "feat: S1-5 move script (rewrites, entries, package scaffold)"
```
Expected: the complexity gate passes with no new baseline row. Every new function is at or under 20.

---

### Task 8: Trial run in a throwaway worktree (nothing committed from it)

The spec requires a trial run before the real one. Its numbers must match "Measured before planning". A difference means the base moved or the script is wrong. Fix the script on the branch (commit `fix: ...`), then run the trial again.

- [ ] **Step 1: Make the worktree and install.**

```bash
TRIAL=$(mktemp -d)/s1-5-trial
git worktree add --detach "$TRIAL" HEAD
cd "$TRIAL" && bun install --frozen-lockfile
cd packages/nax
```

- [ ] **Step 2: Dry run.** `bun scripts/s1-move.ts --dry-run | grep -v "^  test \|^  helper "`. Expected:
  - `sources 188, tests 142, helpers 13, fixtures 1` and `staying files rewritten 451; internal modules 68; namespaces 9`.
  - No `[FAIL]`.
  - The `mention` lines include `test/unit/tools/run-command-exec.test.ts` (fixed in Task 10). Every other mention is a comment or a data string; check each one, and do not let any read a moved file from disk.

- [ ] **Step 3: Real run, then the checks of Task 9 steps 3-6** (typecheck, suites, gates, build) in the trial worktree. Expected: the measured numbers in the table above. Lint and gates are clean except the items Task 10 fixes: `check:agent-boundary`'s manifest test, the nax-ai-imports gate tests, the complexity and test-ratchet baselines, `run-command-exec.test.ts`, nax-agent's missing baselines and the reachability of the deleted scripts.

- [ ] **Step 4: Remove the worktree.** `cd <repo> && git worktree remove --force "$TRIAL"`.

---

### Task 9: The move

- [ ] **Step 1: Rebase onto the latest `main`** (`git fetch && git rebase origin/main`). If `main` moved, rerun `bun scripts/s1-move.ts --dry-run`. New manifest-adjacent files may change the counts; a `[FAIL]` or a new disk ruling stops here for a fix. The spec wants the regenerated run merged the same day.

- [ ] **Step 2: Run the move** from `packages/nax`, on a clean tree:

```bash
bun scripts/s1-move.ts
git -C ../.. status --short | awk '{print $1}' | sort | uniq -c
```
Expected: 344 renames (106 pure, 238 with edits), about 455 modifications (451 rewritten files, `package.json`, `bun.lock`, the 13 shims re-staged) and the new nax-agent files. `bun.lock` gains a `packages/nax-agent` workspace block and nax's `"@nathapp/nax-agent": "workspace:*"`.

- [ ] **Step 3: Typecheck both packages.**

```bash
bun run typecheck                            # packages/nax: src, test, scripts
(cd ../nax-agent && bun run typecheck)
```
Expected: both green. A TS2308 on `nax-agent/src/index.ts` or `src/internal.ts` means a new `export *` ambiguity. Add an `EXPLICIT_REEXPORTS` entry naming the module whose binding nax imports, then re-run the script from a reset tree (`git reset --hard && git clean -fd packages/nax-agent`).

- [ ] **Step 4: Run both suites.**

```bash
(cd ../nax-agent && bun run test)            # unit 2116 / 138 files, integration 30 / 4 files, 0 fail
AGENT=1 bun test test/unit/ --timeout=60000 | tail -4        # 19853 tests / 1312 files (with Tasks 1-7's tests)
AGENT=1 bun test test/integration/ --timeout=60000 | tail -4 # 1547 tests / 144 files
AGENT=1 bun test test/ui/ --timeout=60000 | tail -4 && bun run test:e2e | tail -4
```
Expected: nax unit shows exactly 3 failures, all fixed in Task 10:
- `committed manifest > loads and every entry exists on disk`
- `check-complexity script > passes against a baseline that matches the tree`
- `RunCommand argv branch > the argv branch's whole file never reaches the shell executor`

Integration, ui and e2e are green. Conservation: nax unit + nax-agent unit = the branch's pre-move unit total. Measure it at the commit before the move: 21969 / 1450 in the final review, which is `main`'s 21924 / 1442 plus Tasks 1-7's 45 tests in 8 files. Record both totals for the PR.

- [ ] **Step 5: Build and pack.**

```bash
bun run build && bun dist/nax.js --version && grep -c "$(git rev-parse --short HEAD)" dist/nax.js
npm pack --dry-run 2>&1 | tail -12
rm -rf dist
```
Expected: the build succeeds, the version prints, the commit appears at least once (`GIT_COMMIT`), the pack lists 5 files, and `package.json` `dependencies` is unchanged.

- [ ] **Step 6: Commit the generated move as it stands.**

```bash
git -C ../.. add -A
git commit -m "refactor: move the native coding agent into packages/nax-agent (scripted)

Generated by packages/nax/scripts/s1-move.ts: 188 sources, 142 tests, 13 test
helpers and 1 fixture moved; 446 nax files rewritten to @nathapp/nax-agent or
@nathapp/nax-agent/internal; entries, scaffold and bun.lock generated. The
follow-up commits fix the gates and baselines this commit leaves stale."
```

---

### Task 10: Post-move gates, baselines and deletions

Every edit here is a gate or a test whose subject moved. Commit in the order given, so each commit leaves its own gate green.

**Files:**
- Modify: `test/unit/tools/run-command-exec.test.ts:114`, `scripts/check-nax-ai-imports.ts`, `test/unit/scripts/check-nax-ai-imports.test.ts`, `scripts/check-adapter-no-config-import.sh`, `test/unit/scripts/check-adapter-no-config-import.test.ts`, `scripts/check-bundle-externals.ts`, `scripts/check-nax-ai-pin.ts`, `test/unit/scripts/check-nax-ai-pin.test.ts`, `scripts/check-worktree-id-ssot.ts:86,126`, `scripts/command-safety-eval.ts:5`, `scripts/check-nax-artifacts-untracked.ts:98`, `package.json`
- Create: `scripts/lib/agent-bundling.ts`, `test/unit/scripts/agent-bundling.test.ts`, `test/unit/scripts/nax-agent-biome-parity.test.ts`, `packages/nax-agent/scripts/baselines/*.json`
- Delete: see the File Structure section.

- [ ] **Step 1: The staying test that reads a moved file.** In `test/unit/tools/run-command-exec.test.ts:114`, the URL becomes `"../../../../nax-agent/src/tools/run-command-exec.ts"`. In its comment above (line 110), change `src/tools/run-command-exec.ts` to `packages/nax-agent/src/tools/run-command-exec.ts`. Then run `bun test test/unit/tools/run-command-exec.test.ts --timeout=60000`.

- [ ] **Step 2: `check-nax-ai-imports` gets per-package allow-lists.** In `scripts/check-nax-ai-imports.ts`, replace the header's first paragraph (lines 4-6; line 7 is the ` *` separator, keep it) with:

```ts
 * Fails if @nathapp/nax-ai is imported outside the allow-listed sites of the
 * package being scanned (read from its package.json name):
 * - packages/nax: src/agents/catalog/ only. nax reaches the R3 usage and rate
 *   types through @nathapp/nax-agent's re-export (S1 spec section 7).
 * - packages/nax-agent: src/native/ and the R3 re-export src/cost/standard-types.ts.
```
Replace lines 19-24 (`const ROOT` through `ALLOWED_FILES`) with:

```ts
const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");

interface AllowList {
  readonly prefixes: readonly string[];
  readonly files: readonly string[];
}

const NAX: AllowList = { prefixes: [join("src", "agents", "catalog") + sep], files: [] };
const NAX_AGENT: AllowList = {
  prefixes: [join("src", "native") + sep],
  files: [join("src", "cost", "standard-types.ts")],
};

async function allowListFor(root: string): Promise<AllowList> {
  const pkg = Bun.file(join(root, "package.json"));
  const name = (await pkg.exists()) ? ((await pkg.json()) as { name?: string }).name : undefined;
  return name === "@nathapp/nax-agent" ? NAX_AGENT : NAX;
}

const ALLOWED = await allowListFor(ROOT);
```
Then the skip line becomes `if (ALLOWED.prefixes.some((prefix) => rel.startsWith(prefix)) || ALLOWED.files.includes(rel)) continue;`. The failure message becomes ``console.error(`@nathapp/nax-ai may only be imported from ${[...ALLOWED.prefixes, ...ALLOWED.files].join(", ")}:`);``.

In `test/unit/scripts/check-nax-ai-imports.test.ts`, add `const AGENT_PACKAGE_JSON = JSON.stringify({ name: "@nathapp/nax-agent" });` above `tree()` and change three tests whose subject moved:
- `"passes when nax-ai is imported only from src/agents/native"` becomes `"nax-agent: passes when nax-ai is imported only from src/native"`. Its tree is `{ "package.json": AGENT_PACKAGE_JSON, "src/native/client.ts": <same import>, "src/session/session-types.ts": 'import type { NativeSessionAdapter } from "#src/native/index";\n' }`, and it still expects code 0.
- `"passes when nax-ai is imported from BOTH native and catalog prefixes"` becomes `"nax: src/agents/native is no longer an allowed site, since the native agent moved to nax-agent"`. Its tree is the same two files without `registry.ts`. It expects a non-zero code, output containing `src/agents/native/client.ts`, and output not containing `src/agents/catalog/lookup.ts:`.
- `"passes for the S1-1 staging re-export file"` / `"still fails for a sibling of the staging file"` become `"nax-agent: passes for the R3 re-export file"` / `"nax-agent: still fails for a sibling of the re-export file"`. Their trees gain `"package.json": AGENT_PACKAGE_JSON` and use `src/cost/standard-types.ts` / `src/cost/estimate.ts`.

Verify: `bun test test/unit/scripts/check-nax-ai-imports.test.ts --timeout=60000 && bun run check:nax-ai-imports && (cd ../nax-agent && bun ../nax/scripts/check-nax-ai-imports.ts .)`.

- [ ] **Step 3: `check-adapter-no-config-import.sh` stops scanning a directory that no longer exists** (Decision 9).
  - Line 2: `src/agents/{acp,native,native-agent}/` becomes `src/agents/{acp,native-agent}/`.
  - Line 10 becomes:
    ```bash
    # src/agents/native/ moved to packages/nax-agent (S1-5); check-package-boundaries keeps it free of nax.
    scan_dirs="src/agents/acp/ src/agents/native-agent/"
    ```
  - Lines 18-20 read "Block reaching the plugin system from the native loop ... nothing under src/agents/native/ may depend on src/plugins (the coding agent must stay extractable)". They become "Block reaching the plugin system from an adapter ... no adapter may depend on src/plugins."
  - In `test/unit/scripts/check-adapter-no-config-import.test.ts`, the four fixtures `"src/agents/native/x.ts"` become `"src/agents/native-agent/x.ts"`. The depth is the same, so the relative-path cases keep their specifiers.
  - In `check-adapter-no-config-import.test.ts`'s header comment, replace the first paragraph with: "nax's adapter shells (`src/agents/native-agent/`, `src/agents/acp/`) must not reach into the plugin system. The native loop itself moved to packages/nax-agent in S1-5, where check-package-boundaries forbids any import of nax, plugins included."

- [ ] **Step 4: Bundle layout and the nax-ai pin cover nax-agent.** Create `scripts/lib/agent-bundling.ts`:

```ts
/**
 * nax bundles @nathapp/nax-agent into dist/nax.js instead of installing it
 * (S1 spec section 4.1), so the published package.json must never name it as a
 * dependency, and every runtime dependency of nax-agent must be one nax's
 * consumers install. Called from check-bundle-externals.
 */

export interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const AGENT = "@nathapp/nax-agent";

export function checkAgentBundling(nax: PackageJsonShape, agent: PackageJsonShape): string[] {
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(nax.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) failures.push(`nax dependency ${name} uses ${spec}; npm cannot install it`);
  }
  if (nax.devDependencies?.[AGENT] !== "workspace:*") {
    failures.push(`nax must list ${AGENT} as a devDependency "workspace:*" (it is bundled, not installed)`);
  }
  if (nax.scripts?.build?.includes(`--external "${AGENT}"`)) {
    failures.push(`the build script must bundle ${AGENT}, not mark it --external`);
  }
  for (const [name, spec] of Object.entries(agent.dependencies ?? {})) {
    const declared = nax.dependencies?.[name];
    if (declared !== spec) {
      failures.push(`nax-agent depends on ${name}@${spec}; nax must declare the same in dependencies (found ${declared})`);
    }
  }
  return failures;
}
```
and its test `test/unit/scripts/agent-bundling.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { checkAgentBundling } from "@scripts/lib/agent-bundling";

const NAX = {
  scripts: { build: 'bun build bin/nax.ts --external "@nathapp/nax-ai"' },
  dependencies: { "@nathapp/nax-ai": "0.1.16", zod: "^4.3.6" },
  devDependencies: { "@nathapp/nax-agent": "workspace:*" },
};
const AGENT = { dependencies: { "@nathapp/nax-ai": "0.1.16", zod: "^4.3.6" } };

describe("checkAgentBundling", () => {
  test("the bundled layout passes", () => {
    expect(checkAgentBundling(NAX, AGENT)).toEqual([]);
  });

  test("a workspace: spec in nax's dependencies fails, since npm cannot install it", () => {
    const nax = { ...NAX, dependencies: { ...NAX.dependencies, "@nathapp/nax-agent": "workspace:*" } };
    expect(checkAgentBundling(nax, AGENT)).toEqual([
      "nax dependency @nathapp/nax-agent uses workspace:*; npm cannot install it",
    ]);
  });

  test("nax-agent must be a workspace devDependency and stay out of --external", () => {
    const nax = { ...NAX, scripts: { build: '--external "@nathapp/nax-agent"' }, devDependencies: {} };
    expect(checkAgentBundling(nax, AGENT)).toHaveLength(2);
  });

  test("every runtime dependency of nax-agent is declared by nax at the same version", () => {
    const agent = { dependencies: { ...AGENT.dependencies, zod: "^4.4.0", chalk: "^5" } };
    expect(checkAgentBundling(NAX, agent)).toEqual([
      "nax-agent depends on zod@^4.4.0; nax must declare the same in dependencies (found ^4.3.6)",
      "nax-agent depends on chalk@^5; nax must declare the same in dependencies (found undefined)",
    ]);
  });
});
```
In `scripts/check-bundle-externals.ts`:
- Header line 3: "Gate: the three build-time resolution invariants" becomes "Gate: the four build-time resolution invariants".
- Add invariant 4 to the header, after 3: "4. `@nathapp/nax-agent` is bundled, never installed: nax lists it only as a `workspace:*` devDependency, and declares every runtime dependency of nax-agent itself (scripts/lib/agent-bundling.ts)."
- Exit-code line: `0 -- all four invariants hold`.
- Imports: add `import { join } from "node:path";` and `import { checkAgentBundling } from "./lib/agent-bundling";`.
- Before `if (failures.length > 0)`:
  ```ts
  const agentPkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "nax-agent", "package.json"), "utf8"));
  failures.push(...checkAgentBundling(pkg, agentPkg));
  ```
- The success message gains `; nax-agent is bundled`.

In `scripts/check-nax-ai-pin.ts`:
- The header's first sentence becomes "Gate: nax's and nax-agent's @nathapp/nax-ai dependency is an EXACT version equal to the workspace package's version (nax bundles nax-agent, so the two must agree)."
- `checkNaxAiPin` gains a third parameter `label = "packages/nax"`. The three messages use it: `` `@nathapp/nax-ai is missing from ${label} dependencies` ``, `` `${label}: @nathapp/nax-ai must be an exact X.Y.Z pin, found "${spec}"` `` and `` `${label}: @nathapp/nax-ai pin ${spec} != packages/nax-ai version ${naxAiPkg.version} (bump all in one PR)` ``.
- The `import.meta.main` block becomes:
  ```ts
  const root = findRepoRoot(import.meta.dir);
  const naxAi = await Bun.file(join(root, "packages/nax-ai/package.json")).json();
  const errors: string[] = [];
  for (const label of ["packages/nax", "packages/nax-agent"]) {
    const err = checkNaxAiPin(await Bun.file(join(root, label, "package.json")).json(), naxAi, label);
    if (err) errors.push(err);
  }
  if (errors.length > 0) {
    for (const err of errors) console.error(`[FAIL] ${err}`);
    process.exit(1);
  }
  ```

In `test/unit/scripts/check-nax-ai-pin.test.ts`, replace `"the real repo passes"` with:
```ts
  test("names the package it checks", () => {
    expect(checkNaxAiPin({ dependencies: {} }, { version: "0.1.16" }, "packages/nax-agent")).toMatch(
      /packages\/nax-agent/,
    );
  });
  test("the real repo passes, for nax and for nax-agent", async () => {
    const { findRepoRoot } = await import("@scripts/lib/repo-root");
    const root = findRepoRoot(import.meta.dir);
    const ai = await Bun.file(`${root}/packages/nax-ai/package.json`).json();
    for (const label of ["packages/nax", "packages/nax-agent"]) {
      const pkg = await Bun.file(`${root}/${label}/package.json`).json();
      expect(checkNaxAiPin(pkg, ai, label)).toBeNull();
    }
  });
```

- [ ] **Step 5: Pin nax-agent's copied Biome rule set** (Decision 8). Create `test/unit/scripts/nax-agent-biome-parity.test.ts`:

```ts
/**
 * nax-agent's biome.json is a copy of nax's rule set (S1-5 move script), not an
 * `extends` of it: a nested `"root": false` config inherits nothing in Biome
 * 2.5. This pins the copy so a rule tightened in one package cannot silently
 * stay loose in the other.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "..", "..", "..");

interface BiomeConfig {
  linter?: unknown;
  formatter?: unknown;
  plugins?: string[];
  overrides?: Array<{ includes?: string[]; plugins?: string[]; linter?: unknown }>;
}

async function config(pkg: string): Promise<BiomeConfig> {
  const parsed: BiomeConfig = await Bun.file(join(PACKAGES, pkg, "biome.json")).json();
  return parsed;
}

describe("nax-agent biome config", () => {
  test("has nax's linter and formatter settings", async () => {
    const [nax, agent] = await Promise.all([config("nax"), config("nax-agent")]);
    expect(agent.linter).toEqual(nax.linter);
    expect(agent.formatter).toEqual(nax.formatter);
  });

  test("runs nax's root plugins from nax's biome-plugins directory", async () => {
    const [nax, agent] = await Promise.all([config("nax"), config("nax-agent")]);
    expect(agent.plugins).toEqual(nax.plugins?.map((p) => p.replace("./biome-plugins/", "../nax/biome-plugins/")));
  });

  test("keeps nax's test/** override", async () => {
    const [nax, agent] = await Promise.all([config("nax"), config("nax-agent")]);
    const testOverride = (c: BiomeConfig) => c.overrides?.find((o) => o.includes?.includes("**/test/**"));
    expect(testOverride(agent)?.linter).toEqual(testOverride(nax)?.linter);
  });
});
```

- [ ] **Step 6: Dead path literals.**
  - Delete the two allow-list lines in `scripts/check-worktree-id-ssot.ts` that name moved files: `"src/agents/coding-tool-support.ts",` (line 86) and `"src/tools/scratchpad.ts",` (line 126).
  - In `scripts/command-safety-eval.ts:5`, the usage comment's corpus path becomes `packages/nax-agent/test/fixtures/command-safety/corpus.jsonl`.
  - In `scripts/check-nax-artifacts-untracked.ts:98`, the comment citing `src/tools/git-commit.ts` names `packages/nax-agent/src/tools/git-commit.ts`.
  - Check every other `mention` line Task 8 printed. Data strings in tests that are not read from disk, such as the fix-review tests' `src/utils/path-file-lock.ts`, stay.

- [ ] **Step 7: Delete the move tooling and the ratchet; wire the replacement alone.**

```bash
git rm -r scripts/s1-move.ts scripts/lib/s1-move scripts/s1-move-manifest.json scripts/lib/agent-move-manifest.ts \
  scripts/check-agent-boundary.ts scripts/baselines/agent-boundary-baseline.json \
  test/unit/scripts/agent-move-manifest.test.ts test/unit/scripts/check-agent-boundary.test.ts \
  test/unit/scripts/s1-move-plan.test.ts test/unit/scripts/s1-move-rewrite.test.ts test/unit/scripts/s1-move-entries.test.ts
```
In `package.json`:
- delete `check:agent-boundary` and `check:agent-boundary:update`;
- in `lint:checks`, delete `bun run check:agent-boundary && ` (keep `check:package-boundaries`).

In `scripts/lib/import-specifiers.ts`'s header, "Used by the package-boundary gates and the S1-5 move script." becomes "Used by check-package-boundaries (and, until it ran, the S1-5 move script)." `grep -rn "agent-move-manifest\|check-agent-boundary\|s1-move" scripts src test bin` must then list only `check-package-boundaries.ts`'s header and `import-specifiers.ts`'s header.

- [ ] **Step 8: Baselines.** In packages/nax-agent, create its baselines (each must report 0 except complexity and loose casts):

```bash
cd ../nax-agent && mkdir -p scripts/baselines
bun ../nax/scripts/check-nax-error.ts --package=. --update-baseline
bun ../nax/scripts/check-file-sizes.ts --package=. --update-baseline
bun ../nax/scripts/check-complexity.ts --package=. --init-baseline
bun ../nax/scripts/check-import-cycles.ts --package=. --update-baseline
bun ../nax/scripts/check-test-as-unknown-as.ts --package=. --update-baseline
bun ../nax/scripts/check-test-escape-hatches.ts --package=. --update-baseline
cd ../nax
```
Expected:
- 0 violations, 0 oversized, 0 cycles, 0 casts;
- complexity `baseline initialised with 20 functions in 18 files`;
- escape hatches `tsSuppress=0, ratchetAllow=0, looseCast=12`.

In packages/nax, run each gate in check mode first. It must pass, reporting the moved rows as fallen; only then lock the fall in:

```bash
bun run check:test-escape-hatches          # "[OK] ... looseCast=<n> (looseCast ↓ 12)"
bun run check:test-escape-hatches:update
bun run check:test-satellites:update
bun run check:complexity:update
```
Then prove the complexity rows moved rather than changed:

```bash
MOVE=$(git log --format=%H -1 --grep="(scripted)")
MOVE="$MOVE" bun -e '
const { execSync } = require("node:child_process");
const old = JSON.parse(execSync(`git show ${process.env.MOVE}~1:packages/nax/scripts/baselines/complexity-baseline.json`)).byFile;
const now = (await Bun.file("scripts/baselines/complexity-baseline.json").json()).byFile;
const agent = (await Bun.file("../nax-agent/scripts/baselines/complexity-baseline.json").json()).byFile;
const gone = Object.keys(old).filter((f) => !(f in now));
const changed = Object.keys(now).filter((f) => JSON.stringify(now[f]) !== JSON.stringify(old[f]));
console.log({ gone: gone.length, changed, agentRows: Object.keys(agent).length });
'
```
Expected: `gone: 18, changed: [], agentRows: 18`. The baseline is read from the move commit's parent, the last commit before anything moved.

- [ ] **Step 9: Verify everything this task touched, then commit in two parts.**

```bash
bun run typecheck && AGENT=1 bun run check:all
(cd ../nax-agent && bun run typecheck && bun run check:all)
AGENT=1 bun test test/unit/scripts/ test/unit/tools/run-command-exec.test.ts --timeout=60000
git add -A ../nax-agent/scripts scripts test package.json
git commit -m "chore: point the gates at the new layout and move their baselines"
```
Expected: both `check:all` runs are green, and the scripts suite passes (711 tests in the final review). If you prefer smaller commits, commit steps 1-6 as `fix:`/`test:` commits and steps 7-8 as `chore:`. Every commit after the move commit must leave `check:all` green.

---

### Task 10b: The coverage run (Decision 7)

- [ ] **Step 1:** `bun run test:coverage` from packages/nax. Expected:
  - the run lists 5 suites, including `../nax-agent/test/unit/` and `../nax-agent/test/integration/`;
  - about 23600 tests across about 1600 files;
  - lines ≥ 96.5%, functions ≥ 94%;
  - the per-file ratchet passes: nax-agent files measure as before the move. The only file below the floor is the baseline row `src/execution/feature-lock.ts`. The gate may also print that `src/execution/lock.ts` now meets the floor; that is informational.

  Record the numbers for the PR. The gate must pass without a baseline change. If it needs one, stop and report.

---

### Task 11: CI job, nax config, rules and agent files

**Files:**
- Modify: `.github/workflows/ci.yml`, `.nax/context.md:10-11`, `.nax/mono/packages/nax/context.md:81,139`, `.nax/rules/*.md` (13 frontmatters; text in `adapter-wiring.md`, `error-handling.md`, `retry-strategy.md`)
- Create: `.nax/mono/packages/nax-agent/{config.json,context.md}`
- Regenerate: `packages/{nax,nax-agent}/{CLAUDE,AGENTS,GEMINI,codex}.md`, `.claude/rules/*.md`

- [ ] **Step 1: CI job.** In `.github/workflows/ci.yml`, after the `nax` job, add:

```yaml
  nax-agent:
    name: nax-agent
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: packages/nax-agent
    steps:
      - uses: actions/checkout@v5

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"

      - name: Cache bun dependencies
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      # Root install: links the workspace and runs nax-ai's `prepare`, which
      # builds the dist/ nax-agent's typecheck resolves @nathapp/nax-ai to.
      - name: Install dependencies
        run: bun install --frozen-lockfile
        working-directory: .

      # Same as the nax job: the sandbox unit tests probe for a working bwrap.
      - name: Enable the OS sandbox (bubblewrap)
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq bubblewrap socat ripgrep
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true

      - name: Typecheck
        run: bun run typecheck

      # Biome plus nax's source and test gates run against this package
      # (`bun ../nax/scripts/check-*.ts --package=.`).
      - name: Check all
        run: bun run check:all

      - name: Test (unit)
        run: bun test ./test/unit/ --timeout=60000 --bail

      - name: Test (integration)
        run: bun test ./test/integration/ --timeout=60000 --bail

      # No coverage step: nax's `Coverage floor` step runs these suites with
      # nax's and gates nax-agent's sources (S1-5 plan, Decision 7).
```
Update the comment above the nax job's `Coverage floor` step to say it also gates nax-agent's sources.

- [ ] **Step 2: nax config for the package** (S0 pattern). Create `.nax/mono/packages/nax-agent/config.json`:

```json
{
  "quality": {
    "commands": {
      "test": "bun run --cwd ../nax-ai build && bun run test",
      "typecheck": ["bun run --cwd ../nax-ai build", "bun run typecheck"],
      "lint": "AGENT=1 bun run check:all",
      "build": "bun run typecheck",
      "testScoped": "CI=1 AGENT=1 bun test --timeout=60000 {{files}}",
      "lintFix": "bun run lint:fix",
      "formatFix": "bun run lint:fix"
    }
  }
}
```
No `constitution.md` (nax-ai has one): nax-agent's non-negotiables are the package boundary, which `check-package-boundaries` enforces, and the root constitution. Then create `.nax/mono/packages/nax-agent/context.md`. Follow `.nax/mono/packages/nax-ai/context.md`'s shape: the generate banner, then what the package is, commands, layout and rules. Cover at least:
- what nax-agent holds and that nax bundles it;
- the two entries, with `/internal` not covered by semver;
- `#src/` and `#test/` imports only, never `@/`;
- the dependency direction nax-ai -> nax-agent -> nax and `check-package-boundaries`;
- commands (`bun run typecheck | check:all | test`, run from packages/nax-agent; never bare `bun test`);
- that its gates run from `../nax/scripts` and its coverage is gated by nax's job;
- the src layout table: `session/`, `native/`, `tools/`, `permissions/`, `sandbox/`, `command-safety/`, `coding-tools/`, `command-interceptor/`, `cost/`, `config/`, `infra/`, `internal/`.

- [ ] **Step 3: Repo and nax context.**
  - `.nax/context.md`: add a row after line 11 (the nax-ai row), so the table reads in dependency order from line 11 on: `` | `packages/nax-agent` | `@nathapp/nax-agent` | Native coding agent: session contract, loop, tools, permissions, sandbox (private; bundled into nax) | ``.
  - `.nax/mono/packages/nax/context.md:79`: in the `src/agents/catalog/` row, `via \`src/agents/cost/standard-types.ts\`` becomes `via \`@nathapp/nax-agent\``.
  - `.nax/mono/packages/nax/context.md:81`: the `src/agents/native/` row becomes `` | `src/agents/native-agent/` | nax's thin `NativeAgentAdapter` shell over `@nathapp/nax-agent`'s native session adapter | ``.
  - Lines 139-141 (the nax-ai rule): "**nax-ai is importable from one site only in nax:** `src/agents/catalog/`. nax takes the `Pricing`/`TokenUsage` types from `@nathapp/nax-agent`. Enforced by `bun run check:nax-ai-imports`."
  - Anywhere that file says the native agent, tools, permissions or sandbox live under `src/`, point at `packages/nax-agent`. `grep -n "src/tools\|src/permissions\|src/sandbox\|src/command-safety\|agents/native/" .nax/mono/packages/nax/context.md` lists them.

- [ ] **Step 4: Rules.** In each `.nax/rules/*.md` below, add `- "packages/nax-agent/*"` under `paths:` and the listed globs under `appliesTo:`:

| Rule | Add to `appliesTo` |
|---|---|
| `error-handling.md`, `forbidden-patterns-source.md`, `monorepo-awareness.md`, `project-conventions.md` | `"packages/nax-agent/src/**/*.ts"` |
| `config-patterns.md` | `"packages/nax-agent/src/config/**/*.ts"` |
| `adapter-wiring.md` | `"packages/nax-agent/src/native/**/*.ts"`, `"packages/nax-agent/src/session/**/*.ts"`, `"packages/nax-agent/src/infra/**/*.ts"`, `"packages/nax-agent/src/cost/**/*.ts"`, `"packages/nax-agent/src/coding-tools/**/*.ts"` |
| `retry-strategy.md` | `"packages/nax-agent/src/native/**/*.ts"` |
| `forbidden-patterns-tests.md`, `test-architecture.md`, `test-helpers.md`, `test-writing.md`, `testing-commands.md` | `"packages/nax-agent/test/**/*.test.ts"` |
| `test-ratchets.md` | `"packages/nax-agent/test/**/*.ts"` |

Text references that name a moved path, with their exact replacements:
- `adapter-wiring.md:107-109` ("nax-ai imports live in `src/agents/native/`, `src/agents/catalog/`, and the staging re-export ... nowhere else. Enforced by `bun run check:nax-ai-imports`.") becomes: "nax-ai imports live in `src/agents/catalog/` (nax) and, in packages/nax-agent, in `src/native/` and the re-export `src/cost/standard-types.ts`, and nowhere else. Enforced by `bun run check:nax-ai-imports` in each package."
- `adapter-wiring.md:115-119`, from "nax uses nax-ai's `Pricing`/`TokenUsage` through" to "`bun run check:import-cycles` rejects.", becomes: "nax uses nax-ai's `Pricing`/`TokenUsage` through `@nathapp/nax-agent`'s re-export, so there is no separate nax type. It must not import from `src/agents/cost/`, which already depends on it; the reverse edge would close a runtime import cycle that `bun run check:import-cycles` rejects."
- `error-handling.md:81`: "Use `errorMessage()` from `src/utils/errors`" becomes "Use `errorMessage()` from `@nathapp/nax-agent/internal` (nax) or `#src/infra/errors` (nax-agent)". At line 84, the example import becomes `import { errorMessage } from "@nathapp/nax-agent/internal";`.
- `retry-strategy.md:43`: "in `src/agents/native/session/turn-retry.ts`" becomes "in `packages/nax-agent/src/native/session/turn-retry.ts`". In the sentence before it, "lives in nax" becomes "lives in nax-agent".

- [ ] **Step 5: Regenerate and check.** From the repo root (the root `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `codex.md` are generated from `.nax/context.md`, which step 3 edited):

```bash
bun packages/nax/bin/nax.ts rules lint
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
bun packages/nax/bin/nax.ts rules export --agent=claude
(cd packages/nax && bun run check:rules-drift)
git status --short
```
Expected:
- `rules lint` is clean.
- `generate` refreshes the root agent files; `--all-packages` writes `packages/nax-agent/{CLAUDE,AGENTS,GEMINI,codex}.md` and refreshes nax's.
- `rules export` rewrites `.claude/rules/`, and `check:rules-drift` passes.
- `git status` lists only the files this task meant to touch.

These commands make no LLM calls.

- [ ] **Step 6: Commit.**

```bash
git add .github/workflows/ci.yml .nax .claude/rules CLAUDE.md AGENTS.md GEMINI.md codex.md packages/nax/*.md packages/nax-agent/*.md
git commit -m "ci: add the nax-agent job; point nax config, rules and agent files at the new package"
```

---

### Task 12: Close-out

- [ ] **Step 1: Full verification**, on a clean tree:

```bash
cd packages/nax && bun run typecheck && bun run lint && bun run test && bun run test:coverage
cd ../nax-agent && bun run typecheck && bun run check:all && bun run test
cd ../.. && bun run check:all
```
All exit 0.

- [ ] **Step 2: Fresh-install check.** Run `git clean -fdx -e .nax && bun install --frozen-lockfile` at the repo root, then `bun run typecheck` in packages/nax-agent. This proves a CI-shaped install builds nax-ai and resolves the workspace. Only do this after committing everything: `git clean -x` removes untracked files.

- [ ] **Step 3: Release-shaped check.** From packages/nax:
  - `bun run build && bun scripts/check-bundle-externals.ts && npm pack --dry-run 2>&1 | tail -12 && rm -rf dist`;
  - `cat package.json | grep -A12 '"dependencies"'` shows the same nine dependencies as on `main`.

- [ ] **Step 4: Test accounting for the PR.** Report:
  - the nax unit/integration/ui/e2e totals;
  - nax-agent's unit/integration totals;
  - their sums against `main`'s unit/integration totals (Task 9, step 4);
  - the coverage run's totals and percentages (Task 10b).

- [ ] **Step 5: PR text** (open only after the user approves the push). Title: `refactor: S1-5 scripted move into packages/nax-agent`. Body sections:
  - **Summary** (what moved, counts, the two entries, the gate swap).
  - **Spec deviations**: Decisions 3, 6, 7, 8 and 13, each with its measurement.
  - **Generated vs hand-written** (the move commit is generated, so review it by sampling; review every other commit line by line).
  - **Merge**: the move commit is red by design (Decision 1); squash-merge, or accept one red commit in `main`'s history.
  - **Tests**: conservation numbers; no test edited except the subject-moved and split ones, listed by file.
  - **Behaviour notes**: none expected; the bundle and the pack are unchanged.
  - **Carried items** (for the arc SSOT):
    1. The 177 wiring tests that exercise nax-agent code from nax, including the 8 blocked by nax helpers, before nax-agent can gate its own coverage (S2).
    2. `check-alias-internals` and `check-test-satellites` for nax-agent.
    3. Gate scripts in a shared tooling location (S2).
    4. Biome rule hoisting (chore).
    5. `docs/architecture` paths.
    6. Pruning `_` seams from the public entry, and entry granularity (S2).
    7. Required-check update for the new CI job in branch protection (user, outside the repo).
    8. Remove or condition the `./test/helpers/*` export before nax-agent is published (S2); spec section 8 says helpers are never exports.
    9. `check-alias-internals`, `check-test-satellites` and `check-worktree-id-ssot` for nax-agent (see 2).
  - **Next**: S1 acceptance smoke (billed, approved at launch), then S2/S3.

## Self-review notes (for the reviewer of this plan)

- **Spec coverage, section 6 S1-5 row.** Each item maps to a task:
  - script, trial and regenerate: Tasks 6-9;
  - create package: 7/9;
  - hoist biome: deviation, Decision 8;
  - `git mv` files and tests: 9;
  - rewrite imports: 7/9;
  - rewrite `scripts/check-*` paths: 9 (imports) and 10 (literals);
  - rules and `.nax/mono`: 11;
  - CI job and devDependency: 11/9;
  - remove staging allow-list: 10;
  - replace the ratchet: 5/10.
- **Section 8 S1-5.** Test count before and after: 9 and 12. Build: 9 and 12. `GIT_COMMIT`: 9. Pack: 9 and 12. Global-install layout: 10 (invariant 4) and 12. `check-package-boundaries`: 5 and 10.
- **Section 9.** Item 1 is covered (5, 10). Item 2 is covered for tests (11), with coverage per Decision 7. Item 3, the billed smoke, is outside this PR. Item 4 (SSOT) is the PR follow-up.
- **Narrowings the final review flagged, all deliberate:**
  - **Test counts.** Spec section 8 says the script "prints both" test counts. Here the script prints the plan size, and Task 9 step 4 and Task 12 step 4 count tests by hand.
  - **Bundle check.** Spec section 7 has `check-bundle-externals` assert every external import of nax-agent. Here `checkAgentBundling` compares declared dependencies. Undeclared imports are caught by `check-package-boundaries`, and devDependencies are allowed only under nax-agent's `test/`.
  - **`check-logger-storyid`.** It stays nax-only (Decision 6).

## Final-review record (2026-10-02)

Two reviewers each applied every task in a throwaway worktree from `51fe17cda`. Both returned "ready after fixes", with the same measurements as above: 188 / 142 / 13 / 1 move, 344 renames, conserved test totals, combined coverage 96.79-96.80%, identical CLI output before and after (md5 of `--help`, `config`, `auth list`, `agents`, `models`), and green `check:all` in nax, nax-agent and the root.

One fix round was applied to this plan:
- **Lint and commit breakers:** the `byCodePoint` import uses `@/utils/sort` (Biome bans `../../`); the rewrite test avoids a deep `@test/helpers/...` string; `opencode.json` was dropped from Task 11.
- **Wrong line ranges and imports:** Task 1's two extra unused imports; Task 2's line ranges; Task 10's header line ranges and the "four invariants" wording.
- **Gate coverage:** four more gates wired into nax-agent (Decision 6); devDependencies allowed only under nax-agent's `test/`.
- **Exact rule and context text:** written out in Task 11.
- **Counts:** corrected for this plan's own new tests.
- **Disclosure:** the red move commit (Decision 1); the 8 wiring tests named (Decision 2); carried items 8 and 9.
