# S2-3c — Tools coverage drains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the nine tools/sandbox files out of nax-agent's coverage baseline — every one reaches 80% lines on nax-agent's own tests and its baseline entry is removed — by porting the seven nax test files that already exercise this code and adding new nax-agent tests for the two files nax never covered directly.

**Architecture:** This is a port, not authoring. nax still holds dedicated tests for exactly these files; they stayed in nax in S2-1 because they import nax fixtures and helpers. The one nax fixture every tools test uses is `naxProtectedPaths()`; nax-agent tests substitute a `testProtectedPaths()` fixture carrying the same policy values the assertions exercise (the interface is nax-agent's own `ProtectedPathsPolicy`). Five of the seven ports split: the nax-owned wiring tests (permission profiles, the rtk interceptor, `storyExecRoot`, nax data constants) stay in nax, everything else moves with a rule-based rewrite. No assertion is edited except the policy-data source (Rule P).

**Tech Stack:** Bun 1.4 workspaces (`linker = "isolated"`), TypeScript 7.0.2, `bun:test`, the repo-tooling coverage gate.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§7.2, R2) · split table in `docs/superpowers/plans/2026-10-02-s2-3a-nax-agent-coverage-gate.md`.

## Global Constraints

- Repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Branch `feat/s2-3c-tools-drains` cut from `origin/main`. Package commands run from the package directory. Never run bare `bun test` (no path) and never `bun run nax`.
- Floors (spec §7.2): **80% lines, 80% functions, 80% per file. "The gap is closed with new tests in nax-agent, never by lowering a floor."** The baseline only shrinks; it must be empty before S2-9 publishes.
- `packages/nax/package.json` **`dependencies` must stay byte-identical** to `main`.
- **No ported test is edited to make it pass.** A ported test changes only (a) its location, (b) import specifiers per Rule I, (c) the policy-data tokens listed in Rule P. Every other line is byte-identical (`git diff -M` shows renames).
- **Test counts are conserved per moved file**: the count Task 0 records for each ported file is the count that must run green in nax-agent (minus only the tests Rule S keeps in nax). Repo total changes only by the new tests this plan lists (10: 8 deny-paths + 2 protected-paths).
- No nax or nax-agent `src/` file may newly fall below its per-file floor or below its baseline because a test left nax. The exposures here: `src/utils/nax-owned-paths.ts`, `src/config/permissions.ts`, `src/runtime/packages.ts`, `src/execution/interceptors/rtk.ts` — the Rule S stays keep each covered. If anything still drops, stop and report; do not baseline it.
- Every commit leaves `bun run check:all` and the touched unit suites green. Conventional commits, no emojis, no push and no PR without the maintainer's approval.
- Max 2 fix rounds per task review.

## Measured baseline (main @ `82dabbd0e`, this plan's work list)

nax-agent own gate: 2574 tests, 90.42% lines / 89.76% functions, 24 baselined files. The nine this PR drains:

| File | Now | Uncovered (lines) | Drain |
|---|---|---|---|
| `src/tools/deny-paths.ts` | 2.78% | 21-52, 71-73 (glob translation, NFC, case-insensitive match) | new `test/unit/tools/deny-paths.test.ts` (8 tests) |
| `src/tools/protected-paths.ts` | 66.67% | 26 (`gitIgnorePatternsOf`) | new `test/unit/tools/protected-paths.test.ts` (2 tests) |
| `src/sandbox/policy-inputs.ts` | 48.78% | 27-30, 35-38, 49-53, 59-63, 69, 83-84 (layout arms, entry filtering, credential listing) | port `test/unit/sandbox/policy-inputs.test.ts` (15) |
| `src/tools/package-managers.ts` | 77.01% | 116, 143-144, 170-171, 188-191, … (classify/normalize branches) | port `test/unit/tools/package-managers.test.ts` (71, minus the worktree describe) |
| `src/tools/package-managers-table.ts` | 76.60% | 159-165, 215, 224-226, … (table lookups) | same port |
| `src/tools/git.ts` | 77.66% | 148-154, 173, 177-180, 200, 222-230, 240-244, 248-257, 280, 411-415, 430 (field validation, postProcess) | port `git.test.ts` (58, minus 1) + `git-interception.test.ts` (28, minus 1) |
| `src/tools/git-commit.ts` | 15.03% | 21-36, 87-143, 164-237 (argv build, partition, run) | port `test/unit/tools/git-commit.test.ts` (22, minus 1) |
| `src/tools/delete.ts` | 18.00% | 76-157 (gitignore checks, run, deny-paths) | port `test/unit/tools/delete.test.ts` (26, minus 2) |
| `src/coding-tools/coding-tool-sandbox.ts` | 20.25% | 71-92, 96-187, 253-264 (resolve, launcher wiring) | port `test/unit/agents/coding-tool-sandbox.test.ts` (30) |

`bun.spawnSync` in fixture helpers moves as-is: nax-agent tests already use it (`test/unit/internal/git-env.test.ts:110`), and `check-no-bun-apis` scans `src/` only.

## Review Focus

1. **A vacuous fixture**: `testProtectedPaths()` lists fewer ignore entries than the ported assertions rely on, so a refusal test fails loudly — the inverse is the trap: extra entries make nax-agent refuse MORE than nax's real policy, and the ports stay green while proving nothing about nax. Pinned in Task 1: fixture values are copied verbatim from nax's constants (provenance note in the file), and every port task's `git diff -M` read confirms assertion lines are byte-identical.
2. **Ports touch the developer's real `~/.nax`**: `naxProtectedPaths()` reads the live `globalConfigDir()`/`trustStorePath()`, and nax's `policy-inputs.test.ts` WRITES credential files into the real global dir. Pinned in Task 2 (and Rule P): every `globalConfigDir()`/`trustStorePath()` site becomes a temp-dir fixture or the fixture's own path; a grep step proves none remain in moved files.
3. **nax loses coverage when ~243 tests leave**: the files that keep tests (Rule S) are exactly the ones covering nax-owned src. Pinned in Task 9 Step 3: nax's own `test:coverage` stays green with no file newly below floor or baseline.
4. **The baseline update swallows a regression**: `test:coverage:update` rewrites every below-floor entry, hiding a newly-below-floor file. Pinned per task and Task 9 Step 2: the gate runs GREEN on the old baseline first; the diff removes only drained keys, adds none, and other values only rise.
5. **A split file rots**: the nax residue keeps describes whose imports were pruned; an unused import or a dangling helper breaks `typecheck`/biome only after the move. Pinned per split task: the residue file's own test run is green and `bun run check:all` passes before the commit.

---

## Rule I — the import rewrite (applies to every port)

- `from "@test/helpers"` → `from "#test/helpers/index"`
- `from "@/utils/git"` (`_gitDeps`, `gitWithTimeout`) → `from "@nathapp/nax-agent/internal"` (nax's `src/utils/git.ts:8` re-exports the same names; identity holdover from the S2-3a probe)
- `from "@nathapp/nax-agent"` and `from "@nathapp/nax-agent/internal"`: **unchanged** — in-package self-imports are established practice (`test/unit/tools/us-005.test.ts:25-26`, `runtime-command-shadow-executed.test.ts:17`)
- `from "bun:test"`, `from "node:*"`: unchanged
- Dynamic `await import("@/utils/git")` (git-interception line 117) → `await import("@nathapp/nax-agent/internal")` — same module instance, the assertion (internal caller never intercepted) holds

## Rule P — the policy-fixture rewrite (the ONLY other thing that changes)

Each ported file gets its `ProtectedPathsPolicy` from a nax-agent fixture instead of nax's builder:

1. `import { naxProtectedPaths } from "@/agents/nax-protected-paths";` is deleted; `testProtectedPaths` comes from `#test/helpers/index` (Task 1).
2. Token rewrite: `naxProtectedPaths()` → `testProtectedPaths()`. Multiple sites per file are all rewritten the same way.
3. Where an assertion reads the policy's own value, it reads the fixture's: `realOrRaw(trustStorePath())` → `realOrRaw(policy.trustStoreFile)` on the fixture instance the test built; `globalConfigDir()` in `policy-inputs.test.ts` → a per-test `makeTempDir` credential dir (the assertions become `join(credDir, n)` for the same `n`).
4. `NAX_OWNED_GIT_EXCLUDE_PATHSPECS` in `git.test.ts` → the local `GIT_EXCLUDES` const with the same two values (`[":(exclude).nax", ":(glob,exclude)**/.nax/**"]`); the moved describes already define exactly this const.
5. Everything else — every `test(...)` body, every assertion not named above, env-var save/restore, temp-dir cleanup — is byte-identical.

## Rule S — the split rule (nax-owned tests stay in nax)

A test stays in nax when its subject is nax wiring or nax data, not the nax-agent file being drained:

| Port file | Stays in nax | Reason |
|---|---|---|
| `git-commit.test.ts` | `is NOT in the default grant` (asserts `DEFAULT_CODING_TOOLS`, nax config) | nax config data |
| `delete.test.ts` | `the unrestricted profile grants Delete`, `the safe profile does NOT grant Delete` (`resolvePermissions` + `makeNaxConfig`) | nax permission wiring |
| `git.test.ts` | `the shared SSOT constant is the git exclude form the tool uses` (asserts `NAX_OWNED_GIT_EXCLUDE_PATHSPECS`) | pins nax's own constant |
| `git-interception.test.ts` | `a hint is stripped from output that also needs trimming` (`createRtkInterceptor`) | rtk's real postProcess |
| `package-managers.test.ts` | the whole `Exec target repoRoot under worktree isolation (nax#2093)` describe (`storyExecRoot`) | nax producer seam |

A stay keeps its describe scaffolding and imports in the residue file; the moved file keeps everything else. Both files must run green before the commit.

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Branch and install**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git fetch origin && git checkout -b feat/s2-3c-tools-drains origin/main
bun install --frozen-lockfile
```

- [ ] **Step 2: Record the per-file counts of the seven ported tests**

```bash
cd packages/nax
for f in test/unit/tools/git-commit.test.ts test/unit/tools/delete.test.ts \
  test/unit/tools/git.test.ts test/unit/tools/git-interception.test.ts \
  test/unit/tools/package-managers.test.ts test/unit/agents/coding-tool-sandbox.test.ts \
  test/unit/sandbox/policy-inputs.test.ts; do
  printf '%s ' "$f"; bun test "./$f" --timeout=60000 2>&1 | grep -E '^ *[0-9]+ (pass|skip|fail)' | tr '\n' ' '; echo
done
```

Expected (grep counts on main): git-commit 22, delete 26, git 58, git-interception 28, package-managers 71, coding-tool-sandbox 30, policy-inputs 15; all 0 fail. Record the exact triples — conservation targets. Also record how many tests the `storyExecRoot` describe holds (expect 2-3) — it is the package-managers stay.

- [ ] **Step 3: Record suite totals** for nax (`./test/unit/`, `./test/integration/`) and nax-agent (`./test/unit/`, `./test/integration/`), each `bun test <dir> --timeout=60000` from its package directory. All `fail` must be 0.

- [ ] **Step 4: Record the coverage picture**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | tail -12
cd ../nax && bun run test:coverage 2>&1 | tail -12
```

Keep both outputs: nax-agent's nine rows above are the before-numbers; nax's own lines/functions and its `files below floor` list are the Task 9 comparison.

- [ ] **Step 5: Record escape-hatch exposure** (S2-3b moved one entry with its file; know beforehand):

```bash
cd packages/nax && grep -oE '"test/unit/[^"]*(git-commit|delete|git|git-interception|package-managers|coding-tool-sandbox|policy-inputs)[^"]*"' scripts/baselines/test-escape-hatches-baseline.json || echo "no escape-hatch entries in the port set"
```

Measured on main: none. If one appears, move it with the file in that port task (same mechanism as S2-3b's auth-store-ops `looseCast`).

No commit in Task 0.

---

### Task 1: `testProtectedPaths` fixture + `session-sandbox-deps` copy + the two new drains

Three helpers land together because every port task imports them; the two new test files drain two baseline keys immediately.

**Files:**
- Create: `packages/nax-agent/test/helpers/protected-paths.ts`
- Create: `packages/nax-agent/test/helpers/session-sandbox-deps.ts` (copy of `packages/nax/test/helpers/session-sandbox-deps.ts`)
- Modify: `packages/nax-agent/test/helpers/index.ts` (two export blocks)
- Test: `packages/nax-agent/test/unit/tools/deny-paths.test.ts`, `packages/nax-agent/test/unit/tools/protected-paths.test.ts`

**Interfaces:**
- Produces: `testProtectedPaths(overrides?: Partial<ProtectedPathsPolicy>): ProtectedPathsPolicy` and `type TestProtectedPaths = ReturnType<typeof testProtectedPaths>` from `#test/helpers/index`; `NON_SHARED_TMPDIR`, `POLICY_BUILT`, `type ConfinedSessionOptions`, `type ConfinedSessionSeam`, `type SessionSandboxDepsLike`, `stubSessionSandboxDeps`, `withSessionSandboxSeam` (verbatim from nax's helper) — Tasks 2-8 import these.

- [ ] **Step 1: Write the failing tests**

`packages/nax-agent/test/unit/tools/deny-paths.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { matchesDenyPaths } from "@nathapp/nax-agent/internal";

describe("matchesDenyPaths", () => {
  test("undefined and empty denylists deny nothing", () => {
    expect(matchesDenyPaths("secrets.env", undefined)).toBe(false);
    expect(matchesDenyPaths("secrets.env", [])).toBe(false);
  });

  test("an exact literal matches itself and only itself (anchored both ends)", () => {
    expect(matchesDenyPaths("secrets.env", ["secrets.env"])).toBe(true);
    expect(matchesDenyPaths("src/secrets.env", ["secrets.env"])).toBe(false);
    expect(matchesDenyPaths("not-secrets.env", ["secrets.env"])).toBe(false);
  });

  test("* does not span separators, ** does", () => {
    expect(matchesDenyPaths("src/a.ts", ["*.ts"])).toBe(false);
    expect(matchesDenyPaths("a.ts", ["*.ts"])).toBe(true);
    expect(matchesDenyPaths("deep/nested/a.ts", ["**/*.ts"])).toBe(true);
  });

  test("? matches exactly one non-separator character", () => {
    expect(matchesDenyPaths("a.ts", ["?.ts"])).toBe(true);
    expect(matchesDenyPaths("ab.ts", ["?.ts"])).toBe(false);
    expect(matchesDenyPaths("a/b.ts", ["?.ts"])).toBe(false);
  });

  test("glob characters in the pattern are literal, not regex", () => {
    expect(matchesDenyPaths("a.+x", ["a.+x"])).toBe(true);
    expect(matchesDenyPaths("aax", ["a.+x"])).toBe(false);
  });

  test("matching is case-insensitive: .ENV is denied by .env (nax#1972)", () => {
    expect(matchesDenyPaths("src/.ENV", ["**/.env"])).toBe(true);
  });

  test("both sides are NFC-normalized: an NFD path from disk matches an NFC pattern", () => {
    expect(matchesDenyPaths("cafe\u0301.env", ["café.env"])).toBe(true);
  });

  test("a directory-shaped entry denies everything under it", () => {
    expect(matchesDenyPaths(".nax-wt/US-003/a.ts", [".nax-wt/"])).toBe(true);
    expect(matchesDenyPaths("other/a.ts", [".nax-wt/"])).toBe(false);
  });
});
```

`packages/nax-agent/test/unit/tools/protected-paths.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { gitExcludePathspecsOf, gitIgnorePatternsOf } from "@nathapp/nax-agent/internal";
import { testProtectedPaths } from "#test/helpers/index";

describe("protected-paths accessors", () => {
  test("a session with a policy hands back its lists", () => {
    const policy = testProtectedPaths();
    expect(gitExcludePathspecsOf({ protectedPaths: policy })).toBe(policy.gitExcludePathspecs);
    expect(gitIgnorePatternsOf({ protectedPaths: policy })).toBe(policy.gitIgnorePatterns);
  });

  test("a session with no policy gets empty lists, never undefined", () => {
    expect(gitExcludePathspecsOf({})).toEqual([]);
    expect(gitIgnorePatternsOf({})).toEqual([]);
  });
});
```

Run both: `cd packages/nax-agent && bun test ./test/unit/tools/deny-paths.test.ts ./test/unit/tools/protected-paths.test.ts --timeout=60000`
Expected: FAIL — `testProtectedPaths` is not exported from `#test/helpers/index` (the deny-paths file may already pass; that is fine, it pins current behaviour).

- [ ] **Step 2: Create the fixture helper**

`packages/nax-agent/test/helpers/protected-paths.ts`:

```ts
// Values copied from nax's src/agents/nax-protected-paths.ts + src/utils/nax-owned-paths.ts (S2-3c):
// the nax-owned constants themselves stay in nax; ports exercise the same engine with these entries.
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProtectedPathsPolicy } from "@nathapp/nax-agent";

/** nax's git exclude pathspecs (NAX_OWNED_GIT_EXCLUDE_PATHSPECS), verbatim. */
export const TEST_GIT_EXCLUDE_PATHSPECS: readonly string[] = [":(exclude).nax", ":(glob,exclude)**/.nax/**"];

/** The NAX_GITIGNORE_ENTRIES subset the ported tests' paths rely on (nax's list is longer; these are the entries its tests exercise). */
export const TEST_GITIGNORE_PATTERNS: readonly string[] = [
  "**/.nax/scratchpad/",
  ".nax-wt/",
  ".nax/metrics.json",
];

/** A host policy fixture: same shape an embedder supplies. Override per test; defaults are inert paths under tmpdir(). */
export function testProtectedPaths(overrides: Partial<ProtectedPathsPolicy> = {}): ProtectedPathsPolicy {
  return {
    gitExcludePathspecs: TEST_GIT_EXCLUDE_PATHSPECS,
    gitIgnorePatterns: TEST_GITIGNORE_PATTERNS,
    projectStateDir: ".nax",
    credentialDir: join(tmpdir(), "nax-agent-test-credentials"),
    trustStoreFile: join(tmpdir(), "nax-agent-test-trust.json"),
    ...overrides,
  };
}
```

- [ ] **Step 3: Copy `session-sandbox-deps.ts` and export both from the barrel**

```bash
cd packages/nax-agent && cp ../nax/test/helpers/session-sandbox-deps.ts test/helpers/session-sandbox-deps.ts
```

Prepend to the copy (above the existing comment block):

```ts
// Copied from packages/nax/test/helpers/session-sandbox-deps.ts (S2-3c); the original stays for nax's coding-tool-support-resolve and run-tmp-wipe tests — the one sanctioned duplicate (spec S2 §6.2). Keep the two in step.
```

Its imports (`bun:test`, `@nathapp/nax-agent` types, `@nathapp/nax-agent/internal` type, `./sandbox`) resolve unchanged in nax-agent — self-imports are established practice; `./sandbox` is nax-agent's own helper. Verify:

```bash
diff <(tail -n +2 test/helpers/session-sandbox-deps.ts) ../nax/test/helpers/session-sandbox-deps.ts && echo VERBATIM
```

Add to `test/helpers/index.ts`, after the timer-spy export:

```ts
export {
  type ConfinedSessionOptions,
  type ConfinedSessionSeam,
  type SessionSandboxDepsLike,
  NON_SHARED_TMPDIR,
  POLICY_BUILT,
  stubSessionSandboxDeps,
  withSessionSandboxSeam,
} from "./session-sandbox-deps";
export { TEST_GITIGNORE_PATTERNS, TEST_GIT_EXCLUDE_PATHSPECS, testProtectedPaths } from "./protected-paths";
```

- [ ] **Step 4: Run everything and verify the two drains**

```bash
cd packages/nax-agent
bun test ./test/unit/tools/deny-paths.test.ts ./test/unit/tools/protected-paths.test.ts --timeout=60000
bun run typecheck && bun run check:all
bun run test:coverage:update 2>&1 | tail -3
git diff scripts/baselines/coverage-per-file-baseline.json
bun run test:coverage 2>&1 | tail -6
```

Expected: 10 pass; VERBATIM; checks exit 0; the baseline diff removes exactly `src/tools/deny-paths.ts` and `src/tools/protected-paths.ts` (22 remain); no key added; gate green; `unreported src/ files with code: 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent/test
git commit -m "test: nax-agent policy fixture and sandbox helpers; drain deny-paths and protected-paths"
```

---

### Task 2: Port `policy-inputs.test.ts` (15 tests) — drains `policy-inputs.ts`

Smallest port; validates Rule P end to end.

**Files:**
- Move: `packages/nax/test/unit/sandbox/policy-inputs.test.ts` → `packages/nax-agent/test/unit/sandbox/policy-inputs.test.ts`
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule I, Rule P; `makeTempDir`, `cleanupTempDir` from `#test/helpers/index`; `@nathapp/nax-agent` / `/internal` imports unchanged.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite**

```bash
cd packages/nax-agent
git mv ../nax/test/unit/sandbox/policy-inputs.test.ts test/unit/sandbox/policy-inputs.test.ts
sed -i '' 's#from "@test/helpers";#from "\#test/helpers/index";#' test/unit/sandbox/policy-inputs.test.ts
```

Then Rule P by hand: delete the `@/config/paths` import; in the `listCredentialFiles` test replace the two `globalConfigDir()` calls with one `const credDir = makeTempDir("sbx-cred-");` (cleanup: the describe has no afterEach — add `rmSync`/`cleanupTempDir` in the existing `finally`, mirroring how the test already removes `made` files), and rewrite the `made` array + assertions to `join(credDir, n)` for the same names. Everything else byte-identical. Finally:

```bash
grep -nE '"@/|"@test/' test/unit/sandbox/policy-inputs.test.ts && echo "LEFTOVER ALIAS" || true
grep -n "globalConfigDir" test/unit/sandbox/policy-inputs.test.ts && echo "REAL CONFIG DIR" || true
bun x biome check --write test/unit/sandbox/policy-inputs.test.ts
git diff -M HEAD --stat
```

Expected: no LEFTOVER ALIAS, no REAL CONFIG DIR; a rename whose changed lines are imports and the Rule P block only. Read the full `git diff -M HEAD` before continuing.

- [ ] **Step 2: Run and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/sandbox/policy-inputs.test.ts --timeout=60000 && bun run typecheck
```

Expected: the Task 0 triple (15 pass), 0 fail.

- [ ] **Step 3: Verify the drain and shrink the baseline by one key**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | grep -E "policy-inputs|lines:|functions:|unreported"
bun run test:coverage:update 2>&1 | tail -3 && git diff scripts/baselines/coverage-per-file-baseline.json
bun run test:coverage 2>&1 | tail -6
```

Expected: `src/sandbox/policy-inputs.ts` ≥ 80% (the port adds the worktree-layout arm 35-38, the glob-char filtering 49-53/59-63, the credential listing 83-84); the diff removes only its key (21 remain); gate green. If it lands short, add focused tests in the same style for the still-uncovered lines, listed in the commit message.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port policy-inputs tests into nax-agent; drain the baseline entry"
```

---

### Task 3: Port `package-managers.test.ts` (71 tests, worktree describe stays) — drains `package-managers.ts` + `package-managers-table.ts`

**Files:**
- Split-move: `packages/nax/test/unit/tools/package-managers.test.ts` → `packages/nax-agent/test/unit/tools/package-managers.test.ts` (everything except the `storyExecRoot` describe); the residue keeps the describe, its comment block, and the `@/runtime/packages` import
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule I, Rule S; `classifyExec`, `isKnownManager`, `normalizeExec`, `type NormalizeInput` from `@nathapp/nax-agent/internal` (unchanged, self-import).
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — `git mv` the file, then move the `storyExecRoot` block (comment + `mainCheckout`/`worktreeRoot` consts + its describe, from `/**\n * Boundary invariant for Exec under worktree isolation` to the describe's close) BACK into a new `packages/nax/test/unit/tools/package-managers-worktree.test.ts` carrying the nax imports (`bun:test`, the agent-internal imports it uses, `storyExecRoot`). Apply Rule I's `@test/helpers` rewrite to the moved file if it appears (measured: it does not). LEFTOVER ALIAS grep + biome + full `git diff -M HEAD` read, as Task 2 Step 1.

- [ ] **Step 2: Run both sides and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/tools/package-managers.test.ts --timeout=60000 && bun run typecheck
cd ../nax && bun test ./test/unit/tools/package-managers-worktree.test.ts --timeout=60000 && bun run typecheck
```

Expected: nax-agent shows 71 minus the stay-count (Task 0's number); the nax residue shows exactly the stay-count; both 0 fail.

- [ ] **Step 3: Verify both drains and shrink the baseline by two keys** — as Task 2 Step 3. Expected: `src/tools/package-managers.ts` and `src/tools/package-managers-table.ts` ≥ 80% (the port adds the alias/denial/smuggling/redirect branches); the diff removes exactly those two keys (19 remain); gate green; add focused same-style tests for any shortfall, listed in the commit message.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port package-manager tests into nax-agent; drain both baseline entries"
```

---

### Task 4: Port `git-interception.test.ts` (28 tests, rtk test stays) — half the `git.ts` drain

**Files:**
- Split-move: `packages/nax/test/unit/tools/git-interception.test.ts` → `packages/nax-agent/test/unit/tools/git-interception.test.ts` (27 tests); the residue keeps `a hint is stripped from output that also needs trimming` with the `fake()` helper, `createRtkInterceptor` import and the `@/utils/git` `_gitDeps` import
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json` (no key removed yet — git.ts drains in Task 5)

**Interfaces:**
- Consumes: Rule I, Rule S; `makeSpawn`, `withDepsRestore` from `#test/helpers/index`; `_gitDeps` from `@nathapp/nax-agent/internal`; the dynamic `await import("@/utils/git")` → `await import("@nathapp/nax-agent/internal")`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — `git mv`, move the rtk test back into a new `packages/nax/test/unit/tools/git-interception-rtk.test.ts` (carrying `bun:test`, `@nathapp/nax-agent` imports it uses, `@test/helpers`, `@/execution/interceptors/rtk`, `@/utils/git`), then Rule I on the moved file (`@test/helpers` sed; `_gitDeps` import swap; dynamic import swap). LEFTOVER ALIAS grep + biome + full `git diff -M HEAD` read.

- [ ] **Step 2: Run both sides and compare counts** — as Task 3 Step 2. Expected: nax-agent 27, nax residue 1, both 0 fail, both typechecks green.

- [ ] **Step 3: Check the drain is on track**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | grep -E "tools/git.ts|lines:|functions:"
```

Expected: `src/tools/git.ts` rises (the postProcess paths 411-415 and the argv-bound validation 240-257 now run); it may still be below 80 — Task 5 finishes it. Do NOT update the baseline in this task.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port git interception tests into nax-agent; keep the rtk postProcess test in nax"
```

---

### Task 5: Port `git.test.ts` (58 tests, SSOT test stays) — drains `git.ts`

**Files:**
- Split-move: `packages/nax/test/unit/tools/git.test.ts` → `packages/nax-agent/test/unit/tools/git.test.ts` (57 tests); the residue keeps `the shared SSOT constant is the git exclude form the tool uses` with its describe and the `@/utils/nax-owned-paths` import
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule I, Rule P (token 4), Rule S; `makeTempDir`, `cleanupTempDir`, `testProtectedPaths` from `#test/helpers/index`; agent `.`/`/internal` imports unchanged.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — `git mv`, move the SSOT test back into a new `packages/nax/test/unit/tools/git-ssot.test.ts` (its describe title, comment, `@/utils/nax-owned-paths` import). Rule I (`@test/helpers`, `_gitDeps`). Rule P: hoist a module-scope `const GIT_EXCLUDES = TEST_GIT_EXCLUDE_PATHSPECS;` (or the literal — the moved describes already define local `GIT_EXCLUDES` consts where used; delete the nax import and point every `NAX_OWNED_GIT_EXCLUDE_PATHSPECS` site at the local const), and `naxProtectedPaths()` → `testProtectedPaths()` at every `protectedPaths:` site. LEFTOVER ALIAS grep + biome + full `git diff -M HEAD` read.

- [ ] **Step 2: Run both sides and compare counts** — as Task 3 Step 2. Expected: nax-agent 57, nax residue 1, both 0 fail.

- [ ] **Step 3: Verify the drain and shrink the baseline by one key** — as Task 2 Step 3. Expected: `src/tools/git.ts` ≥ 80% (adds the field-validation arms 148-154/173-180/200/222-230 that Task 4's buildGitArgv bounds tests and this port exercise); the diff removes only `src/tools/git.ts` (18 remain); gate green; same shortfall rule.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port git tool tests into nax-agent; drain the git baseline entry"
```

---

### Task 6: Port `git-commit.test.ts` (22 tests, default-grant test stays) — drains `git-commit.ts`

**Files:**
- Split-move: `packages/nax/test/unit/tools/git-commit.test.ts` → `packages/nax-agent/test/unit/tools/git-commit.test.ts` (21 tests); the residue keeps `is NOT in the default grant` with its describe and the `@/config/permissions` import
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule I, Rule P, Rule S; `makeSpawn`, `makeSpawnResult`, `testProtectedPaths` from `#test/helpers/index`; `_gitDeps` from `@nathapp/nax-agent/internal`; agent `/internal` imports unchanged.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — `git mv`, move the default-grant test back into a new `packages/nax/test/unit/tools/git-commit-default-grant.test.ts` (describe + `@/config/permissions` import). Rule I (`@test/helpers`, `_gitDeps` in `toolContext`). Rule P: `toolContext`'s `protectedPaths: naxProtectedPaths()` → `testProtectedPaths()` (the fixture's `**/.nax/scratchpad/` entry is what the Fix 3 tests' `.nax/scratchpad/notes.md` paths match; a missing entry fails those tests loudly). LEFTOVER ALIAS grep + biome + full `git diff -M HEAD` read.

- [ ] **Step 2: Run both sides and compare counts** — as Task 3 Step 2. Expected: nax-agent 21, nax residue 1, both 0 fail.

- [ ] **Step 3: Verify the drain and shrink the baseline by one key** — as Task 2 Step 3. Expected: `src/tools/git-commit.ts` ≥ 80% (adds `buildCommitArgvs` 21-36/87-143 and the run/partition path 164-237); the diff removes only its key (17 remain); gate green; same shortfall rule.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port git-commit tests into nax-agent; drain the baseline entry"
```

---

### Task 7: Port `delete.test.ts` (26 tests, two permission tests stay) — drains `delete.ts`

**Files:**
- Split-move: `packages/nax/test/unit/tools/delete.test.ts` → `packages/nax-agent/test/unit/tools/delete.test.ts` (24 tests); the residue keeps the two `resolvePermissions` tests with the `Delete wiring` describe, `makeNaxConfig`, `@/config/permissions` and `@/utils/git` imports
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule I, Rule P, Rule S; `testProtectedPaths` from `#test/helpers/index`; `gitWithTimeout` from `@nathapp/nax-agent/internal`; agent `.` imports unchanged.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — `git mv`, move the two permission tests back into a new `packages/nax/test/unit/tools/delete-permissions.test.ts` (describe + `makeNaxConfig`/`resolvePermissions` imports). Rule I (`@test/helpers`, `gitWithTimeout`). Rule P: the one `protectedPaths: naxProtectedPaths()` site (the Delete-then-GitCommit test) → `testProtectedPaths()`. LEFTOVER ALIAS grep + biome + full `git diff -M HEAD` read.

- [ ] **Step 2: Run both sides and compare counts** — as Task 3 Step 2. Expected: nax-agent 24, nax residue 2, both 0 fail.

- [ ] **Step 3: Verify the drain and shrink the baseline by one key** — as Task 2 Step 3. Expected: `src/tools/delete.ts` ≥ 80% (adds the tracked/ignored checks and run path 76-157, including `matchesDenyPaths` in situ); the diff removes only its key (16 remain); gate green; same shortfall rule.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port delete tool tests into nax-agent; drain the baseline entry"
```

---

### Task 8: Port `coding-tool-sandbox.test.ts` (30 tests) — drains `coding-tool-sandbox.ts`

Uses every Task 1 helper; no split — the whole file's subjects are nax-agent's, only its fixtures were nax's.

**Files:**
- Move: `packages/nax/test/unit/agents/coding-tool-sandbox.test.ts` → `packages/nax-agent/test/unit/coding-tools/coding-tool-sandbox.test.ts`
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule I, Rule P; `assertDefined`, `cleanupTempDir`, `makeFakeSandboxBackend`, `makeTempDir`, `withDepsRestore`, `withWarnSpy`, `ConfinedSessionSeam`, `NON_SHARED_TMPDIR`, `POLICY_BUILT`, `stubSessionSandboxDeps`, `withSessionSandboxSeam`, `testProtectedPaths` from `#test/helpers/index`; agent `/internal` imports unchanged.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — `git mv`, then Rule I (`@test/helpers` → `#test/helpers/index`; every name it needs is exported there after Task 1). Rule P: every `naxProtectedPaths()` → `testProtectedPaths()`, and the `trustStorePath()` assertion site → the fixture instance's `trustStoreFile` (build `const protectedPaths = testProtectedPaths();` where the test asserts `denyWrite` contains the trust store, pass it to the resolve call, assert `realOrRaw(protectedPaths.trustStoreFile)`). Delete the `@/trust` import. LEFTOVER ALIAS grep + `grep -n "trustStorePath\|globalConfigDir"` (must be empty) + biome + full `git diff -M HEAD` read.

- [ ] **Step 2: Run and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/coding-tools/coding-tool-sandbox.test.ts --timeout=60000 && bun run typecheck
```

Expected: the Task 0 triple (30 pass), 0 fail.

- [ ] **Step 3: Verify the drain and shrink the baseline by one key** — as Task 2 Step 3. Expected: `src/coding-tools/coding-tool-sandbox.ts` ≥ 80% (adds `resolveSessionSandbox` and the launcher wiring 71-187); the diff removes only its key (15 remain); gate green; same shortfall rule.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port coding-tool-sandbox tests into nax-agent; drain the baseline entry"
```

---

### Task 9: Verify, conserve, record

**Files:** none (results go in the PR body).

- [ ] **Step 1: Totals.** Re-run Task 0 Step 3. Expected:
  - nax unit = before − (moved) where moved = 71 + 27 + 57 + 21 + 24 + 30 + 15 minus the five stays' counts (Task 0 recorded each); integration unchanged;
  - nax-agent unit = before + moved + 10 (Task 1); integration unchanged;
  - repo sum = before + 10 exactly; 0 fail anywhere.

- [ ] **Step 2: Gates and baselines.**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck && bun run check:all
cd packages/nax-agent && bun run test:coverage 2>&1 | tail -8
git show origin/main:packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json | grep -c '": 0\.'
grep -c '": 0\.' scripts/baselines/coverage-per-file-baseline.json
git diff origin/main -- packages/nax/package.json | grep -A3 '"dependencies"' || echo "nax dependencies untouched"
```

Expected: all exit 0; nax-agent gate green with 15 baselined files (was 24); `nax dependencies untouched`.

- [ ] **Step 3: nax's own coverage held** (Review Focus 3).

```bash
cd packages/nax && bun run test:coverage 2>&1 | tail -12
```

Expected: exit 0; no file named below floor or newly baselined that Task 0 did not already name — specifically none of `src/utils/nax-owned-paths.ts`, `src/config/permissions.ts`, `src/runtime/packages.ts`, `src/execution/interceptors/rtk.ts`. If one appears, stop and report (Global Constraints); do not baseline it.

- [ ] **Step 4: PR body record.** nax-agent's before/after overall numbers; the nine before/after per-file rows; the baseline count 24 → 15 and the remaining 15 as the S2-3d work list; per-file ported counts (moved vs stayed per split); any focused tests added under the shortfall rule. The PR is not opened without the maintainer's approval.

---

## Self-review notes

- Spec §7.2 / R2 coverage: the gap closes with ports + 10 new tests, no floor moves, the baseline only shrinks (24 → 15), `--require-all-files` stays 0 (every step re-checks). The S2-3a split table's S2-3c row listed exactly these nine files; `internal/git-exec.ts` (76.47%) and the other 14 belong to S2-3d.
- Step scan: port tasks are rule-driven (Rules I/P/S decide every changed line); new tests carry their assertions as code; verification steps name the expected number. The `policy-inputs` credential-dir rewrite and the `coding-tool-sandbox` trust-store rewrite are the two places Rule P touches assertion-adjacent lines; both are pinned with the exact replacement shape.
- Interface consistency: `testProtectedPaths`/`TEST_GIT_EXCLUDE_PATHSPECS` (Task 1) match the names Tasks 5-8 use; `session-sandbox-deps` exports are verbatim, so `coding-tool-sandbox.test.ts`'s import list resolves unchanged.
- Review Focus: each line maps to a pinning step (VERBATIM diff + byte-identical assertion read; the two greps proving no real-config-dir reach; Task 9 Step 3; baseline diff discipline; per-split residue runs).
- Proportion: six of nine port tasks share one procedure specified by three rules; only the two Rule-P-heavy rewrites and the two new test files carry code.
