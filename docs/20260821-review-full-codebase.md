# Deep Code Review: @nathapp/nax (full codebase)

**Date:** 2026-08-21 (**rev. 3** — 2026-08-22: re-verification + implementation handover)
**Reviewer:** ox-alpha (AI); rev. 2 re-verification and rev. 3 decision register by a second reviewer
**Status:** ready for handover — see **Handover Brief** below before starting work
**Version:** 0.81.0 (HEAD `76c5bafdc`, clean tree)
**Files:** ~891 TS files in `src/` + `bin/` (~141k LOC); all 40 source directories covered via 6 parallel deep-dive passes + knowledge-graph hotspot analysis
**Baseline:** `bun run typecheck` — clean (exit 0) at review time; only 4 non-comment `any` uses in `src/`

---

## Revisions — what changed and why

Every rev-1 finding was independently re-read against source at HEAD `76c5bafdc`. **All 47 findings
survive as real defects** — nothing was withdrawn. What changed is *accuracy*, and in two cases
*severity*:

| # | Change | Effect |
|:--|:---|:---|
| R1 | **BUG-1 escalated in blast radius.** Rev 1 stopped at "verifier gate goes green". It missed that a passing verifier verdict is load-bearing far beyond its own phase: `shouldSkipPhaseForRectification` and `ExecutionPlan.run`'s success aggregation *both* carve out full-suite-gate failures whenever the verifier explicitly passed ("verifier-as-SSOT"). A coerced false-green verdict therefore **suppresses the real test-execution gate**, rather than merely sitting beside it. | BUG-1 rationale rewritten; stays P0 |
| R2 | **BUG-1's proposed fix was wrong.** Rev 1 recommended requiring `verdict.approved !== false` in `categorizeVerdict`. That directly contradicts a documented design decision (`operations/verify.ts:130-133`: `approved:false` for *advisory* AC/quality reasons is deliberately treated as success — semantic review owns those). Implementing rev 1's fix would regress the advisory-override path. | Fix replaced with an evidence-based one |
| R3 | **BUG-2's proposed fix was insufficient.** Rev 1 said "normalization exists (`normalizeSeverity`) but isn't applied". It is applied on the `Finding` conversion path — and it is **itself case-sensitive and fails open** (`"Critical"` → `"info"`). Normalizing only inside `isBlockingSeverity` leaves the converted-`Finding` lane still wrong. | Fix moved to the parse boundary |
| R4 | **New finding BUG-48** (HIGH): `interaction.defaults.fallback` is dead config — never read by anything. The removal notice in `interaction/init.ts:33` explicitly instructs users to set it. | Added |
| R5 | **BUG-12 under-scoped.** Not just `cost.amount` — all four numeric fields in the `usage_update` block (`inputTokens`, `outputTokens`, `used`, `cost.amount`) use a bare `typeof` check. | Scope widened |
| R6 | **TYPE-29 / ENH-47 partly speculative.** The repo declares no `engines` field and contains **zero** `win32` references in `src/`; Windows is not a supported target. The Win32 halves of both findings are hypothetical. The POSIX half of TYPE-29 (`runtime/packages.ts` separator-less `startsWith`) is real on every platform. | Both demoted / re-scoped |
| R7 | **Priority table was off by one** from BUG-10 downward (it labelled BUG-11 "metrics", BUG-12 "scratch purge", etc.), and referenced a nonexistent `BUG-19`. | Table rebuilt |
| R8 | **Line citations corrected** in BUG-1 (95-102 → 96-102; 113-118 → 107-119), BUG-3, SEC-3, BUG-11. | Corrected inline |
| R9 | **SEC-3 precondition stated.** Unconfigured red-gate triggers are fail-*closed* (`TRIGGER_METADATA` defaults `security-review`/`cost-exceeded`/`merge-conflict` to `"abort"`). The fail-open requires an explicit typo'd `fallback` override. | Likelihood qualified; severity held |
| R10 | **BUG-25's second claim narrowed.** The unlink target is scoped to `${basename(queuePath)}.lock.*`, not arbitrary files. Only the live-pid-with-unparsable-timestamp half is a genuine correctness bug. | Narrowed |
| **R11** | **Rev 3: 24 open design questions resolved** into a decision register (D-1…D-24) so the implementing session makes no judgment calls. Each decision cites the code evidence it rests on. | New **Handover Brief** section |
| **R12** | **Rev 2's own `noImplicitReturns` suggestion disproved.** Measured: 0 errors, and it does *not* flag `applyFallback` (the switch is exhaustive over the declared union). It would not have caught SEC-3. | SEC-3 fix corrected (D-8) |
| **R13** | **Rev 2's BUG-7 fix was unbuildable.** It called for a per-story cost estimate; no estimator exists anywhere in the codebase. Replaced with an un-projected pre-gate mirroring the single-story path. | BUG-7 fix corrected (D-14) |
| **R14** | **MEM-6 mitigating factor added:** `WorktreeManager.create` self-heals a stale worktree for the same story id on the next run, so the leak is bounded to stories that never re-run. | MEM-6 severity confirmed MEDIUM |

---

## Handover Brief (rev. 3 — for the implementing session)

This section exists so an implementer can start work without making judgment calls. Every place the
review previously said "either X or Y", or named a fix that needed a design choice to become
actionable, is **resolved below with the evidence the decision rests on**. Where a decision is
deliberately deferred, it says so and says why.

### Ground rules

| | |
|:---|:---|
| Baseline | HEAD `76c5bafdc` (v0.81.0), clean tree. Re-verify line numbers before editing — they drift. |
| Commands | `bun run typecheck` · `bun run lint` · `bun test test/unit/<path>.test.ts --timeout=30000` (targeted) · `bun run test` (full) |
| Method | TDD per `CLAUDE.md`: write the failing regression test first. Every finding below names the assertion that would have caught it. |
| Scope discipline | One finding per commit, conventional commits. Do **not** bundle unrelated findings — several fixes touch shared files (`triggers.ts`, `json-file.ts`) and reviewability matters more than round-trips. |
| Non-negotiable | `resolvePermissions(config, stage)` stays the single source of truth (see SEC-41 — do not "simplify" it). No hardcoded permission literals. |
| Verify before trusting | This review is a static read. Where a fix changes gate behaviour (BUG-1, BUG-2), run the affected unit suites and report actual output — do not assert green without it. |

### Decision register

Every previously-open choice, resolved. **D-numbers are referenced from the findings below.**

| # | Question the review left open | **Decision** | Evidence / rationale |
|:--|:---|:---|:---|
| **D-1** | BUG-1: what counts as sufficient evidence for `allPassing = true`? | Initialise `allPassing = false`. Set true **only** from (a) a parsed ratio whose captured keyword is `pass` **and** `failCount === 0` **and** `total > 0`, or (b) an explicit boolean `obj.tests.allPassing === true`. **No "zero tests" escape hatch.** | A zero-test story cannot reach this code: `coerceVerdict` runs only in the `verifier` phase, which `build-plan-for-strategy.ts:206` registers **only** when `isThreeSession`. The `no-test`/`test-after` strategies use `verify-scoped` instead (`:211`). In three-session TDD, tests always exist — so "no evidence" is always a defect, never a legitimate state. |
| **D-2** | BUG-1: should `categorizeVerdict` also require `approved !== false`? | **No.** Leave `categorizeVerdict`'s success condition alone. | `operations/verify.ts:126-133` documents that `approved:false` for *advisory* AC/quality reasons is deliberately a success — semantic review owns those. Rev 1 recommended this change; it would regress the advisory-override path. Fix the *parser*, not the categoriser. |
| **D-3** | BUG-1: gate the verifier-as-SSOT carve-out on verdict provenance? | **Yes — but as a separate, second commit.** Thread a `coerced: boolean` flag on the verdict; let only a non-coerced (`isValidVerdict`) verdict suppress the full-suite gate in `shouldSkipPhaseForRectification` and `ExecutionPlan.run`. | This is defence-in-depth against the *next* parse bug, not this one. Splitting it keeps the P0 parser fix small and independently revertable. If time is short, ship the parser fix alone — it closes the live hole. |
| **D-4** | BUG-2: where should severity be normalized? | **At the parse boundary** — inside `validateLLMShape` (`semantic-helpers.ts:64-80`) and `validateAdversarialShape` (`adversarial-helpers.ts:77-91`), alongside the existing `withNormalizedCategory` step. | Those functions already normalize `category` and already filter malformed entries, with the reasoning written down ("discarded HERE rather than defended against by every consumer"). Severity is the one field that good pattern forgot. Normalizing here fixes both the raw-`LLMFinding` lane and the converted-`Finding` lane in one place. |
| **D-5** | BUG-2: what does an unrecognized severity map to? | **`error` (fail-closed)**, after a synonym pass. Log the raw value at `warn` so drift is diagnosable. | Safe because unfounded promotions are caught downstream: `finding-filters.ts:55-56` downgrades *blocking* findings whose `verifiedBy.observed` doesn't match HEAD to `unverifiable`, and `filterByAcGroundingMinimal` requires `acIndex` on `error` findings. A garbage finding promoted to `error` therefore gets evidence-gated back down rather than blocking the story. Fail-closed classification + evidence gate is the correct order. |
| **D-6** | BUG-2: what synonyms? | `critical\|blocker\|severe\|fatal` → `critical`; `error\|high\|major` → `error`; `warning\|warn\|medium\|moderate` → `warning`; `low` → `low`; `info\|note\|nit\|minor\|suggestion\|trivial` → `info`; `unverifiable\|unconfirmed\|unverified` → `unverifiable`. Lowercase + trim first. Everything else → `error` per D-5. | The low-end synonyms matter as much as the high end: without `nit`/`minor`/`suggestion`, D-5's fail-closed rule would promote cosmetic findings to blocking and flood the gate. Vocabulary drawn from what the prompts actually request (`review-builder.ts:80`, `adversarial-review-builder.ts:143` → `"error"\|"warning"\|"info"\|"unverifiable"`; `debate-builder.ts:29` adds `critical`/`low`; `critic-builder.ts:146` uses `blocker`/`major`/`minor`). |
| **D-7** | BUG-2: where does the shared normalizer live? | `src/review/severity.ts`, next to `SEVERITY_RANK`. Delete both copies of `normalizeSeverity` and re-export from `semantic-helpers.ts` / `adversarial-helpers.ts` to keep import sites unchanged. | The two copies are byte-identical (`semantic-helpers.ts:111-123`, `adversarial-helpers.ts:119-131`). `severity.ts` already owns the rank table they must agree with. |
| **D-8** | SEC-3: enable `noImplicitReturns` repo-wide? | **Enable it (it is free), but do not expect it to catch this.** The actual fix is the Zod enum + `default: return "abort"`. | Measured: `bunx tsc --noEmit --noImplicitReturns` exits **0** — zero new errors. It does not flag `applyFallback` because the switch *is* exhaustive over the declared `InteractionFallback` union; the lie is the unchecked `as InteractionFallback` cast at `triggers.ts:54`, which the Zod enum removes. Rev 2 implied this flag would surface the class — it does not. |
| **D-9** | BUG-48: honour `interaction.defaults.fallback`, or delete the field? | **Honour it — with a red-tier carve-out.** Precedence: per-trigger `triggers.<name>.fallback` → `interaction.defaults.fallback` → `TRIGGER_METADATA[t].defaultFallback`, **except** that triggers with `safety: "red"` ignore the global default and fall back to their metadata default unless overridden per-trigger. | Deleting would break the documented migration path for the removed `auto` plugin (`init.ts:31-33`). But honouring it unconditionally would let `defaults.fallback: "continue"` — the exact value that notice tells users to set — silently convert `security-review` / `cost-exceeded` / `merge-conflict` into approve-on-timeout. `TriggerMetadata.safety` already carries the red/yellow/green tier (`types.ts:110`), so the carve-out needs no new data. Update the `init.ts:33` message to state the red-tier exception. |
| **D-10** | SEC-5 / BUG-10 / BUG-40: what API shape for strict JSON loading? | **Add a sibling `loadJsonFileStrict<T>(path, context)`** in `utils/json-file.ts`: returns `null` for ENOENT, throws `NaxError` (path + `{ cause }`) on parse failure. Leave `loadJsonFile` untouched. | Only 9 call sites exist, so changing the original is feasible — but a sibling means each migration is an explicit, reviewable decision rather than a behaviour change to callers nobody re-read. `loadJsonFile` already distinguishes the two cases structurally via `existsSync` (`json-file.ts:28`); the strict variant just stops collapsing them onto `null`. |
| **D-11** | SEC-5: which call sites migrate to strict? | `config/loader.ts:114, :133, :378, :438` (all four config layers) and `config/profile.ts:221-226` (wrap the unguarded `.json()`). **`metrics/tracker.ts` gets quarantine, not throw** (see D-12). **Leave `hooks/runner.ts:60,70` alone** — out of scope, note as follow-up. | Config layers gate agent permissions and quality enforcement; silently reverting them to defaults is the finding. Hooks are a separate risk conversation and shouldn't ride along in a security fix. |
| **D-12** | BUG-10: throw or quarantine on corrupt `metrics.json`? | **Quarantine.** Catch the strict-load throw, rename the file to `metrics.json.corrupt-<ISO-8601-ts>`, log at `warn`, continue with `[]`. Do not abort the run. | Metrics are telemetry, not correctness. Aborting a completed run because its history file is torn punishes the user for a prior crash. Quarantine preserves the evidence *and* keeps the run's own metrics — it is strictly better than both alternatives. |
| **D-13** | MEM-6: track worktree creation, or force worktree isolation? | **Neither — gate cleanup on worktree existence.** In `pipeline-result-handler.ts:374`, replace `if (ctx.config.execution.storyIsolation === "worktree")` with an existence check on `join(ctx.workdir, ".nax-wt", ctx.story.id)`. | Verified same path on both sides: `worktree/manager.ts:90` creates `.nax-wt/<storyId>`, `pipeline-result-handler.ts:44` removes it. This is a **one-line, single-file** change requiring no cross-layer plumbing of a `worktreeCreated` flag through `parallel-batch → parallel-worker → result-handler`. Creation is unconditional, so cleanup keyed on existence is correct by construction. Sequential shared-mode runs create no worktree → check is false → no-op. |
| **D-14** | BUG-7: where does a "projected batch cost" estimate come from? | **It doesn't — drop the projection.** Call `enforceCostLimit(ctx, totalCost, costLimit)` immediately before `runParallelBatch`, with current cost, exactly mirroring the single-story path. | Rev 2 suggested `current + per-story estimate × batch size`. No such estimator exists: `enforceCostLimit` (`unified-executor.ts:61-88`) is a plain `enforcedCost < costLimit` threshold check, and the single-story gate at `:481-484` does not project either. Inventing an estimator is a separate feature. The un-projected pre-gate already bounds overshoot to one batch instead of unbounded-after-approval, which is the finding. |
| **D-15** | BUG-9: how far to go on parallel queue commands? | **Bounded fix, two parts.** (1) In `queueCheckStage.execute`, return `{action:"continue"}` immediately when `ctx.skipPrdPersistence === true` — a cloned pipeline must never *claim* a command it cannot durably apply. (2) Drain the queue once per batch boundary in the coordinator (`unified-executor`, where it owns the root PRD), via the existing `processQueueFile`. | This converts silent loss into deferred-but-honoured, using machinery that already exists (`queue-handler.ts:136` `processQueueFile` is already claim-process-clear under one lock). **Deferred by decision:** mid-batch immediacy for `ABORT`/`PAUSE` needs worker cancellation plumbing and is a separate piece of work — commands will take effect at the batch boundary, not instantly. Say so in the release note; that is still strictly better than the command being deleted. |
| **D-16** | BUG-14: what does an "inconclusive" acceptance run do? | **Keep the criteria, warn, do not discard.** Discard only on `refined.testable === false` or `failedSet.has(acId)` — i.e. delete the third disjunct `(exitCode !== 0 && failedACs.length === 0)`. | Deleting one disjunct is the whole fix. **Deferred by decision:** the converse defect — `exitCode === 0` promoting everything with no per-AC evidence — needs a positive-evidence signal the runner does not currently emit. File it; do not attempt it here. |
| **D-17** | BUG-24: is changing `WorktreeInfo.branch` to nullable safe? | **Yes.** Widen to `branch: string \| null` and push on `path` alone. | Verified repo-wide: `WorktreeInfo` is referenced only in `worktree/types.ts`, `worktree/manager.ts` (its own parser), and the `worktree/index.ts` barrel. `.branch` has **no consumer outside the parser that produces it** — there is no external caller to break. |
| **D-18** | BUG-26: heuristic tightening or mandatory `{test_files}` placeholder? | **Neither — fall back to *append* instead of *replace* when the candidate token is an interpreter's script operand.** Add `INTERPRETERS = ["node","bun","deno","python","python3","ruby","npx","tsx","ts-node"]`; if `lastPathIndex === 1 && INTERPRETERS.includes(unquote(parts[0]))`, take the existing append branch. | Requiring a placeholder silently breaks every existing custom command. Appending is fail-safe in the only direction that matters for a *verification* gate: worst case the runner ignores the extra argument and runs the full suite (a superset), never the wrong target. `node ./scripts/run-tests.js` → `node ./scripts/run-tests.js 'test/unit/foo.test.ts'`. Note `bun test test/foo` is unaffected (`parts[1]` is `test`, no `/`). |
| **D-19** | BUG-33: framework markers or ≥2 probe passes? | **Neither — require positive evidence that tests ran.** A probe counts as attributable only when `parseTestOutput(probeOutput).passed + .failed >= 1`. Keep the existing Go markers as a secondary guard. | `parseTestOutput` (`test-runners/parser.ts:31`) already dispatches per framework and returns `{passed, failed}`, and `FlakeProbeInput` **already carries `framework`**. This is framework-general, reuses tested code, needs no phrasing research per runner, and avoids doubling probe cost. |
| **D-20** | SEC-41: throw on missing config, or default to `safe`? | **Default to `"safe"` (approve-reads) and log a `warn` naming the stage.** Do not throw. | Consistency argument decides it: the existing `default:` arm already falls back to `approve-reads` for *invalid* profiles (`permissions.ts:50`). Treating "absent" more permissively than "invalid" is the actual bug. Throwing risks breaking live call sites that pass `opts.config ?? this._config` (`manager.ts:674,717`, `session/manager.ts:445`) where the manager's own config may be unset; a warn-and-fail-closed default fixes the security posture with zero crash risk. |
| **D-21** | ENH-35: fix the inert cumulative-attempts cap, or document it? | **Document it as per-tier only. Do not change budgets in this pass.** | Changing escalation budgets is a cost/behaviour decision with prior context (attempts reset on tier change is `@design BUG-011`, deliberate). Tightening it is a product call, not a review fix. Add the clarifying comment and open an issue. |
| **D-22** | ENH-45: reword the hook blocklist or drop it? | **Reword.** Keep the check, change the message from "Security validation failed" to a best-effort lint warning, and reference the argv-mode note at `hooks/runner.ts:191-203`. | The finding is reviewer over-trust in a message that implies a guarantee. Rewording removes the false confidence at zero functional risk; dropping the check removes a genuine (if partial) speed bump. |
| **D-23** | STYLE-30 / TYPE-29: which "safe relative path" implementation wins? | **The segment-wise one.** Delegate `path-security.ts:53` `isRelativeAndSafe` to the helper documented at `prd/modifies.ts:50-57`. Separately, fix `runtime/packages.ts:29-33` to use `path.relative`. | The segment-wise implementation carries a written rationale; the substring one (`includes("..")`) is the naive copy and it is the one guarding the real gate. **Do not** touch the Win32 half of TYPE-29 — the repo declares no `engines` field and contains zero `win32` references in `src/`; that concern is hypothetical. |
| **D-24** | ENH-20: what shape does fail-open reporting take? | **`reviewsFailedOpen: number`** aggregated onto `RunResult` and printed in the end-of-run summary as a distinct line whenever `> 0`. | Minimal surface, no new subsystem. The data already exists honestly (`failOpen: true` on each check, plus `recordAdversarialAudit`); only the aggregation and the print are missing. |

### Sequencing for the implementing session

Ship in this order — each group is one PR:

1. **PR 1 — "green must mean checked" (P0).** BUG-1 parser fix (D-1, D-2) → BUG-2 boundary normalization (D-4…D-7) → ENH-20 fail-open counter (D-24). These three are the same defect class and individually leave another route to a false pass. Run the full review + verdict unit suites and report actual output.
2. **PR 2 — verdict provenance (P0 follow-up).** D-3 only. Separate so PR 1 stays revertable.
3. **PR 3 — interaction config (P1).** SEC-3 + BUG-44 + BUG-48 (D-8, D-9). Three defects in ~15 lines of `schemas-infra.ts` / `triggers.ts`.
4. **PR 4 — crash and teardown (P1).** BUG-4, BUG-3, SEC-18.
5. **PR 5 — JSON contract (P1/P2).** D-10 → D-11 → D-12, i.e. SEC-5 + BUG-40 + BUG-10 together, since they share the new function.
6. **PR 6 — parallel mode (P2).** MEM-6 (D-13), BUG-7 (D-14), BUG-8, BUG-9 (D-15).
7. **PR 7 — deadline convention sweep (P2/P4).** BUG-13, BUG-31, MEM-19, PERF-32 in one pass — same pattern, same fix.
8. **PR 8+ — remaining MEDIUM then LOW.**

### Known-deferred (do not attempt without asking)

- Mid-batch immediacy for `ABORT`/`PAUSE` in parallel mode (D-15) — needs worker cancellation.
- Positive per-AC evidence for acceptance promotion (D-16) — needs a runner signal that doesn't exist.
- Escalation budget values (D-21) — product decision, see the existing "escalation budgets never bind" analysis.
- Windows portability (D-23, ENH-47) — not a supported target today; don't invent one.
- `hooks/runner.ts` corrupt-config posture (D-11) — deliberately out of scope of the config fix.

---

## Verification Methodology

Rev 1: multi-agent sweep, then per-finding manual re-read at the cited lines with downstream
propagation traced and sibling-implementation contrasts confirmed. Unverifiable candidates were
excluded, not downgraded.

Rev 2: every finding re-opened at HEAD, with two additional checks rev 1 did not perform —
(a) **downstream consumer tracing** (does a false value from this function change a *run outcome*,
or only a label?), and (b) **proposed-fix validation** (does the recommended change contradict a
documented design decision elsewhere?). R1–R3 above are the product of those two checks.

---

## Overall Grade: B− (74/100)

| Dimension | Score | Rationale |
|:---|:---|:---|
| Security | 13/20 | Excellent injection hygiene (argv-only spawns, allowlists, webhook HMAC/rate-limits) — but three fail-open gates on safety-critical paths, one of which (verdict coercion) actively *suppresses* the real test gate downstream, plus one unvalidated path join and one dead safety-config field |
| Reliability | 13/20 | Exceptional checkpoint/lock discipline — offset by 4 unbounded-hang spawn paths, a keypress that can crash a multi-hour run, corruption-silent data loss, and a parallel-mode worktree leak |
| API Design | 17/20 | Strong typing, discriminated unions, `_deps` injection everywhere; only 4 justified `any`. Deduction: `applyFallback` declares a non-optional return type it does not satisfy on all paths |
| Code Quality | 16/20 | BUG-XX-annotated history, enforced file-size limits, dense regression tests; but `normalizeSeverity` is duplicated verbatim in two modules and both copies drifted from the ranks they feed |
| Best Practices | 15/20 | Atomic writes, O_EXCL locks, SIGTERM→SIGKILL escalation as house style; the "every subprocess gets a deadline" convention is enforced in git/test-executor paths and skipped in four others |

**Summary.** This is an unusually well-engineered codebase: process teardown, lock acquisition,
checkpoint/resume, and shell-quoting are handled with a rigor rarely seen, and nearly every subtle
race carries a comment naming the bug it closes. The serious findings concentrate in three themes:

1. **Fail-open verdict/severity parsing on the product's core value proposition.** The TDD verifier
   and review gates can be flipped to PASS by exactly the LLM output shapes the coercion layer was
   built to tolerate — and, per R1, a false-green verifier verdict then *disables* the real
   full-suite test gate via the verifier-as-SSOT carve-out. This is the single highest-leverage
   defect in the review.
2. **Deadline asymmetry.** The repo's own "every subprocess gets a deadline" convention is enforced
   in git/test-executor paths but skipped in four other spawn sites, creating indefinite-hang risk.
3. **Parallel-mode control-plane gaps.** Worktree cleanup, cost gating, queue commands, and PRD
   mutation propagation all have single-story-correct, parallel-incorrect behavior.

A fourth, quieter theme is **duplicated policy drifting apart** — two `normalizeSeverity` copies,
two "safe relative path" policies, two batch-size sources, two config-corruption postures. In each
case one copy is correct and the other is not, and the incorrect one guards the more important path.

---

## Findings

### 🔴 CRITICAL

#### BUG-1: TDD verdict coercion parses negated approvals and inverted ratios as PASS — and a false-green verdict then suppresses the full-suite test gate
**Severity:** CRITICAL | **Category:** Bug / Security of gate | **Confidence:** High (full chain traced twice)

Three parsing defects compose into a false-green verdict, and a fourth mechanism converts that
verdict into suppression of the one gate that would have caught it.

```ts
// src/tdd/verdict-reader.ts:96-102
const isVerifiedButFailed = /VERIFIED\b.*\b(FAIL|FAILED|RED|NOT MET)\b/.test(verdictStr);
const approved =
  verdictStr === "PASS" ||
  verdictStr === "PASSED" ||
  verdictStr === "APPROVED" ||
  (verdictStr.startsWith("VERIFIED") && !isVerifiedButFailed) ||
  verdictStr.includes("ALL ACCEPTANCE CRITERIA MET") ||   // ← matches the NEGATION too
  obj.approved === true;
```
```ts
// src/tdd/verdict-reader.ts:107,113-118 — pass/fail word never captured
let allPassing = approved;                                 // ← seeded from `approved`
...
const match = (summary.test_results as string).match(/(\d+)\/(\d+)\s+(?:tests?\s+)?(?:pass|fail)/i);
if (match) {
  passCount = Number.parseInt(match[1], 10);               // first number ALWAYS treated as passes
  const total = Number.parseInt(match[2], 10);
  failCount = total - passCount;
  allPassing = failCount === 0;
}
```
```ts
// src/tdd/verdict.ts:133-149 — categorizeVerdict decides success from tests.allPassing alone
if (!verdict.tests.allPassing) { ...return failure... }
return { success: true };
```

**Deep analysis — the parse defects.**
1. `includes("ALL ACCEPTANCE CRITERIA MET")` matches `"NOT ALL ACCEPTANCE CRITERIA MET"` →
   `approved = true`. The contradiction regex at :96 guards only the `startsWith("VERIFIED")`
   branch, not this one.
2. The ratio regex alternation `(?:pass|fail)` is **uncaptured**, so `"5/5 FAIL"` yields
   `passCount=5, failCount=0, allPassing=true` — the word that disambiguates is matched and thrown away.
3. `allPassing` is seeded from `approved` at :107, so defect 1 alone produces `allPassing=true`
   with **zero test evidence** (`passCount=0, failCount=0`).
4. `categorizeVerdict` returns `{success:true}` purely from `tests.allPassing`; `approved` is
   consulted only inside `hasAdmissibleIncorrectTestDiagnosis`, which requires `allPassing === false`.
   Nothing re-validates.

**Deep analysis — the amplifier (new in rev 2).** A verdict that passes is not merely one green
phase. Two independent carve-outs key off it:

```ts
// src/execution/story-orchestrator/rectification.ts:39-52
/**
 * Verifier-as-SSOT: when the verifier explicitly passed, full-suite-gate
 * failures represent unrelated regressions that this story did not cause.
 */
export function shouldSkipPhaseForRectification(input) {
  if (phase.kind !== "full-suite-gate") return false;
  ...
  return phaseExplicitlyPassed(phaseOutputs[verifierName]);
}
```
```ts
// src/execution/story-orchestrator/execution-plan.ts:464-470
const success =
  missingRequiredReviewPhases.length === 0 &&
  Object.entries(phaseOutputs).every(([name, output]) => {
    if (verifierPassedSsot && name === gateName) return true;   // ← gate failure ignored
    return phasePassed(name, output, this.ctx.storyId);
  });
```

So a coerced verdict does not just fail to catch red tests — it **causes actual red full-suite-gate
output to be discarded**, both from the rectification fix cycle and from story success aggregation.

**Why no other gate catches it.** `verifier` and `verify-scoped` are mutually exclusive:
`build-plan-for-strategy.ts:206,211` register `verifier` only when `isThreeSession` and
`verify-scoped` only when `!isThreeSession`. In the three-session TDD path — the only path where
`coerceVerdict` runs — `full-suite-gate` **is** the test evidence, and it is exactly what the
carve-out discards.

**Proof of reachability.** `coerceVerdict` runs whenever `isValidVerdict(raw)` is false
(`operations/verify.ts:120`) — i.e. precisely for the free-form output it exists to tolerate. A
verifier responding `{"verdict":"NOT ALL ACCEPTANCE CRITERIA MET"}`, or
`{"verdict":"FAIL","verification_summary":{"test_results":"5/5 FAIL"}}`, coerces to a passing
verdict; the story is then certified with failing tests actively ignored.

**Risk:** The orchestrator's central invariant — "loops until done *and verified*" — inverts for
exactly the adversarial LLM outputs the coercion layer was built to tolerate, and takes the
compensating control down with it.

**Fix (corrected in rev 2 — do NOT apply rev 1's version). Decisions: D-1, D-2, D-3.**
- Capture the keyword: `/(\d+)\/(\d+)\s+(?:tests?\s+)?(pass|fail)/i`, branch on `match[3]`.
- Reject negation before the `includes` check: bail when `/\bNOT\b/.test(verdictStr)`, or match
  `"ALL ACCEPTANCE CRITERIA MET"` only when not preceded by `NOT `.
- **Require evidence for `allPassing` (D-1).** Stop seeding it from `approved`: initialise
  `allPassing = false` and set it true only from (a) a parsed ratio whose captured keyword is `pass`
  with `failCount === 0` and `total > 0`, or (b) an explicit `obj.tests.allPassing === true`.
  **No "zero tests" escape hatch** — D-1 establishes that a zero-test story cannot reach this code,
  because `verifier` is registered only for three-session strategies. This is the load-bearing
  change: it closes defects 1 and 3 at once.
- **Do not** add `approved !== false` to `categorizeVerdict`'s success condition (D-2) — it would
  regress the documented advisory-override path at `verify.ts:126-133`.
- **Second commit (D-3):** thread a `coerced: boolean` on the verdict and let only a non-coerced
  verdict suppress the full-suite gate in `shouldSkipPhaseForRectification` and `ExecutionPlan.run`.
  Kept separate so the parser fix stays independently revertable.

**Regression test that would have caught this:** `coerceVerdict({verdict:"NOT ALL ACCEPTANCE CRITERIA MET"})`
must not yield `approved: true`; `coerceVerdict({verdict:"FAIL", verification_summary:{test_results:"5/5 FAIL"}})`
must yield `tests.allPassing === false`. Both belong in `test/unit/verification/tdd-verdict.test.ts`,
which already covers `coerceVerdict` at :156-290.

---

### 🟠 HIGH

#### BUG-2: Severity classification is case-sensitive and fails open — and the normalizer that was supposed to fix that has the same bug
**Severity:** HIGH | **Category:** Bug (fail-open) | **Confidence:** High

```ts
// src/review/severity.ts:26-29
export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  const rank = (SEVERITY_RANK as Record<string, number>)[sev] ?? 0;
  return rank >= SEVERITY_RANK[threshold];
}
```
```ts
// src/review/semantic-helpers.ts:111-123 — byte-identical copy at adversarial-helpers.ts:119-131
export function normalizeSeverity(sev: string): FindingSeverity {
  if (sev === "warn") return "warning";
  if (sev === "critical" || sev === "error" || ... ) return sev;
  return "info";                                    // ← unknown → advisory, not blocking
}
```

**Deep analysis.** `SEVERITY_RANK` keys are lowercase (`info`…`critical`). Any capitalized or
unrecognized severity — `"Critical"`, `"CRITICAL"`, `"High"`, `"blocker"` — gets rank `0`, which is
below the default `error` threshold, so it is classified advisory. (Under `blockingThreshold: "info"`
rank 0 ≥ 0 holds and unknowns *do* block — the fail-open is specific to the `error`/`warning`
thresholds, which are the defaults.)

**Correction to rev 1 (R3).** Rev 1 framed this as "normalization exists but `isBlockingSeverity` is
called on raw strings". That is only half true, and the missing half changes the fix:

- On the **raw-`LLMFinding` lane**, `isBlockingSeverity` is indeed called on unnormalized LLM
  strings — `semantic-outcomes.ts:212-213`, `semantic-debate.ts:182-183`,
  `recurrence-demotion.ts:185,195,199,205`, `semantic-helpers.ts:151`, `finding-filters.ts:68`,
  `semantic-evidence.ts:64`, `operations/semantic-review.ts` and `operations/adversarial-review.ts`
  throughout. The parse boundary (`validateLLMShape`, `validateAdversarialShape`) normalizes
  **`category` only** — `severity` passes through untouched (`semantic-helpers.ts:77`).
- On the **converted-`Finding` lane**, `normalizeSeverity` *does* run
  (`llmFindingToFinding`, `toAdversarialReviewFindings`) — and maps `"Critical"` to `"info"`,
  producing the same fail-open outcome plus permanent information loss.

So fixing `isBlockingSeverity` alone leaves the converted lane broken. Both copies of
`normalizeSeverity` need the same treatment, and the right place is one layer earlier.

**Risk:** Review gates under-block whenever the model deviates from lowercase enum output — and the
highest-severity findings are the most likely to be demoted, because models reach for varied
vocabulary (`"Critical"`, `"BLOCKER"`, `"High"`) precisely for severe issues. A reviewer emitting
`"Critical: SQL injection in auth.ts"` produces a non-blocking finding and `buildPassedResult`
reports success.

**Fix. Decisions: D-4, D-5, D-6, D-7.**
1. **Normalize severity at the parse boundary (D-4)** — inside `validateLLMShape` (`semantic-helpers.ts:64-80`)
   and `validateAdversarialShape` (`adversarial-helpers.ts:77-91`), as a sibling step to the existing
   `withNormalizedCategory`. Every downstream consumer then sees canonical values by construction,
   which fixes the raw-`LLMFinding` lane and the converted-`Finding` lane at once.
2. **Lowercase + trim, then map synonyms (D-6):** `critical|blocker|severe|fatal` → `critical`;
   `error|high|major` → `error`; `warning|warn|medium|moderate` → `warning`; `low` → `low`;
   `info|note|nit|minor|suggestion|trivial` → `info`; `unverifiable|unconfirmed|unverified` →
   `unverifiable`. The low-end synonyms are not optional — without them, step 3 promotes cosmetic
   findings to blocking.
3. **Unknown → `error`, fail-closed (D-5)**, with the raw value logged at `warn`. Safe because
   `finding-filters.ts:55-56` downgrades blocking findings lacking HEAD-matching `verifiedBy`
   evidence to `unverifiable`, and `filterByAcGroundingMinimal` requires `acIndex` on `error`
   findings — an unfounded promotion is evidence-gated back down rather than blocking the story.
4. **De-duplicate (D-7):** delete both byte-identical `normalizeSeverity` copies, move to
   `review/severity.ts` next to `SEVERITY_RANK`, re-export from both helper modules so import sites
   are unchanged.
5. Belt-and-braces: normalize inside `isBlockingSeverity` too.

**Regression tests that would have caught this:** `isBlockingSeverity("Critical") === true`;
`normalizeSeverity("BLOCKER") === "critical"`; `normalizeSeverity("nit") === "info"`; and a
boundary-level assertion that `validateLLMShape({passed:false, findings:[{severity:"Critical",...}]})`
returns a finding whose severity is already `"critical"`.

#### BUG-48 (new in rev 2): `interaction.defaults.fallback` is dead config — documented, validated, plumbed, never read
**Severity:** HIGH | **Category:** Bug (silent no-op safety control) | **Confidence:** High

```ts
// src/interaction/triggers.ts:41-52
const defaults = config.interaction?.defaults ?? { timeout: 600000, fallback: "escalate" as InteractionFallback };

let fallback: InteractionFallback = metadata.defaultFallback;   // ← from TRIGGER_METADATA, not config
let timeout = defaults.timeout;                                 // ← config IS honoured for timeout
```
```ts
// src/interaction/init.ts:73-76 — passed to the chain...
const chain = new InteractionChain({
  defaultTimeout: config.interaction.defaults.timeout,
  defaultFallback: config.interaction.defaults.fallback,
});
// src/interaction/chain.ts — ...where `defaultFallback` appears exactly once, in the interface (:21).
// `this.config.defaultTimeout` is read at :94. `this.config.defaultFallback` is read nowhere.
```

**Deep analysis.** The field survives Zod validation (`schemas-infra.ts:163`, a strict 4-value enum),
is documented in `config-descriptions.ts:230`, is logged back at the user on startup
(`init.ts:88-89`), and is passed into `InteractionChain` — but no code path ever reads it. The only
per-trigger fallback that takes effect is `TRIGGER_METADATA[trigger].defaultFallback`, overridable
only by a **per-trigger** `triggers.<name>.fallback`.

The clincher is `init.ts:31-33`: when the `auto` plugin was removed, the error message tells users
`Use \`interaction.defaults.fallback: "continue"\` for auto-approval on timeout`. That is the
documented migration path for a removed feature, and it does nothing.

**Risk:** Every operator who sets `interaction.defaults.fallback` gets silent no-op behaviour with
positive confirmation in the logs. Users following the removal notice get neither the old `auto`
plugin nor the replacement. Users setting it to `"abort"` as a blanket safety posture keep the
per-trigger defaults instead — which happen to be `"abort"` for red gates but `"continue"` for
`story-oversized`/`review-gate` and `"skip"` for `max-retries`.

**Fix (D-9): honour it, with a red-tier carve-out.** In `getTriggerConfig`:

```ts
// Red-tier gates (security-review, cost-exceeded, merge-conflict) ignore the
// global default — a blanket `defaults.fallback: "continue"` must not silently
// convert a safety gate into approve-on-timeout. Override them per-trigger.
const base =
  metadata.safety === "red"
    ? metadata.defaultFallback
    : (config.interaction?.defaults?.fallback ?? metadata.defaultFallback);
let fallback: InteractionFallback = base;
if (typeof triggerConfig === "object" && triggerConfig.fallback) {
  fallback = triggerConfig.fallback;   // per-trigger override still wins (see SEC-3 for its validation)
}
```

`TriggerMetadata.safety` already carries the tier (`types.ts:110`), so this needs no new data.
Update the `init.ts:33` message to state the red-tier exception, so the documented migration path
for the removed `auto` plugin is accurate.

**Do not** simply delete the field: it is the documented replacement for a removed feature.

**Regression test that would have caught this:** `getTriggerConfig("cost-warning", cfg)` with
`interaction.defaults.fallback: "abort"` must return `fallback: "abort"`; the same config against
`"security-review"` must return `"abort"` via the metadata default, and must **not** return
`"continue"` when the global default is `"continue"`.

#### BUG-3: `acpx cancel` / `acpx stop` omit `--cwd` — teardown can hit the wrong agent's session in parallel runs
**Severity:** HIGH | **Category:** Bug (cross-story interference) | **Confidence:** High

```ts
// src/agents/acp/spawn-client-session.ts:392 (close, forceTerminate branch)
await this.trackedSpawn(["acpx", this.agentName, "stop"], undefined, options?.signal);
                                              // ← no --cwd → inherits nax's process cwd
// src/agents/acp/spawn-client-session.ts:412-415 (cancelActivePrompt)
const cmd = ["acpx", this.agentName, "cancel"];
await this.trackedSpawn(cmd);
```
Contrast the same file's `close()` at :378, which does it correctly:
```ts
const cmd = ["acpx", "--cwd", this.cwd, this.agentName, "sessions", "close", this.sessionName];
```
and `SpawnAcpClient.forceStop` (`spawn-client.ts:286-296`), which passes `--cwd` and documents why
(BUG-16 there): without it the command resolves against nax's cwd instead of the session's worktree,
"risking a hit against — or a miss of — the wrong queue owner in a parallel/worktree run where
multiple agent instances of the same agentName run concurrently."

**Deep analysis.** Both call sites pass `opts = undefined`, so `runTrackedSpawn`
(`spawn-client-process.ts`) spawns with no `cwd`. In a parallel batch, story A's idle watchdog
firing `cancelActivePrompt()` executes `acpx claude cancel` in nax's working directory — acpx's
cwd-scoped lookup can cancel story B's in-flight prompt or miss A's entirely (A's process then dies
only via the SIGTERM group-kill fallback immediately above, at :407-410, which limits — but does
not eliminate — the damage on the local side).

**Risk:** Cross-story cancellation corrupts an unrelated story's turn (stamped cancelled mid-work),
while the intended target keeps spending until its own watchdog fires. Cost + correctness impact in
every parallel run that exercises idle-cancel.

**Fix:** Add `"--cwd", this.cwd` to both argv arrays (mirroring :378), with a test asserting the
spawned argv contains the session cwd. Three of four `acpx` invocations in this class already do
this; the two that don't are the outliers.

#### SEC-3: Interaction red-gate fallback fails OPEN on a mistyped fallback string
**Severity:** HIGH | **Category:** Security / Bug (fail-open safety gate) | **Confidence:** High

```ts
// src/config/schemas-infra.ts:168-172 — per-trigger override accepts ANY string
z.object({
  enabled: z.boolean(),
  fallback: z.string().optional(),     // defaults block (:163) correctly uses z.enum([...])
  timeout: z.number().optional(),
}),
```
```ts
// src/interaction/triggers.ts:53-55 — unchecked cast
if (triggerConfig.fallback) {
  fallback = triggerConfig.fallback as InteractionFallback;
}
```
```ts
// src/interaction/chain.ts:186-195 — no default clause
switch (fallback) {
  case "continue": return "approve";
  case "skip":     return "skip";
  case "escalate": return "approve";
  case "abort":    return "abort";
}                                     // unknown → undefined
```
```ts
// src/interaction/triggers.ts:141-142 — undefined ≠ "abort" → proceed
const effectiveAction = chain.applyFallback(response, fallback);
return effectiveAction !== "abort";
```

**Deep analysis.** The `defaults.fallback` schema is a strict 4-value enum, but the per-trigger
override is a free string cast blindly to `InteractionFallback`. `applyFallback`'s switch is
exhaustive over the *declared* union with no `default`, so `"abrt"` (typo) returns `undefined`, and
every red-gate check — `checkSecurityReview` (:141), `checkCostExceeded` (:159),
`checkMergeConflict` (:177) — treats `undefined !== "abort"` as "proceed". No validation error is
raised at config load.

`applyFallback` is declared to return `InteractionAction` (non-optional) yet returns `undefined` on
that path; `strict: true` does not catch it because `noImplicitReturns` is not enabled. This is the
same class of hole as BUG-2 — the type system is asserting a guarantee the code does not provide.

**Precondition (rev 2 qualification).** The *unconfigured* posture is fail-closed: `TRIGGER_METADATA`
defaults `security-review`, `cost-exceeded`, and `merge-conflict` to `"abort"`. The fail-open needs
an explicit, misspelled per-trigger `fallback` override — a deliberate act of configuration that
goes wrong. Severity stays HIGH because the failure is silent, inverts the operator's stated intent,
and lands on a safety control; but the exposure is narrower than rev 1's wording implied.

**Risk:** An operator configuring an abort-on-timeout security gate silently converts it to
approve-on-timeout.

**Fix (D-8):** `z.enum(["continue","skip","escalate","abort"])` in the per-trigger schema (rejects at
load and makes the `as InteractionFallback` cast honest), plus `default: return "abort"` in the
switch (fail-closed defence-in-depth). Fix BUG-44 in the same edit — it is one line below.

**On `noImplicitReturns` (D-8, corrected):** rev 2 suggested enabling it to surface this class.
Measured at HEAD, `bunx tsc --noEmit --noImplicitReturns` exits **0** — and it does *not* flag
`applyFallback`, because the switch is exhaustive over the *declared* union. The flag is free to
enable as hygiene, but it would not have caught this; the unchecked cast is what hides the hole.

#### BUG-4: Async TUI key handler rejections are unhandled — one failed queue write tears down the whole run as a crash
**Severity:** HIGH | **Category:** Bug (reliability) | **Confidence:** High (mechanism fully traced)

```ts
// src/tui/App.tsx:124,158-161 — async handler awaiting fallible FS writes
const handleKeyboardAction = async (action: KeyboardAction) => {
  ...
  case "PAUSE":
    if (queueFilePath) {
      await writeQueueCommand(queueFilePath, { type: "PAUSE" });   // rejects on FS error
```
```ts
// src/tui/App.tsx:198-199 — fire-and-forget, no .catch
} else if (showAbortConfirm && queueFilePath) {
  writeQueueCommand(queueFilePath, { type: "ABORT" });
```
```ts
// src/tui/hooks/useKeyboard.ts:81+ — promise returned by onAction is discarded
useInput((input, key) => { ... onAction({ type: "PAUSE" }); ... });
```
```ts
// src/execution/crash-signals.ts:180-208 — any escaping rejection ⇒ full teardown
return async (reason: unknown) => {
  ...
  await performTeardown(ctx);
  await writeFatalLog(ctx.jsonlFilePath, "unhandledRejection", error);
  await updateStatusToCrashed(...);
  process.exit(1);
};
```

**Deep analysis.** `writeQueueCommand` ends in `withQueueFileLock(...) → appendFile(...)`
(`queue-writer.ts:64-76`) and genuinely rejects on disk-full / permissions / deleted-directory.
`handleKeyboardAction` is an `async` function passed where `(action) => void` is expected;
`useKeyboard`'s `useInput` callback invokes it and drops the returned promise; Ink does not observe
it either. During a run, `installSignalHandlers` registers an `unhandledRejection` handler that
performs full teardown, writes a fatal log, marks status `crashed`, and exits 1.

Note the two paths differ in kind: the `await`ed cases leak the rejection out of an async function
nobody awaits, and the ABORT case at :198 is a bare unhandled promise. Both land in the same place.

**Failure scenario:** User presses `p`/`a`/`s`/`r` while `.queue.txt` is unwritable → the rejection
escapes the TUI → a multi-hour orchestration run is killed and recorded as *crashed*, for want of a
`.catch()` that should have shown an inline toast.

**Fix:** In `useKeyboard`, wrap dispatch: `Promise.resolve(onAction(a)).catch(err => bus.emit(...))`;
additionally catch inside `handleKeyboardAction` per-case and surface via state. The user-visible
outcome of an unwritable queue file should be "couldn't pause", not "run crashed".

---

### 🟡 MEDIUM

#### SEC-5: Corrupt `config.json` is silently treated as absent — run proceeds on defaults (including permissive permissions)
**Severity:** MEDIUM | **Category:** Security / Bug | **Confidence:** High

```ts
// src/utils/json-file.ts:27-43
export async function loadJsonFile<T>(path: string, context = "json-file"): Promise<T | null> {
  if (!existsSync(path)) return null;          // ← absent
  try { return (await Bun.file(path).json()) as T; }
  catch (err) { logger.warn(context, "Failed to parse JSON file", {...}); return null; }  // ← corrupt: same signal
}
// src/config/loader.ts:133-134 (project layer; identical pattern at :114-115 global layer)
const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
if (!projConf) return rawConfig;
```

**Analysis.** One trailing comma in a hand-edited `.nax/config.json` → parse warning → layer skipped
→ run continues on global+defaults: quality commands, gates, and `execution.permissionProfile` all
revert. For a tool whose config gates agent permissions and quality enforcement, corrupt-config
should fail fast. The per-package overlay path (`loader.ts:554-568`) already fails fast on invalid
overlays — the root layers are inconsistent with it. Related inconsistency: `readProfileChainFromConfig`
(`profile.ts:221-226`) reads the same file with an **unguarded** `configFile.json()` and runs
*before* the tolerant layers (`loader.ts:305` vs `:321/:324`), so the same corruption can
alternatively surface as a raw `SyntaxError` with no NaxError context (see BUG-40 — same file, same
root cause, opposite failure mode).

Note the fix is structurally easy: `loadJsonFile` **already** distinguishes the two cases via
`existsSync` — it just collapses them onto the same `null` return.

**Fix (D-10, D-11):** add a sibling `loadJsonFileStrict<T>(path, context)` to `utils/json-file.ts` —
`null` for ENOENT, `NaxError` (path + `{ cause }`) on parse failure. Leave `loadJsonFile` itself
untouched so each migration is an explicit decision.

Migrate exactly these call sites: `config/loader.ts:114, :133, :378, :438` (all four config layers)
and `config/profile.ts:221-226` (wrap the unguarded `.json()`, which also closes BUG-40).
`metrics/tracker.ts` uses the same function but quarantines rather than throws — see BUG-10 / D-12.
**Leave `hooks/runner.ts:60,70` on the tolerant loader** (D-11): corrupt-hooks posture is a separate
risk conversation and should not ride along in a config-security fix.

**Regression test that would have caught this:** a `.nax/config.json` containing a trailing comma
must fail the run with a `NaxError` naming the path — not silently produce a config whose
`execution.permissionProfile` reverted to the default.

#### MEM-6: Failed parallel stories leak their entire worktree checkout under default `storyIsolation: "shared"`
**Severity:** MEDIUM | **Category:** Memory / Resource leak | **Confidence:** High

```ts
// src/execution/parallel-batch.ts:142-144 — created unconditionally, for every story
for (const story of stories) {
  storyStartTimes.set(story.id, Date.now());
  try { await worktreeManager.create(workdir, story.id); }
```
```ts
// src/execution/pipeline-result-handler.ts:374-377 — cleanup gated on isolation mode
// EXEC-002: All tiers exhausted — remove the worktree directory but keep the branch
if (ctx.config.execution.storyIsolation === "worktree") {
  await removeWorktreeDirectory(ctx.workdir, ctx.story.id);
```
Default is `"shared"` (`schemas-execution.ts:207`), and `--parallel` (`bin/nax.ts:202,556-565`)
sets only the concurrency number — nothing forces worktree isolation. Merge success removes the
worktree via `MergeEngine.merge` (`worktree/merge.ts:89`), but only pipeline-**passed** stories are
merged (`parallel-batch.ts:277`: `successfulIds = workerResult.pipelinePassed.map(...)`).

**Analysis.** The create is unconditional; the cleanup is conditional — that asymmetry is the whole
bug. For every failed/paused story in a parallel batch: worktree created → never merged → cleanup
gated off → `.nax-wt/<storyId>` + `git worktree` metadata accumulate across runs. Each leak is a
full checkout (potentially gigabytes) plus stale branch refs that later `list()`-based accounting
must ignore (and see BUG-24 — that accounting is itself lossy).

**Mitigating factor (rev 3).** `WorktreeManager.create` (`manager.ts:87-130`) self-heals a stale
worktree for the *same story id* at the start of the next run (prune → remove → conditional branch
delete). So the leak persists only for stories that never re-run — real disk cost, but not unbounded
growth for a repeatedly-retried story. This is why MEM-6 is MEDIUM rather than higher.

**Fix (D-13) — one line, one file.** In `pipeline-result-handler.ts:374`, gate cleanup on worktree
*existence* rather than config mode:

```ts
// The worktree is created unconditionally by parallel-batch (:143), so cleanup
// must key off whether one exists — not off storyIsolation, which creation ignored.
if (existsSync(join(ctx.workdir, ".nax-wt", ctx.story.id))) {
  await removeWorktreeDirectory(ctx.workdir, ctx.story.id);
```

Verified same path on both sides (`manager.ts:90` creates, `pipeline-result-handler.ts:44` removes).
This needs **no** cross-layer plumbing of a `worktreeCreated` flag through
`parallel-batch → parallel-worker → result-handler`. Sequential shared-mode runs create no worktree,
so the check is false and the behaviour is unchanged.

**Regression test that would have caught this:** a parallel batch with one failing story leaves no
`.nax-wt/<storyId>` directory behind under the default `storyIsolation: "shared"`.

#### BUG-7: Parallel batch dispatch has no pre-dispatch cost-limit gate (asymmetric with single-story path)
**Severity:** MEDIUM | **Category:** Bug (cost overrun) | **Confidence:** High

```ts
// src/execution/unified-executor.ts:254-340 — multi-story batch: NO enforceCostLimit before dispatch
if ((ctx.parallelCount ?? 0) > 0) {
  ...
  const batchResult = await _unifiedExecutorDeps.runParallelBatch({...});
// vs single-story path :481-484 — gated BEFORE spend
{ const singleCostCheck = await enforceCostLimit(ctx, totalCost, costLimit, singleStory.id); ... }
// vs post-batch check :459-461 — only AFTER the whole batch spent
const batchCostCheck = await enforceCostLimit(ctx, totalCost, costLimit);
```

**Analysis.** Sequential overshoot past `costLimit` is bounded by one story; a batch dispatched at
cost just under the limit can overshoot by N × per-story cost before the post-batch check fires.
Once the user approves "continue past limit" once, every subsequent multi-story batch again runs to
completion before the next prompt. `runBatchPreChecks` receives `totalCost` but never checks it —
the value is threaded to the right place and then unused.

**Fix (D-14) — no projection.** Call `enforceCostLimit(ctx, totalCost, costLimit)` immediately
before `runParallelBatch`, with current cost, mirroring the single-story path at `:481-484` exactly.

Rev 2 suggested projecting `current + per-story estimate × batch size`. **No such estimator exists** —
`enforceCostLimit` (`unified-executor.ts:61-88`) is a plain `enforcedCost < costLimit` threshold and
the single-story gate does not project either. Building one is a separate feature. The un-projected
pre-gate already bounds overshoot to a single batch instead of unbounded-after-approval, which is
the finding.

#### BUG-8: Stale story-object references after batch pre-check PRD reload silently drop worker mutations
**Severity:** MEDIUM | **Category:** Bug (state divergence) | **Confidence:** Medium-High

```ts
// src/execution/escalation/batch-pre-check.ts:65-70
if (batchPre.shouldSkipIteration) {
  skipped.add(batchStory.id);
  prd = await loadPRDFn(prdPath);            // fresh objects...
  prdDirty = false;
}
...
return { prd, prdDirty, dispatchable: batch.filter((s) => !skipped.has(s.id)) };
//                                    ^^^^^ but `batch` holds PRE-reload objects
```
```ts
// src/execution/unified-executor.ts:298,312-313
prd = batchPreCheck.prd;                   // executor adopts the NEW generation
const batchResult = await _unifiedExecutorDeps.runParallelBatch({
  stories: batchPreCheck.dispatchable,     // ...dispatched with OLD objects
```

**Analysis.** If any sibling is escalated/skipped by the pre-check, the PRD reload creates new story
objects, but `dispatchable` still references the old generation. Workers mutate those orphans by
reference — `parallel-worker.ts:60-62` sets `story.storyGitRef` after capturing the worktree ref,
and `pipeline/stages/execution.ts:171-175` records repo-scoped fixes via reference identity — while
the single-writer save serialises the **new** PRD generation (`reconcileBatchOutcome(prd, ...)`
marks by id). Result: `storyGitRef` (the crash-resume diff baseline, BUG-114) and repo-scoped fix
records are lost for exactly the batches that had a sibling escalation.

No sibling skip ⇒ no reload ⇒ references match ⇒ tests pass. That conditional is why this survives
the suite, and it is also the shape of the test that would catch it.

**Fix:** Re-resolve dispatchable stories by id from the fresh PRD before returning:
`batch.filter((s) => !skipped.has(s.id)).map((s) => prd.userStories.find((p) => p.id === s.id) ?? s)`.

#### BUG-9: Queue commands are consumed-and-destroyed with no durable effect in parallel mode
**Severity:** MEDIUM | **Category:** Bug (control plane) | **Confidence:** High

```ts
// src/pipeline/stages/queue-check.ts:131-135,155-159
// BUG-4: in parallel mode every story's worktree pipeline runs on a structuredClone of the
// PRD with skipPrdPersistence: true (CR-1 single-writer rule)...
const persistPrd = ctx.skipPrdPersistence !== true;
...
if (persistPrd) { await savePRD(ctx.prd, resolvePrdPath(ctx)); }
else { warnUnpersistedCommand(logger, ctx, { command: "ABORT" }); }
// src/execution/queue-handler.ts:155-160 — command file deleted regardless
await unlink(processingPath).catch(...)
```

**Analysis.** Whichever sibling pipeline hits stage 1 first claims the queue file under lock and
clears it after processing. A user writing `ABORT`/`SKIP US-3`/`RETRY`/`PRIORITY`/`INJECT` mid-batch
has the command applied to one stale clone, the file deleted, and zero durable effect: the target
story keeps running, pending stories stay pending, `PAUSE` pauses one pipeline while siblings
finish. The code warns — this is a *known* limitation, honestly annotated — but from the operator's
view the control signal is silently lost, and the warning goes to the log, not to the person who
just typed the command.

**Fix (D-15) — bounded, two parts.**

1. **Stop destroying what you cannot apply.** In `queueCheckStage.execute`
   (`pipeline/stages/queue-check.ts:107`), return `{ action: "continue" }` immediately when
   `ctx.skipPrdPersistence === true`, *before* calling `processQueueFile`. A cloned pipeline must
   never claim a command it cannot durably persist.
2. **Drain at the batch boundary.** In `unified-executor`, where the coordinator owns the root PRD,
   call the existing `processQueueFile` (`execution/queue-handler.ts:136` — already claim-process-clear
   under one lock) once per batch boundary.

**Deferred by decision (D-15):** commands take effect at the batch boundary, not mid-batch.
Immediate `ABORT`/`PAUSE` requires worker-cancellation plumbing and is separate work — call it out
in the release note. Deferred-but-honoured is strictly better than silently deleted, and it also
makes `PAUSE` consistent (today it pauses exactly one sibling).

#### BUG-10: Corrupt `metrics.json` silently wipes all run history on next save
**Severity:** MEDIUM | **Category:** Bug (data loss) | **Confidence:** High

```ts
// src/metrics/tracker.ts:442-445 (inside withPathFileLock)
const existing = await loadJsonFile<RunMetrics[]>(metricsPath, "metrics");  // null on parse error
const allMetrics = Array.isArray(existing) ? existing : [];
allMetrics.push(finalMetrics);
...
await saveJsonFile(metricsPath, cappedMetrics, "metrics");                  // 1-entry array overwrites file
```

**Analysis.** `loadJsonFile` returns `null` for a torn/corrupt file (its own docstring admits the
rename is not crash-durable: "a power loss … can still leave a zero-length destination"). The lock
protects concurrency, not corruption: one bad parse coerces history to `[]`, appends only the
current run, and renames it over the file. All historical cost/routing data is destroyed behind a
single warn line; aggregates then report one-run numbers as the project baseline — which is worse
than an error, because the output still looks plausible.

This is the same `loadJsonFile` conflation as SEC-5, in a destructive context. Fixing SEC-5's
strict variant makes this a one-line change.

**Fix (D-12) — quarantine, do not abort.** Use `loadJsonFileStrict` (D-10); catch the parse throw,
rename the file to `metrics.json.corrupt-<ISO-8601-ts>`, log at `warn`, and continue with `[]`.

Aborting the run was the alternative and is wrong: metrics are telemetry, not correctness, and
failing a completed run because its history file is torn punishes the user for a *prior* crash.
Quarantine preserves the evidence and keeps the current run's metrics. Never treat "unreadable" as
"empty" on a read-modify-**write** path.

#### BUG-11: Scratch purge deletes session directories when `lastActivityAt` is present but unparseable
**Severity:** MEDIUM | **Category:** Bug (data loss) | **Confidence:** High

```ts
// src/session/scratch-purge.ts:81-90
if (!lastActivityAt) continue;
// Skip sessions still within the retention window (boundary is non-inclusive)
if (new Date(lastActivityAt).getTime() >= cutoffMs) continue;   // NaN >= cutoffMs === false
...
await _scratchPurgeDeps.remove(sessionDir);                     // rm -rf
```

**Analysis.** A descriptor whose `lastActivityAt` is corrupt/non-ISO (older schema, partial write)
yields `NaN`; the retention guard does not fire; the directory is archived/deleted regardless of
actual age. Note the *malformed-JSON* case a few lines above is handled correctly (`catch { continue }`)
— it is only the parsed-but-invalid-date case that falls through, which is the harder one to notice.

The sibling sweeper `sweepOrphansImpl` (`manager-sweep.ts:20-31`) added explicit NaN handling
(MEM-1) with a documented policy decision — this file got no such treatment, and here the failure is
destructive (verify results, rectify history, digests gone despite `retentionDays: 30`).

**Fix:** `const t = new Date(lastActivityAt).getTime(); if (!Number.isFinite(t) || t >= cutoffMs) continue;`
— fail safe (keep) on unparseable timestamps, matching manager-sweep's policy.

#### BUG-12: `usage_update` numeric parsing accepts non-finite values — `Infinity` flows into exact-cost accounting
**Severity:** MEDIUM | **Category:** Bug / Type safety | **Confidence:** High

```ts
// src/agents/acp/parser.ts:167-179 — FOUR bare typeof checks in one block
const inp = metaUsage.inputTokens ?? metaUsage.input_tokens;
if (typeof inp === "number") activity.inputTokens = inp;
const out = metaUsage.outputTokens ?? metaUsage.output_tokens;
if (typeof out === "number") activity.outputTokens = out;
if (activity.outputTokens == null && typeof update.used === "number") {
  activity.outputTokens = update.used;
}
if (typeof (update.cost as Record<string, unknown> | undefined)?.amount === "number") {
  activity.costUsd = (update.cost as Record<string, unknown>).amount as number;
  state.exactCostUsd = activity.costUsd;
}
```

**Analysis (scope widened in rev 2 — R5).** Rev 1 reported only `cost.amount`. In fact the entire
`usage_update` branch is the outlier: every *other* numeric field in this parser goes through
`asFiniteNumber` (defined at :56-58; used at :201-202, :213-214, :255-256, :267-268, :279-280), and
the BUG-59 comment at :273-278 says the helper exists precisely because "Infinity/-Infinity are
typeof number but not finite". The `usage_update` block at :167-179 has four bare `typeof` checks
and is the only place in the file that skipped the convention.

`JSON.parse("1e999")` → `Infinity`, so one malformed/acpx-buggy usage_update sets
`exactCostUsd = Infinity`, which `sendTurn` sums into `totalExactCostUsd` (`adapter.ts:474-476`) —
poisoning dispatch events, metrics, and run-cost summaries for the story. Negative amounts likewise
subtract. Token fields feed the same accounting.

**Fix:** Route all four through `asFiniteNumber` (which already handles the `??` fallback pairs
natively: `asFiniteNumber(metaUsage.inputTokens, metaUsage.input_tokens)`), consistent with the
file's own BUG-59 discipline. Consider a lint rule or a test that asserts no bare
`typeof x === "number"` remains in this parser.

#### BUG-13: Worktree dependency provisioning spawns with no timeout — hung install stalls the story forever
**Severity:** MEDIUM | **Category:** Bug (hang) | **Confidence:** High

```ts
// src/worktree/dependencies.ts:58-70
const proc = _worktreeDependencyDeps.spawn(argv, { cwd: worktreeRoot, stdout: "pipe", stderr: "pipe" });
const [exitCode, stdout, stderr] = await Promise.all([
  proc.exited,
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
```

**Analysis.** No deadline, no SIGKILL fallback, no abort wiring — unlike every git call, which the
repo deliberately routed through `gitWithTimeout` to fix this exact hang class (BUG-5 comments in
`worktree/manager.ts:111`, `merge.ts:48`). `bun install`/`pnpm install` waiting on a registry or NFS
mount blocks that story — and in parallel mode, batch completion — indefinitely; recovery requires
an external kill. This is arguably the *most* likely of the four missing-deadline sites to fire in
practice, since package-manager network stalls are routine.

**Fix:** Reuse the tracked-spawn deadline pattern (deadline → killProcessTree → drained streams)
already proven in `src/agents/acp/spawn-client-process.ts`. See also BUG-31, MEM-19, PERF-32 — the
same convention gap, four places.

#### BUG-14: Acceptance hardening pass discards ALL suggested criteria when the test command fails opaquely
**Severity:** MEDIUM | **Category:** Bug (data loss / wrong inference) | **Confidence:** High

```ts
// src/acceptance/hardening.ts:220-228
for (const refined of storyRefined) {
  acIndex++;
  const acId = `AC-${acIndex}`;
  if (refined.testable === false || failedSet.has(acId) || (exitCode !== 0 && failedACs.length === 0)) {
    toDiscard.push(refined.original);
```

**Analysis.** The spawned acceptance-test command killed by the SIGTERM/SIGKILL timeout path
(:183-191), or crashing at load time, produces `exitCode !== 0` with no parseable `AC-N` ids — the
third disjunct then discards **every** suggested criterion in the group, and the PRD is saved
without them (:236, :272). An environmental failure (timeout, missing venv, syntax error in the
generated test) permanently deletes debater-suggested criteria.

The converse is equally wrong and rev 1 noted it only in passing: `exitCode === 0` promotes
everything, with no evidence any criterion was actually exercised. The pass has two outcomes for
three input states — the missing state is "inconclusive".

**Fix (D-16) — delete one disjunct.** Drop `(exitCode !== 0 && failedACs.length === 0)` from the
condition at :224, so discard requires `refined.testable === false` or an explicit
`failedSet.has(acId)`. Log a warning on the inconclusive path so the operator sees that the run was
uninformative rather than clean.

**Deferred by decision (D-16):** the converse defect — `exitCode === 0` promoting everything with no
per-AC evidence — needs a positive-evidence signal the runner does not currently emit. File it
separately; do not attempt it in this fix.

#### BUG-15: `program.parse()` with async action handlers + unprotected awaits → raw stack-trace crashes
**Severity:** MEDIUM | **Category:** Bug (error handling) | **Confidence:** High

```ts
// bin/nax.ts:1786
program.parse();          // commander ^13.1.0: async handler promises NOT observed (needs parseAsync)
// bin/nax.ts:361 — inside `run` action, OUTSIDE any try/catch
const config = await loadConfig(naxDir ?? undefined, cliOverrides);
```

**Analysis.** With `parse()`, Commander ignores the promise returned by an async action handler; a
rejection becomes an unhandled rejection (Bun prints a stack trace, exit 1). Every other error path
in these actions is carefully wrapped in try/catch + house-style red errors — but `loadConfig` at
:361 (invalid Zod config), `loadPRD` at :533, and the per-entry `loadPRD` loop in `features list`
(:870-872, where one corrupt PRD kills the whole listing) sit outside protection. A hand-edited
invalid config produces a raw Zod stack trace instead of the friendly error the CLI shows everywhere
else — and, per SEC-5, an invalid config is a state the tool tolerates elsewhere, so users will hit
this.

**Fix:** Switch to `await program.parseAsync(process.argv)` and wrap the identified awaits in the
existing try/catch pattern. For `features list`, catch per entry so one bad PRD degrades to one bad
row.

#### BUG-16: `nax status` crashes on schema-drifted `status.json` (unchecked cast + unguarded access)
**Severity:** MEDIUM | **Category:** Bug (robustness) | **Confidence:** Medium-High

```ts
// src/cli/status-features.ts:71-74
try { const content = Bun.file(statusPath); return (await content.json()) as NaxStatusFile; }
// src/cli/status-features.ts:212-221 — displayAllFeatures: no optional chaining, no try/catch
if (projectStatus) {
  const pidAlive = isPidAlive(projectStatus.run.pid);          // TypeError if `run` absent
  ...
  console.log(chalk.dim(`   Cost:       $${projectStatus.cost.spent.toFixed(4)}`));
```

**Analysis.** Parse errors are caught, but shape errors are not: a truncated-then-valid `{}` or an
older-schema file lacking `run`/`cost`/`progress` throws `TypeError` out of `displayAllFeatures` and
`displayFeatureDetails` (:309, :317, :377). The sibling path `getFeatureSummary` (:128-165)
deliberately wraps this exact access in try/catch because "a stale or schema-drifted status.json
must not crash" — the other two displays never received the same treatment. A diagnostic command
crashing on the artifact it exists to diagnose is the worst time for it.

**Fix:** Validate with the existing Zod schema (or reuse `getFeatureSummary`'s guarded accessor)
before display; degrade to "status unavailable" like the table view does.

#### BUG-17: `prompts --init` auto-wires overrides into a config file nothing loads
**Severity:** MEDIUM | **Category:** Bug (silent no-op feature) | **Confidence:** High

```ts
// src/cli/prompts-init.ts:112
const configPath = join(workdir, "nax.config.json");
```

**Analysis.** Repo-wide grep confirms `nax.config.json` appears **only** in prompts-init itself
(:21, :53, :94, :103-107, :112, :145, :171) and in unrelated doc comments; the loader SSOT is
`<root>/.nax/config.json` (`config/paths.ts`, layered global→project merge). So: (a) in the normal
case it prints instructions referencing a nonexistent convention — and :132 spells it a *third* way
("create nax/config.json"); (b) if a user happens to have a `nax.config.json`, the tool writes
`prompts.overrides` into it and reports `[OK] Auto-wired` — silently inert forever.

Same shape as BUG-48: a feature that validates, reports success, and does nothing.

**Fix:** Target `join(workdir, ".nax", "config.json")` via the shared config-load/save helpers, and
fix the three inconsistent spellings in the user-facing strings.

#### SEC-18: `config profile create` skips `validateProfileName` — path-traversal write, inconsistent with SEC-08
**Severity:** MEDIUM (defence-in-depth; local CLI) | **Category:** Security | **Confidence:** High

```ts
// src/cli/config-profile.ts:177-190
export async function profileCreateCommand(profileName: string, startDir: string): Promise<string> {
  const profilesDir = join(projectConfigDir(startDir), "profiles");
  const profilePath = join(profilesDir, `${profileName}.json`);
  ...
  mkdirSync(profilesDir, { recursive: true });
  await Bun.write(profilePath, "{}");
```

**Analysis.** `loadProfile`/`loadProfileEnv` run `validateProfileName` (`config/profile.ts:56`,
called at :81 and :136) precisely because names flow into `join()`; the create path performs the
identical join with no validation. `nax config profile create "../../evil"` writes
`<projectRoot>/evil.json`; more `../` escapes further. Read-side consumers validate; the write side
does not — the asymmetry is the finding.

Severity is MEDIUM rather than HIGH because the operator is typing the traversal themselves; the
value is preventing a footgun and closing an inconsistency, not stopping an attacker.

**Fix:** Export `validateProfileName` from `config/profile.ts` (currently module-private at :56)
and call it as the first statement of `profileCreateCommand`, before either `join`.

#### MEM-19: `runTrackedSpawn` normal-exit drain has no deadline — session setup can hang forever
**Severity:** MEDIUM | **Category:** Memory / Hang | **Confidence:** Medium-High

```ts
// src/agents/acp/spawn-client-process.ts:192-196
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text().catch(() => ""),
  new Response(proc.stderr).text().catch(() => ""),
]);
return { exitCode: raced.code, stdout, stderr };
```

**Analysis.** The PERF-1 deadline bounds `await proc.exited`, and the timeout path cancels streams
(:179-188) — but once the process exits normally, the drain above is unbounded (`.catch` handles
errors, not a missing EOF). The same module family races every stream against a drain timer in
`prompt()` (`spawn-client-session.ts:249-260`) specifically because "Bun bug: piped streams may not
close after kill"; a grandchild inheriting the pipe fd and outliving acpx produces the identical
missing-EOF on the natural-exit path. `createSession`/`loadSession`/`closeSession` hang ⇒
`ensureAcpSession` hangs ⇒ story stalls with no watchdog (callers do not thread AbortSignals into
client startup).

The deadline is applied to the path that was *expected* to hang and omitted from the one that hangs
by surprise.

**Fix:** Race both drains against a bounded timer (reuse `makeDrain`) on the normal-exit path too.

#### ENH-20: Review gates convert to "pass" on LLM dispatch failure; `failOpen` is recorded but never consumed
**Severity:** MEDIUM | **Category:** Enhancement (design-risk observability) | **Confidence:** High

```ts
// src/review/adversarial-outcomes.ts:98-106 (mirrored in semantic-outcomes.ts)
return {
  check: "adversarial",
  success: true,
  failOpen: true,
  output: `skipped: LLM call failed — ${String(err)}`,
```

**Analysis.** During an agent outage or repeated malformed JSON, both gates return
`success:true, failOpen:true`; `runReview` computes `checks.every(c => c.success)` → stage green.
The audit event trail (`recordAdversarialAudit`) captures fail-open honestly, but nothing downstream
inspects it: a run whose every review was skipped is indistinguishable from a reviewed-and-passed
run in the pipeline outcome.

This is a deliberate availability-over-strictness trade-off, logged as such — the gap is that the
trade-off is invisible in results and metrics. It compounds with BUG-1 and BUG-2: three independent
ways for "green" to mean "not actually checked", none of which surface in the run summary.

**Fix (D-24):** aggregate a `reviewsFailedOpen: number` onto `RunResult` and print it as a distinct
end-of-run summary line whenever `> 0`, so operators can distinguish "reviewed green" from "not
reviewed". The data already exists honestly on each check (`failOpen: true`) and in
`recordAdversarialAudit` — only the aggregation and the print are missing. No new subsystem.

---

### 🟢 LOW

Each finding below was verified in source (rev 1 and re-verified rev 2); analysis compressed for readability.

| ID | Title | Proof (file:lines) | Analysis & Failure Scenario | Fix |
|:---|:---|:---|:---|:---|
| STYLE-21 | Legacy console formatters don't strip control bytes (log-injection hardening applied to 1 of 3 formatters) | `logger/formatters.ts:54` pushes raw `entry.message`; `logger/logger.ts:160-161` selects these when `formatterMode` unset; hardened path `log-format/formatter.ts:285` uses `stripControlChars` | Agent stderr / PRD-authored text with `\x1b]0;…\x07` forges terminal output on the legacy path (early logging, non-run commands). JSONL file output is safe. | Apply `stripControlChars` in `formatConsole`/`formatPlainConsole` |
| BUG-22 | SinkRegistry shallow clone contradicts its stated redaction-by-construction guarantee | `logger/sink-registry.ts:36-44`: `sink({ ...entry })` — docstring claims mutation isolation | Nested `entry.data` is shared by reference; a sink doing `entry.data.x = …` leaks the mutation to the JSONL writer and later sinks — the exact hazard the comment claims to prevent | Clone `data` too (`{...entry, data: entry.data && {...entry.data}}`) |
| MEM-23 | `markStoryAsBlocked` appends to `priorErrors` unboundedly (sibling `markStoryPaused` dedupes) | `prd/types.ts:354` (`priorErrors = [...(story.priorErrors \|\| []), \`BLOCKED: …\`]`) vs `prd/index.ts:436-441` (dedupe guard + comment citing context-injection cost) | Flapping dependency appends near-identical `BLOCKED:` entries each cycle; each is injected into resumed-agent context, growing tokens + prd.json linearly | Mirror the `prior.at(-1) !== entry` guard |
| BUG-24 | `parseWorktreeList` silently drops detached-HEAD worktrees | `worktree/manager.ts:305-315`: both push sites require `currentWorktree.path && currentWorktree.branch`; porcelain emits `detached` with no `branch` line | Rebase/bisect worktrees vanish from `list()`; cleanup/accounting consumers miss them — compounds MEM-6, whose leaked worktrees this accounting is meant to find | **D-17:** widen to `branch: string \| null`, push on `path` alone. Safe — verified repo-wide that `.branch` has no consumer outside the parser that produces it |
| BUG-25 | Queue-file-lock contradicts its own BUG-10 invariant: a live holder with an unparsable timestamp loses the lock | `utils/queue-file-lock.ts:42-53` docstring says the age bound applies "when the candidate's own timestamp can't be parsed", but `isLiveCandidate` returns **false** on `createdAt === null` without consulting `isPidAlive` → unlinked at :67 | Live holder whose filename timestamp doesn't parse (renamed scheme / old format) loses the lock → two processes in the critical section. *(rev 2: the unlink is scoped to `${basename(queuePath)}.lock.*`, so rev 1's "any unrelated file" claim is narrower than stated — that half is cosmetic)* | Return true (live) when the pid is alive even if the timestamp is unparsable — matching the docstring |
| BUG-26 | Smart-runner heuristic can replace the runner script path with test files | `verification/smart-runner.ts:409-432`: last token containing `/` not preceded by `PATH_TAKING_FLAGS` is replaced | `node ./scripts/run-tests.js` → `node 'test/unit/foo.test.ts'`; scoped run executes the wrong thing, failure misattributed to the story | **D-18:** when the candidate is an interpreter's script operand (`parts[0]` in `node\|bun\|deno\|python\|python3\|ruby\|npx\|tsx\|ts-node` and `lastPathIndex === 1`), take the existing *append* branch instead of replacing. Fail-safe: worst case runs a superset, never the wrong target. A mandatory `{test_files}` placeholder would silently break existing custom commands |
| BUG-27 | Semantic-debate dedup collapses distinct findings sharing file:line | `review/semantic-debate.ts:158-167`: key = `acId ?? file:line` | Two debaters flagging different defects on the same line merge into one; the second defect vanishes from blocking classification and recurrence fingerprints | Include normalized issue text in the key (as `recurrence-demotion.fingerprintFor` does) |
| SEC-28 | `nax resume` skips `validateFeatureName` (BUG-35 guard inconsistency) | `commands/resume.ts:156` joins the raw `-f` value; guards exist at `bin/nax.ts:237,759`, `commands/common.ts:112` | `nax resume -f ../../x` reads/writes checkpoint/PRD paths outside `.nax/features/`. Operator-invoked, so LOW — same shape as SEC-18 | Add `validateFeatureName(cmdOpts.feature)` |
| TYPE-29 | Separator-less containment check in `runtime/packages.ts` (**rev 2: Win32 half is speculative**) | `runtime/packages.ts:29-33`: `packageDir.startsWith(repoRoot)` with no separator — `/repo` matches `/repository`. `utils/path-security.ts:69,80` use `` `${root}/` `` | The `packages.ts` bug is real on POSIX: a sibling dir sharing a name prefix yields a garbage relative key. The path-security Win32 concern is hypothetical — the repo declares no `engines` field and contains **zero** `win32` references in `src/`, so Windows is not a supported target | **D-23:** fix `packages.ts` with `path.relative`. Do **not** touch the Win32 half — no `engines` field, zero `win32` refs in `src/`; that target does not exist today |
| STYLE-30 | Two conflicting "safe relative path" policies; the naive substring one guards the real gate | `path-security.ts:53` `normalized.includes("..")` rejects `foo..bar.ts`; `prd/modifies.ts:50-57` documents why segment-wise is correct | Legitimate filenames (`v1..v2.snap`) are silently denied context injection — fail-closed correctness drift between duplicate implementations, and the weaker copy is the one on the gate | **D-23:** delegate `path-security.ts:53` to the segment-wise helper documented at `prd/modifies.ts:50-57` — the copy that carries a written rationale wins |
| BUG-31 | Review/TDD git spawns have no timeout (violates the repo's own BUG-039 convention) | `review/diff-utils.ts:59-70` (+3 more sites in file), `review/scoped-lint.ts:62-76`, `tdd/isolation.ts:39-63`; contrast `smart-runner.ts:466` comment citing BUG-039 | Wedged git (lock contention / NFS) hangs the review/isolation stage indefinitely; `getAddedLinesPerFile` also never checks `proc.exited`. One of four missing-deadline sites (see BUG-13, MEM-19, PERF-32) | Route through `gitWithTimeout` |
| PERF-32 | `getAgentVersion`: unbounded `proc.exited`, stderr piped but never drained | `agents/shared/version-detection.ts:42-52` | Hung wrapper script blocks the multi-agent health precheck; >64KB stderr can deadlock the pipe buffer | Deadline + drain-or-cancel stderr |
| BUG-33 | Flake-probe zero-match detection covers Go phrasing only | `verification/flake-probe.ts:23-33` markers `/no tests? to run/i`, `/^ran 0 tests?/m`; the comment concedes the conservatism | bun/jest/vitest zero-match + exit 0 counts as an attributable pass ⇒ one probe pass relabels a deterministic failure "flaky" and quarantines it for the run — i.e. another route to false green | **D-19:** require positive evidence — count a probe as attributable only when `parseTestOutput(out).passed + .failed >= 1`. `FlakeProbeInput` already carries `framework` and `test-runners/parser.ts:31` already dispatches per framework, so this is framework-general and costs no extra probe runs. Keep the Go markers as a secondary guard |
| RACE-34 | `PidRegistry.register()` resolves before the PID is durably persisted | `execution/pid-registry.ts:449-453`: coalescing returns the in-flight `writeQueueTail`, which does not cover the just-added pid | Hard kill in the window leaves a live agent PID absent from `.nax-pids`. Bounded today (the registry isn't yet a cross-process kill list) but the `await register()` durability contract is false | Return a tail that includes the pending write |
| ENH-35 | `canEscalate` cumulative-attempts cap effectively inert (attempts reset on every tier change) | `escalation/tier-escalation.ts:460-466` vs `:526-552` (`@design BUG-011` reset) | Termination comes solely from tier exhaustion; anyone tightening budgets expecting the cumulative cap to fire will find it never does | **D-21:** document as per-tier only; open an issue. Do **not** retune budgets here — the per-tier reset is deliberate (`@design BUG-011`) and budget values are a product/cost decision |
| PERF-36 | Sequential loop recomputes the batch plan each iteration with a hardcoded size 4, ignoring the injected plan | `execution/unified-executor.ts:578` (`ctx.useBatch ? precomputeBatchPlan(getAllReadyStories(prd), 4) : ctx.batchPlan`) vs `runner-execution.ts:168,203` precomputed `ctx.batchPlan` | Wasted recompute; two sources of truth for batch size; future tuning silently doesn't apply to this path | Use `ctx.batchPlan ?? precomputeBatchPlan(...)` |
| RACE-37 | Concurrent `openSession(name)` opens two physical sessions; the loser is orphaned | `session/manager.ts:424-447`: the map check precedes `await adapter.openSession`; the second `set` overwrites the first | The first physical acpx session lives until TTL/forceStop. Single-flight exists for `sendPrompt` but not for open | Extend the `_busySessions`-style synchronous check-and-set to `openSession` |
| MEM-38 | Losing the stderr-drain race leaves the `readStreamTail` reader pending forever (BUG-46 fixed stdout only) | `agents/acp/spawn-client-session.ts:267-273`: the stdout winner cancels `parseHandle`; the stderr winner cancels only the timer | Parked reader holds the stream lock + decoder + 64KB tail closure per affected prompt | Cancel the stderr reader when `drainB` wins |
| BUG-39 | `ensureGitExcludes` does an unlocked read-modify-write of `.git/info/exclude`; substring matching | `worktree/manager.ts:29-41` | Overlapping invocations interleave read-read-write-write; the last writer clobbers the first's entries; `includes("runs/")` suppresses longer entries | Serialize via the existing path-file-lock; line-aware matching |
| BUG-40 | Malformed profile-chain config read throws a raw SyntaxError before the tolerant layers run | `config/profile.ts:221-226` unguarded `.json()`; ordering proven at `loader.ts:305` vs `:321/:324` | The same corrupt file handled tolerantly a few lines later crashes earlier with no NaxError context. Two opposite postures on one file — see SEC-5 | try/catch → empty chain, and let the layer loaders own diagnostics |
| SEC-41 | `resolvePermissions` defaults to `approve-all` when the config object is missing | `config/permissions.ts:38-39`: `config?.execution?.permissionProfile ?? "unrestricted"`; the `default:` arm correctly fails safe to `approve-reads` for *invalid* values | A call site that forgets to thread config — the exact mistake CLAUDE.md warns about — silently gets maximum permissiveness, while a *typo'd* profile fails safe. The absent case is treated more permissively than the invalid one | **D-20:** default to `"safe"` (approve-reads) and `warn` naming the stage. Not a throw — the existing `default:` arm already falls back to approve-reads for *invalid* profiles, so treating absent more permissively than invalid is the bug; throwing risks live call sites passing `opts.config ?? this._config` |
| BUG-42 | Telegram callback action cast to the action union without validation | `interaction/plugins/telegram.ts:442`: `parts[1] as InteractionResponse["action"]` | An arbitrary string from the configured chat flows into action switches. Gated by `isFromConfiguredChat`, so this is robustness, not privilege | Validate against known actions, else ignore |
| BUG-43 | `substituteTemplate` interpolates context keys into a RegExp unescaped | `interaction/triggers.ts:67-75`: `new RegExp(\`\\{\\{${key}\\}\\}\`, "g")` | A key like `cost(usd)` breaks or mis-substitutes templates. Built-in keys are safe today; `TriggerContext` has an open `[key: string]: unknown` index signature, so callers can add arbitrary keys | Escape the key, or split/join literal replace |
| BUG-44 | Per-trigger `timeout` override is unbounded (defaults are validated `min(1000).max(3600000)`) | `config/schemas-infra.ts:171` (`z.number().optional()`) vs `:162`; consumer `triggers.ts:56-58` | `-1` / `0.5` reaches `setTimeout` and fires immediately — the interactive gate becomes an unconditional fallback with no error. Same schema asymmetry as SEC-3, one line below it | `.int().positive()` mirroring the defaults block |
| ENH-45 | Hook-command blocklist is trivially bypassable; creates false audit confidence | `hooks/runner.ts:136-146` — the blocklist misses `bash payload.sh`, `wget -qO- host \| sh`, `node -e` | Mitigated by argv-mode execution (documented at :191-203) — the residual issue is reviewer over-trust of a "Security validation failed" message that implies more than it delivers | **D-22:** keep the check, reword the message from "Security validation failed" to a best-effort lint warning referencing the argv-mode note at :191-203 |
| RACE-46 | Curator rollup append vs GC rename race loses observations | `plugins/builtin/curator/rollup.ts:81` plain `appendFile`; `rollup-prune.ts:150-151` rewrite + `rename`, with no coordination | Rows appended between GC's read pass and its rename land in the old inode and are destroyed. Telemetry loss only | Take the shared path-file-lock around both |
| ENH-47 | Shelled-out `rm` / `ln -s` with unchecked exit codes (**rev 2: portability half is speculative**) | `bin/nax.ts:656-667`; contrast `unlock.ts:96-97` "native unlink, not a shelled-out rm" | The unchecked exit code is the real defect: a failed `ln -s` silently leaves a stale `latest.jsonl`. The "fails on Windows" argument is hypothetical (no `engines`, no `win32` refs anywhere in `src/`); the no-coreutils-on-PATH case remains valid | Use native `unlink`/`symlink` |

---

## Excluded Candidates (verified insufficient)

Findings surfaced during the sweep that did **not** survive verification, documented for review integrity:

- *"Stale `protocolIds` after NO_SESSION recovery"* — a real observation, but impact is limited to
  audit-event correlation labels; excluded pending product input on whether audit IDs must track
  re-created sessions.
- *"`cumulative_token_usage` double-counting"* — depends on acpx wire semantics not observable in
  this repo; the unit tests encode per-turn summability deliberately. Needs a one-line confirmation
  against acpx, not a code change.
- *Webhook server attack surface* — investigated hardest of all areas; found **no** exploitable
  issue: loopback-only bind, HMAC-SHA256 with `timingSafeEqual`, streaming body-size limit defeating
  a lying Content-Length, dual rate-limit buckets, request-ID allowlist, bounded pending-response
  store.
- *(rev 2)* **No rev-1 finding was withdrawn on re-verification.** Two had their scope corrected
  (TYPE-29, ENH-47) and two had their recommended fix corrected (BUG-1, BUG-2), but all 47 describe
  real defects at HEAD `76c5bafdc`.

---

## Things Done Well (verified)

1. **Process-tree teardown discipline** (`agents/acp/spawn-client-process.ts`): SIGTERM→SIGKILL
   escalation gated by a liveness re-check (PID-reuse protection), per-PID escalation-timer dedup,
   grace timers cleared on every settle path, wedged-vs-aborted distinction.
2. **Checkpoint/resume subsystem** (`execution/checkpoint/`): O_APPEND serialized writer,
   torn-line-tolerant reader with per-story runId filtering, randomized capture-failure sentinels
   preventing false "tree-moved" comparisons.
3. **Lock acquisition** (`execution/lock.ts:96-165`): atomic `O_CREAT|O_EXCL`, rename-based stale
   claiming with post-rename content re-verification, exclusive-create restore when the rename stole
   a replaced lock (BUG-34).
4. **Shell-quoting at every trust boundary**: `shellQuoteArg` in flake-probe/runners/scoped-lint;
   regex metacharacter escaping for test filters; argv-array spawning everywhere — prompts and model
   names never touch a shell string.
5. **Webhook plugin defence-in-depth** (`interaction/plugins/webhook.ts`): loopback bind, timing-safe
   HMAC, streaming body cap, pre-auth/auth rate limiting, registered-ID allowlist, honest 503 on
   store overflow.
6. **Prototype-pollution-hardened config merger** (`config/merger.ts`): `__proto__` / `constructor` /
   `prototype` filtered at every recursion level; prototype-checked `isPlainObject`.
7. **TUI render-storm prevention** (`tui/hooks/useAgentStreamEvents.ts`): per-token events mutate
   refs only; dirty-flag-guarded 150 ms flush to state; capped escalation log.
8. **Honest persistence docs** (`utils/json-file.ts`): atomic-write caveats (no fsync, orphaned tmp
   on hard kill) documented in place rather than hidden.
9. *(rev 2)* **Malformed-entry defence at the LLM parse boundary** (`semantic-helpers.ts:72-85`,
   `adversarial-helpers.ts:83-95`): `findings: [null]` and `findings: ["prose"]` are filtered once,
   at the boundary, rather than defended against by every consumer — with the reasoning written
   down. BUG-2 is precisely the field this good pattern forgot to cover, which makes it a
   one-line extension rather than a new mechanism.

---

## Priority Fix Order

*(rev 2: rebuilt — the rev-1 table was off by one from BUG-10 downward and referenced a nonexistent
BUG-19.)*

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| **P0** | BUG-1 | S–M | Verdict coercion: capture the pass/fail keyword, reject negations, stop seeding `allPassing` from `approved`. **Do not** add `approved !== false` to `categorizeVerdict` (contradicts the advisory-override design). Consider gating the verifier-as-SSOT carve-out on non-coerced verdicts |
| **P0** | BUG-2 | S | Normalize severity **at the parse boundary** (`validateLLMShape` / `validateAdversarialShape`), case-insensitively, unknown → fail-closed; de-duplicate the two `normalizeSeverity` copies |
| **P0** | SEC-3 | S | `z.enum` for the per-trigger fallback + `default: return "abort"` in the switch |
| **P1** | BUG-48 | S | Honour `interaction.defaults.fallback` in `getTriggerConfig`, or remove the field and the `init.ts:33` guidance |
| **P1** | BUG-4 | S | Catch TUI key-handler rejections; surface inline instead of crashing the run |
| **P1** | BUG-3 | S | Add `--cwd` to the `acpx cancel` / `acpx stop` argv |
| **P1** | SEC-18 | S | `validateProfileName` in profile create |
| **P1** | SEC-5 | M | Fail fast on config parse errors — strict `loadJsonFile` variant (ENOENT ≠ corrupt); also fixes BUG-10 and pairs with BUG-40 |
| **P2** | MEM-6 | M | Remove worktrees for failed parallel stories (track creation, not config mode) |
| **P2** | BUG-10 | S | Quarantine corrupt `metrics.json` instead of wiping history |
| **P2** | BUG-11 | S | NaN-safe timestamp guard in scratch purge |
| **P2** | BUG-12 | S | `asFiniteNumber` for all four `usage_update` numeric fields |
| **P2** | BUG-13 | M | Deadline for worktree dependency provisioning spawn |
| **P2** | BUG-8 | M | Re-resolve dispatchable stories by id after the PRD reload |
| **P2** | BUG-9 | M | Coordinator-owned queue-command application in parallel mode |
| **P3** | BUG-7, BUG-14, BUG-15, BUG-16, BUG-17, MEM-19, ENH-20 | M | Batch: cost pre-gate, inconclusive-acceptance handling, `parseAsync`, status shape validation, prompts-init path, drain deadlines, `failOpen` reporting |
| **P4** | LOW items (STYLE-21 … ENH-47) | S each | Table above; mostly one-line guards or doc clarifications. Prioritise BUG-31 / PERF-32 alongside BUG-13 to close the deadline convention gap in one pass |

**Sequencing:** see **Handover Brief → Sequencing for the implementing session**, which is the single
source of truth for PR grouping. In short: BUG-1 + BUG-2 + ENH-20 ship together ("green must mean
checked" — individually each leaves another route to a false pass); SEC-3 + BUG-44 + BUG-48 are one
PR (~15 lines of `schemas-infra.ts` / `triggers.ts`); SEC-5 + BUG-40 + BUG-10 share the new
`loadJsonFileStrict`; BUG-13 + BUG-31 + MEM-19 + PERF-32 are one deadline-convention sweep.

**Every "Fix" paragraph above is now prescriptive.** Where a choice existed it is resolved in the
decision register (D-1…D-24) and cited inline. If you find yourself weighing options while
implementing, that is a gap in this document — record it rather than deciding silently.

---

*Review artifacts: knowledge-graph hotspot query (complexity/loop-depth rankings), 6
directory-cluster deep dives (~45 candidate findings), mechanical pattern scans (`any`,
`setInterval`, spawn/timeout conventions), manual verification of all included findings.*

*Rev 2 artifacts: per-finding source re-read at HEAD `76c5bafdc`; downstream-consumer tracing for
BUG-1 (`rectification.ts`, `execution-plan.ts`, `build-plan-for-strategy.ts`) and BUG-2
(`semantic-helpers.ts`, `adversarial-helpers.ts`, 40 call sites); proposed-fix validation against
`operations/verify.ts:126-133`; dead-config trace for BUG-48 (`triggers.ts` → `init.ts` → `chain.ts`);
platform-support check (`package.json` `engines`, `win32` grep over `src/`). Typecheck proof:
`bun run typecheck` exit 0 at HEAD `76c5bafdc`.*
