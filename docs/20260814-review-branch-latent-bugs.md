# Code Review: Latent Bugs & Timeout Regressions in `fix/security-reliability-review-20260814`

**Date:** 2026-08-14
**Reviewer:** Claude (independent second-pass review)
**Scope:** full branch vs `main` (7d7d11ff) — 31 commits, 81 files, ~2950 insertions / 586 deletions
**Method:** 4 parallel subsystem reviews (locking/concurrency; timeout/hang fixes; config integrity; logger/CLI/PRD) + independent second-pass direct source verification of every HIGH and MEDIUM finding (rev 2)

**Rev 2 verification notes:** all 3 HIGH findings confirmed exactly as stated. Of the 5 MEDIUM findings, 3 confirmed as stated (BUG-34, BUG-36, BUG-37); 2 downgraded to LOW after tracing the full consumption path showed the claimed impact doesn't hold (BUG-35: hooks have a default 5s internal timeout that already matches the drain deadline — the gap is narrower than "no timeout at all"; BUG-38: the justification text is only rendered into the prompt when `testStrategy === "no-test"`, gated independently of the field's presence, so the claimed prompt-confusion consequence doesn't occur).

**Note on existing docs:** `docs/20260814-review-p0-fixes.md` self-reviews only 6 of the 31 fixes on this branch (the original "Batch 1" P0 set) and found nothing beyond two LOW items. This review covers the other 25 commits (Batches 2–7 from `docs/20260814-review-current.md`'s fix plan), which had no prior review pass, plus re-examines whether any of the P0 fixes interact badly with the later ones.

---

## Overall Grade: B (78/100)

| Dimension | Score |
|:---|:---|
| Security | 17/20 |
| Reliability | 14/20 |
| API Design | 16/20 |
| Code Quality | 16/20 |
| Best Practices | 15/20 |

The fixes are individually well-targeted and each closes the specific defect it names. But two of them introduce **new, concrete regressions** rather than just narrowing the original bug: the diff-drain deadline in `completion.ts` silently returns empty output for legitimately-slow-but-healthy `git diff` calls (data loss, not a hang), and the acceptance-gate crash guard in `acceptance.ts` compares a raw fail count against a deduplicated AC-ID count, so it false-positives on any overridden AC with more than one failing assertion. A third, `SEC-05`'s secret-masking fix, only covers one of `nax config`'s two display code paths — `--explain` still prints secrets in plaintext, which is the exact vulnerability the fix was meant to close. None of these are hypothetical; all three were verified against the code as written on HEAD.

---

## Findings

### 🟠 HIGH

#### BUG-31: `getDiffText`/`getDiffFilePaths` silently return empty output for diffs slower than 2s but faster than the 10s kill timeout
**Severity:** HIGH | **Category:** Bug (data loss, not a hang)
**File:** `src/pipeline/stages/completion.ts:288-311`, `:340-358`

```ts
const timerId = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, GIT_TIMEOUT_MS); // 10s
...
const [rawOutput] = await Promise.all([
  raceWithDeadline(readTextStreamPrefix(proc.stdout, MAX_DIFF_TEXT_CHARS), STREAM_DRAIN_DEADLINE_MS), // 2s
  raceWithDeadline(readTextStreamPrefix(proc.stderr, 0), STREAM_DRAIN_DEADLINE_MS),
  proc.exited,
]);
output = rawOutput === DRAIN_TIMEOUT ? "" : rawOutput;
...
return timedOut ? "" : output;
```

`STREAM_DRAIN_DEADLINE_MS` (2s) races the **live, still-running** git process on every invocation — not just after a SIGKILL, which is how the identical `raceWithDeadline` pattern is used everywhere else in the codebase (e.g. `verification/executor.ts:145-150`, which only applies it inside the `if (timedOut)` branch, after the process is already dead). Here, a `git diff` that takes 3–9 seconds (large diff, slow disk, NFS-backed workdir) but completes well within the real 10s budget hits the 2s stream-read deadline first: `rawOutput === DRAIN_TIMEOUT` → `output = ""`, while `timedOut` stays `false` (no kill fired) and the function returns success with empty content.

**Risk:** This function backs the fragment-capture system's "AC6: every changed file" guarantee (per the code's own comment) and completion-phase diff annotation. A moderately large or slow diff silently produces an empty fragment body / empty diff text with no error, warning, or retry — not a crash, a quiet correctness loss that is much harder to detect than a hang.

**Fix:** Apply `STREAM_DRAIN_DEADLINE_MS` only after `timedOut` is true (post-SIGKILL drain), mirroring `executor.ts`. Let the live read run unbounded up to the real `GIT_TIMEOUT_MS` kill.

#### BUG-32: Acceptance crash-guard compares raw fail count against deduplicated AC-ID count — false-positives when an overridden AC has multiple failing assertions
**Severity:** HIGH | **Category:** Bug
**File:** `src/pipeline/stages/acceptance.ts:277-278`, compared against `src/test-runners/ac-parser.ts:32-34`

```ts
if (exitCode !== 0 && failedACs.length > 0 && actualFailures.length === 0) {
  const { failCount } = analyzeTestExitCode(output, exitCode);
  if (failCount > failedACs.length) { /* report AC-ERROR: "suite may have crashed" */ }
}
```

`parseTestFailures()` (used to produce `failedACs`) is documented as returning a **"Deduplicated array of AC IDs"** — one entry per distinct `AC-N` label regardless of how many test cases carry that label. `failCount` from `analyzeTestExitCode` is the raw per-test-case failure count. If a single overridden AC has 3 failing `it()`/test-case blocks all tagged `AC-3`, `failedACs.length` is 1 but `failCount` is 3, so `failCount > failedACs.length` is true even though nothing failed beyond the overridden AC.

**Risk:** This is the exact scenario BUG-12 was fixed to correctly pass ("all failed ACs overridden → continue"). The fix's own guard now wrongly reports `AC-ERROR`/"suite may have crashed" for a legitimately-passing (post-override) package whenever an overridden AC's test coverage is more than one assertion — a common case, not an edge case.

**Fix:** Compare `failCount` against the raw (non-deduplicated) count of AC-tagged failure lines, or dedupe `failCount` the same way before comparing, so both sides count "distinct failing ACs" rather than mixing raw and deduplicated cardinalities.

#### BUG-33: `nax config --explain` still prints resolved secrets in plaintext — SEC-05 only patched one of two display paths
**Severity:** HIGH | **Category:** Security
**File:** `src/cli/config-display.ts:82-100`

```ts
} else if (explain) {
  displayConfigWithDescriptions(config, [], sources);   // <- config, unmasked
} else {
  const masked = maskProfileValues(config as unknown as Record<string, unknown>);
  console.log(JSON.stringify(masked, null, 2));          // <- masked
}
```

`configCommand`'s `--explain` branch calls `displayConfigWithDescriptions` directly on the raw `config` object; masking is wired only into the default (no-flag) branch. `nax config --explain` still prints the fully resolved config — including `models.<agent>.<tier>.env` values and anything else `maskProfileValues` targets — in plaintext to stdout, terminal scrollback, and captured CI output.

**Risk:** This is the identical exposure SEC-05 was opened to close, just reachable via a different flag. Anyone using `--explain` (arguably the more commonly reached-for flag for inspecting config) still leaks secrets.

**Fix:** Call `maskProfileValues(config)` before passing it into `displayConfigWithDescriptions`, or mask inside that function.

### 🟡 MEDIUM

#### BUG-34: `acquireLock`'s tombstone-restore step is an unconditional overwrite — can re-introduce double-acquisition under a 3-way race
**Severity:** MEDIUM (defeats the BUG-07 fix under concurrency, but requires 3 racing processes)
**File:** `src/execution/lock.ts:105-121`

The BUG-07 fix replaces unconditional `unlink` with `rename(lockPath, tombstonePath)` + pid verification, restoring via `rename(tombstonePath, lockPath)` on mismatch. `rename()` unconditionally overwrites whatever currently exists at the destination. Trace: process A reads stale lock (dead pid X); process B independently claims and replaces it with its own live lock (pid B); A's `rename(lockPath, tombstoneA)` succeeds anyway (against B's live lock, not the stale one A originally saw), sees the pid mismatch, and restores via `rename(tombstoneA, lockPath)` — but in the gap between A's steal and A's restore, a third process D sees no lock file, wins `O_CREAT|O_EXCL`, and believes it holds the lock. A's restore then silently overwrites D's fresh lock with B's stale tombstoned content. Result: B and D both believe they hold the lock.

**Fix:** Guard the restore with an exclusive create (fail if `lockPath` already exists) instead of a blind `rename`, or re-verify lock identity immediately after restoring.

#### BUG-36: `maskProfileValues` skips arrays — plugin-config secrets pass through unmasked when reused for the full `NaxConfig` (SEC-05)
**Severity:** MEDIUM | **Category:** Security
**File:** `src/cli/config-profile.ts:96-108`

`maskProfileValues` recurses into plain objects but explicitly excludes arrays (`typeof value === "object" && !Array.isArray(value)`). It was written for the flatter profile-JSON shape; SEC-05 reuses it verbatim for the full `NaxConfig`. `config.plugins` is `z.array(PluginConfigEntrySchema)`, each with an arbitrary `config: z.record(...)` bag — a plugin's `apiKey`/`token` stored inside `plugins[i].config` is never masked, even though the same key name would be masked outside an array.

**Fix:** Recurse into array elements too, or special-case `plugins[].config` explicitly.

#### BUG-37: `SENSITIVE_ENV_KEY_PATTERN` blocklist is incomplete — BUG-21's `process.env` fold-in can still leak secret-shaped values
**Severity:** MEDIUM | **Category:** Security
**File:** `src/config/dotenv.ts` / `src/config/profile.ts:38`

The BUG-21 fix folds `process.env` into the profile `$VAR` resolution base, gated only by `/key|token|secret|password|credential/i`. Names like `DATABASE_URL`, `AUTHORIZATION`, `PRIVATE_DATA`, `SESSION_ID` don't match and pass through. A project-controlled `.nax/config.json` profile field referencing `$DATABASE_URL` now resolves into the merged run config and can be persisted into `prd.json`/cost logs — the fix closes the "profile can't reach ambient env" gap but reopens a narrower secret-shaped-value leak.

**Fix:** Broaden the pattern (e.g. also match `_URL`, `_DSN`, `AUTH`, `SESSION`) or invert to an explicit allowlist of safe-to-fold keys.

### 🟢 LOW

- **L-g** (was BUG-35) `src/pipeline/event-bus.ts:334-364` — `drain()`'s fixed `DRAIN_SETTLE_DEADLINE_MS = 5000` doesn't scale with a hook's own configurable timeout. **Correction after verification:** hooks are not undefended — `src/hooks/runner.ts:15` sets `DEFAULT_TIMEOUT = 5000`, matching drain's default almost exactly, so the common case is fine. The real, narrower gap: `HookDefinition.timeout` is user-configurable per-hook (`src/hooks/types.ts:31`), and if a hook is configured with `timeout > 5000ms` (a legitimate deploy/notify script), `drain()` still drops it from `_pending` at the fixed 5s mark while the hook keeps running unobserved — the process can proceed mid-side-effect for that one configuration. Fix: derive `drain()`'s per-subscriber deadline from the max configured hook timeout, or accept a per-subscriber override.
- **L-h** (was BUG-38) `src/prd/schema.ts:228-246` — the `NO_TEST_JUSTIFICATION_SIGNAL` keyword gate (BUG-26 fix) can leave `testStrategy` and `noTestJustification` populated inconsistently (a justification worded without matching keywords stays attached to a story whose `testStrategy` remains e.g. `"test-after"`). **Correction after verification:** this is data hygiene only, not a functional bug — traced `src/pipeline/stages/prompt.ts:104` (`role = testStrategy === "no-test" ? "no-test" : "tdd-simple"`) and `src/prompts/sections/role-task.ts:52-61` (justification text is only rendered when `role === "no-test"`), confirming the field's presence is never independently read to gate test generation or alter the prompt for a non-`no-test` story. No other consumer (`src/config/test-strategy.ts` only references the field in a doc comment) reads it either. Cosmetic only — a stray populated field in `prd.json` with no behavioral effect.

- **L-a** `src/execution/status-writer.ts:216` — `this._mutex.then(write).catch(write)` calls `write` twice if `.then`'s handler throws (chained, not parallel). Currently inert because `_doUpdate` swallows all internal errors and never rejects — but a future edit removing that internal try/catch would silently reintroduce the exact torn-write race BUG-01 fixed. Worth a comment or an explicit guard.
- **L-b** `src/config/merger.ts` — the `__proto__`/`constructor`/`prototype` key filter (SEC-07) only strips keys from `override`, not `base`. Currently inert (spread-based merge, no `Object.assign` in the traced call graph) but the function provides no self-contained guarantee against a future caller reintroducing the hole via `base`.
- **L-c** `src/config/loader.ts:365-393` — hoisting the config guards to the no-profile package-overlay path (BUG-05) is a real, if intentional, compatibility break: any existing per-package config that silently passed through unvalidated before will now hard-fail `NaxConfigSchema.safeParse` where it previously ran. Correct fix, but worth flagging explicitly in the changelog/release notes since it can break existing repos' `.nax/mono/<pkg>/config.json` on upgrade.
- **L-d** `src/acceptance/hardening.ts:166-207` (BUG-04) — `killTimer`/`sigkillTimer` aren't cleared in a `finally`, so a rejecting `proc.exited` (rare) leaks both timers, which then fire later against a possibly-reused pid. Pre-existing in the pattern this fix mirrors (`quality/runner.ts` has the same gap) — not novel to this diff, already noted in `docs/20260814-review-p0-fixes.md` LOW-1.
- **L-e** `src/acceptance/hardening.ts` — the new per-spawn timeout bounds one package group but `processPackageGroup` runs sequentially per group with no phase-level cap, so total hardening-pass wall time in a monorepo with many groups is still effectively unbounded (N × 30min). Strictly better than fully unbounded, but doesn't fully deliver "the run's completion phase never wedges indefinitely."
- **L-f** `src/logger/redact.ts` — `MAX_REDACT_DEPTH = 100` labels legitimately deep (but non-circular) payloads with the same `"[Circular]"` marker used for actual cycles, which could mislead someone debugging logs into thinking there's a cycle that doesn't exist. Cosmetic; use a distinct `"[MaxDepth]"` marker.

---

## Verified Clean (no new bugs found)

- `src/worktree/manager.ts` (BUG-28) — force-delete guard correctly narrowed; no leak on the live-worktree branch.
- `src/utils/queue-file-lock.ts` (BUG-10), `src/execution/queue-handler.ts` / `src/pipeline/stages/queue-check.ts` (BUG-11) — lock-liveness check and single-critical-section refactor both correct; no dangling old code paths.
- `src/acceptance/fix-generator.ts` (BUG-29), `src/execution/progress.ts` (BUG-09) — fixes are correct as described, no regressions.
- `src/quality/runner.ts` (BUG-02), `src/utils/git.ts` / `src/execution/deferred-review.ts` (MED-04), `src/interaction/plugins/webhook.ts` (BUG-18/SEC-04), `src/agents/acp/adapter.ts` / `spawn-client-session.ts` — timers cleared on all paths, timeout vs. success correctly distinguished.
- `src/logger/formatters.ts` (MED-02) — three-tier fallback in `formatJsonl` cannot itself throw; no silent line drop. `redact.ts`'s WeakSet is correctly scoped per top-level call (no cross-call leakage).
- `src/cli/prompts-main.ts` (BUG-24) — `try/finally { await runtime.close() }` correctly wraps every path; no use-after-close or double-close.
- `src/interaction/triggers.ts` (BUG-17) — `applyFallback` is a no-op for non-timeout responses; only timeout/system paths change behavior, as intended.
- `src/review/semantic-evidence.ts` (SEC-03) — removal of the `isAbsolute` fallback strictly narrows behavior; no regression.
- `src/config/merge.ts` (BUG-06) — `!= null` gating consistently applied across all `packageOverride.agent` read sites.
- `src/prd/types.ts` (BUG-25) — `isStalled`'s retry boundary exactly matches `isResumableCurrentStory`'s `<=` semantics.
- `src/config/schemas.ts` / `schemas-execution.ts` (BUG-20) — derived-defaults refactor preserves original default values.
- `src/config/profile.ts` (SEC-08) — traversal validation correctly blocks `../` variants at all three entry points.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | BUG-33 | S | `nax config --explain` doesn't mask secrets — same vuln SEC-05 was meant to close |
| P0 | BUG-32 | S | Acceptance crash-guard false-positives on overridden ACs with multiple failing assertions |
| P0 | BUG-31 | S | `completion.ts` diff-drain deadline silently drops output on slow-but-healthy git diffs |
| P1 | BUG-34 | M | Lock tombstone-restore can double-acquire under 3-way race |
| P1 | BUG-37 | S | `SENSITIVE_ENV_KEY_PATTERN` blocklist incomplete (secret-shaped env leak) |
| P1 | BUG-36 | S | `maskProfileValues` skips arrays — plugin secrets unmasked |
| P3 | L-a…L-h | S | Documentation/hardening items; L-g and L-h were originally reported MEDIUM but downgraded after tracing the full consumption path showed no live functional impact |

Nothing here is a regression from `main`'s baseline for the *original* findings (all originally-reported bugs are genuinely fixed) — but BUG-31, BUG-32, and BUG-33 are new defects introduced by the fixes themselves and should block merge until addressed, since two of them (BUG-32, BUG-33) directly undermine the two findings they were meant to close.
