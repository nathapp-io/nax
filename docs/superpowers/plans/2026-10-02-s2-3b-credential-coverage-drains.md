# S2-3b — Credential/auth coverage drains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the seven credentials/auth files out of nax-agent's coverage baseline — every one of them reaches 80% lines on nax-agent's own tests and its baseline entry is removed — by porting the four nax test files that already exercise this code and adding small new tests for the two files nax never covered directly.

**Architecture:** This is a port, not authoring. nax still holds dedicated tests for exactly these files (`change-guard.test.ts`, `exec-source.test.ts`, `fingerprint.test.ts`, `auth-store-ops.test.ts`); they stayed in nax in S2-1 only because they import nax's `@/logger` and `@test/helpers`. nax-agent has had equivalents since S2-1/S2-3a (`makeLogger` + `setAgentLogger`, `#test/helpers/index`), so each file moves with a mechanical, rule-based rewrite — no assertion is touched. The one missing helper, `withTimerSpy`, is copied from nax (the sanctioned duplicate). `native/models.ts` and `infra/credentials-config.ts` get small new nax-agent test files instead; nax's `models.test.ts` imports nax config schemas and stays.

**Tech Stack:** Bun 1.4 workspaces (`linker = "isolated"`), TypeScript 7.0.2, `bun:test`, the repo-tooling coverage gate.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§7.2, R2) · split table in `docs/superpowers/plans/2026-10-02-s2-3a-nax-agent-coverage-gate.md`.

## Global Constraints

- Repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Branch `feat/s2-3b-credential-drains` cut from `origin/main`. Package commands run from the package directory. Never run bare `bun test` (no path) and never `bun run nax`.
- Floors (spec §7.2): **80% lines, 80% functions, 80% per file. "The gap is closed with new tests in nax-agent, never by lowering a floor."** The baseline only shrinks; it must be empty before S2-9 publishes.
- `packages/nax/package.json` **`dependencies` must stay byte-identical** to `main`.
- **No ported test is edited to make it pass.** A ported file changes only (a) its location, (b) import specifiers per the rewrite rules in each task, (c) the logger-capture tokens listed in Rule L. Every other line is byte-identical (`git diff -M` shows renames).
- **Test counts are conserved per moved file**: the count Task 0 records for each ported file is the count that must run green in nax-agent. Repo total changes only by the new tests this plan lists (9: 2 timer-spy + 4 models + 3 credentials-config).
- No nax or nax-agent `src/` file may newly fall below its per-file floor or below its baseline because a test left nax — nax's `src/logger/` is the exposure here. If one does, stop and report; do not baseline it.
- Every commit leaves `bun run check:all` and the touched unit suites green. Conventional commits, no emojis, no push and no PR without the maintainer's approval.
- Max 2 fix rounds per task review.

## Measured baseline (main @ `be5c34230`, this plan's work list)

nax-agent own gate: 2459 tests, 87.60% lines / 87.70% functions, 31 baselined files. The seven this PR drains:

| File | Now | Uncovered (lines) | Drain |
|---|---|---|---|
| `src/native/auth.ts` | 41.04% | 146-161, 175-245, 255-266, 297-345 (`fromPiEntry`, `importPiCredentials`, list/remove/label, `ambientShadows`, `providersWithoutCredentials`) | port `auth-store-ops.test.ts` (20 tests) |
| `src/native/credentials/exec-source.ts` | 44.03% | 91, 104-148, 172-211, 221-230, 269-285, 288 (`outcomeOf`, `handleFailure`, decline-with-lease, `managedByHelper`, `accountOf`) | port `exec-source.test.ts` (36 tests) |
| `src/native/credentials/change-guard.ts` | 40.96% | 64-107, 148-178 (`classify` verdicts, warn/refuse, identity/replacement data) | port `change-guard.test.ts` (22 tests) |
| `src/native/credentials/fingerprint.ts` | 78.08% | 57, 87-88, 124-139, 164 (EEXIST race, invalid-salt warn-once, fs failure, oauth secret) | port `fingerprint.test.ts` (13 tests) |
| `src/native/credentials/helper-process.ts` | 78.42% | 137, 150-156, 175-180, 210, 236-238, 248-249, 262-263, 291-326 (timeout/cap/spawn-fail/no-answer/EPIPE/drain-abort) | drained by the same exec-source port (it drives these paths through real helper scripts) |
| `src/infra/credentials-config.ts` | 57.14% | 26-30, 36 (unset throw, reset) | new `test/unit/infra/credentials-config.test.ts` (3 tests) |
| `src/native/models.ts` | 75.76% | 49-59, 81, 102-104, 201-209 (`parseNativeModel` throw, unknown effort, window override exceeds) | new `test/unit/native/models.test.ts` (4 tests) |

`git grep -l providersWithoutCredentials` in nax tests confirms `auth-store-ops.test.ts` is the direct-logic test (the `precheck/checks-native-credentials.test.ts` and `cli/auth*.test.ts` files test nax wiring and stay in nax). nax's `models.test.ts` stays: it imports `@/config` zod schemas and `@/agents/cost`.

## Review Focus

1. **A port silently measuring nothing**: the logger rewrite points assertions at a logger the code never logs to, so every log assertion passes vacuously. Pinned per port task: after the move, the target file's line coverage rises above 80% AND the specific logging branches listed in its table row appear in the report (they only execute when the captured logger is the installed one).
2. **`withTimerSpy` copy drifts from nax's original**, so future edits diverge. Pinned in Task 1: the copy is verbatim with a provenance first line, and a diff step proves it.
3. **Ports touch the developer's real `~/.nax`**: a lost `NAX_GLOBAL_CONFIG_DIR` save/restore lets credential-file writes hit home. Pinned per port task: the env-var save/restore and temp-dir cleanup blocks are preserved byte-identical (Rule L forbids touching them), and Task 7 re-runs the whole nax-agent suite green.
4. **The baseline update swallows a regression**: `test:coverage:update` rewrites every below-floor entry, hiding a newly-below-floor file. Pinned in Task 7 (and per-task): gate runs GREEN on the old baseline first; the diff after update removes only drained keys, adds none, and other values only rise.
5. **nax's logger loses coverage** because 91 tests that called `initLogger`/`addSink` leave nax. Pinned in Task 7 Step 3: nax's own `test:coverage` stays green with no file newly below floor or baseline; otherwise stop and report (Global Constraints).

---

## Rule L — the logger-capture rewrite (applies to Tasks 2-5, nothing else changes)

Each ported file captures log entries through nax's logger today. The mechanical replacement, token by token:

1. Delete the import line `import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";` and add:
   ```ts
   import { getSafeLogger, setAgentLogger } from "#src/infra/index";
   import { type LogCall, makeLogger } from "#test/helpers/index";
   ```
2. Replace the capture declarations and hooks:
   - `let entries: LogEntry[];` and `let unsubscribe: () => void;` → `let logger: ReturnType<typeof makeLogger>;`
   - add at module scope, after the env-var save: `const originalLogger = getSafeLogger();`
   - in `beforeEach`: the three lines `entries = [];` / `resetLogger();` / `initLogger({ level: "silent" });` / `unsubscribe = addSink((entry) => entries.push(entry));` → one line `logger = makeLogger(); setAgentLogger(logger);`
   - in `afterEach`: `unsubscribe();` / `resetLogger();` → `setAgentLogger(originalLogger);`
3. Token rewrites in bodies: `entries.filter(` → `logger.calls.filter(`; `entries.length = 0;` → `logger.reset();`; the type annotation `LogEntry[]` → `LogCall[]` (e.g. the `named()` / `credentialEvents()` helper return types). `entry.message`, `entry.level`, `entry.data` keep their names — `LogCall` carries the same fields.
4. Everything else — every `test(...)` body, every assertion, the `NAX_GLOBAL_CONFIG_DIR` save/restore blocks, temp-dir cleanup — is byte-identical.

`LogCall`/`makeLogger` are the existing exports of `packages/nax-agent/test/helpers/agent-logger.ts`; `setAgentLogger`/`getSafeLogger` the existing infra slot (`src/infra/index.ts:6`). Restoring `originalLogger` (the safe wrapper `getSafeLogger()` returns when unset) is the restore pattern `withLogSpy` in that same helper file already uses.

## Rule I — the import rewrite (applies to Tasks 2-5)

- `from "@test/helpers"` → `from "#test/helpers/index"`
- `from "@/errors"` → `from "@nathapp/nax-agent/internal"` (NaxError is nax's re-export of the identical class; imports already pointing there stay)
- `from "@/logger"` → handled by Rule L
- `from "bun:test"`, `from "node:*"`, `from "@nathapp/nax-ai"`, `from "@nathapp/nax-agent/internal"`: unchanged.

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Branch and install**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git fetch origin && git checkout -b feat/s2-3b-credential-drains origin/main
bun install --frozen-lockfile
```

- [ ] **Step 2: Record the per-file counts of the four ported tests**

```bash
cd packages/nax
for f in test/unit/agents/native/credentials/fingerprint.test.ts \
  test/unit/agents/native/credentials/change-guard.test.ts \
  test/unit/agents/native/credentials/exec-source.test.ts \
  test/unit/agents/native/auth-store-ops.test.ts; do
  printf '%s ' "$f"; bun test "./$f" --timeout=60000 2>&1 | grep -E '^ *[0-9]+ (pass|skip|fail)' | tr '\n' ' '; echo
done
```

Expected (grep counts on main): fingerprint 13, change-guard 22, exec-source 36, auth-store-ops 20; all 0 fail. Record the exact `pass/skip` triples — these are the conservation targets.

- [ ] **Step 3: Record suite totals** for nax (`./test/unit/`, `./test/integration/`) and nax-agent (`./test/unit/`, `./test/integration/`), each `bun test <dir> --timeout=60000` from its package directory. All `fail` must be 0.

- [ ] **Step 4: Record the coverage picture**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | tail -40
cd ../nax && bun run test:coverage 2>&1 | tail -12
```

Keep both outputs: nax-agent's seven rows above are the before-numbers; nax's own lines/functions and its `files below floor (baseline 2)` are the Task 7 comparison.

No commit in Task 0.

---

### Task 1: `withTimerSpy` for nax-agent

`exec-source.test.ts` imports `withTimerSpy` from `@test/helpers`; nax-agent has no equivalent. nax's `packages/nax/test/helpers/timer-spy.ts` is self-contained (spies on the globals only, no `bun:test`, no nax import), so it is copied under the sanctioned-duplicate rule (nax-agent AGENTS.md: a helper nax also needs is copied with a first-line note naming the original).

**Files:**
- Create: `packages/nax-agent/test/helpers/timer-spy.ts` (copy of `packages/nax/test/helpers/timer-spy.ts`)
- Modify: `packages/nax-agent/test/helpers/index.ts` (one export line)
- Test: `packages/nax-agent/test/unit/helpers/timer-spy.test.ts`

**Interfaces:**
- Produces: `withTimerSpy<T>(fn: () => Promise<T>): Promise<TimerSpyResult<T>>` and `TimerSpyResult<T>` (`{ result, armed, cleared, leaked }`) from `#test/helpers/index`. Task 4's port imports it.

- [ ] **Step 1: Write the failing tests**

`packages/nax-agent/test/unit/helpers/timer-spy.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { withTimerSpy } from "#test/helpers/index";

describe("withTimerSpy", () => {
  test("records armed and cleared timers; a cleared timer is not leaked", async () => {
    const spy = await withTimerSpy(async () => {
      const id = setTimeout(() => {}, 60_000);
      clearTimeout(id);
      return "done";
    });
    expect(spy.result).toBe("done");
    expect(spy.armed).toHaveLength(1);
    expect(spy.leaked).toEqual([]);
  });

  test("reports an armed-but-never-cleared timer as leaked", async () => {
    const spy = await withTimerSpy(async () => {
      setTimeout(() => {}, 60_000);
      return 1;
    });
    expect(spy.leaked).toEqual(spy.armed);
    clearTimeout(spy.armed[0] as ReturnType<typeof setTimeout>);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/nax-agent && bun test ./test/unit/helpers/timer-spy.test.ts --timeout=60000
```

Expected: FAIL — `withTimerSpy` is not exported from `#test/helpers/index`.

- [ ] **Step 3: Copy the helper and export it**

```bash
cd packages/nax-agent && cp ../nax/test/helpers/timer-spy.ts test/helpers/timer-spy.ts
```

Prepend this first line to the copy (above the existing comment block):

```ts
// Copied from packages/nax/test/helpers/timer-spy.ts (S2-3b); the original stays for nax's own tests — the one sanctioned duplicate (spec S2 §6.2).
```

Add to `test/helpers/index.ts`, after the agent-logger export block:

```ts
export { type TimerSpyResult, withTimerSpy } from "./timer-spy";
```

- [ ] **Step 4: Verify the copy is verbatim and the tests pass**

```bash
cd packages/nax-agent
diff <(tail -n +2 test/helpers/timer-spy.ts) ../nax/test/helpers/timer-spy.ts && echo VERBATIM
bun test ./test/unit/helpers/timer-spy.test.ts --timeout=60000
bun run typecheck && bun run check:all
```

Expected: `VERBATIM`; 2 pass; checks exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent/test/helpers
git commit -m "test: copy withTimerSpy from nax for nax-agent's helper barrel"
```

---

### Task 2: Port `fingerprint.test.ts` (13 tests)

Smallest port — it validates Rule L before the two big files.

**Files:**
- Move: `packages/nax/test/unit/agents/native/credentials/fingerprint.test.ts` → `packages/nax-agent/test/unit/native/credentials/fingerprint.test.ts`
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json` (Task 2's step removes one key)

**Interfaces:**
- Consumes: `#test/helpers/index` (`assertNaxError`, `makeTempDir`, `cleanupTempDir`, `makeLogger`), `#src/infra/index` (`getSafeLogger`, `setAgentLogger`), Rule L, Rule I.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite**

```bash
cd packages/nax-agent
git mv ../nax/test/unit/agents/native/credentials/fingerprint.test.ts test/unit/native/credentials/fingerprint.test.ts
sed -i '' 's#from "@test/helpers";#from "\#test/helpers/index";#' test/unit/native/credentials/fingerprint.test.ts
```

Then apply Rule L by hand to this one file (delete the `@/logger` import, add the two imports, the `originalLogger` const, the beforeEach/afterEach replacements, and the `entries` → `logger.calls` / `logger.reset()` / `LogEntry` → `LogCall` tokens). Finally:

```bash
grep -nE '"@/|"@test/' test/unit/native/credentials/fingerprint.test.ts && echo "LEFTOVER ALIAS" || true
bun x biome check --write test/unit/native/credentials/fingerprint.test.ts
git diff -M HEAD --stat
```

Expected: no LEFTOVER ALIAS; `git diff -M` shows a rename whose changed lines are imports, the Rule L tokens, and nothing else. Read the full `git diff -M HEAD` before continuing — any changed assertion is a Rule violation.

- [ ] **Step 2: Run in nax-agent and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/native/credentials/fingerprint.test.ts --timeout=60000
```

Expected: the Task 0 pass/skip/fail triple for this file, 0 fail. Then `bun run typecheck` exits 0.

- [ ] **Step 3: Verify the drain**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | grep -E "fingerprint|lines:|functions:|unreported"
```

Expected: `src/native/credentials/fingerprint.ts` at ≥ 80% (the EEXIST race at 87-88, the invalid-salt warn-once at 130-139 and the oauth secret at 164 are the lines the port adds); floors hold; `unreported src/ files with code: 0`.

- [ ] **Step 4: Shrink the baseline by this one key**

```bash
cd packages/nax-agent && bun run test:coverage:update 2>&1 | tail -3
git diff scripts/baselines/coverage-per-file-baseline.json
bun run test:coverage 2>&1 | tail -6
```

Expected: the diff removes `"src/native/credentials/fingerprint.ts"` and updates `updatedAt`; **no key is added**; every other changed value only rises. `test:coverage` exits 0 with 30 baselined files.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port fingerprint tests into nax-agent; drain the baseline entry"
```

---

### Task 3: Port `change-guard.test.ts` (22 tests)

**Files:**
- Move: `packages/nax/test/unit/agents/native/credentials/change-guard.test.ts` → `packages/nax-agent/test/unit/native/credentials/change-guard.test.ts`
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule L, Rule I, `#test/helpers/index`, `#src/infra/index`. The file's existing imports (`AuthStamp` type from `@nathapp/nax-agent`, `_resetFingerprintSalt`/`createChangeGuard`/`fingerprintCredential` from `@nathapp/nax-agent/internal`, `@nathapp/nax-ai` types) are unchanged — in-package they resolve to the same modules.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — same procedure as Task 2 Step 1 (`git mv`, Rule I sed for `@test/helpers`, Rule L by hand, LEFTOVER ALIAS grep, biome, and a full `git diff -M HEAD` read). Note this file also imports `type NaxError`-shaped helpers only via `assertNaxError`; its `@/logger` import carries `type LogEntry`, which Rule L replaces with `LogCall`.

- [ ] **Step 2: Run and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/native/credentials/change-guard.test.ts --timeout=60000 && bun run typecheck
```

Expected: the Task 0 triple for this file, 0 fail.

- [ ] **Step 3: Verify the drain**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | grep -E "change-guard|lines:|functions:|unreported"
```

Expected: `src/native/credentials/change-guard.ts` ≥ 80% — the `classify` verdict branches (148-178: renewed/changed, warn vs refuse, `CREDENTIAL_CHANGED` throw) and `servedAuth` are what the port adds; floors hold; unreported 0.

- [ ] **Step 4: Shrink the baseline by this one key** — identical to Task 2 Step 4. Expected: only `"src/native/credentials/change-guard.ts"` removed; 29 baselined files; gate green.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port change-guard tests into nax-agent; drain the baseline entry"
```

---

### Task 4: Port `exec-source.test.ts` (36 tests) — drains exec-source AND helper-process

**Files:**
- Move: `packages/nax/test/unit/agents/native/credentials/exec-source.test.ts` → `packages/nax-agent/test/unit/native/credentials/exec-source.test.ts`
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule L, Rule I; `withTimerSpy` (Task 1); `assertNaxError`, `makeTempDir`, `cleanupTempDir` from `#test/helpers/index`; `AUTH_HELPER_STDERR_MAX_BYTES`, `AUTH_HELPER_STDOUT_MAX_BYTES`, `createExecCredentialSource`, `LEASE_FRESHNESS_MS` from `@nathapp/nax-agent/internal` (unchanged); `type NaxError` — the `@/errors` import — from `@nathapp/nax-agent/internal` (Rule I).
- Produces: nothing later tasks import.

These tests spawn real helper scripts. In nax they ran under nax's installed Bun runtime; in nax-agent they run under the Node default runtime. S2-4 verified spawn parity (20/20 behaviour cases under both runtimes), so no assertion changes.

- [ ] **Step 1: Move and rewrite** — same procedure as Task 2 Step 1, plus Rule I for `from "@/errors"`. The file keeps `withTimerSpy` — now from `#test/helpers/index`.

- [ ] **Step 2: Run and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/native/credentials/exec-source.test.ts --timeout=120000 && bun run typecheck
```

Expected: the Task 0 triple for this file, 0 fail. A timeout-related failure under the Node runtime is a finding, not a test edit: report it (the S2-4 behaviour cases say it should not happen).

- [ ] **Step 3: Verify both drains**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | grep -E "exec-source|helper-process|lines:|functions:|unreported"
```

Expected: `src/native/credentials/exec-source.ts` ≥ 80% (adds `outcomeOf` 104-148, `handleFailure` 190-211, decline-with-lease 221-230, `managedByHelper` 269-285, `accountOf` 288) AND `src/native/credentials/helper-process.ts` ≥ 80% (adds timeout/cap kill paths 248-249/262-263, spawn-failed 291-293, no-answer 306-308, the `timed-out`/`stdout-over-cap` results 316-323). If helper-process lands between its current 78.42% and 80%, list its still-uncovered lines (`bun run test:coverage:report` prints them) and add focused tests in the SAME moved file's style (a `FakeHelper` spec driving that path) until it clears 80 — these are new tests, listed in the commit message.

- [ ] **Step 4: Shrink the baseline by these two keys** — as Task 2 Step 4. Expected: `"src/native/credentials/exec-source.ts"` and `"src/native/credentials/helper-process.ts"` removed; 27 baselined files; gate green.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port exec-source tests into nax-agent; drain exec-source and helper-process"
```

---

### Task 5: Port `auth-store-ops.test.ts` (20 tests) — drains `auth.ts`

**Files:**
- Move: `packages/nax/test/unit/agents/native/auth-store-ops.test.ts` → `packages/nax-agent/test/unit/native/auth-store-ops.test.ts`
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

**Interfaces:**
- Consumes: Rule L, Rule I; `assertNaxError`, `makeTempDir`, `cleanupTempDir` from `#test/helpers/index`; its `@nathapp/nax-agent/internal` imports unchanged.
- Produces: nothing later tasks import.

- [ ] **Step 1: Move and rewrite** — same procedure as Task 2 Step 1. This file's imports are `@nathapp/nax-agent/internal`, `@test/helpers`, `@/logger` only.

- [ ] **Step 2: Run and compare counts**

```bash
cd packages/nax-agent && bun test ./test/unit/native/auth-store-ops.test.ts --timeout=60000 && bun run typecheck
```

Expected: the Task 0 triple for this file, 0 fail.

- [ ] **Step 3: Verify the drain**

```bash
cd packages/nax-agent && bun run test:coverage:report 2>&1 | grep -E "native/auth|lines:|functions:|unreported"
```

Expected: `src/native/auth.ts` ≥ 80% (adds `fromPiEntry` 146-161, `importPiCredentials` 175-226 with all three error codes and the force/skip branches, list/remove/label 228-245, `ambientShadows` 255-266, `providersWithoutCredentials` 297-345). If it lands short, add focused tests in the same style for the still-uncovered lines, listed in the commit message, until it clears 80.

- [ ] **Step 4: Shrink the baseline by this one key** — as Task 2 Step 4. Expected: only `"src/native/auth.ts"` removed; 26 baselined files; gate green.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "test: port auth store-ops tests into nax-agent; drain the auth baseline entry"
```

---

### Task 6: New tests for `models.ts` and `credentials-config.ts`

**Files:**
- Create: `packages/nax-agent/test/unit/native/models.test.ts`
- Create: `packages/nax-agent/test/unit/infra/credentials-config.test.ts`

**Interfaces:**
- Consumes: `parseNativeModel`, `toThinkingLevel`, `resolveContextWindow` from `#src/native/models`; `configureCredentials`, `credentialsConfig`, `_resetCredentialsConfig`, `type CredentialsConfig` from `#src/infra/credentials-config`; `assertNaxError`, `makeLogger` from `#test/helpers/index`; `setAgentLogger`/`getSafeLogger` from `#src/infra/index`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing models tests**

`packages/nax-agent/test/unit/native/models.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { getSafeLogger, setAgentLogger } from "#src/infra/index";
import type { NaxError } from "#src/infra/index";
import { parseNativeModel, resolveContextWindow, toThinkingLevel } from "#src/native/models";
import { assertNaxError, makeLogger } from "#test/helpers/index";

const originalLogger = getSafeLogger();

/** Run a function that must throw a NaxError, and return it asserted. */
function expectNaxError(run: () => unknown, label: string): NaxError {
  try {
    run();
  } catch (err) {
    assertNaxError(err, label);
    return err;
  }
  throw new Error(`${label}: expected a NaxError`);
}

describe("parseNativeModel", () => {
  test.each(["gpt-5", "openrouter/", "/deepseek", "claude-opus-5[high]"])(
    "rejects %s as malformed with NATIVE_MODEL_MALFORMED",
    (raw) => {
      const err = expectNaxError(() => parseNativeModel(raw), `parseNativeModel(${raw})`);
      expect(err.code).toBe("NATIVE_MODEL_MALFORMED");
    },
  );
});
```

```ts
describe("toThinkingLevel", () => {
  test("passes a valid level through", () => {
    expect(toThinkingLevel("high")).toBe("high");
  });

  test("an unknown effort warns once with the effort in data and returns undefined", () => {
    const logger = makeLogger();
    setAgentLogger(logger);
    try {
      expect(toThinkingLevel("turbo")).toBeUndefined();
      const warns = logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.data).toMatchObject({ effort: "turbo" });
    } finally {
      setAgentLogger(originalLogger);
    }
    expect(toThinkingLevel(undefined)).toBeUndefined();
  });
});

describe("resolveContextWindow", () => {
  test("an override above the real window throws CONTEXT_WINDOW_OVERRIDE_EXCEEDS_REAL_WINDOW", () => {
    const err = expectNaxError(() => resolveContextWindow(200_000, 128_000), "window override rejection");
    expect(err.code).toBe("CONTEXT_WINDOW_OVERRIDE_EXCEEDS_REAL_WINDOW");
  });

  test("an override at or below the real window is accepted, and undefined falls back", () => {
    expect(resolveContextWindow(128_000, 128_000)).toBe(128_000);
    expect(resolveContextWindow(8_000, 128_000)).toBe(8_000);
    expect(resolveContextWindow(undefined, 128_000)).toBe(128_000);
  });
});
```

Run: `cd packages/nax-agent && bun test ./test/unit/native/models.test.ts --timeout=60000`
Expected: PASS (these pin current behaviour; the RED check is Step 3's coverage row — the file's uncovered lines 49-59/102-104/201-209 must be exercised, and they are exactly these tests' branches).

- [ ] **Step 2: Write the failing credentials-config tests**

`packages/nax-agent/test/unit/infra/credentials-config.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import type { NaxError } from "#src/infra/index";
import {
  type CredentialsConfig,
  _resetCredentialsConfig,
  configureCredentials,
  credentialsConfig,
} from "#src/infra/credentials-config";
import { assertNaxError } from "#test/helpers/index";

afterEach(() => {
  _resetCredentialsConfig();
});

/** Run a function that must throw a NaxError, and return it asserted. */
function expectNaxError(run: () => unknown, label: string): NaxError {
  try {
    run();
  } catch (err) {
    assertNaxError(err, label);
    return err;
  }
  throw new Error(`${label}: expected a NaxError`);
}

describe("credentialsConfig", () => {
  test("throws CREDENTIALS_NOT_CONFIGURED at stage credentials when the slot is unset", () => {
    _resetCredentialsConfig();
    const err = expectNaxError(() => credentialsConfig(), "unset slot");
    expect(err.code).toBe("CREDENTIALS_NOT_CONFIGURED");
  });

  test("returns the configured config, and only that instance", () => {
    const config: CredentialsConfig = {
      configDir: () => "/tmp/does-not-matter",
      readAuthConfig: async () => ({ source: "file", onChange: "warn" }),
    };
    configureCredentials(config);
    expect(credentialsConfig()).toBe(config);
  });

  test("_resetCredentialsConfig clears the slot again", () => {
    configureCredentials({ configDir: () => "/", readAuthConfig: async () => ({ source: "file", onChange: "warn" }) });
    _resetCredentialsConfig();
    expect(() => credentialsConfig()).toThrow();
  });
});
```

Run: `cd packages/nax-agent && bun test ./test/unit/infra/credentials-config.test.ts --timeout=60000`
Expected: 3 pass. Note: other suites configure the slot; the `afterEach` reset leaves it unset, which is the state the module documents as the default.

- [ ] **Step 3: Verify both drains and shrink the baseline by two keys**

```bash
cd packages/nax-agent && bun run test:coverage:update 2>&1 | tail -3
git diff scripts/baselines/coverage-per-file-baseline.json
bun run test:coverage 2>&1 | tail -6
```

Expected: `src/native/models.ts` and `src/infra/credentials-config.ts` gone from the below-floor list (24 baselined files remain); the diff removes exactly those two keys, adds none; `test:coverage` exits 0; `unreported src/ files with code: 0`.

- [ ] **Step 4: Checks and commit**

```bash
cd packages/nax-agent && bun run typecheck && bun run check:all
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent
git commit -m "test: cover models error paths and the credentials-config slot; drain both entries"
```

---

### Task 7: Verify, conserve, record

**Files:** none (results go in the PR body).

- [ ] **Step 1: Totals.** Re-run Task 0 Step 3. Expected:
  - nax unit = before − 91 (13 + 22 + 36 + 20); integration unchanged;
  - nax-agent unit = before + 91 + 9 (Task 1: 2, Task 6: 7); integration unchanged;
  - repo sum = before + 9 exactly; 0 fail anywhere.

- [ ] **Step 2: Gates and baselines.**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck && bun run check:all
cd packages/nax-agent && bun run test:coverage 2>&1 | tail -8
git show origin/main:packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json | grep -c '": 0\.' 
grep -c '": 0\.' scripts/baselines/coverage-per-file-baseline.json
git diff origin/main -- packages/nax/package.json | grep -A3 '"dependencies"' || echo "nax dependencies untouched"
```

Expected: all exit 0; nax-agent gate green with 24 baselined files (was 31); `nax dependencies untouched`.

- [ ] **Step 3: nax's own coverage held** (Review Focus 5).

```bash
cd packages/nax && bun run test:coverage 2>&1 | tail -12
```

Expected: exit 0; `files below floor (baseline 2)` with no file named that Task 0 did not already name — specifically no `src/logger/` file. If one appears, stop and report (Global Constraints); do not baseline it.

- [ ] **Step 4: PR body record.** nax-agent's before/after overall numbers; the seven before/after per-file rows from this plan's table; the baseline count 31 → 24 and the remaining 24 as the S2-3c/d work list; per-file ported counts; any focused tests added under Task 4 Step 3 / Task 5 Step 3. The PR is not opened without the maintainer's approval.

---

## Self-review notes

- Spec §7.2 / R2 coverage: the gap closes with tests in nax-agent (ports + 9 new), no floor moves, the baseline only shrinks (31 → 24), `--require-all-files` stays 0 throughout (every step re-checks). The S2-3a split table's S2-3b row listed exactly these files plus the two post-S2-4 ones (`helper-process`, now drained with exec-source; `internal/git-exec.ts` stays for S2-3d with the rest — its 76.47% belongs to the "rest" drain, not credentials/auth).
- Step scan: port tasks are rule-driven (Rules L and I decide every changed line); new-test tasks carry the assertions as code; verification steps name the expected number.
- Interface consistency: `withTimerSpy`/`TimerSpyResult` (Task 1) match nax's names, which Task 4's port already uses; `makeLogger`/`LogCall`/`setAgentLogger`/`getSafeLogger` are existing exports, cited by file and line.
- Review Focus: each line maps to a pinning step (coverage-rise assertions per port; the VERBATIM diff; byte-identical env-var blocks checked by the `git diff -M` read; baseline diff discipline; nax coverage re-check).
- Proportion: four of seven tasks are mechanical ports specified by two rules, not transcribed bodies.
