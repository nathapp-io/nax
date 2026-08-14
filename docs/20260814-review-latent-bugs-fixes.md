# Code Review: fixes for the 6 latent bugs (BUG-31..34, 36, 37)

**Date:** 2026-08-14
**Reviewer:** Claude (self-review of own changes)
**Scope:** 9 files (6 source + 2 test-runner barrel/impl + 1 new test block), uncommitted working-tree changes on `fix/security-reliability-review-20260814`, diffed against the branch's own HEAD (not `main`)
**Baseline:** `bun run typecheck` green, `bun run lint` green (incl. both test-debt ratchets unchanged), 4246 tests / 0 fail across all touched subsystems

---

## Overall Grade: A- (88/100)

| Dimension | Score |
|:---|:---|
| Security | 18/20 |
| Reliability | 18/20 |
| API Design | 17/20 |
| Code Quality | 18/20 |
| Best Practices | 17/20 |

Each fix is targeted at exactly the finding it addresses, reuses an existing in-repo pattern where one exists (`executor.ts`'s post-exit drain shape for BUG-31, the existing `O_CREAT|O_EXCL` exclusive-create idiom for BUG-34), and ships with a regression test where the finding was behavioral (BUG-31). The one iteration mistake — my first BUG-31 fix over-corrected and broke the existing BUG-13 regression tests by gating the drain deadline on `timedOut` instead of "past `proc.exited`" — was caught by the existing test suite and corrected before commit, which is exactly what that suite is for. No fix introduces a new abstraction beyond what's needed, and no fix touches code outside its named finding's blast radius. Deductions are for two pre-existing gaps inherited (not introduced) by this diff, and one design decision (broadening two secret-key regexes) whose false-positive tradeoff is real but was consciously accepted per the finding's own reasoning.

---

## Findings

### 🟢 LOW

#### LOW-1: `completion.ts` stream reads lack the `.catch()` safety net that `executor.ts`'s reference pattern has
**Category:** Reliability
**File:** `src/pipeline/stages/completion.ts:317-318`, `:373-374`

`executor.ts`'s `stdoutPromise = new Response(proc.stdout).text().catch(() => "")` guarantees the underlying stream-read promise can never reject — `raceWithDeadline`'s `Promise.race` then only ever "loses" to a slow-but-eventually-resolving promise, never to a rejecting one. `completion.ts`'s `readTextStreamPrefix`/`readDiffFilePaths` have no equivalent `.catch()`, so if the stream itself errors (e.g. a broken pipe after SIGKILL — the exact scenario BUG-13 documents), the underlying promise can reject. Once `drainAfterExit`'s `raceWithDeadline` has already resolved via its own timeout branch, that rejected underlying promise becomes an unhandled rejection.

**This is not a regression from this diff** — the same gap existed in the pre-fix code (the promises were unguarded there too; only the point where they were raced against the deadline moved). Flagging for visibility since BUG-31's fix touched this exact code path and the reference pattern it partially followed does include this safety net. Not blocking.

**Fix (optional, out of scope for this diff):** add `.catch(() => "")` / `.catch(() => new Set())` at the point `stdoutPromise`/`stderrPromise`/`pathsPromise` are created, mirroring `executor.ts`.

#### LOW-2: Broadening `SENSITIVE_ENV_KEY_PATTERN`/`SENSITIVE_KEY_PATTERN` to include `url`, `auth`, `session` trades false positives for safety
**Category:** Reliability (usability)
**File:** `src/config/profile.ts:34`, `src/cli/config-profile.ts:22`

Adding `auth|session|cookie|private|dsn|url` to both patterns means legitimate non-secret fields whose names merely contain these substrings — e.g. a profile field literally named `baseUrl`, or a config value under a key like `sessionTimeout` — now get masked in `nax config profile show` output and excluded from the ambient `process.env` fallback in `loadProfileEnv`. This is the documented, intentional tradeoff (over-matching fails safe: a var excluded from the fallback throws `UnresolvedEnvVarError` rather than leaking), and existing tests for both files pass unmodified, so no currently-tested config shape regresses. Noting it because it's a real, if accepted, usability cost — a user with a profile that legitimately references `$SOME_SERVICE_URL` will now hit a hard failure post-fix where it silently resolved before, and will need to define it explicitly in the profile's own `.env` file to unblock (which is the fix's stated intent, but worth being aware of as a behavior change for existing users).

---

## Verification of each fix's core claim

- **BUG-31** (`completion.ts`): confirmed the new `drainAfterExit` helper is only ever invoked after `await proc.exited`, so `STREAM_DRAIN_DEADLINE_MS` never races a live process — traced both call sites (`getDiffText`, `getDiffFilePaths`). Added two new regression tests (`SLOW_BUT_HEALTHY_MS = 2500`, i.e. past the 2s deadline but under the 10s kill timeout) proving the fix: both fail on the pre-fix code path (would resolve to `""`/empty `Set`) and pass on the fixed code. The pre-existing BUG-13 regression tests (normal exit, streams that never close) still pass — confirmed the deadline still applies unconditionally post-exit, not just post-kill, so both findings stay fixed simultaneously.
- **BUG-32** (`acceptance.ts` / `ac-parser.ts`): confirmed `parseTestFailuresDetailed` increments `taggedFailureCount` on every one of the five match branches (Bun, Go, pytest, Jest/Vitest, AC-HOOK sentinel) that also push to `failedACs` — the two counters are computed from the exact same match sites, just one dedups and one doesn't, so they can never drift independently. `parseTestFailures` (the pre-existing export) is now a one-line delegate to `.failedACs`, preserving its exact prior contract — confirmed via the passing `test-runners` suite with no changes needed there.
- **BUG-33** (`config-display.ts`): confirmed the `--explain` branch now runs through the exact same `maskProfileValues` call as the default JSON view, so both `nax config` display paths are masked identically post-fix.
- **BUG-34** (`lock.ts`): confirmed `tryExclusiveCreate` is only reachable from the `claimedPid !== lockPid` (mismatch/steal) branch, confirmed it's wrapped by `acquireLock`'s existing outer `try/catch` so a non-EEXIST error (e.g. permission denied) degrades to `return false` + a logged warning rather than crashing the caller — same failure mode as every other error path in this function. Confirmed the tombstone is always cleaned up (`unlink(tombstonePath)`) regardless of whether the restore succeeded, so no `.stale.<pid>.<ts>` files are leaked on either branch.
- **BUG-36** (`config-profile.ts`): confirmed `maskProfileValue` is mutually recursive with `maskProfileValues` (object branch) and self-recursive for arrays, confirmed finite depth (config trees, not user-supplied arbitrary-depth data — no circular-reference risk class here, unlike the logger's `redactValue`). Confirmed `plugins[].config.apiKey` — the motivating case — now masks correctly by tracing the schema (`PluginConfigEntrySchema.config: z.record(...)` inside `z.array(...)`).
- **BUG-37** (`profile.ts` / `config-profile.ts`): confirmed both copies of the pattern were updated in lockstep (the file comments cross-reference each other, matching the existing "mirrors" comment already in the codebase before this diff).

## Test-suite interaction (worth calling out, not a defect)

My first attempt at the BUG-31 fix gated `drainAfterExit`'s deadline on the `timedOut` flag (i.e., only apply the 2s deadline if *we* killed the process). This broke two existing BUG-13 regression tests, which simulate a process that exits normally (not via our SIGKILL) but whose streams never close regardless — a scenario the deadline is supposed to catch independent of *why* the process exited. The existing test suite caught this immediately (`bun test` — 2 failing, both timing out at their 5s test timeout) before any commit. Corrected by applying the deadline unconditionally once `proc.exited` has resolved (any reason), which satisfies both BUG-31 (never races a *live* process) and BUG-13 (always bounds the *post-exit* drain) simultaneously. This is exactly what a pre-existing regression-test suite is supposed to catch on a fix that touches shared logic — surfaced here for transparency, not as an unresolved finding.

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P3 (optional) | LOW-1 | S | Add `.catch()` guards to the stream-read promises in `completion.ts`, mirroring `executor.ts` |
| P3 (informational) | LOW-2 | — | No code change — documents an accepted usability tradeoff from broadening the secret-key regexes |

Nothing here blocks merge.
