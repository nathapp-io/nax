# Deep Code Review: @nathapp/nax — Latent Bugs (Fresh Sweep)

**Date:** 2026-08-11 (Rev 4: 2026-08-12 — proof harness audited, rewritten as assertions, and re-executed)
**Reviewer:** opencode (5 parallel subsystem reviews + independent spot-verification)
**Version:** 0.79.0 (`0d92c460`)
**Files:** 838 TS files (~122.5k LOC source, src/ only)
**Baseline:** `bun run typecheck`, `bun run lint`, `bun test` (unit + integration + ui + e2e)
**Method:** Hotspot queries over the codebase knowledge graph (complexity ≥ 15, loop-depth ≥ 3, linear-scan-in-loop) → 5 parallel deep reads (execution / pipeline+verification / agents+routing+config / context+prd+tdd+review / cli+commands+queue+worktree) → manual verification of every HIGH finding against source.

**Relation to prior review:** `docs/20260811-review-latent-bugs.md` (Rev 3, 57 findings, v0.78/0.79) covers a different slice. Findings below were cross-checked against it: **~90% are new** (no predicate overlap for 20+ distinctive signatures). Findings marked ✅ were independently re-verified by me directly against source; the rest carry the reviewing subagent's line-verified evidence.

**Verification (2026-08-12, revision 1):** All 61 findings re-verified against `0d92c460` (HEAD at verification time) by 5 parallel subsystem sweeps + independent spot-checks (git porcelain experiments, regex executions, call-graph traces). Result: **48 confirmed as written, 11 confirmed-with-amendments** (mechanism holds; impact/example/severity corrected — see per-finding notes), **2 false claims** (BUG-24 in full, and BUG-46's porcelain half: git always C-quotes space-containing rename paths, so the cited unquoted inputs are not producible — verified empirically, incl. `core.quotePath=false`). Severity corrections: **BUG-33 MEDIUM→LOW** (the second "patch-step" call is a pure synchronous string builder — no LLM call is wasted, the runner-up patch feature is simply lost), **BUG-56 MEDIUM→LOW** (dead code: `writeReviewVerdict` has zero production callers, and story ids are validated upstream by `validateStoryId`). No line-number drift was found anywhere; all citations match `0d92c460` exactly. *(Rev 4 amends this: the claim was made without an exhaustive sweep, and a full one found 4 imprecise citations out of 137 — see below.)*

**Verification (2026-08-12, revision 2 — execution proof):** Every runtime-reproducible finding was then *executed* against the real modules, not just read. A harness (`docs/reviews/2026-08-11-latent-bugs-v2-proof.ts`) imports the production code and triggers each defect with real inputs. Dead-wiring findings were additionally proven with the codebase knowledge graph (in-degree 0 / no callers) and full call-site traces.

**Verification (2026-08-12, revision 3 — harness audit + rewrite):** The Rev-2 harness was itself audited by executing it. **It did not pass.** It carried no assertions (it printed values and always exited 0, so "all passing" was not a claim it could make), it **crashed** with `ENOENT` in its BUG-26 block, and `process.exit(1)` on that crash killed the run before the concurrently-scheduled BUG-34 and BUG-44 blocks printed anything — so three findings labelled EXEC had produced **no execution evidence at all**. Six further "proof" lines were `Object.keys(module)` dumps that demonstrate only that a module imports, and the BUG-31 lines read `v.passCount` instead of `v.tests.passCount`, printing `undefined` for the very numbers the finding is about. The harness was rewritten: every check is now an assertion with an expected value, checks run sequentially (they share injected `_deps` state), the repo root is derived from `import.meta.url`, scratch state goes to a `mkdtemp` directory that is cleaned up, and the process exits non-zero on any failure. BUG-26 now drives the **real** `writeQueueCommand` (the Rev-2 block hand-simulated its read-modify-write inline, which proves nothing about the shipped function). Result on `0d92c460`: **31 assertions, 0 failures, exit 0**, reproducible across runs.

**Verification (2026-08-12, revision 4 — exhaustive citation sweep):** Rev 1's "no line-number drift anywhere; all citations match exactly" was asserted without an exhaustive check. Every `path.ts:LINE` reference in this document was then extracted mechanically and its cited lines printed and compared against the claim they support: **137 distinct citations, 0 out-of-range, 4 imprecise, 133 exact.** No finding's *mechanism* was affected — all four are pointer errors, not evidence errors:

| Finding | Was | Corrected to |
|:---|:---|:---|
| BUG-48 | `paused-story-prompts.ts:60-62` given as the source of keys `resume`/`skip`/`approve`/`abort` | that file holds `resume`/`skip`/**`keep`**; `approve`/`abort` are in `story-size-prompts.ts:81,83` — two files were conflated and `keep` was omitted |
| BUG-44 | `report.ts:152` "surfaces it" | `:152` is the function's `return`; the `avgCost` field is at `report.ts:157` (`buildModelEfficiency`, :150-159) |
| BUG-12 | body cites per-package lists at `acceptance.ts:270-278`, Appendix cites `:257` | `:270-278` is correct; `:257` is the `AC-ERROR` sentinel push — the two halves of the doc disagreed |
| BUG-02 | "the missing self-check is in `validateStory` at schema.ts:540" | `:540` is the second-pass `rawStories.map(... validateStory ...)` **call site**, not a line inside `validateStory` |

Also corrected in passing: BUG-33's "pure **synchronous** string builder" — `runPatchStep` is declared `async` (it simply awaits nothing). The substantive point (no LLM call is wasted) stands.

**Verdicts changed by Rev 3:** none. Every finding's mechanism was reconfirmed by execution or graph; the rewrite exposed no new false positives and no new bugs, and BUG-34/BUG-44/BUG-26 — previously asserted but unexecuted — now reproduce as written. Two Rev-2 *descriptions* were sharpened against measured output (BUG-29's in-memory/persisted divergence is `snapshot()` reporting exactly the one orphaned event, not a running total; BUG-46's counter-example is recorded explicitly). The most consequential runtime proofs:

- **BUG-01** `validatePlanOutput` accepts `"dependencies": ["ST001"]`, stores it raw, `storyIds.has("ST001")` = **false** → dependency silently treated as satisfied.
- **BUG-02** duplicate `ST-001` x2 passes `validatePlanOutput` unchanged.
- **BUG-06** the real `verifyScopedOp` with exit-0 + `[no test files]` returns `{success: true, status: "passed", passCount: 0}` — false green.
- **BUG-13** `TestACL2_Check` → `[]` (no phantom; original example wrong) but `TestMac_2`/`TestMac2`/`test_mac_2` → `["AC-2"]` phantom in all three framework branches.
- **BUG-14** `"WARN: 3 failed requests"` in green output → `failCount: 3, allTestsPassed: false, isEnvironmentalFailure: false`.
- **BUG-25** crash between `readQueueFile` rename and `clearQueueFile`: `PAUSE` is overwritten and permanently lost.
- **BUG-26** queue-writer's read-modify-write resurrects a consumed `SKIP US-001` (double delivery).
- **BUG-27** `curatorStatus` crashes with `SyntaxError: JSON Parse error` on a truncated `observations.jsonl` line.
- **BUG-29** an event recorded during `drain()`'s final-write window is **never persisted**, and a later `drain()` does not recover it; `snapshot()` afterwards reports exactly that orphaned event ($1 of $3 recorded, disk holds the other $2) — in-memory and audit trail diverge in both directions.
- **BUG-31** `"VERIFIED FAILED: 3 tests red"` + `test_results: "3/3 FAIL"` coerces to `approved: true, passCount: 3, failCount: 0`; a `2024/05/13` date yields `passCount: 2024, failCount: -2019`.
- **BUG-34** real `git diff --name-only HEAD` (via `getChangedFiles`) misses the untracked `brand-new.ts`.
- **BUG-44** 3 attempts / 0 successes / $18 spent → `avgCost: 0`.
- **BUG-10** per-package `models.claude.fast` override drops `balanced`/`powerful` (merged tiers: `fast` only).
- **BUG-45** `a**b` matches `a/x/b` (crosses dirs); `foo\ bar` fails to match `foo bar`.
- **BUG-57** `- **API docs** — [docs](url)` → tags `["docs"]` → entry dropped for every role.
- **BUG-58** double `**Out of scope:**` marker → `"thing one **Out of scope:**"` (marker text leaks into the item).

Call-graph proofs at review time: `preIterationTierCheck` (BUG-04), `detectRuntimeCrash` (BUG-05), auto-plugin `decide` (BUG-09), `executeParallel` (BUG-40), `AgentManager.reset` (BUG-52) all had **zero production callers** (knowledge-graph in-degree 0, verified by grep); `handleTierEscalation`'s only inbound edge was `handlePipelineFailure` (BUG-05); `AgentManager.reset` was only referenced from test helpers. These observations describe the reviewed revision, not current `main`; the resolution annotations below record the merged changes.

---

## Overall Grade: B- (76/100)

| Dimension | Score | Notes |
|:---|:---|:---|
| Security | 16/20 | No injection/eval/secret issues; data-loss vector is `git clean -fd` rollback (verified); verdict-writer traversal is dead code (BUG-56 → LOW) |
| Reliability | 13/20 | Dead escalation wiring, false-green verify paths, non-atomic cross-process writes |
| API Design | 15/20 | Solid typing (zod everywhere, no `any` in public APIs) |
| Code Quality | 16/20 | Excellent discipline: `_deps` injection, structured errors, budget-bounded loops |
| Best Practices | 16/20 | Defensive parsing, timeout races, allSettled patterns — above typical |

**Summary:** The codebase is unusually well-engineered for its size — error chaining, injectable deps, timeout races on every subprocess, and capped retry loops are consistent. No CRITICAL (crash-class, corruption-class) bugs found. The systemic weakness is **dead/broken wiring**: two escalation features (`preIterationTierCheck`, `RUNTIME_CRASH` same-tier retry) and the entire auto-interaction plugin are fully wired out of the call graph, silently degrading configured behavior. Secondary themes: (1) false-green/false-pass verdict paths in test parsing and review coercion, (2) non-atomic cross-process persistence (metrics, queue file, status.json), and (3) destructive git operations (`git clean -fd`) run in user worktrees.

---

## Findings

### 🔴 HIGH

#### BUG-01: PRD dependencies stored unnormalized — dependency ordering silently broken
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/prd/schema.ts:216-221` — the dependency *check* normalizes, the stored value does not:
```ts
const dependencies: string[] = Array.isArray(rawDeps) ? (rawDeps as string[]) : [];
for (const dep of dependencies) {
  if (!allIds.has(normalizeStoryId(dep))) { throw ... }   // validated as normalized
}
// stored as-is: "ST001" never matches id "ST-001"
```
Consumers match raw strings: `prd/index.ts:111` (`!storyIds.has(dep) || completedIds.has(dep)`), `story-selector.ts:112,138`. An LLM emitting `"dependencies": ["ST001"]` passes validation yet the dep is never matched — `story-selector.ts:114` (`if (!dep) return true`) treats it as *already satisfied*, so the dependent story executes **before** its prerequisite (silent ordering break; verified 2026-08-12 — not a stall).
**Risk:** Any unnormalized dep silently bypasses ordering — dependent story runs early; spurious failures + rectification churn.
**Fix:** `dependencies = dependencies.map(normalizeStoryId)` (dedup) at schema.ts:217, or normalize in `loadPRD`.
**Proof (EXEC):** harness — `validatePlanOutput` accepts `ST001`, stores it raw, `storyIds.has("ST001") === false` → dependency ignored by `story-selector.ts:114`.

#### BUG-02: Duplicate story IDs pass validation — runner re-executes the same story forever
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/prd/schema.ts:527-540` — the validation pass builds `allIds` but `validateStory` never rejects a story whose **own** id is already present (it only checks *dependencies*; note the cited lines are the `allIds` build, and schema.ts:540 is the second-pass `rawStories.map(... validateStory ...)` **call site** — the missing self-check belongs inside `validateStory`, which spans schema.ts:70-...). `markStoryPassed`/`getNextStory` (`prd/index.ts:229,110`) resolve the first match, so the duplicate stays `pending` forever → `isComplete` never true → the runner re-selects and re-executes the duplicate indefinitely. `injectStory`'s guard (`prd/index.ts:389`) covers only the INJECT path.
**Risk:** Infinite re-execution / never-completing run on a hand-edited or LLM-generated PRD with a duplicated id.
**Fix:** Reject `allIds.has(normalizeStoryId(s.id))` in the second pass (mirror `injectStory`'s guard at `prd/index.ts:389`).
**Proof (EXEC):** harness — `validatePlanOutput` with `ST-001` x2 returns both stories unchanged; no test covers it (`schema.test.ts:135` tests deps only).

#### BUG-03: Empty canonical-rule frontmatter (`---\n---\n`) throws — rules corpus silently lost / precheck blocker
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed (regex-verified, impact amended 2026-08-12)
`src/context/rules/rules-frontmatter.ts:161-166`:
```ts
const close = effectiveContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
if (!close) {
  if (warnings.length > 0) { return default; }
  throw new RulesFrontmatterError("Canonical rule frontmatter is missing closing '---'", filePath);
}
```
The regex requires a line break *after* the opening delimiter **and** before the closing one — the compact empty block `---\n---\n` can never match (regex-verified against real input; the closing `---` is consumed as content). `loadCanonicalRules` doesn't catch per-file parse errors and `static-rules.ts:458-466` rethrows. Impact corrected on verification (2026-08-12): the error does **not** crash the context stage — `orchestrator.ts:287` escalates only `NeutralityLintError`, so the static-rules provider is **soft-skipped** (orchestrator.ts:293-309) and the story's context silently loses the entire rules corpus; separately, the precheck `canonical-rules-lint` check (`checks-system.ts:129-146`) converts any loader error into a **blocker**, failing the run before it starts when precheck is enabled.
**Risk:** One empty-frontmatter rule file disables the rules corpus (silent rule loss per story, or a precheck blocker); also `---`-horizontal-rule files at file start.
**Fix:** Special-case `^---\r?\n---\r?\n?` (skip), and make `loadCanonicalRules` catch per-file `RulesFrontmatterError` → warn + skip.
**Proof (EXEC):** harness — `parseFrontmatter("---\n---\n")` throws `Canonical rule frontmatter is missing closing '---'`; `---\n\n---\n` parses.

#### BUG-04: Per-tier attempt budgets dead — story escalates after every single failure
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ fixed 2026-08-12, PR #1550
`src/execution/escalation/tier-escalation.ts:130` — `preIterationTierCheck` has **zero callers** outside its own barrel export (`escalation/index.ts:8`; grep-verified). Config declares `tierOrder: [{fast, attempts:5}, {balanced, attempts:3}, {powerful, attempts:2}]` (schemas.ts:87-90) but `handleTierEscalation` resets `attempts: 0` on tier change (:473) and `canEscalate` compares against `calculateMaxIterations` (the *sum* of all tiers).
**Risk:** The expensive `powerful` tier is reached far earlier than configured; `maxAttempts` effectively never trips mid-ladder; configured budget silently ignored.
**Fix:** Invoke `preIterationTierCheck` before each iteration, or make `handleTierEscalation` compare against the current rung's `tierCfg.attempts`.
**Proof (GRAPH):** `preIterationTierCheck` inbound callers = **[]** (knowledge graph + grep); `canEscalate` (tier-escalation.ts:382-383) compares `s.attempts < calculateMaxIterations(tierOrder)` = 10; attempts reset to 0 on tier change (:473).

**Resolution:** `preIterationTierCheck` is now invoked before sequential and parallel dispatch, enforces the current rung's attempt budget, and resets attempts only when advancing to the next rung. The shipped defaults are `fast:2`, `balanced:2`, `powerful:2`.

#### BUG-05: RUNTIME_CRASH same-tier retry unreachable — `runtimeCrashResult` never populated
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ fixed 2026-08-12, PR #1550
`src/execution/escalation/tier-escalation.ts:346` — the only `retry-same` exit is gated on `shouldRetrySameTier(ctx.runtimeCrashResult)`, but the sole production call (`pipeline-result-handler.ts:368-384`) passes no such field; the type is populated nowhere in `src/` (grep: definition + consumer only).
**Risk:** Every `CALL_OP_NO_OUTPUT`/`CALL_OP_MAX_RETRIES` crash escalates to a costlier tier instead of the documented "transient, retry same tier" — over-spend + wrong fix semantics.
**Fix:** Thread the verify status into `handlePipelineFailure`'s escalation call.
**Proof (GRAPH):** `detectRuntimeCrash` in-degree **0**; `shouldRetrySameTier`'s only caller is `handleTierEscalation`; the only `handleTierEscalation` caller is `handlePipelineFailure` (pipeline-result-handler.ts:368-384) — passes no `runtimeCrashResult`; the field is assigned nowhere in src/ (grep).

**Resolution:** execution-stage runtime crashes are classified through `tddFailureCategory`, converted to `runtimeCrashResult` by `handlePipelineFailure`, and routed to a bounded same-tier retry (`RUNTIME_CRASH_RETRY_CAP = 2`).

#### BUG-06: Scoped verify reports "passed" on exit 0 with zero tests executed (false green)
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed → **fixed 2026-08-12, PR #1553**
`src/operations/verify-scoped.ts:216-217`:
```ts
const ranNoTests = parsed.passed === 0 && parsed.failed === 0 && parsed.failures.length === 0;
if (!result.success && result.status !== "TIMEOUT" && !isFullSuite && ranNoTests) { ... rerun full suite ... }
```
The zero-test guard only fires when the run **failed**. A scoped run that exits 0 while executing nothing (Go `[no test files]` on a helper-only `_test.go`; Mocha on a mapped `.js` file with no specs) falls through to `return { success: true, status: "passed", passCount: 0 }`. In deferred-regression mode the full-suite gate runs only at run end, so the story is marked passed with zero verification.
**Risk:** Story's changes never actually exercised; failure surfaces as a whole-run failure with no fix cycle.
**Fix:** Gate success on `parsed.passed > 0` when `!isFullSuite`, or treat success+`ranNoTests` as a scoped failure → rerun full suite.
**Proof (EXEC):** harness — the real `verifyScopedOp` (injected `regression` returning exit 0 + `[no test files]`) returns `{success: true, status: "passed", passCount: 0}`. `verify-scoped.test.ts:313` only covers the *failed* zero-test path (#1207) — the exit-0 case is untested.

#### BUG-07: TDD rollback runs `git clean -fd` — deletes user's untracked work
**Severity:** HIGH | **Category:** Bug (data loss) | **Status:** ✅ confirmed → **fixed 2026-08-12, PR #1553**
`src/tdd/rollback.ts:30-39`:
```ts
const cleanProc = _rollbackDeps.spawn(["git", "clean", "-fd"], { cwd: workdir, ... });
```
`git clean -fd` deletes *every* untracked, non-ignored file in the workdir. Invoked on ordinary TDD failure (`post-run.ts:490-503`) and non-blocking-fix restore (`non-blocking-fix.ts:411`). The run's own `.nax/` outputs are ignored, but the user's `.env`, notes, and WIP files are silently destroyed — in the user's own worktree, mid-session.
**Risk:** Permanent loss of user files on any TDD/fix failure path.
**Fix:** `git clean -fd -e <run-owned-paths>` or scope clean to a computed changed-file list (`git diff` + staged + run's own files) instead of blanket `-fd`.
**Proof (GIT):** scratch-repo experiment — `git clean -fd` semantics confirmed (deletes every untracked non-ignored file); `.gitignore:43-66` does **not** ignore e.g. `.nax/features/<id>/status.json`/`checkpoint.jsonl` (git check-ignore), so run-owned state outside the ignored list is also destroyed.

#### BUG-08: `metrics.json` read-modify-write race — history silently wiped
**Severity:** HIGH | **Category:** Memory/Persistence | **Status:** ✅ confirmed → **fixed 2026-08-12, PR #1555**
`src/metrics/tracker.ts:388-396` + `src/utils/json-file.ts:60-72`:
```ts
const existing = await loadJsonFile<RunMetrics[]>(metricsPath, "metrics");
const allMetrics = Array.isArray(existing) ? existing : [];   // torn read → null → WIPED
allMetrics.push(finalMetrics);
await saveJsonFile(metricsPath, allMetrics, "metrics");        // truncate-then-write, non-atomic
```
Parallel runs each live in their own git worktree/process sharing the same `projectOutputDir`; two concurrent runs both read, one overwrites the other's entry; a torn read parses as garbage → `loadJsonFile` returns `null` → the whole history is replaced by `[newRun]`.
**Risk:** Run metrics lost; cost history wiped on crash or concurrency.
**Fix:** Write `<path>.tmp` + `rename()` (atomic), or a JSONL append store.
**Proof (SRC):** `json-file.ts:31-41` returns `null` on any parse failure → `tracker.ts:389-390` maps that to `[]` → history wiped on next append; `json-file.ts:60-72` is an in-place `Bun.write` (truncate-then-write, no temp file).

#### BUG-09: "auto" interaction plugin is dead code — configured auto-mode throws on every prompt
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed → **fixed 2026-08-12, PR #1553** (deleted per the Group 1 ruling below)
`src/interaction/plugins/auto.ts:117-122`:
```ts
async receive(_requestId: string, _timeout = 60000): Promise<InteractionResponse> {
  throw new Error("Auto plugin requires full request context (not just requestId)");
}
```
`decide()` (:127) has **zero callers** in `src/` (grep-verified); `_autoPluginDeps` is never injected by production code; the chain registers only one plugin. With config `interaction.plugin: "auto"`, every `chain.prompt()` (story-size gate, paused-story prompts, cost-warning/security triggers) throws "All interaction plugins failed".
**Risk:** Documented auto-approval feature completely non-functional; triggers silently degrade.
**Fix:** Wire `decide()` into the chain's receive path, or remove the plugin.
**Proof (GRAPH):** auto-plugin `decide` inbound callers = **[]** (knowledge graph + grep for `.decide(` in src/); `receive()` throws unconditionally (auto.ts:117-122); `createInteractionPlugin` (interaction/init.ts:69-70) registers exactly one plugin; the fallback cascade (chain.ts:73-82) iterates a single entry, and bridge-builder catches the throw and silently continues (bridge-builder.ts:66-71).

#### BUG-10: Per-package `models` override replaces the whole per-agent tier map
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/config/merge.ts:67`:
```ts
models: packageOverride.models !== undefined ? { ...root.models, ...packageOverride.models } : root.models,
```
Docstring says "deep", but a package override of `models.claude.fast` silently drops root `balanced`/`powerful` for that agent (no `models` cases in merge.test.ts). Later tiers resolve to unknown-model fallbacks mid-run.
**Risk:** One-line per-package override cripples the rest of the tier ladder.
**Fix:** `{ ...root.models, [agent]: { ...root.models[agent], ...override.models[agent] } }` per agent.
**Proof (EXEC):** harness — override of `models.claude.fast` only → merged claude tiers: `fast` (balanced/powerful silently dropped); gemini tiers intact. `merge.test.ts` has no `models` cases; `merge-agent-models-routing.test.ts:85-114` only passes complete tier maps.

#### BUG-11: Acceptance retry loop off-by-one — last configured retry never used
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed (call-site semantics) → **fixed 2026-08-12, PR #1553**
`src/execution/lifecycle/acceptance-loop.ts:429-455`:
```ts
acceptanceRetries++;
if (acceptanceRetries >= maxRetries) { ... return buildFailureResult(...); }
```
The counter consumes a retry *before* any fix runs. Default `acceptance.maxRetries: 3` → only 2 fix rounds; `maxRetries: 1` → run fails without ever invoking `runAcceptanceFixCycle`.
**Risk:** Configured fix budget systematically under-delivers; `maxRetries: 1` means zero fix cycles.
**Fix:** Move the `>= maxRetries` check to after the fix-cycle phase (or start counter at -1 / compare `>`).
**Proof (SRC):** acceptance-loop.ts:429 `acceptanceRetries++` precedes the fix cycle; the `>= maxRetries` gate at :435 fires before `runAcceptanceFixCycle` ever runs; default 3 (schemas.ts:287) → 2 fix rounds; `maxRetries: 1` → 0 fix rounds.

#### BUG-62: Provider capacity errors are parsed as review verdicts and fail-open — story ships unreviewed
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed (measured over 4570 review-audit records, 2026-08-12) → **fixed 2026-08-12, PR #1551** (see "Fix Status" below)
Found while measuring BUG-30, and it displaces BUG-30 as the real defect. When the provider refuses a call, the refusal text is returned as the reviewer's *output* rather than raised as an adapter failure. It therefore flows into the review op's parse path, fails `validateLLMShape`, exhausts the parse-retry budget, and lands in `reviewExhaustedFallback` (`_review-fallback.ts:21`) — which asks only whether the blob contains `"passed": false`. It doesn't, so the op returns `FAIL_OPEN`, `runner.ts:492` counts it as `success: true`, and the story completes with **no story-level review at all**.

Measured over every `~/.nax/*/review-audit/` record (4570 records, 8 projects):

| | count | share |
|:---|---:|---:|
| Parse give-ups (`parsed: false`) | 75 | 1.64% of reviews |
| → fail-open (silently passes) | 57 | 76% of give-ups |
| → looksLikeFail (blocks) | 18 | 24% of give-ups |

Of the 16 give-ups carrying `unparsedPreview` (the diagnostic is recent; the other 59 predate it — a 21% sample, all from the recent window):

- **6 blocks** — every one a genuinely truncated `{"passed":false,"inspectedFiles":[…` verdict. Blocking was correct.
- **10 fail-opens** — 9 were the literal provider string `"Selected model is at capacity. Please try a different model."`; 1 was a reviewer prose preamble. **None were verdicts.**

All 10 capacity errors were agent `codex` on 2026-08-11 — a single provider incident burst that silently skipped 10 reviews across the `nax` and `rs-stock` projects. `grep -rn "capacity" src/agents/` returns **nothing**: the condition is entirely unhandled.
**Risk:** Provider incidents silently disable story-level review. The run reports success and the audit record is the only trace. Bursty by nature, so a single bad provider afternoon can ship a whole feature unreviewed.
**Fix:** Classify provider-refusal / non-verdict output as a retriable **infrastructure** failure before it reaches `reviewExhaustedFallback`, and route it to backoff + agent swap. This is the same underlying gap as **BUG-20** (`manager.ts:503-515` maps every hard exception to `retriable: false`) seen from the reviewer end — the two should be fixed together. Note `parse-retry.ts:117` returns `delayMs: 0`, so the existing parse-retry is not a usable vehicle for this: it re-calls an at-capacity model immediately, with a `jsonRetry()` prompt instructing it to emit valid JSON — nonsense advice for a provider refusal.
**Proof (DATA):** `find ~/.nax -path "*/review-audit/*" -name "*.json"` → 4570 records; `parsed:false` = 75; `failOpen:true` = 57; `looksLikeFail:true` = 18; all 16 `unparsedPreview` values classified above.

**Corollary — BUG-30 is not the bug it was written as.** The `/"passed"\s*:\s*false/` heuristic was directionally **correct on 16 of 16** measured cases: every blob it blocked was a real truncated failure verdict, and every blob it passed was not a verdict at all. The fail-open/fail-closed policy question posed in Group 1 is adjudicating a coin-flip that isn't flipping; the fix belongs at classification, not at the gate. The give-up rate is also bursty rather than uniform — 0.79.0's apparent 8/48 (16.7%) is the 2026-08-11 provider incident plus one large-deletion feature (`retire-dead-cli-config-surface`, 4 give-ups in 11 records), not a version regression.

### 🟡 MEDIUM

#### BUG-12: Cross-package acceptance AC-id collision under-reports failures
`src/pipeline/stages/acceptance-setup.ts:358` + `acceptance.ts:261-268` — each package's test file numbers criteria `AC-1..N` independently, but `allFailedACs` dedups by bare id: package A failing AC-2 and package B failing AC-2 (different criteria) collapses to one finding. Verified 2026-08-12; impact limited to the aggregate `failedACs`/`findings` (reporting/failure messages) — the per-package `failedPackages[].failedACs` lists (acceptance.ts:270-278) retain complete attribution and drive the fix fan-out (acceptance-loop.ts:531). **Fix:** key by `packageDir + acId`.

#### BUG-13: `parseTestFailures` fabricates phantom AC ids from unanchored regex
`src/test-runners/ac-parser.ts:57-75` — `line.match(/AC[-_]?(\d+)/i)` against the entire failure line (gated Go/pytest/jest-vitest branches): a Go test named `TestMac_2` or a jest `TestMac2` failing for unrelated reasons yields a phantom `AC-2` acceptance failure + spurious fix story (regex-executed 2026-08-12; note the original example `TestACL2_Check` does **not** match — `AC` must be followed by a separator/digit). Feeds fix-story generation (`acceptance-loop.ts:166-178`, `hardening.ts:168-188`). **Fix:** anchor — `/^--- FAIL: (Test)?AC[-_]?(\d+)\b/i` (and a `● TestAC\d+` branch for jest).

#### BUG-14: `(\d+)\s+fail` fallback misreads green suites with log noise
`src/test-runners/parser.ts:482-487` — any log line like `WARN: 3 failed requests` inside test output sets `failed=3` on an all-green run (used by `analyzeTestExitCode` for every framework → ENVIRONMENTAL vs TEST misclassification). **Fix:** require summary context (line-anchored `^\s*\d+\s+fail`).

#### BUG-15: `parseMochaOutput` takes the FIRST `N passing` match — undercounts multi-spec runs
`src/test-runners/parse-mocha.ts:14-23` — `output.match()` returns the first occurrence; Mocha/Cypress emit per-spec progress + final summary, so `0 passing` from an early spec wins. Feeds `ranNoTests` (BUG-06) and verdicts. **Fix:** `matchAll` and keep the last.

#### BUG-16: Bun output parser loses `currentFile` attribution for `.test.tsx`/`.spec.ts` headers
`src/test-runners/parser.ts:92` — the header check is a string `endsWith` (not a regex) matching only `.test.ts:`/`.test.js:`; failures in `.test.tsx`/`.spec.ts`/`.test.mts`/`.test.cts` files leave `currentFile = ""` → attributed `file: "unknown"` → rectifier/smart-runner target the wrong file. Verified 2026-08-12; attribution-only (counts and test names unaffected). **Fix:** `/(\.test\.|\.spec\.)[jt]sx?:$/`.

#### BUG-17: `(fail)` name parser truncates test names containing `[<digits>ms]`
`src/test-runners/parser.ts:116` — `^\(fail\)\s+(.+?)\s+\[[\d.]+m?s\]` (no `$`, lazy `.+?`): `(fail) render [5ms] timeout handling [1.2ms]` yields name `render` and misreads the error block. **Fix:** anchor `\]$`, greedy `.+`.

#### BUG-18: `buildSmartTestCommand` replaces the last path-like token — drops config flags
`src/verification/smart-runner.ts:355-376` — the last token containing `/` (smart-runner.ts:357-364) is silently replaced by the scoped test files. Mechanism verified (2026-08-12) but the cited example was wrong: `vitest run --config vitest.config.ts` has no slash-bearing token, so the config is kept and test files are **appended**; only **slash-bearing** config paths are destroyed — `vitest run --config ./vitest.config.ts` → `vitest run '<test files>'` and `jest --config config/jest.config.js --runInBand` → config replaced — scoped runs execute against the wrong/no config. **Fix:** exclude tokens after known flag options / require positional position.

#### BUG-19: LLM routing cache keyed by bare `story.id` — cross-feature contamination
**Status:** ✅ fixed 2026-08-12, PR #1557
`src/routing/router.ts:196-238` + `strategies/llm-cache.ts:12` — module-level cache keyed `US-001`; the clear at `routing.ts:32-34` fires only when the story whose id equals the run's **first** story id is routed. Verified 2026-08-12: in a plain sequential run starting with the same id the clear *does* fire, so poisoning is conditional — it bites under parallel routing (stories route concurrently), a skipped/paused `stories[0]` whose routing stage never runs, or a run starting with a different id. **Fix:** key by `${featureName}:${story.id}`.

**Resolution:** the routing-decision cache now lives on `NaxRuntime`; every `createRuntime()` call receives a fresh cache, eliminating cross-run and cross-feature contamination without positional invalidation.

#### BUG-20: `complete()` hard exceptions bypass all retry policy
**Status:** ✅ confirmed → **fixed 2026-08-12, PR #1551** (see "Fix Status" below)
`src/agents/manager.ts:503-515` — any hard exception from `adapter.complete()` (timeout race rejection, spawn failure, parse error) becomes `fail-unknown`/`retriable:false`; **no same-agent retry** (the fail-timeout retry branch, `hop-retry-policy.ts:102-125`, can never fire for `complete()` — verified 2026-08-12). Swap clause amended: a fallback swap *does* occur when `fallback.onQualityFailure` is enabled; with the default config it doesn't. One transient timeout is terminal for `autoApproveOp`/decompose-style ops. **Fix:** map `AGENT_TIMEOUT`/spawn errors to retriable outcomes.

#### BUG-21: CLI interaction timeout leaves the readline question pending — input drift
`src/interaction/plugins/cli.ts:99-117` — after a `Promise.race` timeout, the `rl.question()` callback stays live. Verified empirically (2026-08-12): impact is worse than originally stated — the next `question()` registers **no callback at all**, and the user's typed answer is consumed by the stale callback; every subsequent prompt times out until one user input discharges the stale handler (fallback-to-skip after any single timeout). `cancel()` (cli.ts:87-89) does not help. **Fix:** `rl.close()` + recreate on timeout.

#### BUG-22: Telegram plugin: concurrent receives share `lastUpdateId` — answers cross-dropped
**Status:** ✅ fixed 2026-08-12 on `fix/bug-22-25-26-interaction-queues`
`src/interaction/plugins/telegram.ts` — `receive()` polls in a loop per request with shared instance offset: loop A can advance past loop B's response, which `parseUpdate` then drops (mismatched id). Parallel stories → silent timeout fallbacks. **Fix:** single poller, fan-out to request callbacks.

#### BUG-23: `autoCommitIfDirty` runs git without timeout and never drains pipes
`src/utils/git.ts:271-404` — `rev-parse`/`status`/`checkout`/`add`/`commit` lack the `GIT_TIMEOUT_MS` guard every other caller uses, and `add`/`commit` await `proc.exited` without consuming stdout/stderr: a hanging pre-commit hook or >64KB stderr stalls the whole run. **Fix:** route all through `gitWithTimeout` + drain.

#### BUG-24: ~~Porcelain rename misparse when old path is bare and contains ` -> `~~ ❌ FALSE (removed 2026-08-12)
`src/utils/porcelain.ts:217-238` — the arrow-split guard only handles *quoted* old paths; `>` is printable ASCII so `R  foo -> bar.txt -> baz.txt` splits at the first arrow → wrong path for `.nax/` structural restore → deletion committed while "restored" path no-ops. **Fix:** parse `-z` output, or bail (fail-safe) when >1 separator.

**Verification verdict:** **FALSE** — git *always* C-quotes space-containing paths in porcelain rename lines (space-quoting is inherent to the porcelain v1 rename format, independent of `core.quotePath`; verified empirically in a scratch repo, incl. `git -c core.quotePath=false status`). The cited unquoted input `R  foo -> bar.txt -> baz.txt` cannot be produced by git: it emits either `R  "foo -> bar.txt" -> baz.txt` (quoted-region walk at porcelain.ts:219-235 handles it correctly) or `R  "foo bar" -> baz.txt`. A bare old path containing ` -> ` necessarily contains spaces → always quoted. `splitRenameOldPath` is correct for every real git output; the finding is dropped.

#### BUG-25: Queue commands lost on crash; stale `.processing` never recovered
**Status:** ✅ fixed 2026-08-12 on `fix/bug-22-25-26-interaction-queues`
`src/execution/queue-handler.ts:48-116` — `readQueueFile` renames `.queue.txt` → `.processing`, and the stage deletes it later; death between the two loses PAUSE/ABORT/SKIP forever, and the leftover `.processing` is never re-ingested (next rename silently overwrites). **Fix:** recover `.processing` on read; truncate instead of rename.

#### BUG-26: `queue-writer` read-modify-write resurrects consumed commands
**Status:** ✅ fixed 2026-08-12 on `fix/bug-22-25-26-interaction-queues`
`src/utils/queue-writer.ts:63-69` — TUI reads content, runner renames-and-clears in between, TUI writes back old content + new command → already-applied SKIP/RETRY/PRIORITY delivered twice (double retry / re-skip). **Fix:** O_APPEND-style single write, or don't delete until the writer's write is observed.

#### BUG-27: `curator` JSONL parsing throws on truncated line (defeats its own crash-inspection purpose)
`src/commands/curator.ts:103-111` — `observations.jsonl` is written non-atomically (`plugins/builtin/curator/index.ts:95-97`); a crash leaves a partial last line and `nax curator status`/`dryrun` die with uncaught `JSON.parse`. **Fix:** per-line try/catch, skip invalid.

#### BUG-28: `nax status` crashes on schema-drifted `status.json` from an older run
`src/cli/status-features.ts:126-153` — `status.cost.spent` throws if `cost` missing, outside the try/catch → one stale feature kills the whole `Promise.all` status output. Also: `isPidAlive` on a recycled PID reports dead runs as "⚡ Running". **Fix:** optional-chain each field or schema-validate.

#### BUG-29: cost-aggregator `drain()` drops events recorded during the final write
`src/runtime/cost-aggregator.ts:344-374` — events landing in `_inFlightEvents` between splice and second write are never flushed; a later `drain()` returns early. In-memory totals diverge from the persisted audit trail. **Fix:** loop until empty, or set `_draining=false` after draining in-flight.

#### BUG-30: Semantic review: substring `"passed": false` anywhere in unparseable output → hard fail
`src/operations/semantic-review.ts:370` — after parse retries are exhausted, ANY garbage containing `"passed": false` (in an evidence string, quoted example) becomes a blocking failure; adversarial twin guards with a findings-array check (`adversarial-review.ts:458`), semantic does not — asymmetric. **Fix:** require the pattern at top-level object position.

#### BUG-31: Verdict coercion: `startsWith("VERIFIED")` approves "VERIFIED FAILED"; first `\d+/\d+` matches dates
`src/tdd/verdict-reader.ts:91-113` — (a) `"VERIFIED FAILED: 3 tests red"` → approved; (b) `"2024/05/13"` in the summary yields pass=2024/total=5 → negative fail counts; (c) `"PASSED"` fails the exact `"PASS"` equality. All three verified (2026-08-12); note the failures are largely *false-negative* (a date first-match under-reports pass counts), and the whole coercion path only affects the free-form fallback — the strict schema path requires boolean `approved` (verdict-reader.ts:39). **Fix:** anchor ratio regex; reject `VERIFIED*` containing FAIL/RED/NOT MET.

#### BUG-32: Judge selector: any non-empty verdict text = "passed"
**Status:** fixed 2026-08-12, PR #1553 (`judge.ts:34` only, per the Group 1 ruling — `synthesis.ts:36` intentionally left alone)
`src/debate/selectors/judge.ts:34` + `synthesis.ts:36` — the judge is asked for a verdict, but `output.trim() ? "passed" : "failed"` converts "None of the proposals are acceptable — reject" into a pass; judge debates can never fail closed. **Fix:** parse a machine-readable pass/fail token (`jsonMode: true`).

#### BUG-33: Debate plan selection's second patch-step is a no-op — runner-up patch feature lost (severity: LOW, amended 2026-08-12)
`src/debate/runner-plan-helpers.ts:295-307` — `finalizePlanSelection` re-runs `runPatchStep` with empty `patchPrompts` (`runner-plan-helpers.ts:300-307`), so the winner never receives the runner-up's AC-delta patch. Verified correction: `runPatchStep` (`verifier-pick.ts:119-127`) is declared `async` but awaits nothing — it is a **pure string builder** (`extractDistinctACs` + `PatchPromptBuilder`) and makes no LLM call and nothing is discarded except the patch feature itself (contrast the live path at `runner-plan-helpers.ts:192`). Original wording "second patch-step LLM call whose result is discarded" was wrong. **Fix:** gate the second `runPatchStep` on `patchPrompts.length > 0`.

#### BUG-34: TDD isolation checks blind to untracked files (the most common violation)
`src/tdd/isolation.ts:31-63` — `git diff --name-only <ref>` excludes untracked files; both isolation checks run before any commit, so a test-writer's new stub file or an implementer's new test file passes silently. **Fix:** merge `git status --porcelain` results.

#### BUG-35: Greenfield override not mirrored into `ctx.story.routing.testStrategy` — stale PRD persisted
`src/pipeline/stages/routing.ts:90-104,152-158` — after the greenfield forced switch to `tdd-simple`, `ctx.routing` says `tdd-simple` but `ctx.story.routing` and the saved PRD still say `three-session-tdd`. Escalation (`tier-escalation.ts:394,434`) and rectifier prompts read the stale value → wrong rectification semantics. **Fix:** re-apply override to `story.routing` and re-save.

#### BUG-36: Rectification pipeline persists shared PRD to stray `.nax/features/unknown/prd.json` + double-emits `story:completed`
`src/execution/merge-conflict-rectify.ts:155-175` + `parallel-batch.ts:350-363` — the rectification pipeline context lacks `skipPrdPersistence: true`/`prdPath`, so `completion.ts` writes to a fallback path and mutates the shared live PRD the single-writer contract (`unified-executor.ts:263`) forbids; it also re-emits `story:completed` (double-counted hooks/reporters). **Fix:** set `skipPrdPersistence: true` + `prdPath` on the rectification context.

#### BUG-37: Rectification agent spend excluded from batch `totalCost` (cost-limit fires late)
`src/execution/parallel-batch.ts:377-379` — batch total sums only worker `storyCosts`; the rectification pipeline's full run cost lands in `mergeConflicts[].cost` and never folds into the total → `costLimit` check at `unified-executor.ts:392` under-reports. Verified 2026-08-12: this is an accounting/metrics gap, not a limit bypass — the executor's limit check partially compensates via `ctx.runtime.costAggregator.snapshot().totalCostUsd` (rectification runs with the shared runtime, `merge-conflict-rectify.ts:171`). **Fix:** `totalCost += mergeConflicts.reduce((s, c) => s + c.cost, 0)`.

#### BUG-38: `shortCircuited` validate sweeps with empty findings exit the fix cycle as "resolved"
`src/findings/cycle.ts:531-559` — the full-validate path drops `normalizeValidateResult(fullRaw).shortCircuited` (cycle.ts:534; the lite path at cycle.ts:424-426,485-511 honors it); a timed-out/crashed gate re-run (`{success:false, findings:[]}`) classifies as `"resolved"` (cycle.ts:54-55) → false "resolved" metrics + lost repair budget. Verified 2026-08-12; mitigated in the common case by `acceptOnTimeout` defaulting to **true** (full-suite-gate.ts:273), so the false-resolved fires on `acceptOnTimeout:false` timeouts or failing phases with zero structured findings. **Fix:** route `shortCircuited` in the full path like the lite branch.

#### BUG-39: Failed-story retry unreachable in default batch mode
**Status:** ✅ fixed 2026-08-12, PR #1558
`src/execution/unified-executor.ts:411,507` — `lastStoryId` is only set when `!ctx.useBatch`; `getNextStory`'s retry-current-story branch requires it, so a transiently failed story is terminal in batch mode but retried in single mode. **Fix:** set `lastStoryId` unconditionally or carry the retry id in the batch selector.

**Resolution:** `lastStoryId` is populated unconditionally, and `resolveRetryCandidate` gives an eligible failed story priority before both planned-batch and independent-parallel selection.

#### BUG-40: `executeParallel` crashes the whole run on one malformed per-package config
`src/execution/parallel-coordinator.ts:194-205` — `Promise.all` on config loads; `parallel-batch.ts` deliberately uses `allSettled` for the identical load. Currently latent (documented as unused in production — grep confirms zero callers of the `execution/parallel` barrel in src/; verified 2026-08-12) but one refactor away from aborting a batch with stranded worktrees. **Fix:** mirror allSettled + warn-and-fallback.

**Decision implemented 2026-08-12:** delete the retired `executeParallel` coordinator and remove its barrel export. Production parallel execution already runs through `UnifiedExecutor` → `runParallelBatch`, whose per-package config loading uses `Promise.allSettled` with warn-and-fallback behavior.

#### BUG-41: `nax unlock` TOCTOU — can delete a *new* run's lock
`src/commands/unlock.ts:76-93` — liveness checked, then `Bun.spawn(["rm", lockPath])` — the PID is never re-checked before removal, and spawning `rm` breaks on PATHs without it. **Fix:** re-read the lock immediately before `fs.promises.unlink`; only delete if PID unchanged.

### 🟢 LOW

- **BUG-42:** `nax status` precheck stale-lock check trusts wall clock — sleep/NTP skew creates false blockers (`precheck/checks-config.ts:38-40`); cross-check with `mtime`.
- **BUG-43:** `session/manager-sweep.ts:23` — unparseable `lastActivityAt` → `NaN < cutoff` = false → session retained forever; treat NaN as expired. Verified 2026-08-12 — the sibling `scratch-purge.ts:80` guards `if (!lastActivityAt) continue;` before the same call, which `sweepOrphansImpl` lacks.
- **BUG-44:** `metrics/aggregator.ts:91` — `avgCost = totalCost / successes`; a model with 0 successes but real spend reports avgCost 0 (surfaced by `buildModelEfficiency`, `report.ts:150-159` — the `avgCost` field itself is at :157; the earlier `:152` citation pointed at the function's `return`). Use attempts.
- **BUG-45:** `utils/path-filters.ts:83-85` — `**` without flanking slashes compiles to `.*` crossing directory boundaries (`a**b` matches `a/x/b`); also backslash escapes lost in normalizePath.
- **BUG-46:** `utils/porcelain.ts:236` — ~~bare-path arrow split~~ **❌ FALSE (2026-08-12):** same reasoning as BUG-24 — git never emits an unquoted space-containing path in porcelain rename lines, so the quoted-region guard covers every real input (verified empirically). `utils/llm-json.ts:142-150` — first-`{`/last-`}` extraction without brace/string balancing **✅ confirmed**; prose braces or a `}` inside a JSON string mis-slices, and `JSON.parse` then fails → falls through to throw (`llm-json.ts:163`). Note: it fails rather than misparses (the original "can even accept the wrong object" is a narrower edge — a mis-slice that happens to be valid JSON). **Fix:** brace-balancing scanner; drop the porcelain half.
- **BUG-47:** `interaction/plugins/webhook.ts:348-352,466-472` — pending-response capacity drops return 200 OK to the caller (silent discard); return 429/503.
- **BUG-48:** `interaction/plugins/telegram-format.ts:130` — `callback_data` = `${request.id}:choose:${opt.key}` crosses Telegram's 64-byte limit with long trigger ids → 400 → whole send throws. Verified 2026-08-12 (line corrected — construction is at :130, not 45-72): latent — every in-repo option key fits. **Citation corrected 2026-08-12 (Rev 4):** the keys are `resume`/`skip`/`keep` (`paused-story-prompts.ts:60-62`) and `approve`/`abort` (`story-size-prompts.ts:81,83`) — the earlier note attributed all four to one file and omitted `keep`. All are ≤7 chars, so 34-char ids + 22+-char keys are needed to overflow. **Fix:** truncate keys or split callbacks.
- **BUG-49:** `agents/acp/stdout-line-reader.ts:38-43` — unbounded `remainder` buffering for newline-less/multi-MB lines (doubled memory).
- **BUG-50:** `interaction/plugins/webhook.ts:386-402` — if `Bun.serve` rejects, `serverStartPromise` stays rejected; plugin permanently broken until re-init. Null it in a catch.
- **BUG-51:** `config/loader.ts:315-334` — profile/CLI layers bypass the compat shims (`applyRemovedStrategyCompat` etc.) applied to file layers; `routing.strategy: "manual"` in a profile hard-fails instead of remapping.
- **BUG-52:** `agents/manager.ts:406,149-156` — agents marked unavailable on one failure, cleared only per-run; one transient rate-limit pins the run to fallback agents. **Fixed 2026-08-12:** transient unavailability is reset at terminal story/batch boundaries; authentication and quota failures remain unavailable for the run.
- **BUG-53:** `agents/acp/parser.ts:84-193` — JSON-RPC accepted only for `jsonrpc === "2.0"`; protocol drift falls into the legacy branch, silently corrupting `state.text`.
- **BUG-54:** `agents/acp/parser.ts:161-166` — partial usage objects fabricate `{0,0,...}` token usage → "$0.00" rows indistinguishable from free calls; return undefined.
- **BUG-55:** `plugins/loader.ts:449-475` — explicitly configured plugin that fails import/validate/setup is skipped, built-ins throw — inconsistent fail-fast. Amended 2026-08-12: the **validate-failure branch is silently skipped** (returns `null` with no log at all, loader.ts:431-434); import/setup failures are logged + skipped. A typo'd custom routing/reporter silently no-ops. **Fixed 2026-08-12:** explicitly configured plugins now fail fast; auto-discovered global/project plugins retain warn-and-skip behavior.
- **BUG-56:** `review/verdict-writer.ts:59-62` — story ids from hand-edited `prd.json` (re-validated nowhere) flow into `join(verdictDir, `${storyId}.json`)` — `../` escapes the verdict dir; validate ids. **Severity LOW (amended 2026-08-12):** `writeReviewVerdict` has zero production callers (only `test/unit/review/verdict-writer.test.ts`) — dead code — and `validateStoryId` (`prd/validate.ts:21-40`, enforced at schema.ts:82) already rejects `..`/slashes. Defense-in-depth gap, not an exploitable path today. (`featureName` is also unvalidated in the path, verdict-writer.ts:51-54.) **Resolved 2026-08-12:** deleted the dead writer and its isolated tests.
- **BUG-57:** `context/feature-context-filter.ts:53-64` — last `[...]` on a headline wins; a markdown link `[docs](url)` at headline end is parsed as an audience tag → entry excluded for every role.
- **BUG-58:** `prd/out-of-scope-extract.ts:241-250` — bare-marker loop swallows a second `**Out of scope:**` marker inside the block; items attributed to the wrong story.
- **BUG-59:** `pipeline/stages/completion.ts:186-203` — `git diff` spawn with no timeout (unlike every sibling); a hung git hangs run completion forever.
- **BUG-60:** `execution/parallel-batch.ts:340-342` — dependency-prep failure durations fall back to `batchEndMs`, contradicting the module's own design note (skews per-story duration metrics).
- **BUG-61:** `execution/unified-executor.ts:572-584` — cost-warning interaction trigger evaluated only in the single-story branch; parallel runs never get the 80% warning.

---

## Original Priority Fix Order

This table preserves the review-time ordering. It is historical: the numbered findings were subsequently resolved, rejected as false, or intentionally left unchanged as recorded in the status annotations and triage tables below.

| Priority | IDs | Effort | Description |
|:---|:---|:---|:---|
| P0 | BUG-03, BUG-07, BUG-08 | S/M | Rules corpus lost from empty frontmatter (precheck blocker); `git clean -fd` data loss; metrics history wipe race |
| P0 | BUG-01, BUG-02 | S | PRD dependency normalization + duplicate-id rejection (ordering/liveness correctness) |
| P1 | BUG-04, BUG-05, BUG-09 | M | Dead wiring: tier budgets, crash retry, auto plugin — configured behavior silently ignored |
| P1 | BUG-06, BUG-13, BUG-14, BUG-15 | S/M | False-green / phantom-failure verdict paths in verification and AC parsing |
| P1 | BUG-10, BUG-11, BUG-36, BUG-37 | S/M | Config merge depth, acceptance retry off-by-one, rectification bookkeeping |
| P2 | BUG-12, BUG-16 → BUG-35, BUG-38 → BUG-41 | M/L | Remaining medium findings (parsers, races, persistence) |
| P2 | BUG-42 → BUG-61 | S | Low-severity hardening batch |

> **Verification note (2026-08-12):** BUG-24 and the porcelain half of BUG-46 were verified **false** (git always C-quotes space-containing porcelain rename paths) and are excluded from the fix order; all other findings are confirmed against `0d92c460` as written or with the amended impact noted inline. Severity corrections: BUG-33 → LOW (no LLM call wasted), BUG-56 → LOW (dead code).

**Suggested follow-up:** after fixes land, re-run the isolated regex checks from BUG-03/13/14/17/31 as unit tests (they are all pure-string functions — cheap to pin). The proof harness (`docs/reviews/2026-08-11-latent-bugs-v2-proof.ts`) holds 31 assertions covering BUG-01/02/03/06/10/13/14/15/16/17/25/26/27/29/31/34/44/45/46/57/58; each `bugNN()` function can be lifted into the corresponding `test/unit/` file as a regression test by swapping `check(...)` for `expect(...).toEqual(...)` and **inverting the expected value** — the harness asserts the defect *reproduces*, whereas the regression test must assert it no longer does. Note the harness deliberately keeps two counter-examples (BUG-13's `TestACL2_Check`, BUG-46's brace-in-string) that assert correct behaviour and should carry over unchanged.

---

## Fix Triage: What Can Be Patched vs What Needs a Decision (2026-08-12, Rev 4)

The Priority Fix Order above ranks by *impact*. This section ranks by *who can act*. **41 of the 59 live findings are mechanical** — the fix is local, the correct behaviour is not in dispute, and the proof harness already pins the input. The remaining 18 split into two groups that a maintainer should not silently "fix".

### Group 1 — Needs a human decision (the correct behaviour is a product choice, not a bug)

| Finding | The decision | Why it can't be defaulted |
|:---|:---|:---|
| **BUG-04, BUG-05, BUG-09, BUG-40, BUG-52** | **Delete-or-wire.** Five findings are dead code, not broken code. For each: implement the wiring, or delete the feature *and* the config surface that advertises it. | Wiring BUG-04 makes per-tier budgets actually bind (5/3/2 instead of a flat sum of 10), so stories reach `powerful` **later** and fail **earlier** — a cost-vs-success-rate trade. Wiring BUG-09 is worse: `receive(requestId)` structurally cannot carry the request, which is *why* `auto.ts` throws — see Group 2. Deleting is equally legitimate and much cheaper. Someone must say which. |
| **BUG-07** | Scope the `git clean -fd`, or gate it behind a confirmation/config flag. | Narrowing the clean leaves agent-created files behind, which can poison the next iteration; blanket clean destroys user `.env`/WIP. Both are real failure modes — pick the one this product prefers. |
| **BUG-06** | Should a package with zero executed tests pass or fail? | Gating on `parsed.passed > 0` correctly kills the false green, but fails legitimately test-free changes (docs-only, config-only, helper-only Go packages). Needs a policy plus probably a config knob. |
| **BUG-11** | Does `acceptance.maxRetries: 3` mean 3 *attempts* or 3 *fixes*? | Fixing the off-by-one increases fix cycles — and cost — for every user on the default config. The fix and a default change should land together. |
| **BUG-30** | Should semantic review fail open or fail closed on unparseable output? | Mirroring adversarial's guard is the obvious mechanical move, but it changes a gate from fail-closed to fail-open. That is a safety posture, not a bug fix. |
| **BUG-32** | Define a machine-readable judge verdict. | The judge is *asked* for a verdict but graded on "is the output non-empty". Fixing means changing the debate prompt contract and its parsing together — a protocol change, not a predicate change. |
| **BUG-55, BUG-56** | Should a mis-configured plugin fail the run? Should dead `writeReviewVerdict` be deleted or hardened? | Both are one-line changes in either direction; the direction is the call. |

### Group 1 — Decisions taken (2026-08-12)

Rulings from the maintainer review of the table above. Undecided rows stay open.

| Finding | Ruling | Notes |
|:---|:---|:---|
| **BUG-07** | ~~**Snapshot-diff clean.** Capture `git status --porcelain` at phase start; on rollback delete only untracked paths that appeared since.~~ **Fixed 2026-08-12, PR #1553.** | Rejects both options as framed. Agent-created files all post-date the snapshot so they are still cleaned; the user's pre-existing `.env`/WIP predates it and survives. No config knob, no policy call. Implementation note: a null baseline (snapshot read failed) skips the untracked cleanup entirely rather than being coerced to "nothing pre-existed" — caught by a pre-merge code review. |
| **BUG-06** | ~~**Route to the full-suite rerun.** Treat exit-0-with-zero-tests as *inconclusive*, not as pass or fail — fall into the existing zero-test fallback at `verify-scoped.ts:216`.~~ **Fixed 2026-08-12, PR #1553.** | Docs-only and helper-only changes still pass via the full suite; a story whose tests silently didn't run is caught. Avoids the false green without failing legitimately test-free work. |
| **BUG-11** | ~~**`maxRetries` means fix cycles. Fix the off-by-one and keep the default at 3.**~~ **Fixed 2026-08-12, PR #1553** (`>=` → `>`). | Deliberate cost increase: every user on defaults gains a third acceptance fix round they don't get today, traded for a higher pass rate. The fix does **not** ship with a compensating default change. |
| **Parse-retry budget** | ~~**Make the review parse-retry attempt count configurable, default 3** (currently hardcoded `maxAttempts: 2` at `semantic-review.ts:329` and `adversarial-review.ts:224` — one initial call plus one corrective re-prompt).~~ **Fixed 2026-08-12, PR #1553** — new `review.parseRetryMaxAttempts` config field. | Taken with BUG-62's measurement on the record: raising the count does **not** address the dominant give-up cause (provider capacity errors, which retry immediately at `delayMs: 0` against an at-capacity model — that population is now handled separately by PR #1551's provider-refusal classification). It is a real improvement for the truncation population, which is the minority but the one where retries work. |
| **BUG-30, BUG-32** | **Deferred — do not change the gate.** | Superseded by BUG-62: the substring heuristic is correct on 16/16 measured cases, so `derivePhaseOutcome` (`run-phase.ts:410-416`) and `allPassed` (`runner.ts:492`) stay as they are. BUG-32's judge selector (`judge.ts:34`, any non-empty text = passed) is independently wrong and unaffected by that data — see the row below (fixed separately from this deferral). |
| **BUG-09** | ~~**Delete `auto.ts` and its config surface.**~~ **Fixed 2026-08-12, PR #1553.** | Evidence: across all 8 projects under `~/.nax/`, the only `interaction.plugin` value ever configured is `"telegram"` — `"auto"` has never been used. The feature is advertised, broken (`receive()` throws unconditionally), and unadopted. Deleting also removes the `IInteractionPlugin` signature change from Group 2, since that change existed only to serve this plugin. Auto-approval remains available via `interaction.defaults.fallback: "continue"`, which works today. |
| **BUG-32** | ~~**Fix `judge.ts:34` only. Leave `synthesis.ts:36` as it is.**~~ **Fixed 2026-08-12, PR #1553** — the judge prompt now requires a leading `JUDGE_VERDICT: ACCEPT\|REJECT` marker, parsed and stripped before the verdict is graded; fails closed if unparseable. Low priority — doubly latent. | The doc conflates two call sites. A judge is *asked for a verdict*, so grading it on "is the output non-empty" is wrong. A synthesis is asked to *produce a plan*, so "did we get output" is a defensible success predicate — no change needed there. Latency: `debate.enabled` defaults **false** (`schemas-debate.ts:112`) and is not enabled in any config on this machine; `judgeSelector` fires only for `resolver.type: "custom"` (`pick.ts:33`), while the shipped defaults are `synthesis` (plan) and `majority-fail-closed` (review). Reachable only if someone both enables debate and configures a custom resolver. |
| **BUG-04 + BUG-63** | ~~**Wire per-tier budgets with `fast:2, balanced:2, powerful:2`, and populate the escalation event's `from` field.**~~ **Fixed 2026-08-12, PR #1550.** | `preIterationTierCheck` is wired into sequential and parallel dispatch; escalation events record the source tier. |
| **BUG-05** | ~~**Wire runtime-crash classification into bounded same-tier retry.**~~ **Fixed 2026-08-12, PR #1550.** | `handlePipelineFailure` now supplies `runtimeCrashResult`; retries are capped at two before human review. |
| **BUG-40** | **Delete the retired coordinator. Implemented 2026-08-12.** | The active `runParallelBatch` path already provides the required `allSettled` fallback behavior. |
| **BUG-52** | **Reset transient failures at story/batch boundaries; preserve auth/quota failures for the run. Implemented 2026-08-12.** | Restores recovered providers without repeatedly retrying credentials or exhausted quota. |
| **BUG-55** | **Explicit config fails fast; auto-discovery warns and skips. Implemented 2026-08-12.** | Explicit entries express operator intent; discovery directories may legitimately contain unrelated or temporarily invalid files. |
| **BUG-56** | **Delete the dead verdict writer. Implemented 2026-08-12.** | No production callers or supported config surface justified retaining and hardening it. |

**BUG-04 analysis (measured 2026-08-12 over 1101 story verdicts + 110 escalation events in `~/.nax/*/runs/*/observations.jsonl`).**

Attempt distribution across every recorded story verdict:

| attempts | 0 | 1 | 2 | 3 | 4 | 5+ |
|:---|---:|---:|---:|---:|---:|---:|
| stories | 132 | 865 | 90 | 10 | 4 | **0** |

**No story has ever reached 5 attempts** — the `fast` rung's configured budget. 78.6% succeed on the first attempt and only 14 stories (1.3%) ever exceed two. Escalation is correspondingly eager: 97 distinct stories escalated, 86 of them exactly once.

The consequence is that wiring the budgets *as currently configured* would make things worse, not better. A binding 5-attempt `fast` rung would add up to four extra iterations at the weakest tier for stories that today escalate after one failure — and the July-2026 baseline already attributes 31.5% of fix iterations to waste. The shipped `5/3/2` numbers were never validated against behaviour because they have never been in force. Wiring them is not "restoring intended behaviour"; it is enabling an untested configuration.

`2/2/2` makes the ladder actually bind (today it does not bind at all) without inflating low-value retries at `fast`, and it is consistent with the observed distribution — a story that has failed twice at a tier has, empirically, near-zero chance of succeeding at attempt 3+ on that same tier.

#### BUG-63: escalation telemetry records `from: ""` — the tier ladder cannot be audited
**Severity:** MEDIUM | **Category:** Observability | **Status:** ✅ fixed 2026-08-12, PR #1550
Every one of the 110 recorded escalation events carries an empty `from`:
```json
{"kind":"escalation","payload":{"from":"","to":"powerful"}}
```
60 escalations land on `powerful` and 50 on `balanced`, but with `from` unpopulated it is impossible to distinguish a story that *skipped* a rung (`fast` → `powerful`, the BUG-04 defect) from one that legitimately started mid-ladder (a `medium`-classified story starting at `balanced` and escalating once). Of the 58 distinct stories that reached `powerful`, 47 have no accompanying `balanced` event — consistent with rung-skipping, but not provable without `from`.
**Risk:** The most expensive routing decision in the system is unauditable. BUG-04's fix cannot be verified after it ships.
**Fix:** Populate `from` with the pre-escalation tier at the emit site. Prerequisite for validating BUG-04.
**Proof (DATA):** `grep '"kind":"escalation"' ~/.nax/*/runs/*/observations.jsonl` → 110 events, `"from":""` on all 110.

**Resolution:** both pre-iteration budget escalation and post-failure tier escalation emit `story:escalated` with `fromTier` set to the pre-escalation tier.

### Group 2 — Needs an architecture change (a local patch moves the bug rather than fixing it)

| Finding | Why a local patch is insufficient |
|:---|:---|
| **BUG-08** | ~~The real fix is the storage format: atomic `tmp`+`rename`, or a JSONL append store. Either changes the on-disk contract every reader depends on (`nax metrics`, aggregator, report) and needs a migration for existing `metrics.json`.~~ **Fixed 2026-08-12, PR #1555** — see "Fix Status" below. User took the smaller of the two options (atomic `tmp`+`rename`, not the JSONL rewrite) — no on-disk format change, no migration needed. |
| **BUG-25 + BUG-26** | ~~These are **one** defect, not two: the queue file has no ownership protocol between the TUI writer and the runner consumer. Patching either side alone just relocates the race. Needs an append-only or lock-based protocol with crash recovery for the orphaned `.processing` file.~~ **Fixed 2026-08-12** on `fix/bug-22-25-26-interaction-queues`: append-only writes and reader/writer ownership locking, with orphaned `.processing` recovery. |
| **BUG-09** | ~~Wiring `decide()` requires an interaction protocol change.~~ **Resolved 2026-08-12, PR #1553:** the unused `auto.ts` plugin and its config surface were deleted instead. |
| **BUG-22** | ~~"Single poller, fan-out to callbacks" restructures the Telegram plugin from per-request polling to a shared poller with a subscription registry.~~ **Fixed 2026-08-12** on `fix/bug-22-25-26-interaction-queues`: one poller dispatches updates through a pending-receiver registry. |
| **BUG-36 + BUG-37** | ~~The rectification pipeline borrows the story pipeline's context without its worktree contract (`skipPrdPersistence`, `prdPath`, cost attribution, event emission). Setting the three missing fields fixes today's symptoms; the durable fix is a first-class rectification context type so the next field added to the story contract isn't silently missed again.~~ **Fixed 2026-08-12, PR #1559** — see "Fix Status" below. Landed the durable version: reuses the worker's own context-builder (`buildWorktreePipelineContext`) over the worker's own context object, rather than a hand-rolled parallel type. |
| **BUG-19** | ~~The cache belongs on the runtime, scoped to the run.~~ **Fixed 2026-08-12, PR #1557:** `NaxRuntime.routingCache` is fresh for every runtime. |
| **BUG-20** | ~~Mapping `AGENT_TIMEOUT`/spawn errors to retriable outcomes touches the adapter failure taxonomy shared by the `run()` and `complete()` paths. Done carelessly it makes genuinely fatal errors retry forever.~~ **Fixed 2026-08-12, PR #1551** — see "Fix Status" below. Turned out narrower than the Group-2 framing implied: BUG-62's actual mechanism (a provider refusal returned as ordinary run-kind turn output, not a thrown exception) lives entirely in `callOp`/`makeParseRetryStrategy`, not in the shared adapter-failure taxonomy, so the two fixed independently without touching `run()`'s taxonomy at all. |
| **BUG-39** | ~~The batch selector needs a channel to carry retry state.~~ **Fixed 2026-08-12, PR #1558:** `resolveRetryCandidate` preempts both batch selection paths and `lastStoryId` is maintained in every mode. |

### Group 3 — Mechanical (patch directly; the harness already pins each input)

BUG-01, BUG-02, BUG-03, BUG-10, BUG-12, BUG-13, BUG-14, BUG-15, BUG-16, BUG-17, BUG-18, BUG-21, BUG-23, BUG-27, BUG-28, BUG-29, BUG-31, BUG-33, BUG-34, BUG-35, BUG-38, BUG-41, BUG-42, BUG-43, BUG-44, BUG-45, BUG-46, BUG-47, BUG-48, BUG-49, BUG-50, BUG-51, BUG-53, BUG-54, BUG-57, BUG-58, BUG-59, BUG-60, BUG-61.

Two caveats inside this group: **BUG-29**'s loop-until-empty fix is local, but `snapshot()` semantics after `drain()` should be settled at the same time (it currently reports only post-drain arrivals). **BUG-51**'s fix touches config layering order, so it warrants a layering test rather than a spot patch.

---

## Fix Status (2026-08-12)

All 39 Group 3 (mechanical) findings above are **fixed** on branch `fix/20260811-bugs`, verified by `bun x tsc --noEmit` (clean), `bun run lint` (clean — biome, deep-relative-import/alias-internal/file-size/nax-error ratchets all hold), the full test suite (`bun run test`: 12596 unit + 1102 integration + 24 UI, 0 failures), and the proof harness (`bun docs/reviews/2026-08-11-latent-bugs-v2-proof.ts`: 32/32 assertions pass — expectations updated in place from "reproduces the bug" to "reproduces the fix"). The Group 1 and Group 2 findings were resolved in follow-up PRs recorded in the tables above. BUG-30 remains an intentional no-change decision rather than a pending fix. The separate post-review follow-ups listed below are not numbered findings.

**Two regressions were caught and corrected before merge, both worth recording as lessons:**

- **BUG-38** (`src/findings/cycle.ts`): the first-pass fix exited the entire fix-cycle retry loop on *any* `shortCircuited=true` validate result. That flag is also set on every ordinary mid-cycle iteration where a phase fails and the cycle is expected to keep retrying — so the first-pass fix broke 19 rectification-budget tests (dispatch counts collapsing from the configured cap to 1). Corrected to only intercept when the outcome would otherwise misclassify as `"resolved"` — proven exact via `classifyOutcome`: `findingsAfter.length === 0` is necessary and sufficient for a `"resolved"` outcome, so gating on `outcome === "resolved" && fullShortCircuited` catches precisely the false-green case this bug describes and nothing else.
- **BUG-42** (`src/precheck/checks-config.ts`): the first-pass fix took `Math.min` of two elapsed-time signals (recorded timestamp, file mtime) to guard against clock skew — but both signals are `Date.now()`-derived, so a clock jump corrupts them identically and `Math.min` is a no-op on every real code path (the lock file is written once, never touched again, so the two readings are already equal). Where the two genuinely diverge (an external `git checkout`/restore touching the lock file), the fix actively introduced a **false negative**: a 3-hour-old lock from a dead process would read as fresh, blocking `nax run` behind a phantom lock in a Tier-1 blocker check. A post-fix code review caught this before merge (flagged by the tell that two passing tests needed `utimesSync` backdating to keep working — the signature of a weakened detector) and it was corrected to use PID liveness (`process.kill(pid, 0)`) as the authoritative signal, with elapsed time only as a backstop for a dead-but-recycled PID.

**A post-fix independent code review** (`code-reviewer` agent, standard-depth, scope = the full diff) additionally found and fixed, before merge:

| Bug | Issue | Fix |
|:---|:---|:---|
| BUG-13 | Go anchor `^--- FAIL:` dropped every **indented** subtest failure (Go nests subtest failure lines) | Anchor widened to `^\s*--- FAIL:` |
| BUG-14 | Log-noise exclusion lookbehind `(?<!\b[A-Za-z]+:\s)` excluded *any* `Word: N fail`, including real Jest/vitest summary lines like `"Tests: 3 failed"` | Narrowed to actual log-level prefixes (warn/info/debug/error/etc.) |
| BUG-17 | New `$`-anchored `(fail)` regex broke on CRLF output (trailing `\r` after `split("\n")`) | `$` → `\s*$` |
| BUG-23 | `git.ts` timeout-path drain promises were unawaited without a `.catch()` — a SIGKILLed process erroring its pipes could surface as an unhandled rejection | Eager `.catch(() => "")` attached |
| BUG-31 | Ratio regex `(?:pass\|PASS)` didn't recognize the FAIL side of a ratio (`"42/45 FAIL"`), so a summary contradicting an approving verdict silently reported `failCount 0` | Widened to `(?:pass\|fail)` |
| BUG-42 | See above — merge-blocking, corrected to PID liveness | |
| BUG-43 | The `manager-sweep.ts` NaN guard (`if (!session.lastActivityAt) continue`) was a no-op — `continue` and falling through to `NaN < cutoff` both retain the session, so the fix changed nothing for the case it was written for (a *truthy-but-unparseable* timestamp) | Rewritten to treat any non-finite parsed timestamp as expired |
| BUG-45 | (style) a literal raw NUL byte in `path-filters.ts` made the file report as binary to `file`/`git diff`/`grep` | Replaced with `" "` escape |
| BUG-48 | Prefix truncation of `request.id` for Telegram's 64-byte `callback_data` limit strips the trailing UUID first — i.e. exactly the entropy — so two same-trigger prompts in the same window could truncate to an identical id and collide, re-opening BUG-34's cross-prompt mixup on approve/reject/**abort** buttons | Switched to a SHA-256 hash of the id instead of a prefix, so truncation can no longer destroy uniqueness |
| BUG-53 | Protocol-drift guard returned `undefined` without setting `state.error`, so a version-drifted acpx would read as a *successful empty turn* instead of a failure | `state.error ??= "Unsupported acpx JSON-RPC protocol version"` before the early return |
| n/a | `rules-frontmatter.ts` empty-block probe `/^---\r?\n---\r?\n?/` also matched the first 6 chars of a doc whose second line was a longer dash rule (`"---\n------\nbody"`), silently truncating the body | Tightened to require a real line end after the closing `---` |
| n/a | `completion.ts`'s new `GIT_TIMEOUT_MS` guard called `clearTimeout` after the `await`, so a throwing read leaked the timer | Moved into `finally` |
| n/a | `parseLLMJson`'s brace-balancing candidate scan was unbounded — O(n·k) on adversarial/malformed LLM output on the retry-storm path | Capped at `MAX_JSON_CANDIDATES = 50` |
| n/a | `CostAggregator.drain()`'s write-until-empty loop (BUG-29) had no iteration ceiling | Added `MAX_DRAIN_PASSES = 20` with a warn log if hit; added a regression test pinning that `snapshot()` reflects the full total after drain, not zero |
| n/a | `autoCommitIfDirty`'s `git add -A` / `git commit` (BUG-23's `gitWithTimeout` routing) inherited the default 10s timeout, which a large monorepo's `git add -A` can exceed — a timeout was silently swallowed, leaving the tree dirty | Given an explicit 30s budget (`AUTO_COMMIT_GIT_TIMEOUT_MS`) and now logs on non-zero exit instead of discarding it |

Remaining open items from that review (not merge-blocking, tracked as follow-ups): `src/agents/acp/parser.ts`'s legacy-branch `id`+object-`error` overlap with JSON-RPC error shape (worth confirming against acpx's legacy emitter); Telegram `callback_data` keys containing `:` desync build/parse (fails closed, but silently — validate at `buildKeyboard`); config compat-shim deprecation warnings now fire once per layer (up to 3×) instead of once — dedupe the warning sink; `truncateUtf8Bytes` is O(n²) per truncation (irrelevant at id-length sizes, would matter if reused for longer strings); `readAndParseLines`/`MAX_BUFFERED_LINE_BYTES` are now public barrel exports purely so a test could reach them through `@/agents` — consider tagging `@internal`.

**All five actioned 2026-08-12** (branch `fix/1560-followups`). Each was reproduced by a failing test before being fixed:

| Item | Finding on re-check | Resolution |
|:---|:---|:---|
| acp `parser.ts` error-shape overlap | **Real defect, worse than filed.** The drift guard's `id` + object-`error` disjunct stole a shape the legacy branch *already handles correctly* (`parser.ts:262-265` reads `event.error.message`), so a legacy error response carrying an id had its real failure reason (`"model not available"`) replaced by `"Unsupported acpx JSON-RPC protocol version"` — destroying the caller's only diagnostic. No acpx-emitter confirmation was needed: the legacy branch's own object-`error` handler is the proof that shape is representable | Narrowed the guard to object-`result` only (the sole shape the legacy branch genuinely cannot represent — it requires a *string* result). A drifted JSON-RPC error now falls through to the same legacy handler and still surfaces its message, so the guard loses nothing |
| Telegram `:` desync | Confirmed, and it is **two** defects, not one. `parseUpdate` took `parts[2]` as the value, truncating any option key containing `:`; and a `:` in `request.id` makes `parts[0]` unrecoverable outright | Split by what is fixable: the parse side now rejoins `parts.slice(2).join(":")` so multi-segment option keys round-trip intact; `buildCallbackData` throws `INTERACTION_INVALID_REQUEST_ID` for an id containing `:`, since that one can never round-trip and previously produced buttons that could only resolve by timeout. No in-repo option key or id contains `:` today, so this was latent |
| Compat-shim warning dedupe | Confirmed — and it is **4×**, not the 3× filed. `applyConfigCompatShims` has four call sites (global, project, profile, CLI), all reachable | `createConfigWarnDedupe()` — one dedupe per `loadConfig` call, shared by both shim styles (the `(msg) => void` sink and the `Logger` sink) so a key warned via one is not re-warned via the other. Threaded a `warn` sink through the two shims that lacked one. Scoped per load, so a later load warns again |
| `truncateUtf8Bytes` O(n²) | Confirmed and measured: 500k chars took **2288 ms** | Rewritten to encode once, cut at the byte budget, and walk back off UTF-8 continuation bytes (≤3 steps). The regression test bounds the same input at 500 ms |
| `@internal` barrel exports | Confirmed as filed | Tagged at the definition site and at both re-export sites (`src/agents/acp/index.ts`, `src/agents/index.ts`) |

One structural consequence: `loader.ts` crossed the 600-line limit, so the whole compat-shim chain moved to `src/config/compat-shims.ts` (loader keeps layering and file I/O). The two test files that reached the shims through `loader` now import them from their real home.

**Quality review of the above (`post-impl-review --phase quality`, 2026-08-12): 3 MEDIUM, all actioned.** Two were regressions the follow-ups themselves introduced; one was a pre-existing gap the narrowing made reachable.

| Finding | Verdict on re-check | Resolution |
|:---|:---|:---|
| Narrowing the drift guard drops `retryable` / `acpxCode` for a drifted JSON-RPC error | **Half right — the mechanism is real, the stated cost is not.** The reviewer claimed the change "now misclassifies" a retriable failure as terminal. It does not: the pre-change guard `return`ed *before* touching `state.retryable`, so that flag was `false` on this path both before and after — no regression, and the change still strictly improves the message. Its first proposed fix (revert the guard) would have reinstated the original bug. But the residual gap is genuine: the legacy branch never read `error.data`, and narrowing made that branch reachable for id-bearing errors | Took the reviewer's *second* option — the legacy error branch now mirrors the JSON-RPC one (`acpxCode`/`detailCode` suffix, `retryable`, first-error-wins). Corrected the overclaiming "nothing is lost" comment |
| Warning dedupe keys on message text only, dropping differing `data` | **Confirmed — a real regression introduced by the dedupe.** Several shims emit fixed message text with the offending value in `data` (`{ legacyPattern }`, `{ value: modelTier }`), so two layers configured with *different* values collapsed to one warning and the second value was never shown | Dedupe key is now message + serialised `data`, so genuine repeats still collapse but a differing payload still surfaces |
| `buildCallbackData`'s throw is un-catchable in the send path | **Confirmed.** `buildKeyboard` is called at `telegram.ts:154`, outside the `try`, and `InteractionChain.send()` has no catch — the fallback cascade exists only on `receive()`. The fix traded a silent desync for a hard crash, where every other interaction failure degrades to `request.fallback` | `send()` catches it, logs the cause, and posts the prompt without buttons — loud in the log, still resolvable via `fallback`. Pushed `telegram.ts` over 600 lines, so config validation + Bot API wire types moved to `src/interaction/plugins/telegram-config.ts` |

**PR:** branch `fix/20260811-bugs` → `main`.

### BUG-20 / BUG-62 — fixed 2026-08-12, PR #1551 (merged)

Shipped as a follow-up, separately from the Group 3 batch above (Group 1/2 items are triaged individually, not batched).

- **BUG-20**: `AgentManager.completeWithFallback`'s catch site (`manager.ts:503-515`) now calls a new `classifyCompleteException` (`src/agents/complete-exception-classifier.ts`) instead of hardcoding `fail-unknown/retriable:false` for every thrown exception. Reuses `parseAgentError` for structured errors (auth/rate-limit/model-not-available/timeout/crash) and adds an `AGENT_TIMEOUT` NaxError-code case. Result: a thrown auth or rate-limit error now correctly reaches `shouldSwap`'s availability branch instead of being terminal. Note the fix is narrower than the original Group-2 framing assumed — `completeWithFallback` has no rate-limit backoff path at all (`_retryStrategy` is only consulted from `runWithFallback`), so a `fail-rate-limit` classification unlocks agent swap but not same-agent backoff; without a swap candidate configured, a rate-limited complete-kind op is still terminal.
- **BUG-62**: new `classifyProviderRefusalFailure` (`src/operations/turn-failure-classification.ts`, next to its sibling `classifyEmptyOutputFailure`) detects the measured provider-refusal literal in non-empty turn output inside `callOp`'s `sendWithFileOutput`, and `makeParseRetryStrategy` (`src/agents/retry/parse-retry.ts`) now short-circuits past the wasted "reformat as JSON" retry attempt when a turn already carries a classified `adapterFailure` — while still invoking the op's `exhaustedFallback` so strict-parser ops (e.g. `adversarialReviewOp`) get their declared fail-open value rather than callOp's raw-`TurnResult` last-resort passthrough. Deliberately does **not** touch `op.parse`'s own `"passed": false` regex gate (BUG-30) — that gate's fail-open/fail-closed policy question is still open per the Group 1 ruling above; this fix only changes what happens *before* a refusal reaches that gate (routes it through manager-tier backoff/swap first).
- A `code-reviewer` pass on the first draft of this fix caught two real bugs before merge: the parse-retry short-circuit initially dropped `exhaustedFallback` entirely (would have let a strict-parser op with no `op.recover` silently return an untyped raw `TurnResult` as its output — the "Strict-parser interaction" failure mode `.claude/rules/retry-strategy.md` exists to prevent), and the refusal regex was initially unanchored and unbounded (would have misclassified a genuine review verdict that quotes the refusal phrase as finding evidence, or an implementer summary that happens to mention it). Both fixed before merge: anchored to the start of the trimmed output, length-capped, and rejected outright when the output parses as valid LLM JSON.
- Verified: `bun x tsc --noEmit` clean, `bun run lint` clean, full suite green (12653 unit + 1102 integration + 24 UI, 0 failures).

**PR:** `fix/bug-20-62-retriable-failures` → `main` (#1551, merged `5f2db96f`).

---

### BUG-06 / BUG-07 / BUG-09 / BUG-11 / BUG-32 + parse-retry budget — fixed 2026-08-12, PR #1553 (merged)

Six Group 1 rulings (table above) shipped together as one batch.

- **BUG-06**: `verify-scoped.ts`'s zero-test-rerun guard dropped its `!result.success` requirement — a scoped run that exits 0 while executing nothing is now routed into the same full-suite fallback as the failing case, rather than reported as a false-green pass.
- **BUG-07**: new `getUntrackedPaths`/`parsePorcelainUntrackedPaths` (`src/utils/git.ts`, `src/utils/porcelain.ts`) snapshot untracked paths at TDD phase start (`execution.ts`, alongside `initialRef`) and again at `captureSnapshotRef` (ADR-024 non-blocking-fix path, after `autoCommitIfDirty`). `rollbackToRef` now diffs the before/after snapshots and deletes only paths that appeared since, instead of `git clean -fd`.
- **BUG-09**: deleted `AutoInteractionPlugin`, `autoApproveOp`, and the dead `"auto-approver"` `OneShotPromptBuilder` role. `interaction/init.ts` throws `INTERACTION_PLUGIN_REMOVED` with a migration hint (`interaction.defaults.fallback: "continue"`) for `plugin: "auto"`.
- **BUG-11**: the acceptance retry-budget check in `acceptance-loop.ts` changed `acceptanceRetries >= maxRetries` to `> maxRetries` — the retry whose count just reached the budget now still runs its own fix cycle.
- **BUG-32**: `judge.ts` now requires and parses a leading `JUDGE_VERDICT: ACCEPT|REJECT` marker (added to the prompt in `debate-builder.ts`), strips it from the returned output, and fails closed when the marker is missing or unparseable. `synthesis.ts:36` deliberately left untouched per the ruling.
- **Parse-retry budget**: new `review.parseRetryMaxAttempts` config field (default 3, was hardcoded `maxAttempts: 2` in both `semantic-review.ts` and `adversarial-review.ts`). Required updating two places that must stay in sync by convention, not by type-sharing: the Zod schema (`schemas-review.ts`) and the hand-maintained `ReviewConfig` interface (`src/review/types.ts`) that `NaxConfig.review` is actually typed as.
- A pre-merge `code-reviewer` pass caught a **critical regression** in the BUG-07 fix: `getUntrackedPaths` returning `[]` on git failure/timeout (instead of signaling "unknown") would, at snapshot time, make an unreadable baseline look like an empty one — so a later rollback would treat every currently-untracked file as "appeared since the phase started" and delete it, reintroducing BUG-07's exact data-loss failure mode through the very code meant to fix it. Corrected: `getUntrackedPaths` returns `null` on failure, and both `rollbackToRef` and `captureSnapshotRef` treat `null` as "skip the untracked cleanup" — never as "nothing pre-existed". The same pass also caught that `git status --porcelain` paths are always repo-root-relative, not `cwd`-relative, so joining them onto `workdir` directly silently no-ops in a monorepo package subdirectory; `rollbackToRef` now resolves against `getGitRoot()` instead. Also widened the BUG-32 verdict regex to tolerate markdown decoration (bold, code fences) and a short preamble, and added a word boundary so `JUDGE_VERDICT: ACCEPTED` doesn't match `ACCEPT`.
- Verified: `bun x tsc --noEmit` clean, `bun run lint` clean (test-typecheck and test-as-unknown-as ratchets both improved), full suite green (12645 unit + 1102 integration + 24 UI, 0 failures).

**PR:** `fix/latent-bugs-v2-group3-batch2` → `main` (#1553, merged `20a6602f`).

---

### BUG-08 — fixed 2026-08-12, PR #1555 (merged)

First of the Group 2 (architecture-change) findings to ship, taken alone rather than batched — Group 1/2 items are triaged individually, not batched, matching the BUG-20/BUG-62 precedent.

- `saveJsonFile()` (`src/utils/json-file.ts`) previously wrote via `Bun.write(path, json)`, which truncates the destination in place. A concurrent `loadJsonFile()` call from another process (e.g. two parallel `nax` runs sharing `projectOutputDir`) could observe a torn/partial write, fail to parse it, and return `null` — which `src/metrics/tracker.ts` (and the other two callers, `src/cli/routing-calibrate.ts` and `src/prd/index.ts`) coerced into "no prior history", silently wiping accumulated history on the next write.
- Fix: `saveJsonFile()` now writes to a sibling `<path>.tmp-<uuid>` file, then `rename()`s it over the destination — the same pattern already used by `src/plugins/builtin/curator/rollup-prune.ts`. A reader always observes either the fully-written old content or the fully-written new content, never a torn write. Scoped narrowly per the user's explicit choice between the two options the review posed: atomic `tmp`+`rename` (no on-disk format change, no migration), not a JSONL append-store rewrite. Documented as *not* eliminating the read-modify-write race between two concurrent appenders — both can still read the same prior array and one write can still lose the other's entry — only the torn-read/history-wipe failure mode.
- A pre-merge `code-reviewer` pass caught that the first draft's regression test raced writer and reader in the *same process*, which can never observe a torn write regardless of atomicity (same-process writes complete as one microtask-scheduled unit) — it passed unchanged against the pre-fix code, so it gave zero real coverage. Corrected to a genuine cross-process test: a spawned subprocess (`test/fixtures/json-file-writer.ts`) hammers the same path while the test process polls `loadJsonFile`, asserting zero torn/null reads — verified to fail against the pre-fix `Bun.write`-in-place implementation (2 torn reads) and pass against the fix.
- Verified: `bun x tsc --noEmit` clean, `bun run lint` clean, full suite green (12649 unit + 1102 integration + 24 UI, 0 failures).

**PR:** `fix/bug-08-metrics-atomic-write` → `main` (#1555, merged `2c0839b0`).

---

### BUG-36 + BUG-37 — fixed 2026-08-12, PR #1559 (open)

Second of the Group 2 (architecture-change) findings to ship, taken together since both symptoms trace to the same root cause: the rectification re-run borrowing the story pipeline's context without its worktree contract.

- `merge-conflict-rectify.ts` built its own `PipelineContext` for the post-conflict re-run by hand, independently of `parallel-worker.ts`'s `buildWorktreePipelineContext` — so it silently diverged from the worker's context: no `skipPrdPersistence`/`prdPath` (mutating the shared live PRD and writing to a stray `.nax/features/unknown/prd.json` since `featureDir` was hardcoded `undefined`), and an unconditional second `story:completed` emit for a story whose original worktree pass had already emitted it once before the conflict was found (double-counted hooks/reporters).
- `parallel-batch.ts`'s `totalCost` summed only `storyCosts` (the pre-conflict first pass), never folding in `mergeConflicts[].cost` (the rectification agent's own re-run spend), under-reporting batch spend against `costLimit`.
- Fix: the durable version of "set the three missing fields" from the Group 2 triage table — `rectifyConflictedStory` now builds its context via the same `buildWorktreePipelineContext(pipelineContextBase, story)` the worker calls, over the identical `pipelineContext` object the worker ran with (`pipelineContextBase`, threaded from both the parallel-batch and the sequential single-story worktree-isolation call site), plus rectification-specific overrides. A new `skipCompletionEvents` context flag suppresses the duplicate `story:completed` emit (and the equivalent duplicate `appendProgress` "passed" line) without touching the worker's own first-pass emit. `totalCost` now folds in `mergeConflicts[].cost`, and so do the per-story metrics for a rectified conflict (same gap, one layer up).
- A pre-merge `code-reviewer` pass caught a **critical regression** in the first draft: adding `prdPath` to the *shared* worktree pipeline base (needed so rectification's clone carries it) meant `routing.ts`'s `savePRD` call — unconditional on `prdPath` presence, not gated on `skipPrdPersistence` — now fired for every concurrent parallel worker on ordinary (non-conflicted) runs too, reintroducing the exact shared-PRD race the fix was meant to close. Corrected by gating both `routing.ts` `savePRD` call sites on `skipPrdPersistence`, matching `completion.ts`'s existing guard. The same pass also caught that the sequential rectification path lacked `skipPrdPersistence` entirely, so its completion stage would persist a stale `structuredClone` of the PRD over the real `prd.json` instead of letting the caller (`pipeline-result-handler.ts`, already the single writer via its own `prdDirty: true` contract) persist the live object — fixed by setting `skipPrdPersistence` there too. The review also flagged that the first draft's regression tests only proved a reference was forwarded (`pipelineContextBase === ctx.pipelineContext`), not that the constructed context was correct — a `buildRectificationPipelineContext()` pure function was extracted so the actual built context's `skipPrdPersistence`/`prdPath`/`featureDir`/`skipCompletionEvents` fields could be asserted directly.
- Verified: `bun x tsc --noEmit` clean, `bun run lint` clean (file-size, deep-relative, test-typecheck ratchets all hold or improved), full suite green (12683 unit + 1140 integration + 24 UI, 0 failures).

**PR:** `fix/bug-36-37-rectification-context` → `main` (#1559, open).

---

## Appendix A — Proof & Evidence (2026-08-12)

Proof kinds: **EXEC** = reproduced by running the real production module (see `docs/reviews/2026-08-11-latent-bugs-v2-proof.ts`); **GRAPH** = knowledge-graph call trace (zero callers / in-degree 0, cross-checked by grep); **SRC** = call-site/source trace at the cited lines; **GIT** = empirical git experiment in a scratch repo.

**How to read EXEC rows.** Each is an assertion in the harness with a hardcoded expected value, not a printed observation. `bun docs/reviews/2026-08-11-latent-bugs-v2-proof.ts` exits 0 only if all 31 reproduce; if a fix lands and a defect stops reproducing, the corresponding row fails loudly. Three rows below (BUG-26, BUG-34, BUG-44) were asserted but **not** executed in Rev 2 — the harness crashed before reaching them — and were first genuinely executed in Rev 3. Findings with no EXEC row are not reproducible from a pure function or an injectable-dep boundary; they are proved by GRAPH/SRC/GIT instead, and that is a weaker standard — a dead-wiring finding proves the call graph, not the user-visible consequence.

### Executed proofs (real modules, real inputs — 31 assertions, all passing on `0d92c460`)

| BUG | Proof | Evidence (harness line) |
|:--|:--|:--|
| BUG-01 | EXEC | `validatePlanOutput` with `dependencies:["ST001"]` passes; stored dep `"ST001"`, `storyIds={ST-001,ST-002}`, `matched=false` |
| BUG-02 | EXEC | duplicate `ST-001` x2 passes validation; stories `ST-001,ST-001` |
| BUG-03 | EXEC | `parseFrontmatter("---\n---\n")` → throws `RulesFrontmatterError`; `---\n\n---\n` parses fine |
| BUG-06 | EXEC | `verifyScopedOp` (injected `regression`: exit 0, `[no test files]`) → `{success:true, status:"passed", passCount:0}` |
| BUG-10 | EXEC | `mergePackageConfig` with `models.claude.fast` override → claude tiers: `fast` only (balanced/powerful dropped); gemini untouched |
| BUG-13 | EXEC | `TestACL2_Check` → `[]`; `TestMac_2` / `TestMac2` / `test_mac_2` → `["AC-2"]` (all 3 branches) |
| BUG-14 | EXEC | `analyzeTestExitCode("WARN: 3 failed requests", 0)` → `failCount:3, allTestsPassed:false, isEnvironmentalFailure:false` |
| BUG-15 | EXEC | `parseMochaOutput("spec1: 0 passing\nspec2: 5 passing, 1 failing")` → `{passed:0, failed:1}` (first match wins) |
| BUG-16/17 | EXEC | `.test.tsx` header → `file:"unknown"`; `(fail) render [5ms] timeout handling [1.2ms]` → name `render` |
| BUG-25 | EXEC | crash between rename and clear: `PAUSE` read, `.processing` orphaned; next `readQueueFile` overwrites it — `PAUSE` lost, `SKIP` delivered |
| BUG-26 | EXEC | real `writeQueueCommand(PAUSE)` with the consumer (`readQueueFile` + `clearQueueFile`) interleaved inside its read-modify-write window → file ends `SKIP US-001`, `PAUSE`: the already-consumed SKIP is resurrected |
| BUG-27 | EXEC | `curatorStatus` on truncated `observations.jsonl` → `SyntaxError: JSON Parse error: Expected '}'` |
| BUG-29 | EXEC | 3 events recorded (gated writes); one lands during drain's final write → file `[1,2]` after both the first and a second `drain()`; `snapshot()` then reports `totalCostUsd: 1` — exactly the orphaned ts=3 event, which never reaches disk |
| BUG-31 | EXEC | `VERIFIED FAILED` + `3/3 FAIL` → `approved:true, passCount:3, failCount:0`; `2024/05/13 5/5 PASS` → `passCount:2024, failCount:-2019`; `PASSED` → not approved |
| BUG-34 | EXEC+GIT | real `getChangedFiles` on scratch repo: `git diff --name-only HEAD` returns `["tracked.txt"]`; untracked `brand-new.ts` invisible |
| BUG-44 | EXEC | 3 attempts / 0 successes / $18 → `avgCost:0` |
| BUG-45 | EXEC | `a**b` matches `a/b` **and** `a/x/b` (crosses dirs); `foo\ bar` matches `foo/ bar` but not `foo bar` |
| BUG-46 | EXEC | `parseLLMJson('the { payload } was: {"a": 1}')` → throws (mis-slices, then fails; it does not accept a wrong object). Counter-example asserted: a `}` inside a JSON string parses correctly — the defect is narrower than "brace handling is broken" |
| BUG-57 | EXEC | `- **API docs** — [docs](url)` → tags `["docs"]` → excluded for every role; `[implementer]` + link → shadowed to `["docs"]` |
| BUG-58 | EXEC | double marker → `[{"storyId":"US-002","text":"thing one **Out of scope:**"},{"storyId":"US-002","text":"thing two"}]` |
| BUG-24 | GIT | `git status --porcelain` on a file renamed from `foo -> bar.txt`: `R  "foo -> bar.txt" -> baz.txt` — always C-quoted, incl. `core.quotePath=false`; a plain `plain.txt -> renamed.txt` in the same output stays unquoted, isolating the quoting to the space-containing path. The unquoted input in the finding cannot exist → **FALSE**. Re-verified independently 2026-08-12 (git 2.50.1) |
| BUG-46 (porcelain half) | GIT | same reasoning as BUG-24 → **FALSE** |

### Call-graph proofs (knowledge graph + grep)

| BUG | Proof | Evidence |
|:--|:--|:--|
| BUG-04 | GRAPH | `preIterationTierCheck` inbound callers = **[]**; only reference is the barrel re-export (`escalation/index.ts:8`); `canEscalate` compares against `calculateMaxIterations` = sum of all tiers (5+3+2), attempts reset on tier change (:473) |
| BUG-05 | GRAPH | `detectRuntimeCrash` in-degree **0**; `shouldRetrySameTier`'s only inbound edge is `handleTierEscalation`; `handleTierEscalation`'s only inbound edge is `handlePipelineFailure` (pipeline-result-handler.ts:368-384) which never passes `runtimeCrashResult`; type populated nowhere in src/ |
| BUG-09 | GRAPH | auto-plugin `decide` inbound callers = **[]**; `receive()` throws unconditionally (auto.ts:117-122); `_autoPluginDeps` never injected; `createInteractionPlugin` registers a single plugin |
| BUG-19 | SRC | router.ts:196-197,238 keyed by bare `story.id`; only invalidation is `routing.ts:32-34` — conditional on `ctx.story.id === ctx.stories[0]?.id`; `clearCache` (whole-map) has no other production caller |
| BUG-20 | SRC | manager.ts:503-515 catch → `retriable:false` "fail-unknown" for any `adapter.complete()` throw; no same-agent retry path for complete() |
| BUG-36 | SRC | worker pipeline sets `skipPrdPersistence: true` (unified-executor.ts:263); rectification context (merge-conflict-rectify.ts:155-173) has neither `skipPrdPersistence` nor `prdPath`, `featureDir: undefined` → completion.ts:57-58 falls back to `…/.nax/features/unknown/prd.json`; `story:completed` emit (completion.ts:111-125) is NOT gated on `persistPrd` |
| BUG-39 | SRC | `lastStoryId` assigned only under `if (!ctx.useBatch)` (unified-executor.ts:411,507) |
| BUG-40 | GRAPH | `executeParallel` inbound callers = **[]** (dead code confirmed) |
| BUG-52 | GRAPH | `AgentManager.reset` inbound callers = **[]** in src/ (only test helpers) |
| BUG-33 | SRC | runner-plan-helpers.ts:300-307 passes `[]` patchPrompts; verifier-pick.ts:119-127 `runPatchStep` = pure string builder (extractDistinctACs + PatchPromptBuilder, no LLM) |
| BUG-35 | SRC | routing.ts:90-105 writes `story.routing` + saves PRD **before** the greenfield override mutates only the local `routing` (:152) and `ctx.routing` (:158) |
| BUG-12 | SRC | acceptance.ts:159 (`allFailedACs` accumulator), :262-263 bare-id dedup `!allFailedACs.includes(acId)`; per-package lists kept at :270-278 (`:257` in an earlier revision was the `AC-ERROR` sentinel push, not the normal path) |
| BUG-30 | SRC | semantic-review.ts:370 `/"passed"\s*:\s*false/.test(output)` → hard fail; adversarial twin guards with findings-array check (adversarial-review.ts:458) |
| BUG-41 | SRC | unlock.ts:76-91 liveness check then `Bun.spawn(["rm", lockPath])` with no re-check |
| BUG-23 | SRC | git.ts:396-404 `git add -A`/`git commit` await `proc.exited` with pipes never drained, no timeout |
| BUG-11 | SRC | acceptance-loop.ts:429 `acceptanceRetries++` before fix cycle; `>= maxRetries` at :435 fires before `runAcceptanceFixCycle`; default 3 (schemas.ts:287) → 2 fix rounds |

### Test-coverage gaps (why the suite is green despite the bugs)

| BUG | Gap |
|:--|:--|
| BUG-02 | `test/unit/prd/schema.test.ts` has a dependency-resolution test (:135) but no duplicate-id rejection case |
| BUG-06 | `verify-scoped.test.ts:313` covers `#1207` zero-test **failure** fallback; no exit-0 zero-test success case |
| BUG-10 | `merge.test.ts` has no `models` cases; the models tests (`merge-agent-models-routing.test.ts:85-114`) only pass **complete** tier maps |
| BUG-13 | ac-parser tests use `AC-1`-style ids, never lookalike identifiers (`TestMac_2`) |
| BUG-14 | parser tests exercise real summary lines, not log noise inside output |
| BUG-15 | parse-mocha tests use single summaries (`1 passing`, `0 passing`, `4 passing`) — no multi-spec interleaving |
| BUG-18 | smart-runner tests pass plain paths (`src/config/schema.ts`) — no `--config <slash-path>` case |
| BUG-31 | no `VERIFIED FAILED` / date-ratio coercion case in verdict-reader tests |
