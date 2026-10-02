# S2-3a — nax-agent's own coverage gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give nax-agent its own coverage gate. It runs in nax-agent's CI job and holds 80% lines and functions overall, 80% per file against a ratchet baseline, and requires every `src/` file with executable code to appear in the report. At the same time, nax's coverage job stops counting nax-agent. No behaviour change to the nax CLI.

**Architecture:** `check-coverage.ts` moves from `packages/nax/scripts/` to `packages/repo-tooling/scripts/` and becomes package-rooted, like the other shared gates: it scans the current directory or `--package=<dir>`, measures `src/` only, and runs whichever of `test/unit/`, `test/integration/` and `test/ui/` exist. Dropping nax's `../nax-agent/src/` scope and nax-agent's suites happens in the same move, because the generic script has no notion of a sibling package. A new opt-in flag, `--require-all-files`, fails on any `src/` file that holds executable code but has no record in the report (spec §7.2); nax-agent turns it on. Before the gate lands, ten nax tests that import nax only for names nax re-exports from nax-agent move into nax-agent. That lifts nax-agent's own coverage from 78.94% to about 87% lines, so the aggregate floor passes without lowering it.

**Tech Stack:** Bun 1.4 workspaces (`linker = "isolated"`), TypeScript 7.0.2, Biome 2.5.10, `bun:test`, `Bun.Transpiler`, `Bun.Glob`.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§7.1, §7.2, §9 row S2-3).

## S2-3 is split (spec §7.1: "S2-3 is split further if the list is long")

Measured on `main` @ `23d8b7cbf`, nax-agent's own tests cover 78.94% of lines (116 lines short of the 80% aggregate floor) and 83.79% of functions. 40 `src/` files sit under 80%, about 1,435 lines short in total.

| PR | Content |
|---|---|
| **S2-3a (this plan)** | port the 10 re-export-only tests; move the gate to repo-tooling, package-rooted; `--require-all-files`; nax-agent's gate with a ratchet baseline (about 31 files); nax stops counting nax-agent |
| S2-3b | drain the credentials and auth files: `native/auth.ts`, `native/credentials/{exec-source,change-guard,fingerprint}.ts`, `infra/credentials-config.ts`, `native/models.ts` |
| S2-3c | drain the tools files: `tools/{git-commit,delete,deny-paths,protected-paths,package-managers,package-managers-table,git}.ts`, `coding-tools/coding-tool-sandbox.ts`, `sandbox/policy-inputs.ts` |
| S2-3d | drain the rest: `session/*`, `cost/*`, `native/session/*`, `internal/{command-spec/index,agent-output-env}.ts`, `config/bash-approval.ts` |
| after S2-4 | `internal/bun-deps.ts` leaves nax-agent in S2-4 (its baseline entry drops with it); `native/credentials/helper-process.ts` and `internal/git-exec.ts` are retyped by S2-4, so they are drained after it |

The baseline must be empty before S2-9 publishes (spec R2). Each drain PR gets its own just-in-time plan against the baseline this PR writes.

## Global Constraints

- Repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Branch `feat/s2-3a-coverage-gate` (it already carries this plan). Rebase it onto `origin/main` before Task 0.
- Package commands run from the package directory. Never run bare `bun test` (no path) and never `bun run nax`.
- Bun 1.4.0 in CI; TypeScript `7.0.2` exact; Biome `2.5.10` exact.
- Floors (spec §7.2): **80% lines, 80% functions, 80% per file**. No floor is lowered. "The gap is closed with new tests in nax-agent, never by lowering a floor."
- `packages/nax/package.json` **`dependencies` must stay byte-identical** to `main`.
- **No test is edited to make it pass.** A test may change only to (a) move, (b) change an import specifier or its position (Biome sorting), or (c) test a gate this PR changes. Every such change is listed in its task.
- **Test counts are conserved.** Task 0 records them. After Task 6, nax + nax-agent + repo-tooling totals equal Task 0's totals plus exactly the new gate tests (Tasks 2 and 3 list them).
- No nax `src/` file may newly fall below the per-file floor or below its baseline because a test left nax. If one does, stop and report. Do not baseline it.
- Every commit leaves `bun run check:all` and the unit suites green in every package it touches. Use conventional commits and no emojis.
- No push, no PR, no `nax run` / `nax plan` without the maintainer's explicit approval.
- Max 2 fix rounds per task review.

## Decisions taken in this plan (deviations, each measured)

1. **A second porting pass, with a sharper rule than S2-1's.** S2-1 kept every test that imports any nax `src/` module. A probe on `23d8b7cbf` imported each such name from nax and compared it by identity with nax-agent's `.` and `/internal` exports. It found 15 tests whose only nax imports are names nax **re-exports from nax-agent**, for example `import type { NaxError } from "@/errors"`. Those imports are incidental, not wiring. A trial move ran them in nax-agent: 12 passed with identical counts and 1 failed typecheck (`tool-mapping`: `ToolDescriptor` is nax's type). Of the remaining two, `external-handler` needs nax's `withTimerSpy` and `trust/store` needs nax's `loadTrustModule`. Two more are excluded by reading them: `config/native-agent.test.ts` asserts that **nax's config barrel** re-exports the constant, which is nax wiring, and `e2e/scripted-agent` drives nax's orchestrator. **10 tests port.** With them, nax-agent's own coverage measured 87.35% lines, 87.58% functions, and 31 files under 80% (619 lines short).
2. **The on-disk check is opt-in (`--require-all-files`), on for nax-agent only.** nax has 68 `src/` files with no record in its report. 56 are type-only, but about 12 hold real code (e.g. `acceptance/templates/*`, `commands/detect.ts`, `constitution/generator.ts`, `tdd/types.ts`, `tui/index.tsx`). Turning the check on for nax is a separate decision with its own work. It is recorded as a follow-up, not done here.
3. **"Executable code" means what Bun records.** Bun writes no `SF:` record for a file with nothing to execute: types only, or re-exports only. The check transpiles each unreported file with `Bun.Transpiler` and exempts it when nothing is left after removing comments, imports, `export … from` re-exports and `export {}`. nax-agent's four unreported files (`native/auth-types.ts`, `permissions/types.ts`, `sandbox/types.ts`, `tools/package-managers-types.ts`) are all type-only (probed).
4. **`check-coverage.ts` loses its complexity ratchet entry when it moves.** nax's complexity baseline holds `scripts/check-coverage.ts: { checkPerFile: 27 }`. repo-tooling has no complexity gate yet; that gap is issue #2326. The entry is removed from nax's baseline with the move.

## Review Focus

1. **The gate passes because it measured nothing.** If `gatedSuites` finds no suite directories, or the coverage run's cwd is wrong, Bun writes a near-empty report. Pinned in Task 2 (`gatedSuites` tests) and Task 4 Step 4: the nax-agent run prints the same test count as the plain suite run.
2. **A file executed by tests but omitted from the report** (GitHub #1779) is reported by `--require-all-files` as unreported. The remedy is `UNMEASURABLE` with a reason, never a skipped check. Pinned in Task 3 (`findUnreportedFiles` honours `UNMEASURABLE`).
3. **A file whose only code is an enum or a side-effect `export const`** must count as executable. Pinned in Task 3 (`hasExecutableCode` enum and const cases).
4. **nax's gate silently still counting nax-agent**, or counting it under a new path. Pinned in Task 2: the scope tests assert that `../nax-agent/src/…` records are ignored, and Task 6 compares nax's report scope.
5. **A ported test that depended on nax's preload.** Pinned in Task 1 Step 3: per-file counts equal Task 0's, run under nax-agent's preload.

---

## File structure

**Moved**
- `packages/nax/scripts/check-coverage.ts` → `packages/repo-tooling/scripts/check-coverage.ts`
- `packages/nax/test/unit/scripts/check-coverage.test.ts` → `packages/repo-tooling/test/unit/scripts/check-coverage.test.ts`
- The 10 ported tests:

| nax (`packages/nax/`) | nax-agent (`packages/nax-agent/`) | Tests |
|---|---|---|
| `test/unit/agents/native/client.test.ts` | `test/unit/native/client.test.ts` | 14 |
| `test/unit/agents/native/credentials.test.ts` | `test/unit/native/credentials.test.ts` | 11 |
| `test/unit/agents/native/credentials/chained-store.test.ts` | `test/unit/native/credentials/chained-store.test.ts` | 17 |
| `test/unit/agents/native/errors-credential-fault.test.ts` | `test/unit/native/errors-credential-fault.test.ts` | 10 |
| `test/unit/agents/native/model-resolver.test.ts` | `test/unit/native/model-resolver.test.ts` | 4 |
| `test/unit/agents/native/turn-retry.test.ts` | `test/unit/native/session/turn-retry.test.ts` | 31 |
| `test/unit/tools/runtime.test.ts` | `test/unit/tools/runtime.test.ts` | 44 |
| `test/unit/tools/us-005.test.ts` | `test/unit/tools/us-005.test.ts` | 5 |
| `test/unit/utils/git-add.test.ts` | `test/unit/internal/git-add.test.ts` | 19 |
| `test/unit/utils/git-env.test.ts` | `test/unit/internal/git-env.test.ts` | 16 |

None of the destinations exists (checked). Only `us-005.test.ts` appears in a baseline (nax's `test-satellites-baseline.json`).

**Created**
- `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json` (written by the gate).

**Modified**
- `packages/nax/package.json` (`test:coverage*` paths), `packages/nax/scripts/baselines/complexity-baseline.json`, `packages/nax/scripts/baselines/test-satellites-baseline.json`, `packages/nax/bunfig.toml` (comments).
- `packages/nax-agent/package.json` (`test:coverage*` scripts), `packages/nax-agent/bunfig.toml` (coverage block), `packages/nax-agent/scripts/baselines/test-satellites-baseline.json`.
- `.github/workflows/ci.yml` (nax-agent `Coverage floor` step; nax step comment).
- `.nax/mono/packages/nax-agent/context.md`, `.nax/rules/testing-commands.md`, then the generated files.

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Rebase and install**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git fetch origin && git rebase origin/main
bun install --frozen-lockfile
```

- [ ] **Step 2: Record the counts of the ten ported tests and the gate test**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
for f in test/unit/agents/native/client.test.ts test/unit/agents/native/credentials.test.ts \
  test/unit/agents/native/credentials/chained-store.test.ts test/unit/agents/native/errors-credential-fault.test.ts \
  test/unit/agents/native/model-resolver.test.ts test/unit/agents/native/turn-retry.test.ts \
  test/unit/tools/runtime.test.ts test/unit/tools/us-005.test.ts test/unit/utils/git-add.test.ts \
  test/unit/utils/git-env.test.ts test/unit/scripts/check-coverage.test.ts; do
  printf '%s ' "$f"; bun test "./$f" --timeout=60000 2>&1 | grep -E '^ *[0-9]+ (pass|skip|fail)' | tr '\n' ' '; echo
done
```

Expected: the counts in the File structure table, and `check-coverage.test.ts` 20; all pass.

- [ ] **Step 3: Record suite totals** for nax (`./test/unit/`, `./test/integration/`), nax-agent (`./test/unit/`, `./test/integration/`) and repo-tooling (`./test/unit/`), each with `bun test <dir> --timeout=60000` from its package directory, reading the `N pass / N skip / N fail` block. All `fail` must be 0.

- [ ] **Step 4: Record both coverage pictures**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun run test:coverage:report 2>&1 | tail -12      # nax's job today (nax + nax-agent scopes)
cd ../nax-agent
rm -rf coverage && bun test ./test/unit/ ./test/integration/ --timeout=60000 --coverage --coverage-reporter=lcov --coverage-dir=coverage >/dev/null 2>&1
grep -c '^SF:src/' coverage/lcov.info
```

Keep both outputs for Task 6. nax's `lines`/`functions` lines and its `files below floor (baseline 2)` line are the comparison point.

No commit in Task 0.

---

### Task 1: Port the ten re-export-only tests

**Files:** the ten moves in the File structure table; `packages/nax/scripts/baselines/test-satellites-baseline.json`; `packages/nax-agent/scripts/baselines/test-satellites-baseline.json`.

**Interfaces:**
- Consumes: nax-agent's `#test/helpers/index` (from S2-1), `@nathapp/nax-agent/internal`.
- Produces: nothing later tasks import. The coverage gain is what Task 4's baseline depends on.

**The rewrite rule (and nothing else):** in each moved file, every `from "@/<path>"` becomes `from "@nathapp/nax-agent/internal"`, and `from "@test/helpers"` becomes `from "#test/helpers/index"`. Every `@/` name in these files was probed to be nax's re-export of the identical nax-agent export (values by identity; types by `tsc` in the trial).

- [ ] **Step 1: Move and rewrite, scripted**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages
while read -r SRC DST; do
  mkdir -p "nax-agent/$(dirname "$DST")"
  git mv "nax/$SRC" "nax-agent/$DST"
  sed -i '' -E 's#from "@/[^"]+";#from "@nathapp/nax-agent/internal";#' "nax-agent/$DST"
  sed -i '' 's#from "@test/helpers";#from "\#test/helpers/index";#' "nax-agent/$DST"
  grep -nE '"@/|"@test/' "nax-agent/$DST" && echo "LEFTOVER ALIAS in $DST"
done <<'EOF'
test/unit/agents/native/client.test.ts test/unit/native/client.test.ts
test/unit/agents/native/credentials.test.ts test/unit/native/credentials.test.ts
test/unit/agents/native/credentials/chained-store.test.ts test/unit/native/credentials/chained-store.test.ts
test/unit/agents/native/errors-credential-fault.test.ts test/unit/native/errors-credential-fault.test.ts
test/unit/agents/native/model-resolver.test.ts test/unit/native/model-resolver.test.ts
test/unit/agents/native/turn-retry.test.ts test/unit/native/session/turn-retry.test.ts
test/unit/tools/runtime.test.ts test/unit/tools/runtime.test.ts
test/unit/tools/us-005.test.ts test/unit/tools/us-005.test.ts
test/unit/utils/git-add.test.ts test/unit/internal/git-add.test.ts
test/unit/utils/git-env.test.ts test/unit/internal/git-env.test.ts
EOF
cd nax-agent && bun x biome check --write test/unit/native test/unit/tools/runtime.test.ts test/unit/tools/us-005.test.ts test/unit/internal
```

Expected: no `LEFTOVER ALIAS`. A file may now import `@nathapp/nax-agent/internal` on two lines (its own line plus a rewritten one). If Biome flags a duplicate import, merge the two into one import statement; that is still rule (b). Then `git diff -M HEAD` must show ten renames whose only changed lines are imports.

- [ ] **Step 2: Move the satellites baseline entry with its file**

`us-005.test.ts` is grandfathered by name. Remove `"test/unit/tools/us-005.test.ts": true` from `packages/nax/scripts/baselines/test-satellites-baseline.json`, and add the same key to `packages/nax-agent/scripts/baselines/test-satellites-baseline.json` (sorted, keep `updatedAt` as-is). The file is the same file, so this is a move, not a new exception.

- [ ] **Step 3: Run each ported file in nax-agent and compare**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
for f in test/unit/native/client.test.ts test/unit/native/credentials.test.ts test/unit/native/credentials/chained-store.test.ts \
  test/unit/native/errors-credential-fault.test.ts test/unit/native/model-resolver.test.ts test/unit/native/session/turn-retry.test.ts \
  test/unit/tools/runtime.test.ts test/unit/tools/us-005.test.ts test/unit/internal/git-add.test.ts test/unit/internal/git-env.test.ts; do
  printf '%s ' "$f"; bun test "./$f" --timeout=60000 2>&1 | grep -E '^ *[0-9]+ (pass|skip|fail)' | tr '\n' ' '; echo
done
bun run typecheck
```

Expected: each count equals Task 0 Step 2; 0 fail; typecheck exit 0. A typecheck error naming an imported type means the probe was wrong for that file: put that file back (`git mv` it back, restore its imports with `git checkout HEAD -- <nax path>` after reverting the move), ledger it, and continue with the rest.

- [ ] **Step 4: Package checks and commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent && bun run check:all
cd ../nax && bun run check:all
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A packages/nax packages/nax-agent
git commit -m "test: port ten nax tests that import nax only for nax-agent re-exports"
```

---

### Task 2: `check-coverage` moves to repo-tooling, package-rooted, `src/` only

**Files:**
- Move: `packages/nax/scripts/check-coverage.ts` → `packages/repo-tooling/scripts/check-coverage.ts`
- Move: `packages/nax/test/unit/scripts/check-coverage.test.ts` → `packages/repo-tooling/test/unit/scripts/check-coverage.test.ts`
- Modify: `packages/nax/package.json`, `packages/nax/scripts/baselines/complexity-baseline.json`, `packages/nax/bunfig.toml` (comments), `.github/workflows/ci.yml` (nax step comment)

**Interfaces:**
- Produces (exported from `packages/repo-tooling/scripts/check-coverage.ts`): `CANDIDATE_SUITES: readonly ["test/unit/", "test/integration/", "test/ui/"]`; `gatedSuites(root: string, exists?: (path: string) => boolean): string[]`; the existing `parseLcov`, `parsePerFileLines`, `findMissingBaselined`, `buildUpdatedBaseline`, `extractTestSummary`, `UNMEASURABLE`. Task 3 adds to this file.

New tests in this task: **2** (`gatedSuites`). Two existing tests are rewritten under rule (c).

- [ ] **Step 1: Move both files**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages
git mv nax/scripts/check-coverage.ts repo-tooling/scripts/check-coverage.ts
git mv nax/test/unit/scripts/check-coverage.test.ts repo-tooling/test/unit/scripts/check-coverage.test.ts
sed -i '' 's#} from "@scripts/check-coverage";#} from "\#scripts/check-coverage";#' repo-tooling/test/unit/scripts/check-coverage.test.ts
```

- [ ] **Step 2: Rewrite the two scope tests and add the `gatedSuites` tests (RED)**

In `repo-tooling/test/unit/scripts/check-coverage.test.ts`:

Replace the test `"counts nax-agent's sources, as lcov names them from nax"` with:

```ts
  test("counts src/ only: a sibling package's records, as lcov names them, are out of scope", () => {
    const totals = parseLcov(
      lcovWithFns([
        ["src/a.ts", 9, 10, 4, 5],
        ["../nax-agent/src/b.ts", 10, 10, 5, 5],
        ["../nax-agent/test/helpers/temp.ts", 0, 40, 0, 8],
      ]),
    );

    expect(totals).toEqual({ linesFound: 10, linesHit: 9, fnFound: 5, fnHit: 4 });
  });
```

Replace the test `"reports nax-agent's files under their lcov path"` with:

```ts
  test("leaves a sibling package's files out of the per-file map", () => {
    const perFile = parsePerFileLines(lcov([["../nax-agent/src/tools/git.ts", 9, 10], ["src/a.ts", 1, 2]]));
    expect([...perFile.keys()]).toEqual(["src/a.ts"]);
  });
```

Add `gatedSuites` to the import list, and append:

```ts
describe("gatedSuites", () => {
  test("runs every candidate suite directory the package has, in order", () => {
    const present = new Set(["/pkg/test/unit/", "/pkg/test/integration/", "/pkg/test/ui/"]);
    expect(gatedSuites("/pkg", (p) => present.has(`${p}/`) || present.has(p))).toEqual([
      "test/unit/",
      "test/integration/",
      "test/ui/",
    ]);
  });

  test("skips a suite directory the package does not have", () => {
    const present = new Set(["/pkg/test/unit/", "/pkg/test/integration/"]);
    expect(gatedSuites("/pkg", (p) => present.has(`${p}/`) || present.has(p))).toEqual([
      "test/unit/",
      "test/integration/",
    ]);
  });
});
```

Run:

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/repo-tooling
bun test ./test/unit/scripts/check-coverage.test.ts --timeout=60000
```

Expected: FAIL. `gatedSuites` is not exported, and the two scope tests still see nax-agent's records.

- [ ] **Step 3: Make the script package-rooted and `src/`-only (GREEN)**

In `packages/repo-tooling/scripts/check-coverage.ts`:

1. Imports: add `import { gateBaselinePath, gatePackageRoot } from "#scripts/lib/package-root";`.
2. Replace the three path constants with:

```ts
const ROOT = gatePackageRoot();
const LCOV_PATH = join(ROOT, "coverage", "lcov.info");
const PER_FILE_BASELINE_FILE = gateBaselinePath(ROOT, "coverage-per-file-baseline.json");
```

3. Delete the `AGENT_SCOPE_PREFIX` doc comment and constant, and make the scope list `src/` alone:

```ts
const SCOPE_PREFIXES: readonly string[] = [AGGREGATE_SCOPE_PREFIX];
```

4. Replace `AGENT_SUITES` and `GATED_SUITES` with:

```ts
/** Suites a package may have; the gate runs the ones that exist, in ONE invocation. `test/e2e/` is deliberately out. */
export const CANDIDATE_SUITES = ["test/unit/", "test/integration/", "test/ui/"] as const;

export function gatedSuites(root: string, exists: (path: string) => boolean = existsSync): string[] {
  return CANDIDATE_SUITES.filter((suite) => exists(join(root, suite)));
}
```

Then in `runCoverage`, compute `const suites = gatedSuites(ROOT);`. If it is empty, `console.error("[coverage] no test/unit, test/integration or test/ui directory under " + ROOT); return 1;`. Pass `...suites` to `bun test`. In `main`, print `gatedSuites(ROOT).join(", ")` where it printed `GATED_SUITES`.

5. Header comment: change "Scope: `test/unit/`, `test/integration/` and `test/ui/`, in ONE `bun test` invocation (~47s), measuring `src/` only" to "Scope: whichever of `test/unit/`, `test/integration/` and `test/ui/` the package has, in ONE `bun test` invocation, measuring the package's `src/` only. The package is the current directory, or `--package=<dir>`; its baseline lives in `<package>/scripts/baselines/`." Change every "bun scripts/check-coverage.ts" in Usage and in printed hints to "bun run test:coverage" / "bun run test:coverage:update" (the package script names).

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/repo-tooling
bun test ./test/unit/scripts/check-coverage.test.ts --timeout=60000
bun run typecheck && bun run check:all
```

Expected: 22 pass (20 + 2), 0 fail; checks exit 0.

- [ ] **Step 4: Repoint nax and drop the stale complexity entry**

`packages/nax/package.json`:

```json
    "test:coverage": "bun run ../repo-tooling/scripts/check-coverage.ts",
    "test:coverage:report": "bun run ../repo-tooling/scripts/check-coverage.ts --report",
    "test:coverage:update": "bun run ../repo-tooling/scripts/check-coverage.ts --update-baseline",
    "test:coverage:list": "bun run ../repo-tooling/scripts/check-coverage.ts --list",
```

Delete the `"scripts/check-coverage.ts": { "checkPerFile": 27 },` line from `packages/nax/scripts/baselines/complexity-baseline.json` (decision 4). In `packages/nax/bunfig.toml`, change the three comment mentions of `scripts/check-coverage.ts` / `check-coverage.ts` to `packages/repo-tooling/scripts/check-coverage.ts`. In `.github/workflows/ci.yml`, in the nax job's `Coverage floor` comment, change `scripts/check-coverage.ts` to `packages/repo-tooling/scripts/check-coverage.ts`, and replace "It also gates nax-agent's sources: these suites run them, and the nax-agent job has no coverage step." with "nax-agent gates its own sources in its own job."

- [ ] **Step 5: nax's gate on nax alone**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun run test:coverage 2>&1 | tail -12
grep -c '^SF:\.\./nax-agent/' coverage/lcov.info
bun run check:all
```

Expected: exit 0, and the printed scope reads `test/unit/, test/integration/, test/ui/ → src/`. `lines`/`functions` are at or above 80% (nax's own numbers, recorded for the PR body). The `files below floor` count is **≤ 2** with no new file named. The grep may be non-zero (Bun still records nax-agent files the nax tests load), but those records are out of scope. If a nax `src/` file is newly below the floor, stop and report it (Global Constraints).

- [ ] **Step 6: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A packages/nax packages/repo-tooling .github/workflows/ci.yml
git commit -m "refactor: move check-coverage into repo-tooling, package-rooted; nax stops counting nax-agent"
```

---

### Task 3: `--require-all-files`

**Files:**
- Modify: `packages/repo-tooling/scripts/check-coverage.ts`
- Test: `packages/repo-tooling/test/unit/scripts/check-coverage.test.ts`

**Interfaces:**
- Consumes: Task 2's `ROOT`, `parsePerFileLines`, `UNMEASURABLE`.
- Produces: `hasExecutableCode(source: string): boolean`; `findUnreportedFiles(onDisk: readonly string[], perFile: ReadonlyMap<string, number>, hasCode: (file: string) => boolean, unmeasurable?: Record<string, string>): string[]`; `sourceFiles(root: string): string[]`; CLI flag `--require-all-files`. Task 4 passes the flag.

New tests in this task: **11** (7 `hasExecutableCode`, 4 `findUnreportedFiles`).

- [ ] **Step 1: Write the failing tests**

Add `findUnreportedFiles` and `hasExecutableCode` to the import list, and append:

```ts
describe("hasExecutableCode", () => {
  test("a file of interfaces and type aliases has none", () => {
    expect(hasExecutableCode("export interface A { x: number }\nexport type B = A | string;\n")).toBe(false);
  });

  test("type-only imports and re-exports have none", () => {
    expect(hasExecutableCode('import type { A } from "./a";\nexport type { B } from "./b";\n')).toBe(false);
  });

  test("a barrel of value re-exports has none", () => {
    expect(hasExecutableCode('export * from "./a";\nexport { b } from "./b";\nexport * as c from "./c";\n')).toBe(false);
  });

  test("comments alone have none", () => {
    expect(hasExecutableCode("/** doc */\n// note\n")).toBe(false);
  });

  test("a const declaration is code", () => {
    expect(hasExecutableCode("export const LIMIT = 3;\n")).toBe(true);
  });

  test("a function declaration is code", () => {
    expect(hasExecutableCode("export function f(): number { return 1; }\n")).toBe(true);
  });

  test("an enum is code (TypeScript emits an object for it)", () => {
    expect(hasExecutableCode("export enum Mode { A, B }\n")).toBe(true);
  });
});

describe("findUnreportedFiles", () => {
  const perFile = new Map([["src/reported.ts", 0.9]]);
  const allCode = () => true;

  test("a file the report names is not unreported", () => {
    expect(findUnreportedFiles(["src/reported.ts"], perFile, allCode, {})).toEqual([]);
  });

  test("an executable file the report omits is unreported, sorted", () => {
    expect(findUnreportedFiles(["src/z.ts", "src/a.ts", "src/reported.ts"], perFile, allCode, {})).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
  });

  test("a file with no executable code is exempt", () => {
    expect(findUnreportedFiles(["src/types.ts"], perFile, () => false, {})).toEqual([]);
  });

  test("a file listed in UNMEASURABLE is exempt", () => {
    expect(findUnreportedFiles(["src/hole.ts"], perFile, allCode, { "src/hole.ts": "#1779 repro" })).toEqual([]);
  });
});
```

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/repo-tooling
bun test ./test/unit/scripts/check-coverage.test.ts --timeout=60000
```

Expected: FAIL, because neither export exists.

- [ ] **Step 2: Implement**

Add to `packages/repo-tooling/scripts/check-coverage.ts`, below `findMissingBaselined`:

```ts
const TRANSPILER = new Bun.Transpiler({ loader: "tsx" });

/** What is left of transpiled output that Bun does not record as executable. */
const NON_EXECUTABLE: readonly RegExp[] = [
  /\/\*[\s\S]*?\*\//g,
  /\/\/[^\n]*/g,
  /^\s*import\s[^;\n]*;?\s*$/gm,
  /^\s*export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']+["'];?\s*$/gm,
  /^\s*export\s*\{\s*\}\s*;?\s*$/gm,
];

/**
 * Whether a source file has anything Bun would record a line for. Bun writes no
 * `SF:` record for a file of types or re-exports only, so such a file's absence
 * from the report is expected, not a measurement hole.
 */
export function hasExecutableCode(source: string): boolean {
  const js = NON_EXECUTABLE.reduce((text, re) => text.replace(re, ""), TRANSPILER.transformSync(source));
  return js.trim() !== "";
}

/**
 * `src/` files on disk that hold executable code but have no record in the report
 * (spec S2 §7.2). The ratchet alone cannot see them: a file the report never names
 * is neither below the floor nor baselined, so it would pass at 0%.
 */
export function findUnreportedFiles(
  onDisk: readonly string[],
  perFile: ReadonlyMap<string, number>,
  hasCode: (file: string) => boolean,
  unmeasurable: Record<string, string> = UNMEASURABLE,
): string[] {
  return onDisk
    .filter((file) => !perFile.has(file) && !(file in unmeasurable) && hasCode(file))
    .sort((a, b) => a.localeCompare(b));
}

/** Every `.ts`/`.tsx` source under `<root>/src/`, as the report names them (`src/...`). */
export function sourceFiles(root: string): string[] {
  return [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })].filter((f) => !f.endsWith(".d.ts"));
}
```

Wire it into `main`:
- read `const requireAllFiles = process.argv.includes("--require-all-files");`;
- after `perFile` is computed: `const unreported = requireAllFiles ? findUnreportedFiles(sourceFiles(ROOT), perFile, (f) => hasExecutableCode(readFileSync(join(ROOT, f), "utf8"))) : [];`;
- print `  unreported src/ files with code: ${unreported.length}` in the summary when `requireAllFiles`;
- in `--list` and `--report`, print each unreported file as `${file}  NOT IN REPORT`;
- in CI mode, if `unreported.length > 0`, add a failure to `failures` that names every file, followed by this hint: `"Each file holds code but no test loads it. Add a test that does, or, if a test does load it and Bun still omits it (GitHub #1779), list it in UNMEASURABLE with the reason."`.

Add one line to the header comment's Usage block: `--require-all-files   also fail on any src/ file with code that has no record in the report`.

- [ ] **Step 3: Run tests and checks**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/repo-tooling
bun test ./test/unit/scripts/check-coverage.test.ts --timeout=60000
bun run typecheck && bun run check:all
```

Expected: 33 pass (22 + 11), 0 fail; checks exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/repo-tooling
git commit -m "feat: check-coverage --require-all-files fails on src files with code missing from the report"
```

---

### Task 4: nax-agent's gate

**Files:**
- Modify: `packages/nax-agent/package.json`, `packages/nax-agent/bunfig.toml`, `.github/workflows/ci.yml`
- Create: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json` (by the gate)

**Interfaces:**
- Consumes: Task 3's `--require-all-files`, Task 1's ported tests.

- [ ] **Step 1: Coverage config for nax-agent's bunfig**

Append to `packages/nax-agent/bunfig.toml` under `[test]`:

```toml
# Coverage, only when `--coverage` is passed (`bun run test:coverage`). Mirrors
# packages/nax/bunfig.toml: lcov only, test files skipped, floors enforced by
# packages/repo-tooling/scripts/check-coverage.ts, which parses coverage/lcov.info.
coverageSkipTestFiles = true
coverageReporter = ["lcov"]
coverageDir = "coverage"
```

- [ ] **Step 2: Package scripts**

Add to `packages/nax-agent/package.json` `scripts`:

```json
    "test:coverage": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files",
    "test:coverage:report": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files --report",
    "test:coverage:update": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files --update-baseline",
    "test:coverage:list": "bun ../repo-tooling/scripts/check-coverage.ts --require-all-files --list",
```

- [ ] **Step 3: The gate fails before it has a baseline (RED)**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
bun run test:coverage 2>&1 | tail -8
```

Expected: exit 1, with `coverage-per-file-baseline.json missing`. The `lines`/`functions` lines read about 87%, at or above the floor. `unreported src/ files with code: 0` holds, because the four unreported files are type-only (decision 3). If the unreported count is not 0, read each file named. A file with real code that no test loads is a finding: stop and report it. A file a test does load is #1779: add it to `UNMEASURABLE` with the reason.

- [ ] **Step 4: Write the baseline and pass (GREEN)**

```bash
bun run test:coverage:update 2>&1 | tail -4
bun run test:coverage 2>&1 | tail -10
bun test ./test/unit/ ./test/integration/ --timeout=60000 2>&1 | grep -E '^Ran '
```

Expected: the baseline is written with about 31 files. `test:coverage` exits 0 with `[coverage] OK`. Its printed test count equals the plain run's `Ran N tests` (Review Focus 1). Read the baseline file: every key starts with `src/`. None of the four type-only files appears, and no key starts with `../`.

- [ ] **Step 5: CI step**

In `.github/workflows/ci.yml`, nax-agent job, replace the two comment lines that begin `# No coverage step:` with:

```yaml
      # nax-agent gates its own coverage (spec S2 §7.2): 80% lines and functions
      # overall, 80% per src/ file against scripts/baselines/coverage-per-file-baseline.json,
      # and every src/ file with executable code must appear in the report
      # (--require-all-files). The baseline must be empty before the first publish.
      - name: Coverage floor
        run: bun run test:coverage
```

- [ ] **Step 6: Reachability and commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun run check:gate-reachability
cd ../nax-agent && bun run check:all
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent .github/workflows/ci.yml
git commit -m "ci: nax-agent gates its own coverage"
```

Expected: `OK: all … check scripts are reachable from CI` (`check-coverage.ts` is reached through both packages' `test:coverage`).

---

### Task 5: Docs and context

**Files:** `.nax/mono/packages/nax-agent/context.md`, `.nax/rules/testing-commands.md`, generated files.

- [ ] **Step 1: nax-agent context**

Replace the paragraph that begins "**There is no coverage step here.**" (through "after changes that add or move tests.") with:

```markdown
**Coverage is gated here.** `bun run test:coverage` runs `test/unit/` and `test/integration/`
with coverage and enforces 80% lines and functions overall and 80% per `src/` file against
`scripts/baselines/coverage-per-file-baseline.json`. With `--require-all-files` it also fails on
any `src/` file that holds code but has no record in the report. CI runs it in this package's
job. The baseline only shrinks, and it must be empty before the first publish (spec S2 R2).
```

- [ ] **Step 2: `.nax/rules/testing-commands.md`**

Change each `scripts/check-coverage.ts` to `packages/repo-tooling/scripts/check-coverage.ts`, and `scripts/baselines/coverage-per-file-baseline.json` to `<package>/scripts/baselines/coverage-per-file-baseline.json`. After the paragraph that explains the one-invocation run, add one sentence: "nax and nax-agent each run it from their own package directory, each over its own `src/`; nax-agent adds `--require-all-files`."

- [ ] **Step 3: Regenerate and check drift**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun packages/nax/bin/nax.ts rules export --agent=claude
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
cd packages/nax && bun run check:rules-drift && bun run check:all
```

Expected: only nax-agent's generated agent files and the `.claude/rules/testing-commands.md` copy change besides the two sources; checks exit 0. Report any other changed generated file as drift instead of committing it.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A
git commit -m "docs: nax-agent coverage gate in context and testing rules"
```

---

### Task 6: Verify, conserve, record

**Files:** none (results go in the PR body).

- [ ] **Step 1: Totals.** Re-run Task 0 Step 3. Expected:
  - nax unit = before − 171 (the ten ported tests) − 20 (`check-coverage.test.ts`);
  - nax-agent unit = before + 171;
  - repo-tooling unit = before + 20 + 13 (Task 2: 2, Task 3: 11);
  - integration unchanged in both packages;
  - so the sum = before + 13 exactly, 0 fail.

- [ ] **Step 2: Gates.**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck && bun run check:all
cd packages/nax && bun run test:coverage 2>&1 | tail -8
cd ../nax-agent && bun run test:coverage 2>&1 | tail -8
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git diff origin/main -- packages/nax/package.json | grep -A3 '"dependencies"' || echo "nax dependencies untouched"
```

Expected: all exit 0; `nax dependencies untouched`.

- [ ] **Step 3: PR body record.** Put these in the PR body: nax's numbers before and after (Task 0 Step 4, Task 2 Step 5); nax-agent's overall numbers; the baseline file count and its full list as the S2-3b..d work list; the split table above; decisions 1-4; and the follow-up "nax has about 12 `src/` files with code and no coverage record (decision 2)". The PR is not opened without the maintainer's approval.

---

## Self-review notes

- Spec §7.2 bullets: `check-coverage` moves to repo-tooling and gains `--package` (Task 2, through `gatePackageRoot`). It runs nax-agent's unit and integration suites under nax-agent's preload (Task 4, run from nax-agent's directory). Floors are 80/80/80 (unchanged constants). The on-disk check is Task 3. nax drops nax-agent's suites and scope (Task 2), and nax's floors are re-measured on nax alone (Task 2 Step 5). The CI job gains the coverage step (Task 4 Step 5).
- **Not in this PR:** "the behaviour cases against the Node runtime" join nax-agent's coverage run when they exist (S2-4 creates them). The empty baseline is S2-3b..d plus the post-S2-4 drain, required before S2-9.
- Interface names are consistent across tasks: `gatedSuites`, `CANDIDATE_SUITES`, `hasExecutableCode`, `findUnreportedFiles`, `sourceFiles`, `--require-all-files`.
