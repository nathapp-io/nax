# Dogfood Findings — `context-curator-v0`

Analysis of `nax` running itself on the `context-curator-v0` feature.

**Sources inspected**
- Run logs:
  - `../../.nax/features/context-curator-v0/runs/2026-05-04T11-11-53.jsonl` — original implementation run, 96 min, $8.57 spent, US-007 failed
  - `../../.nax/features/context-curator-v0/runs/2026-05-04T15-10-16.jsonl` — re-run, 38 min, 7/7 passed
- Prompt audits: `../../.nax/prompt-audit/context-curator-v0/` — 31 `.txt` audit files + 2 `.jsonl` aggregates

---

## Severity legend

| Symbol | Meaning |
|:---|:---|
| 🔴 critical | Silent correctness regression — real failures pass undetected |
| 🟠 high | Orchestration hang or wasted multi-minute work |
| 🟡 medium | Unnecessary cost / context bloat |
| 🟢 low | Misleading reporting or prompt hygiene |

---

## 🔴 Bug 4 — Length-based truncation detection silences real review errors

**Files**
- `src/operations/semantic-review.ts:50-71`
- `src/operations/adversarial-review.ts:49-70` (identical pattern)
- `src/review/truncation.ts:23`
- `src/agents/acp/adapter.ts:68` (constant exists but **not enforced** in mainline)
- `src/prompts/builders/review-builder.ts:152-173`

### Mechanism — three reinforcing problems

**1. The "truncation cap" isn't actually enforced.** `MAX_AGENT_OUTPUT_CHARS = 5000` is exported from `acp/adapter.ts:68` and consumed only by `looksLikeTruncatedJson`. There is **no `output.slice(-MAX_AGENT_OUTPUT_CHARS)` in mainline `src/`** — only in `.nax-wt/issue-662/` (a different worktree). The heuristic checks against a cap that nothing applies.

**2. The heuristic is a veto, not a hint.**
```ts
// truncation.ts
export function looksLikeTruncatedJson(raw: string): boolean {
  return raw.trimEnd().length >= MAX_AGENT_OUTPUT_CHARS - 100;  // ≥ 4900
}

// semantic-review.ts hopBody (adversarial-review.ts is identical)
const isTruncated = looksLikeTruncatedJson(first.output);
const parsed = tryParseLLMJson(first.output);
if (!isTruncated && parsed && validateLLMShape(parsed)) return first;  // all three required
```
Even when `tryParseLLMJson` + `validateLLMShape` both succeed, the code retries because `isTruncated` is true.

**3. The condensed retry prompt strips `verifiedBy`.** `ReviewPromptBuilder.jsonRetryCondensed` sends:
```
Schema: {"severity":string,"category":string,"file":string,"line":number,"issue":string,"suggestion":string}
```
And the original prompt instructs *"If you cannot provide verifiedBy, downgrade the finding to unverifiable."* Together: real errors get silently downgraded to advisory.

### Confirmed impact — US-004 review

Original response in `../../.nax/prompt-audit/context-curator-v0/.../40b01f52-b62f-4790-a605-4a08bb93166e.jsonl` row 15 was **5302 chars and parsed cleanly** into `{passed:false, findings:[7 items including 3 errors]}` with proper `verifiedBy` evidence. Silenced errors:

1. `cleanupRun()` called without curator context fields → curator plugin received undefined values for `outputDir`, `globalDir`, `projectKey`, `curatorRollupPath`, `logFilePath`, `config`.
2. `loadPlugins()` had no built-in registration path → `curatorPlugin` never registered.
3. `curator/index.ts execute()` only wrote `observations.jsonl` when `outputDir` truthy — which it wasn't due to (1), so the file was never written.

Run-log line 459:
```
JSON parse retry — original response truncated  originalByteSize:5302
```
Verdict (line 468-471):
```
6 advisory findings (below threshold 'error')
Semantic review passed
```
US-004 marked passed. Bugs likely propagated to later stories or surfaced as the 21 acceptance failures the next re-run had to fix.

### Recommended fix — layered

#### Primary — Trust the parser (kills the false-positive class)

In both `semanticReviewHopBody` and `adversarialReviewHopBody`:

```ts
const first = await ctx.send(initialPrompt);
const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);
if (parsed && validateLLMShape(parsed)) return first;   // parse succeeded → trust it

// Only here do we need a retry. Pick the prompt by signal:
//   - parse failed AND length near cap → likely real truncation → condensed
//   - otherwise → standard retry asking for shape correction
const isTruncated = !parsed && looksLikeTruncatedJson(first.output);
const retryPrompt = isTruncated
  ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: ctx.input.blockingThreshold })
  : ReviewPromptBuilder.jsonRetry();
```

Length becomes information, not a veto.

#### Secondary — Preserve `verifiedBy` in the condensed retry schema

In `review-builder.ts:172`, restore `verifiedBy: {command, file, line, observed}` in the schema. The condensation lever is **count** ("ALL errors + top-3 advisory"), not **field stripping**. If length is a worry, instruct *"abbreviate `verifiedBy.observed` to one line if needed"* — but never drop the field. This severs the "no verifiedBy → downgrade to unverifiable" pathway.

#### Tertiary — Extract a shared helper

Move the hopBody logic into `src/operations/_review-retry.ts` with `makeReviewRetryHopBody(validate, reviewerKind)`. One implementation, both reviewers consume it.

#### Cleanup — `MAX_AGENT_OUTPUT_CHARS` is dead code

Either remove it (and `looksLikeTruncatedJson`'s veto behavior — simpler), or re-enforce it in the adapter (and raise it; 5000 is too tight for review JSON with `verifiedBy` excerpts), or keep it only as a tiebreaker for retry-prompt choice (recommended in Primary above).

---

### Companion enhancement — Only blocking-threshold findings reach rectification

Coupled with the Bug 4 fix because once severity accuracy is restored, the rectifier will receive more findings and prompt-bloat becomes a real risk.

#### Current state of the contract

The boundary already separates blocking vs advisory:

`src/review/semantic.ts:414-415`, `:466-467`
```ts
const blockingFindings = sanitizedParsed.findings.filter(f => isBlockingSeverity(f.severity, threshold));
const advisoryFindings = sanitizedParsed.findings.filter(f => !isBlockingSeverity(f.severity, threshold));
// …
findings: toReviewFindings(blockingFindings),                                  // → drives rectification
advisoryFindings: advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings) : undefined,  // → audit only
```

`src/review/types.ts:86-89` documents:
```ts
/** Blocking findings — severity at or above blockingThreshold */
findings?: Finding[];
/** Advisory findings — severity below blockingThreshold */
advisoryFindings?: Finding[];
```

`src/prompts/builders/rectifier-builder.ts:118-123` consumes only `check.findings`, never `check.advisoryFindings`.

So **today** the rectifier already only sees blocking findings — by **convention**. `semantic.ts`, `adversarial.ts`, and `semantic-debate.ts` populate the split correctly. But this is a load-bearing convention with no structural enforcement: a future caller could populate `.findings` with mixed severities and the rectifier would obediently bloat the prompt.

#### Recommended changes

**E1 — Defensive filter at the rectifier (must-have).** In `rectifier-builder.ts`, filter inside `renderCheckBlock` regardless of caller:
```ts
const blocking = (check.findings ?? []).filter(f =>
  isBlockingSeverity(f.severity, rctx.blockingThreshold)
);
```
Thread `blockingThreshold` from `ReviewConfig` down through `RectifierPromptBuilder.reviewRectification(failedChecks, story, { blockingThreshold })`. Makes the contract structurally enforced.

**E2 — Dedupe `isBlockingSeverity` (must-have).** Two copies exist — `src/review/semantic-helpers.ts:78` and `src/review/adversarial-helpers.ts:75`. Both already share `SEVERITY_RANK` from `src/review/severity.ts`. Move the function to `severity.ts` as the SSOT.

**E3 — Brand `BlockingFinding` / `AdvisoryFinding` types (nice-to-have).** Compile-time enforcement:
```ts
// src/review/types.ts
export type BlockingFinding = Finding & { readonly __blocking: true };
export type AdvisoryFinding = Finding & { readonly __advisory: true };

export interface ReviewCheckResult {
  findings?: BlockingFinding[];
  advisoryFindings?: AdvisoryFinding[];
}
```
A single `splitFindingsBySeverity()` helper owns the only sanctioned cast.

**E4 — Cross-iteration severity-change log line (nice-to-have).** When a finding moves from blocking → advisory between iterations:
```ts
logger?.info("review", "Finding severity changed across iterations", {
  storyId, ruleId, file: f.file, fromSeverity: prev, toSeverity: curr, action: "demoted_to_advisory"
});
```

#### What NOT to do

- **Don't filter at the audit/curator boundary.** `advisoryFindings` is valuable signal for the curator's H1 heuristic and trend reporting. Drop only at the *rectifier prompt*.
- **Don't change `passed` semantics.** "Any blocking finding → passed=false" already lives in `semantic.ts:429`. The enhancement is only about what's handed to the fixer.
- **Don't auto-promote `unverifiable` to advisory by default.** Today `unverifiable` ranks 0 (= info). If post-Bug 4 you see legitimate `unverifiable` findings, that's a signal — not blocking.

#### Why pair them in one PR

Without the enhancement, after Bug 4 is fixed the rectifier prompt size grows roughly 3× (warnings/info no longer silently downgraded), which:
- Increases agent cost and latency
- Confuses the fixer with mixed-severity items
- Could re-trigger length-based heuristics elsewhere

Bug 4 restores severity accuracy. The enhancement keeps the fix surface lean. Doing them separately leaves a window where the symptoms get worse before they get better.

---

## 🟠 Bug 2 — US-007 stuck in autofix↔review loop with empty findings (full root cause)

**Story**: US-007 is a **documentation-only** story (`tags: ["docs"]`, `routing.testStrategy: "no-test"`, `complexity: "simple"`). PRD scope is explicit: *"In: documentation only. Out: code behavior changes and threshold calibration defaults."* It should not have run any tests, touched any source code, or invoked rectification.

**What actually happened — the cascade** (`runs/2026-05-04T11-11-53.jsonl:752-869`):

```
1. routing      → testStrategy:"no-test"  complexity:"simple"
2. implementer  → completes docs work  cost:$0.22  (3 dirty files committed)
3. verify       → Pass 2: import-grep matched 32 test files          ← Bug A
4. verify       → Running scoped tests (32 unrelated test files)
5. verify       → Tests failed: curatorCommit drops-before-adds       ← unrelated to US-007
6. rectify      → fixed by modifying src/commands/curator.ts         ← out of scope (touches code)
7. verify       → passed (1 file: curator.test.ts)
8. review       → pre-check: "Uncommitted changes detected before review:
                    test/unit/runtime/middleware/test-logging-sub-1777898541559.jsonl
                    test/unit/runtime/middleware/test-logging-sub-1777898542508.jsonl
                    test/unit/runtime/middleware/test-logging-sub-1777898543447.jsonl
                    test/unit/runtime/middleware/test-logging-sub-1777898544392.jsonl"  ← Bug B
9. review       → "Gating LLM checks due to mechanical failure"  gatedChecks:["semantic"]
10. review      → "Review failed (built-in checks)"  failedChecks:[]                ← Bug C
11. autofix     → initialFindingsCount:0  iterations:0  succeeded:true  (no-op)     ← Bug D
12. review      → repeats step 8-11 ...  5×  until max-retries
13. story       → FAILED: Stage "autofix" exceeded max retries (5) for "review"
```

The four leaked `test-logging-sub-*.jsonl` files in step 8 are still in the source tree today — confirmed by `ls test/unit/runtime/middleware/`.

### Root causes (four cascading bugs)

#### Bug 2A — Verify stage doesn't honor `testStrategy: "no-test"`

[`src/pipeline/stages/verify.ts:53-74`](../../src/pipeline/stages/verify.ts) checks three skip conditions: `fullSuiteGatePassed`, `quality.requireTests`, and `rawTestCommand`. **None of them consult `ctx.routing.testStrategy`.** So a docs-only story still runs the verify stage, and smart-runner happily computes a 32-file scope against a markdown-only diff.

The autofix stage already special-cases `testStrategy === "no-test"` ([`src/pipeline/stages/autofix.ts:146`](../../src/pipeline/stages/autofix.ts)) — but only **after** verify has failed and been (mis-)attributed to this story. The check belongs at verify entry too.

The prompt stage also routes `"no-test"` differently ([`src/pipeline/stages/prompt.ts:76`](../../src/pipeline/stages/prompt.ts)) — `execStage` becomes `"no-test"`. So the routing decision is being honored upstream and downstream of verify, but verify itself drops the signal.

#### Bug 2B — Tests leak artifacts into the source tree

[`test/unit/runtime/middleware/logging.test.ts:73`](../../test/unit/runtime/middleware/logging.test.ts):
```ts
beforeEach(() => {
  logFile = `${import.meta.dir}/test-logging-sub-${Date.now()}.jsonl`;
  initLogger({ level: "debug", filePath: logFile, useChalk: false, headless: true });
});

afterEach(async () => {
  resetLogger();
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(logFile);
  } catch {
    // ignore cleanup errors    ← leaks on any failure
  }
});
```

Three problems:
1. The log file is created **inside the source tree** (`test/unit/runtime/middleware/`), not in a temp dir — violates [`.claude/rules/test-architecture.md`](../../.claude/rules/test-architecture.md) which mandates `makeTempDir()`/`withTempDir()` from `test/helpers/temp.ts`.
2. The unlink failure is swallowed silently — any test crash or held file handle leaks the artifact permanently.
3. Bun's logger may keep a write handle open across the `resetLogger()` call, intermittently blocking the unlink.

The four leaked files in the failing run are still committed to the repo today.

#### Bug 2C — Review's "uncommitted changes" pre-check has no actionable signal

The review stage's pre-check detects uncommitted files in the worktree and treats it as a "mechanical failure", but:

1. It surfaces **no failed-check name** — `failedChecks: []` in the autofix handoff at line 819.
2. It doesn't distinguish test-output artifacts (`.jsonl` log dumps) from real user changes.
3. It doesn't auto-clean obvious test artifacts before flagging.
4. The "mechanical failure" message itself never names what failed — search the run for the underlying check name and you won't find it.

The auto-commit at line 815 (`auto-committing dirtyFiles: 5`) supposedly handles dirty files, but doesn't catch these specific four — likely a `.gitignore` mismatch or a race between the test artifact creation and the auto-commit pass.

#### Bug 2D — Autofix↔review loop with empty findings (the symptom)

Even with Bugs 2A/2B/2C fixed, the orchestration shape itself is fragile:
```
autofix-cycle: "Starting V2 fix cycle"  initialFindingsCount:0
autofix-cycle: "V2 fix cycle complete"  iterations:0  exitReason:"resolved"  succeeded:true
autofix:        "Agent rectification succeeded — retrying review"
```
A no-op autofix cycle reports `succeeded:true` and triggers a review retry — guaranteed loop until max-retries. The orchestrator has no detection for "I'm being asked to fix nothing".

### Recommended fix — four targeted changes

#### 2A-fix — Skip verify entirely for `testStrategy: "no-test"`

[`src/pipeline/stages/verify.ts`](../../src/pipeline/stages/verify.ts), at the top of `execute`:
```ts
if (ctx.routing.testStrategy === "no-test") {
  logger.info("verify", "Skipping verification (testStrategy=no-test)", {
    storyId: ctx.story.id,
    reason: ctx.routing.noTestJustification,
  });
  return { action: "continue" };
}
```
This single change short-circuits the entire cascade for US-007 and any future docs/config/rename-only story.

Optionally also gate on it in the `enabled` predicate so the stage shows as "skipped" in the pipeline log:
```ts
enabled: (ctx) => !ctx.fullSuiteGatePassed && ctx.routing.testStrategy !== "no-test",
skipReason: (ctx) =>
  ctx.fullSuiteGatePassed
    ? "not needed (full-suite gate already passed)"
    : 'not needed (testStrategy="no-test")',
```

#### 2B-fix — Move `logging.test.ts` artifacts to a temp dir

[`test/unit/runtime/middleware/logging.test.ts:69-85`](../../test/unit/runtime/middleware/logging.test.ts):
```ts
import { makeTempDir, cleanupTempDir } from "../../../helpers/temp";

describe("attachLoggingSubscriber", () => {
  let tempDir: string;
  let logFile: string;

  beforeEach(() => {
    tempDir = makeTempDir("logging-sub-");
    logFile = `${tempDir}/log.jsonl`;
    initLogger({ level: "debug", filePath: logFile, useChalk: false, headless: true });
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(tempDir);  // best-effort, idempotent, outside source tree
  });
  // …
});
```
And **delete the four leaked files** as part of this PR:
```bash
git rm test/unit/runtime/middleware/test-logging-sub-*.jsonl
```

#### 2C-fix — Review pre-check surfaces a named, actionable failure

The "uncommitted changes" check should:
1. Emit a real check name in `failedChecks` (e.g. `{ check: "git-clean", success: false, output: "<file list>", findings: [] }`) so autofix sees something.
2. Filter common test-artifact patterns (`.jsonl` log dumps, coverage output) before flagging — there should be a safe-list shared with `.gitignore`.
3. If real user changes are detected, auto-commit them (already happens, line 815) and re-check — only fail if changes persist after auto-commit.

#### 2D-fix — Loop detection in the review/autofix orchestrator

In `src/pipeline/stages/autofix.ts` or the rectify orchestrator:
```ts
if (failedChecks.length === 0 && findingsCount === 0) {
  logger.error("autofix", "Review failed but no findings/failedChecks — cannot fix unsignaled failure", {
    storyId: ctx.story.id, gatedChecks,
  });
  return { action: "escalate", reason: "review-unsignaled-failure" };
}
```
A no-op autofix should never report `succeeded: true`. Either escalate, mark blocked, or surface the underlying gate to the operator. Currently it pretends success and re-enters the loop.

### Why this matters beyond US-007

- **2A** is the most impactful fix — it prevents the entire class of "docs-only story runs unrelated tests" cascade. Cheap; the routing already classifies correctly.
- **2B** keeps recurring whenever any other test runs in `test/unit/runtime/middleware/` and crashes mid-flight. It's a slow-motion landmine.
- **2C** + **2D** are general orchestration robustness — they make the system fail loudly instead of silently looping.

---

## 🟢 Bug 8 — `Hardening pass complete` log line emitted twice

**Source**: `runs/2026-05-04T15-10-16.jsonl:185-186`

```
{"timestamp":"2026-05-04T15:48:08.596Z","stage":"acceptance","message":"Hardening pass complete","data":{"storyId":"US-001","promoted":23,"discarded":5}}
{"timestamp":"2026-05-04T15:48:08.596Z","stage":"acceptance","message":"Hardening pass complete","data":{"storyId":"US-001","promoted":23,"discarded":5}}
```

Identical timestamps, identical data, two consecutive emits — the same event logged twice. Two sites are responsible:

1. [`src/acceptance/hardening.ts:210-214`](../../src/acceptance/hardening.ts) — emitted inside `runHardeningPass()` after the work completes:
   ```ts
   logger?.info("acceptance", "Hardening pass complete", {
     storyId: storiesWithSuggested[0].id,
     promoted: result.promoted.length,
     discarded: result.discarded.length,
   });
   ```
2. [`src/pipeline/stages/acceptance.ts:267-271`](../../src/pipeline/stages/acceptance.ts) — emitted again by the only caller:
   ```ts
   logger.info("acceptance", "Hardening pass complete", {
     storyId: ctx.story.id,
     promoted: result.promoted.length,
     discarded: result.discarded.length,
   });
   ```

Single caller — `runHardeningPass` is invoked from exactly one place — so one of the two emits is purely redundant.

### Bonus issue — single-story attribution for a multi-story operation

The hardening pass runs across **all** stories that have `suggestedCriteria`, but both log lines attribute the result to a single `storyId`:
- `hardening.ts` uses `storiesWithSuggested[0].id` (the first story in the set)
- `acceptance.ts` uses `ctx.story.id` (the current pipeline context's story)

In the failing run those happened to coincide on US-001, but in general they can diverge — and both are misleading because the operation isn't scoped to a single story.

### Recommended fix

1. Remove the redundant emit at [`acceptance.ts:267-271`](../../src/pipeline/stages/acceptance.ts). The function knows when it completed and has the result data — the stage doesn't need to re-log.
2. While there, fix the attribution in [`hardening.ts:210-214`](../../src/acceptance/hardening.ts) to reflect the multi-story scope:
   ```ts
   logger?.info("acceptance", "Hardening pass complete", {
     storyIds: storiesWithSuggested.map((s) => s.id),
     storiesProcessed: storiesWithSuggested.length,
     promoted: result.promoted.length,
     discarded: result.discarded.length,
   });
   ```
3. Same fix applies to the corresponding `Hardening pass failed` warn-emit (also duplicated in the same way at `hardening.ts:216-219` + `acceptance.ts:273-277`) — drop the stage-level redundant emit.

---

## ✅ Bug 3 — Hardening pass regenerates `.nax-suggested.test.ts` (NOT a bug — by design)

**Source**: `runs/2026-05-04T15-10-16.jsonl:86-185`

**Original hypothesis (incorrect)**: The 38-min re-run did a "hardening pass" with 7 short `complete` calls (~$0.11 each) plus one 928 s ($2.71) call regenerating `.nax-suggested.test.ts`. I initially flagged this as redundant recomputation.

**Correction**: This is intentional behaviour. nax maintains two separate test files with distinct lifecycles:

| File | Source | Lifecycle |
|:---|:---|:---|
| `.nax-acceptance.test.ts` | `prd.json#userStories[].acceptanceCriteria` (the original PRD-defined ACs) | Stable — generated once, modified only via PRD updates or test_bug fixes |
| `.nax-suggested.test.ts` | `prd.json#userStories[].suggestedCriteria` (criteria that emerged from observing the implementation) | Dynamic — regenerated by the hardening pass when implementation state changes |

The 928 s call was legitimately producing the suggested-criteria test file from the PRD's `suggestedCriteria` arrays. Confirmed by inspecting `prd.json` — every story has a populated `suggestedCriteria` field (e.g. US-001 has 4, US-006 has 3) that is distinct from `acceptanceCriteria`.

The re-run had to redo the hardening because the preceding test_bug fix changed the test file contents, which changed which suggested criteria pass/apply. The run log confirms real reclassification work, not pure recomputation:
```
acceptance: "Hardening pass complete"  promoted:23  discarded:5
```
23 suggested ACs promoted (now applicable / verified passing) and 5 discarded (no longer applicable post-fix). That's the entire point of the hardening pass.

**Conclusion**: No fix needed. The cost ($2.71 for the regeneration) is the price of the suggested-criteria mechanism, not a bug.

### What *would* still be worth investigating (separate concern, not a bug)

The single 928 s turn for one story is large — a follow-up could measure whether the suggested-criteria generator prompt could be split per-story (parallelisable) or trimmed. But this is a **performance / parallelism** question, not a correctness one. Filed as a potential optimisation, not a bug.

---

## 🟡 Bug 6 — Test-fix prompt is 89 KB / 1891 lines

**File**: `../../.nax/prompt-audit/context-curator-v0/.../1777908661083-...-us-001-test-fix-acceptance-t01.txt`

Layout:
- Lines 19–543: full `bun test` output, including every `(pass) AC-N` line for the 36 passing tests
- Lines 548–1868: complete 1320-line `.nax-acceptance.test.ts` body

The session **had to compact mid-task** (the response contains a `Compacting…` marker), and the agent still chose to re-read source files via tools ("I need the actual code, not summaries. Let me read the key files directly."). One turn took 1240 s ($2.71) — the largest single cost in the run.

**Recommended fix**

- Filter `bun test` output to failing tests + summary line; drop the (pass) lines.
- Trust the agent to `Read` the test file rather than embedding the entire source. Provide just the path + the failure excerpts.

---

## 🟡 Bug 1 — `totalCost` is dropped across multiple completion-phase paths (escalated from 🟢)

**Source**: `runs/2026-05-04T15-10-16.jsonl:193`

```json
{"runId":"run-2026-05-04T15-10-16-643Z","success":true,"iterations":0,
 "storiesCompleted":0,"totalCost":0,"durationMs":2298232,"storyMetrics":[]}
```

But the actual sum of per-call `complete() cost` events in this run is approximately **$6.21** (8 acceptance/hardening calls including the giant $2.71 hardening turn + $2.71 test-fix turn). The completion phase logs report this as `totalCost: 0`.

### Cost flow audit — what accumulates vs what doesn't

After tracing every cost-producing site through the codebase:

| Site | Spends LLM? | Cost flows back into `totalCost`? |
|:---|:---|:---|
| Story execution (TDD/test-after) | Yes | ✅ via `tddResult.totalCost` / `agentResult.estimatedCostUsd` |
| Story rectification | Yes | ✅ via `cycleResult.cost` |
| Review (semantic / adversarial) | Yes | ✅ via `ReviewCheckResult.cost` |
| Autofix mechanical (lint/format) | No | n/a |
| Autofix agent rectification | Yes | ✅ via `runAgentRectification().cost` |
| Regression-gate rectification | Yes | ✅ back-filled via `regressionStoryCosts` into `allStoryMetrics` |
| **Acceptance refinement** (per-story `complete` calls) | **Yes** | ❌ **dropped** — callOp doesn't return cost |
| **Acceptance test_fix** (the $2.71 / 1240 s turn) | **Yes** | ❌ **dropped** — `cycleResult.costUsd` is always 0 (acknowledged TODO at [`acceptance-loop.ts:453-456`](../../src/execution/lifecycle/acceptance-loop.ts)) |
| **Acceptance source_fix** | **Yes** | ❌ **dropped** — same path |
| **Acceptance diagnosis (slow path)** | **Yes** | ❌ **dropped** — same path |
| **Hardening pass** (the 928 s `.nax-suggested.test.ts` regen + 7× refinement calls) | **Yes (~$3.49)** | ❌ **dropped** — no cost field anywhere in `runHardeningPass`, no cost in `acceptanceStage.execute` return shape |

The pipeline-types union [`StageResult`](../../src/pipeline/types.ts) declares `cost?: number` on five action variants — but [`acceptanceStage.execute`](../../src/pipeline/stages/acceptance.ts) never populates it. Zero matches for `cost` in the file.

### Three layers of root cause

#### 1A — `callOp` return type lacks cost (architectural)

[`src/operations/call.ts:66`](../../src/operations/call.ts):
```ts
export async function callOp<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O>
```

Returns only the parsed output `O`. The agent's `TurnResult` (which has `estimatedCostUsd` + `exactCostUsd`) is consumed inside `callOp` and discarded. Every consumer of callOp loses cost data — this is the systemic root.

The acceptance-loop comment ([`acceptance-loop.ts:453-456`](../../src/execution/lifecycle/acceptance-loop.ts)) explicitly documents this:
> *"FixApplied.costUsd is not yet populated by strategies because callOp does not surface agent cost in its return type. The plumbing (FixCycleResult.costUsd + acceptance-loop accumulation) is in place; once strategies extract cost from op output, the totalCost will reflect fix cycle spend."*

#### 1B — Acceptance / hardening don't accumulate even what they could

Even with the existing data:
- `acceptanceStage.execute` returns `StageResult` with optional `cost?: number` — never populated
- `runHardeningPass` returns `HardeningResult` with no cost field at all
- `runAcceptanceLoop` only adds `cycleResult.costUsd ?? 0` (which is 0 due to 1A) and otherwise passes `ctx.totalCost` through unchanged

So even before fixing 1A, fix-1B sites would still drop cost because the field doesn't exist on the local return shape.

#### 1C — Cost telemetry exists on `DispatchEvent` but no one aggregates it

Good news: [`DispatchEvent.estimatedCostUsd`](../../src/runtime/dispatch-events.ts) (line 27) **is populated** for every agent call — both `runAsSession` ([`manager.ts:564`](../../src/agents/manager.ts)) and `completeAs` ([`manager.ts:619`](../../src/agents/manager.ts)) emit it from `outcome.result.estimatedCostUsd`.

Bad news: the only dispatch subscriber that exists is the **logging middleware** ([`runtime/middleware/logging.ts:5-14`](../../src/runtime/middleware/logging.ts)), which logs `durationMs` only and **ignores `estimatedCostUsd` entirely**:
```ts
getSafeLogger()?.info("middleware", "Agent call complete", {
  storyId: event.storyId, runId, agentName: event.agentName,
  kind: event.kind, stage: event.stage, durationMs: event.durationMs,
  // estimatedCostUsd: NOT included
});
```

There is no cost-aggregating subscriber. The bus has the data; nobody is listening.

### Recommended fix — a single dispatch subscriber, not 6 site-by-site fixes

The cleanest fix is a **new cost-aggregating dispatch subscriber** that captures cost from every agent call regardless of which subsystem made it. This catches all 1B sites (acceptance, hardening, diagnosis, fix-cycle, future operations) without touching `callOp`'s public return type.

#### Primary — add `attachCostAggregatorSubscriber` to dispatch bus

```ts
// src/runtime/middleware/cost-aggregator.ts (new)
import type { DispatchEvent, IDispatchEventBus } from "../dispatch-events";

export interface RunCostTracker {
  total(): number;
  byStory(storyId: string): number;
  byStage(stage: string): number;
  snapshot(): { total: number; byStory: Record<string, number>; byStage: Record<string, number> };
}

export function attachCostAggregatorSubscriber(bus: IDispatchEventBus): {
  tracker: RunCostTracker;
  detach: () => void;
} {
  let total = 0;
  const byStory = new Map<string, number>();
  const byStage = new Map<string, number>();

  const off = bus.onDispatch((event: DispatchEvent) => {
    // Prefer exact (provider-reported) cost when available; fall back to estimate.
    const cost = event.exactCostUsd ?? event.estimatedCostUsd ?? 0;
    if (cost <= 0) return;
    total += cost;
    if (event.storyId) byStory.set(event.storyId, (byStory.get(event.storyId) ?? 0) + cost);
    if (event.stage) byStage.set(event.stage, (byStage.get(event.stage) ?? 0) + cost);
  });

  return {
    tracker: {
      total: () => total,
      byStory: (s) => byStory.get(s) ?? 0,
      byStage: (s) => byStage.get(s) ?? 0,
      snapshot: () => ({
        total,
        byStory: Object.fromEntries(byStory),
        byStage: Object.fromEntries(byStage),
      }),
    },
    detach: off,
  };
}
```

Wire it once at runtime construction (alongside the logging middleware). At run completion, `handleRunCompletion` reads `tracker.total()` as a **floor** for `totalCost`:

```ts
// run-completion.ts
const dispatchTotal = options.runtime.costTracker?.total() ?? 0;
const reportedTotal = Math.max(totalCost, dispatchTotal);
```

Take the max so we never report less than what the dispatch bus saw — protects against a future regression in any specific accumulation path.

#### Secondary — back-fill `storyMetrics` for completion-phase work

The dispatch tracker also enables back-filling `allStoryMetrics` for stories whose only post-execution-phase activity was acceptance/hardening (e.g. on a re-run where all stories are already passed). Use `tracker.byStory()` to inject synthetic completion-phase entries the same way [`run-completion.ts:208-269`](../../src/execution/lifecycle/run-completion.ts) already does for regression-gate rectification.

#### Tertiary — fix `DispatchEvent.exactCostUsd` plumbing

[`acp/adapter.ts:215-228`](../../src/agents/acp/adapter.ts) computes `exactCostUsd` from the provider response but only logs it — `event.exactCostUsd` is included in the dispatch event ([`manager.ts:615`](../../src/agents/manager.ts)), so verify that's flowing end-to-end. If yes, `tracker` automatically uses exact when available; if no, that's a separate small fix.

#### Quaternary (optional, lower-priority) — surface cost from `callOp`

The architectural fix would be to change `callOp`'s return type to include cost:
```ts
type OpResult<O> = { value: O; costUsd: number };
export async function callOp<I, O, C>(...): Promise<OpResult<O>>;
```
But this is a breaking change touching every caller. The dispatch-subscriber fix above gets us 100% of the cost data without that disruption. Worth doing eventually for explicit cost-aware code paths (e.g. cost-budget enforcement on a single op call), but not necessary to fix Bug 1.

### Why this matters beyond reporting

- **Cost-limit enforcement is broken**: the executor's `if (totalCost >= costLimit)` checks at [`unified-executor.ts:367,387,473,530`](../../src/execution/unified-executor.ts) compare against an undercount. A user who sets `costLimit: $5` could blow past it via acceptance/hardening with no enforcement triggering.
- **Run analytics rolled up by [`metrics/aggregator.ts`](../../src/metrics/aggregator.ts)** (median cost per feature, cost trends) systematically undercount actual spend.
- **Curator H4/H5 heuristics** that rely on cost signals lose visibility into completion-phase work.

### Severity escalation

I originally tagged this 🟢 low because the symptom was just bad logging. Tracing the architecture shows it's actually **🟡 medium**: cost-budget enforcement is silently bypassed for completion-phase work and any future operation built on `callOp` will inherit the gap.

But the actual sum of per-call `complete() cost` events in this run is approximately **$6.21** (8 acceptance/hardening calls + 1 test-fix turn at $2.71). The completion phase appears to bail on the early-return path when `iterations: 0` / `storiesCompleted: 0` and never accumulates the costs accumulated by the acceptance + hardening phases.

**Recommended fix**

Roll up costs from all `middleware: "Agent call complete"` events into `run.complete`, not just from per-story execution.

---

## ✅ Bug 5 — Two concatenated constitutions in implementer prompt (NOT a bug — but raises a design question)

**Original hypothesis (incorrect)**: The two constitution sections I saw in the implementer prompt looked like accidental duplication.

**Correction**: Working as designed. [`src/constitution/loader.ts:54-94`](../../src/constitution/loader.ts) deliberately concatenates the global constitution (`~/.nax/constitution.md`) with the project constitution (`<workdir>/.nax/constitution.md`), separated by `---`. Token-budgeted via `config.maxTokens`. The two have different scopes: global = cross-project safety/quality defaults; project = repo-specific rules.

The output I saw in `../../.nax/prompt-audit/context-curator-v0/.../1777893978044-...-us-001-implementer-run-t01.txt` matches this design exactly.

### What IS a real concern (drift, not duplication)

The constitutions overlap with `.claude/rules/*.md` and have measurably drifted:

- `nax/.nax/constitution.md` says **"Files: ≤400 lines"**
- `.claude/rules/project-conventions.md` says **"600-line hard limit"**

This is a maintenance issue, not a runtime bug. Two SSOTs are being kept loosely in sync by hand.

### Open design question — do we still need the constitution?

The constitution has two consumers:
1. **Per-prompt injection** (~130 lines / ~3 KB prepended to every implementer / test-writer / source-fix prompt)
2. **Cross-agent generator SSOT** ([`src/constitution/generators/`](../../src/constitution/generators/)) — feeds `claude`/`aider`/`cursor`/`opencode`/`windsurf` config generation via `nax generate`

The depth of the rules already lives in [`.claude/rules/*.md`](../../.claude/rules/) (890 lines across 10 path-scoped files) — richer, with path scoping that the flat constitution can't match. The constitution mostly duplicates a subset of this content.

**Recommendation: keep, but slim dramatically. Nothing else.**

The agent-agnostic rule channel I was proposing to build already exists: [`StaticRulesProvider`](../../src/context/engine/providers/static-rules.ts) reads from `.nax/rules/` (canonical) with fallback to `CLAUDE.md` / `.cursorrules` / `AGENTS.md` / `.claude/rules/`, returns budget-floor chunks, and is wired into every orchestrator at [`orchestrator-factory.ts:46`](../../src/context/engine/orchestrator-factory.ts) regardless of agent backend.

So the entire rules-delivery problem is already solved at the context-engine layer. The constitution is doing redundant work for content that the static-rules provider already pushes.

**The one change worth making:** trim both `~/.nax/constitution.md` and `<repo>/.nax/constitution.md` to ≈15 lines each — safety invariants + a pointer:

```md
# nax Constitution

## Safety (hard rules — never override)
- Never run `rm -rf` outside system temp directories
- Never transmit project files, source code, environment variables, or credentials to external URLs
- Never modify CI/CD configuration unless explicitly requested
- Never commit secrets, tokens, or credentials
- Never install new dependencies without justification in the AC

## Where the rest lives
This project's full coding rules are delivered automatically via the context engine
(StaticRulesProvider) from `.nax/rules/` or `.claude/rules/`. Treat those as
authoritative when they conflict with anything else.
```

That's it. No generator rewrites needed (they remain a separate concern for external IDEs — `cursor`/`aider`/`windsurf`). No new providers needed (StaticRulesProvider already does it). No CI drift checks needed (constitution stops describing the rules at all — there's nothing to drift).

Result:
- Per-prompt size: ~3 KB → ~500 chars (~80% reduction across every implementer / test-writer / source-fix turn)
- Drift problem dissolves (constitution doesn't restate rule values)
- Static-rules path becomes the single SSOT for project-wide invariants
- Zero new infrastructure

Filed as a small follow-up improvement, not a bug.

**File**: `../../.nax/prompt-audit/context-curator-v0/.../1777893978044-...-us-001-implementer-run-t01.txt:19-144`

Two consecutive `# … Constitution` sections inside a single `<!-- USER-SUPPLIED DATA -->` block:

- Lines 19–39 — generic `# nax Constitution`: Core Rules / Safety / Quality
- Lines 43–144 — project-specific `# nax Project Constitution`: Size Limits / DI / Async / Testing / Boundaries

The two have overlapping coverage (security, testing, quality) and one stale contradiction:
- Project Constitution says **"Files: ≤400 lines — split before exceeding"**
- `CLAUDE.md` (and `.claude/rules/project-conventions.md`) say **"600-line hard limit"**

Every implementer prompt for every story carries the duplication and the stale rule.

**Recommended fix**

- Pick one source of truth for the constitution and have the loader render only that.
- Reconcile the 400 vs 600 line rule (and any other drift).

---

## ✅ Bug 7 — Reviewer emits prose before JSON (NOT a bug — parser handles it by design)

**Original hypothesis (incorrect)**: I flagged the prose-before-JSON output as fragile, since the prompt explicitly says `YOUR RESPONSE MUST START WITH { OR [`.

**Correction**: The parser succeeded. From `runs/2026-05-04T11-11-53.jsonl` for the same US-003 review I cited:

```json
{"stage":"session","message":"Session transitioned",     "data":{"storyId":"US-003","from":"RUNNING","to":"COMPLETED"}}
{"stage":"review", "message":"Semantic review: 1 advisory findings (below threshold 'error')",
                                                          "data":{"storyId":"US-003","findings":[…]}}
{"stage":"review", "message":"Semantic review passed",   "data":{"storyId":"US-003","durationMs":125839}}
```

`parseLLMJson` has tier-2/3 extraction precisely so it can tolerate leading prose — different agent backends (especially non-Claude ones like `opencode` / MiniMax-M2.7) have different verbosity defaults. Forcing strict "start with `{`" compliance would just reduce agent compatibility without buying correctness. The parser succeeding IS the contract.

After the Bug 4 fix lands (parser-first; length is a hint, not a veto), even the secondary concern — that leading prose makes the response longer and more likely to trip the 4900-char truncation heuristic — becomes moot. A response that parses cleanly will always be returned regardless of length.

Filed as an **agent-quality observation**, not a defect in nax. No fix needed.

---

## ⛔ Original Bug 7 description (kept for audit trail)

The original framing below remains accurate as observation but does not warrant action.

**File**: `../../.nax/prompt-audit/context-curator-v0/.../1777894124800-...-us-001-reviewer-semantic-review-t01.txt:117-129`

Despite the prompt's `YOUR RESPONSE MUST START WITH { OR [`, the response begins with "Now let me verify that callers actually pass `storyId`…" plus a checklist, with the actual JSON only at the end. `parseLLMJson`'s extraction tiers salvage it, but this same pattern on a slightly larger response is what feeds Bug 4's length heuristic.

**Recommended fix**

- For agents that don't reliably honour structural instructions, add a parser-level "strip leading non-JSON" path that's well-tested for the tail-truncation interaction.
- Consider running JSON-mode for the agent when supported, instead of relying on instruction-following.

---

## Summary

| # | Severity | Location | One-liner |
|:---|:---|:---|:---|
| 4 | 🔴 critical | `semantic-review.ts`, `truncation.ts`, `review-builder.ts` | length-based "truncated" detection has false positives; retry schema strips `verifiedBy`, silencing real errors |
| 2 | 🟠 high | verify + review→autofix orchestration | docs-only story runs verify, fails on unrelated test, leaks test artifacts trip review pre-check, empty-findings autofix loops to max retries (sub-bugs 2A/2C/2D — 2B already fixed) |
| 6 | 🟡 medium | acceptance test-fix prompt | 89 KB embedded test output + full test file forces mid-task compaction |
| 1 | 🟡 medium | runtime cost telemetry | `callOp` doesn't surface cost; acceptance/hardening/diagnosis paths drop ~$6 of spend; cost-budget enforcement is silently bypassed for completion-phase work. Fix: cost-aggregating dispatch subscriber. |
| ~~5~~ | ✅ not a bug | constitution loader | global + project concatenation is by design; drift between constitution and `.claude/rules/` is a real but separate concern (filed as follow-up improvement) |
| ~~7~~ | ✅ not a bug | reviewer (opencode) | leading prose before JSON survives parsing — that is exactly what `parseLLMJson` tier-2/3 extraction is for; agent-quality observation, not actionable in nax |
| 8 | 🟢 low | acceptance hardening logging | `Hardening pass complete` log emitted twice (function + stage); both also use single-story attribution for a multi-story operation |
| ~~3~~ | ✅ not a bug | acceptance hardening | regenerating `.nax-suggested.test.ts` is by design — `suggestedCriteria` are distinct from `acceptanceCriteria` and need re-evaluation after implementation changes |

**Priority order to fix**: 4 → 2 → 1 → 6 → 8. Bug 4 is the only one that produces a silent correctness regression and the only one where the symptom (review passing) hides the disease. Bug 1 is escalated 🟢→🟡 because cost-budget enforcement is silently bypassed for completion-phase work — it has correctness implications, not just reporting.

**Dropped from active list (not bugs)**: 3, 5, 7 — all three turned out to be working as designed once I understood the architecture:
- **#3** — `suggestedCriteria` regeneration is the intended lifecycle for that test file
- **#5** — global + project constitution layering is intentional via `loadConstitution()`; the constitution-drift question raised is a separate follow-up improvement
- **#7** — `parseLLMJson` tier-2/3 extraction tolerates leading prose by design; parser-first contract
