# Workflow mode (A5): single implementer + bounded review loop

**Date:** 2026-10-12 · **Status:** design approved in brainstorm. **Rev 2:** read-only spec review (0 blocker,
11 major, 7 minor) folded in, see §14.
**Arc:** autonomy plan A5 (D6). Baseline: `main` @ `f82faa5f8` (v0.87.1).

## 1. Why

The current story path (the **pipeline**) splits one story across about ten sessions: test-writer,
implementer, verifier, semantic and adversarial reviewers, reviewer-fix, worth-check, rectifier, NBF fixer.
Then come post-run acceptance (gen, diagnose, source-fix, test-fix, hardening) and a multi-round finish.
Two live runs on 2026-10-12 measured the cost of that shape:

| | Run A (7 stories) | Run B (7 stories) |
|---|---|---|
| Wall-clock | 263 min (stories 174, finish 62) | 346 min (stories 163, acceptance 75, finish 96) |
| Tokens through the model | 203.5M, **finish 41 %** | 308.5M, **finish 37 %** |
| Outcome | draft PR. Finish rounds found 9 → 5 → 5 findings, a new HIGH in round 3, 3 fix commits never reviewed | draft PR on the finish deadline, 11 open findings |

The reviewers don't converge. Each later lens finds HIGH findings that the earlier ones passed, and a
fresh review session after the run still found HIGH spec findings. In finish, the quality lens alone
carried about 139k tokens per round trip over 261 round trips.

**Workflow mode** replaces that with the loop of the superpowers `subagent-driven-development` skill:
- one implementer per story, which writes the tests and the code;
- a story review with spec and quality verdicts;
- a capped fix loop in a warm session, with re-reviews scoped to each fix;
- one whole-branch review with exactly one fix pass.

The advisor decides judgment calls, so nothing stalls on a human.

## 2. Goals and non-goals

**Goals:**
- An unattended run that ends in a PR plus a report: **no story ever fails or pauses**.
- Fewer sessions re-reading the same code, and bounded loops everywhere.
- Per-story model routing from `prd.json` `routing.complexity`, as today.
- Built beside the pipeline. The pipeline is unchanged and is the control arm of the A/B (§12).

**Non-goals (v1):**
- An LLM controller session ("B"). That comes later, when nax becomes a standalone coding agent.
- A generic declarative step-graph engine ("#3"). Comes later, built from the §5 step functions once A5 has won.
- Parallel stories: workflow mode forces them off (§4).
- Changes to `nax plan` or the PRD format.
- Deleting pipeline code. Any deletion is a separate pass after the A/B.

## 3. Rulings (user, 2026-10-12 brainstorm)

| # | Ruling |
|---|---|
| W-R1 | A deterministic TS loop drives the workflow (A). An LLM controller (B) is a later experiment. A step-graph engine (#3) is a later promotion |
| W-R2 | The implementer must do **TDD with evidence**: for each AC, a test written first and seen failing, then passing. The failing run and the passing run (commands and output) go in the report. Missing evidence, or a test that asserts nothing, is a spec ❌ |
| W-R3 | **No story fails or stalls.** End states: `complete` / `complete-with-rulings` / `complete-gate-open`. At the cap the advisor rules and the run continues. A red gate stays red (D4) |
| W-R4 | Role models: new optional `workflow.models.*` keys, falling back to the existing keys. **One** story-review model in v1 |
| W-R5 | An advisor **pre-flight** before the first story, ruling on conflicts |
| W-R6 | Integration: approach 1, a stage swap. Classic path untouched |
| W-R7 | Naming: `execution.mode: "pipeline" \| "workflow"`, settings under top-level `workflow`, profile `workflow`, code under `src/workflow/` |
| W-R8 | Timeouts are configurable. Defaults: review 30 min, fix 60 min, implement 60 min, CI wait 20 min |
| W-R9 | **CI wait timeout = pending, not failed.** The workflow continues, and pending doesn't block a ready PR |
| W-R10 | The advisor gets a model ladder (`advisor.fallbackModels`), with sticky skipping of quota-exhausted providers |
| W-R11 | Stories run one at a time. Gates keep today's schedule (lint/typecheck/scoped after each turn, full suite once per story) |

Binding constraints from the autonomy plan (§6 there):
- never a cheaper implementer tier;
- no turn cap on the agentic loop;
- fix cycles accumulate context by design;
- gates stay deterministic, and the advisor never turns a red gate green (D4);
- nax never merges;
- acceptance is off (D5);
- #1801 stays a held scope decision.

## 4. Configuration

```jsonc
"execution": { "mode": "pipeline" },   // "pipeline" (default) | "workflow"
"workflow": {                          // read only when execution.mode = "workflow"
  "models": {                          // all optional, ConfiguredModel
    "storyReview":  null,              // falls back to review.semantic.model
    "branchReview": null,              // falls back to finish.reviewers.quality
    "branchFix":    null               // falls back to finish.reviewers.fix (the finish-fix model)
  },
  "maxFixRounds": 5,                   // int >= 1. Warm rounds = min(3, max); rounds after that are fresh
  "preflight": true,
  "timeouts": {
    "implementMs": 3600000,
    "fixMs":       3600000,
    "reviewMs":    1800000,            // story review, re-reviews, branch review, pre-flight, advisor calls
    "ciWaitMs":    1200000,
    "ciPollMs":    30000
  }
},
"advisor": {
  "model": { /* primary, unchanged */ },
  "fallbackModels": []                 // new: ConfiguredModel[] (the schema already accepts tier strings)
}
```

**Normalisation (one choke point).** After config merge, in the loader path that `loadConfig` and
`loadConfigForPackage` share, so a package config can't undo it: when `execution.mode = "workflow"`, force
the following and log one warning that names every key it overrode.

| Forced key | Value | Why |
|---|---|---|
| `acceptance.enabled` | `false` | D5. This covers every reader: `unified-executor.ts:134,:221`, `runner-completion.ts:174,:221` (per-package `groupConfig`), `run-initialization.ts:139`, `acceptance-setup.ts:206,:488`, `acceptance.ts:199`, `give-up-advice.ts:81`, `finish/advise.ts:269`, `execution-description.ts:101` |
| parallel | off | W-R11 |
| `advisor.enabled` | `true` | Workflow kinds ignore `advisor.callers` |

- **Ownership.** `workflow.*` and `execution.mode` are **root-only** keys (`root-only-keys.ts`), like
  `advisor`. The plan adds them to the root-only list, `config-descriptions.ts`, `nax config` display, and
  the profile-threading check.
- **Schema files.** New `config/schemas-workflow.ts` and `config/runtime-types-workflow.ts`. `schemas.ts`
  (551 lines) and `runtime-types.ts` (582) only get one-line imports.
- **Timeout names.** `workflow.timeouts` is separate from `finish.timeouts`. Finish doesn't run in workflow
  mode, so there's no precedence to decide.
- **Implementer model:**
  - always per-story routing: `routing.complexity` → `complexityToModelTier` (`routing/router.ts:99`) →
    `resolveModelForAgent` (`config/schema-types.ts:263`), with profile pins honoured (`storyRoutingModel`,
    `operations/story-routing-model.ts:17`);
  - the rung for escalation is `(story.routing.modelTier, agent)`. Fresh rounds step up with
    `escalateTier(rung, autoMode.escalation.tierOrder)` (`execution/escalation/escalation.ts:34`). If that
    returns `null` (last rung), or the story has a literal profile pin, the round stays on the same model,
    still in a fresh session;
  - `routing.testStrategy` is ignored.
- **Global profile `workflow`** sets `execution.mode: "workflow"`.

## 5. Architecture

### 5.1 Selection (per story)
- **New pipeline.** `pipeline/stages/index.ts` gets a lazy **`getWorkflowPipeline()`** that mirrors
  `getDefaultPipeline` (a Proxy/lazy build, to avoid the existing TDZ cycle), and exports it. Stages:
  queue check, routing, constitution, context, **`workflowStage`**, completion. The prompt and optimizer
  stages are dropped, because the workflow builds its own prompts.
  `workflowStage` is imported lazily, so `src/workflow` → `operations` doesn't add a load-time cycle
  (`check:import-cycles`).
- **Where it's chosen.** At `execution/iteration-runner.ts:237`, pick `getWorkflowPipeline()` when
  `execution.mode = "workflow"`. `parallel-worker.ts:92` and `merge-conflict-rectify.ts:220` are reachable
  only in parallel mode, which normalisation forces off. They aren't changed, and each gets a guard that
  throws if it's ever reached in workflow mode.

### 5.2 `workflowStage` contract (with the unchanged stages around it)
- **It sets only `ctx.agentResult`** (P2-R1, §15): success, with cost, tokens and duration summed over every
  workflow session of the story. It does not set `storyStartTime`, `storyGitRef` or `storyMetrics`:
  - `ctx.storyStartTime` and `ctx.storyGitRef` are set by `iteration-runner`. `storyGitRef` is the story's
    persisted start ref, which the stage reads as BASE;
  - `ctx.storyMetrics` is computed by `completionStage`.
- **It always returns `continue`**, never `escalate` or `fail` (W-R3).
- **Marking stays with `completionStage`.** It still calls `markStoryPassed` (`completion.ts:145`). The
  workflow's Close step **doesn't mark** (no double write); it records the end state in the ledger only.
- **Approvals.** It inherits what `executionStage` does that still applies: the approval store and
  `dispatchAsk` wiring for tool approvals. It doesn't run `resolveAcceptanceExecution` or the post-run
  inspection.
- **Logging.** Every log call carries `storyId` (`check-logger-storyid`).

### 5.3 Feature level
- **Run start.** In workflow mode, `unified-executor` runs **pre-flight** (§8) once before the first
  iteration, and skips:
  - the pre-run acceptance pipeline (`:134`);
  - the post-run acceptance pipeline (`:221`).

  The deferred **plugin** review (`:183`, a deterministic SAST scan, about 4 s) **stays**: it's a gate, not an LLM review.
- **Run end.** `runner-completion.ts` stays at about 587 lines, so it only gets delegates:
  - `handleRunCompletion` is called with `skipRegression: true`, because §7's gates subsume the deferred
    regression gate;
  - the acceptance loop block (`:174-229`) is skipped (acceptance is forced off anyway);
  - the `_runnerCompletionDeps.runFinishPhase` dependency delegates to **`runWorkflowFeature`** (`@/workflow`,
    dynamic import, same pattern as `runFinishPhase`) in workflow mode. It runs at the same point, before
    `runtime.close()`, and is fail-open the same way.
- **Exit reasons:**

  | Exit | Behaviour |
  |---|---|
  | All stories done, or cost limit | The feature workflow runs |
  | Abort / SIGINT | No feature workflow. The run stops, and the ledger allows resume. Stopping is the user's choice, not a stall |

### 5.4 Code layout
- **Step functions:** `src/workflow/`, one file per step. Each is a pure-ish
  `(ctx, input) => Promise<result>` with an injectable `_deps`:
  - `brief.ts`, `implement.ts`, `gates.ts`, `story-review.ts`, `fix-round.ts`, `re-review.ts`,
    `adjudicate.ts`, `close.ts`;
  - `preflight.ts`, `branch-review.ts`, `branch-fix.ts`, `ci-wait.ts`, `finalize.ts`;
  - `ledger.ts`, `result.ts`, `stage.ts` (`workflowStage`), `story-loop.ts` (the state machine),
    `feature.ts` (`runWorkflowFeature`), `index.ts`.

  These are the units that #3 promotes to a step graph and that B exposes as tools.
- **Ops:** `operations/workflow-*.ts`, `RunOperation`s on the `callOp` contract (`operations/call.ts:41`,
  `types.ts:258`): `workflowImplementOp`, `workflowStoryReviewOp`, `workflowReReviewOp`,
  `workflowBranchReviewOp`, `workflowBranchFixOp`.
  - Each declares its tools (`check-op-tool-capability`).
  - Prompt text lives only in `prompts/builders/workflow-*-builder.ts`: implementer, story-review,
    re-review, branch-review, branch-fix, and the advisor kinds in `advisor-builder` siblings.
  - Deterministic gates reuse `lintCheckOp`, `typecheckCheckOp`, `verifyScopedOp` and `fullSuiteGateOp`.
- **Size budget.** Every new file stays under the 600-line source / 800-line test gate.
  `agents/manager.ts` (600) and `session/manager.ts` (658, grandfathered) must not grow.

### 5.5 Sessions
- **How reuse works.** It keys on the **session name** plus the **same endpoint**. The name comes from
  `formatSessionName` (`runtime/session-name.ts`), whose suffix is the **role** when the role isn't `main`;
  `pipelineStage` doesn't affect the name. Endpoint identity is checked in `decideReuse`
  (`endpoint-identity.ts:38-49`).
- **Roles and stages:**

  | Role | Stage | Used for |
  |---|---|---|
  | `wf-implementer` | `run` | The first implementer turn and fix rounds 1..min(3, max). Same name, same model → the **same warm session**. Kept open (`lifetime: "warm"` + `keepOpen`) across rounds and closed at story close |
  | `wf-implementer` | `run` | A fresh round after that, on a stepped-up model: the endpoint differs, so the old session closes and a new one opens. If the model is the same (last rung or pinned), the session is closed explicitly first, so the round really is fresh |
  | `wf-story-review`, `wf-rereview`, `wf-branch-review` | `review` | Fresh, read tools |
  | `wf-branch-fix` | `run` | Fresh, write tools |

  `pipelineStage` is the closed permission enum (`config/permissions.ts:21-30`). Stage `run` keeps today's
  implementer write grants, and `review` keeps reviewer read grants. The MCP stage copy
  (`McpStageSchema`) doesn't need new values.
- **Registration.** The new roles are added to `CanonicalSessionRole` and `KNOWN_SESSION_ROLES`
  (`runtime/session-role.ts`) and to the role table in `docs/architecture/agent-adapters.md` Rule 2 (that
  rule requires it).
- **Follow-up turns** in the warm session go through the op's hop `send`, or
  `SessionManager.getLiveHandle` + `sendPrompt` (`session/manager.ts:388`, `:539`).

## 6. Story workflow (`workflowStage`, one story)

Record `BASE = HEAD` first. Per-story artifacts live under `<storyDir>` =
`<outputDir>/<project>/workflow/<feature>/<runId>/<storyId>/`.

1. **Brief** (`brief.md`):
   - the story description, ACs word for word, `contextFiles`, `expectedFiles`;
   - the **feature spec path** (`.nax/features/<feature>/spec.md`, resolved the way finish resolves it) plus
     the sections of it that mention the story id or one of its AC ids. The PRD has no spec-section field,
     so the brief points at the spec and the agent reads it;
   - the "Story Context" and project rules from the context bundle;
   - pre-flight rulings for the story, rulings carried from earlier stories, and a warning if a dependency
     ended `complete-gate-open`: "you are building on a red base: …".

   Report path: `<storyDir>/report.md`.
2. **Implement** (`workflowImplementOp`, warm, routed model, write tools, `implementMs`).
   - The prompt follows the skill's implementer template:
     - TDD for each AC with evidence (W-R2);
     - focused tests while iterating;
     - commit;
     - self-review;
     - write `report.md` with what was built, TDD evidence, files changed, and **Decisions & assumptions**;
     - never dispatch sub-agents or reviewers.
   - It returns `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` plus commits and a one-line test summary.
   - `NEEDS_CONTEXT` / `BLOCKED` → the advisor `implementer-question` answers into the same session, at most
     2 times per story. After that the work goes on to review with the concern attached.
   - If the implementer didn't commit, auto-commit and note it in the ledger.
3. **Gates:** lint, typecheck, scoped tests. A red gate, **or a gate command that errors** (a spawn error,
   or a non-zero exit with no test results), becomes a finding and goes to a fix round with no review spent.
4. **Story review** (`workflowStoryReviewOp`, fresh, `storyReview` model, tools Read/Glob/Grep/Git, `reviewMs`).
   - Inputs: `brief.md`, `report.md`, and a **review package** for `BASE..HEAD` (commit list, `--stat`,
     `diff -U10`, all in one file).
   - The package goes through `truncateDiff` (`@/review`). Truncated files are listed by name so the
     reviewer can read them.
   - JSON output:
     ```json
     { "spec": "pass|fail", "quality": "approved|changes",
       "findings": [{ "severity": "critical|important|minor", "kind": "spec|quality",
                      "file": "…", "line": 0, "acId": "AC-3", "issue": "…", "suggestion": "…" }],
       "cannotVerify": ["…"] }
     ```
   - `cannotVerify` items go to the ledger for the branch review.
5. **Fix loop.**
   - **Trigger:** `spec = fail` or any critical/important finding. Minor findings → ledger
     `deferred-minor` and never start a round.
   - **Warm rounds:** the open findings go word for word into the warm session.
   - **Fresh rounds:** a fresh session one tier up (§4), with the brief, the report and the findings, framed
     as "a prior implementer tried N times; you own it now; read the report".
   - **Each round:**
     - the implementer fixes, re-runs the covering tests, and appends a fix report;
     - then gates;
     - then a **scoped re-review** (`workflowReReviewOp`, fresh). It gets the findings, brief, report and only
       the `FIX_BASE..HEAD` package, and returns `ADDRESSED | NOT_ADDRESSED` per finding plus new breakage in
       the fix diff only. New critical/important breakage joins the open list. Anything else goes to
       deferred minors.
   - Gate rounds and review rounds share the one cap.
6. **Regression:** the full-suite gate once the loop closes. Red with rounds left → loop. Red at the cap → carried.
7. **Cap:** anything open after the last round → advisor `residual` (§8), one batched call for the story.
   - Review items → parked or ruled load-bearing. A load-bearing instruction goes into dependents' briefs.
   - A red gate gets a diagnosis and stays red.
8. **Close:**
   - **State:** `complete` / `complete-with-rulings` / `complete-gate-open`, written to the ledger and
     `result.json`. Marking prd.json is left to `completionStage` (§5.2).
   - Close the warm session.

**Failure handling inside a story (W-R3):**

| Failure | Behaviour |
|---|---|
| Implementer or fix session fails, not quota (auth, transport, crash) | First the existing `agent.fallback.map` hop on the same op. If that still fails, the round counts as used, and a synthetic finding goes into the loop: "implementer session failed: <error>" |
| Review or re-review reply unparseable after the op's parse retry | The review counts as not run (ledger `review-skipped`). Open findings stay open. With no prior review, the story proceeds to the next step, and the branch review gets the story flagged "unreviewed" |
| A step time limit (§10) | Interrupt. Uncommitted edits **stay in the working tree**. The next round's prompt names the uncommitted files and continues from them. There's no patch set-aside: #2472's set-aside is tied to finish state (`AuditTarget`, `FixBase`) and isn't reused |
| Cost limit reached mid-story | Stop the loop at the current step. The story ends `complete-gate-open` (ledger reason `cost-limit`). Later stories become `not-run`, then the feature workflow runs |
| Abort / SIGINT | Stop. No feature workflow (§5.3) |

## 7. Feature workflow (`runWorkflowFeature`, after the last story)

1. **Repo gates:** `runQualityGates` (`finish/gates/quality.ts:125`) across every package. Red results become
   branch findings.
2. **Branch review** (`workflowBranchReviewOp`, fresh, `branchReview` model, tools Read/Glob/Grep/Git, `reviewMs`).
   - Inputs:
     - the spec, `prd.json` and the pre-flight rulings;
     - a review package for `seed..HEAD` (truncated as in §6);
     - the ledger's deferred minors, parked rulings, `complete-gate-open` / unreviewed / `not-run` stories
       and `cannotVerify` items;
     - the repo-gate findings.
   - **`seed`** is a new helper, `git merge-base <default branch> HEAD`. The default branch comes from
     `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`.
   - Remit:
     - cross-story integration and contracts;
     - reachability, consistency and duplication;
     - **triage each deferred minor** as `fix-now | leave`.
   - **No mandatory per-function walk.**
   - Output: the §6 JSON plus `minorTriage`.
3. **One branch fix** (`workflowBranchFixOp`, `branchFix` model, write tools, `fixMs`). It gets findings,
   fix-now minors, red repo gates and gate-open failures, and fixes, tests, commits and appends to
   `feature-report.md`.
4. **One scoped re-review** of the branch-fix diff.
5. **Adjudication:** the advisor `residual` covers whatever is open. **No second fix pass.**
6. **Gates again:** repo gates + full suite. Red → draft. There's no further fix.
7. **Push, then CI wait** (`ci-wait.ts`, new code). See §7.1.
8. **Approval:** the advisor `finish-approval` (existing). **Ready** only if:
   - every gate is green;
   - CI isn't `failed`;
   - no story is `complete-gate-open` or `not-run`;
   - no ruling is flagged for a human;
   - and the advisor approves.

   Otherwise draft.
9. **PR:** `commitAndPush` (`finish/commit.ts:167`), then `openDraftFinishPr` (`finish/pr/open.ts:203`) /
   `openPr` (`forge/pr.ts:77`) with `draft` from step 8. The body is built by a new
   `workflow/pr-body.ts`, separate from `finish/pr/body.ts`. It holds:
   - a summary;
   - per-story states and rounds;
   - pre-flight rulings and every advisor decision (`finish/pr/body.ts`'s advisor section, reused);
   - parked findings, and deferred minors marked `leave`;
   - gate and CI state;
   - each story's Decisions & assumptions, condensed.

   nax never merges.

**Run result.** `RunResult.success` is `false` if any story is `complete-gate-open` or `not-run`, or the
final gates are red. The exit summary and `status.json` show per-story workflow states. prd.json `passed`
only means "don't re-run".

### 7.1 CI wait (new code)
- **Forge method:** `waitForChecks(forge, prRef, {timeoutMs, pollMs})`. Poll each command every `ciPollMs`:

  | Forge | Command |
  |---|---|
  | gh | `gh pr checks <n> --json name,state,bucket` |
  | glab | `glab mr view <n> --output json` (head pipeline status) |
- **Outcome mapping:**

  | Outcome | When |
  |---|---|
  | `green` | Every check passes |
  | `failed` | Any check fails |
  | `pending` | The timeout is reached, or the forge reports no checks or pipeline for the head |
- A CLI error counts as `pending`, and the error is logged.
- Test seam: injectable `_ciWaitDeps.spawn`.

## 8. Advisor

- **On in workflow mode** (normalisation forces `advisor.enabled = true`, §4). Workflow kinds ignore
  `advisor.callers`. Model order: `advisor.model`, then `advisor.fallbackModels`. If every model fails, the
  per-kind deterministic default in the table below applies.
- **Batched questions.** Today's `AdviceQuestion` / reply is single-choice (one `optionId`). `preflight` and
  `residual` carry N items, so this adds **`adviseBatch(items[])`**: one op call, reply `answers[]`, each
  validated on its own, and each answer written as a standard `Decision` (reusing the ledger record shape).
  An item whose answer is missing or invalid falls to that item's default.
- **Kinds and actions:**

  | Kind | When | Per-item menu → `AdviceAction` | Default if the advisor fails |
  |---|---|---|---|
  | `preflight` (batch) | Once before the first story (if `workflow.preflight`) | `follow-ac` → `supersede {target: spec}` / `follow-spec` → `supersede {target: ac}` / `reconcile` → `supersede` with `newText` / `flag-human` → `hold` (the story runs under the stated default) | `hold` for each conflict |
  | `implementer-question` | `NEEDS_CONTEXT` / `BLOCKED` (≤ 2 per story) | **new** `answer {text}` | No answer. Proceed to review with the concern |
  | `residual` (batch) | Story cap, branch adjudication | `park-reviewer-wrong` → `waive` / `park-real-deferred` → `defer` / `load-bearing` → **new** `carry {instruction, toStories}` (story scope only) (`toStories` is fixed by the menu: the story's not-yet-passed dependents, P3-R1) / `flag-human` → `hold`. Plus a free-text diagnosis for each red gate | `hold` for each item |
  | `finish-approval` | §7.8 | existing | draft |

  Pre-flight's output (overlap table + conflicts) is written to `preflight.json`. Rulings go to the ledger,
  tied to story ids, and into the affected briefs. The PRD is never edited (A1: amendments are ledger-only).
- **Touch points** (all of them; the plan lists the files):
  - `AdviceQuestionKind`, `AdviceAction` (+ `answer`, `carry`), `AdviceActionType`, `AdviceOptionFixed`, and
    `MenuFacts` (`advisor/types.ts`);
  - `buildMenu` cases (`advisor/menus.ts:89`) and reply validation (required fields per action);
  - ledger parsing (`advisor/ledger.ts` `parseLines`);
  - prompts (`prompts/builders/advisor-*`);
  - the PR-body advisor section, which renders `answer` / `carry`;
  - the batch op.

  Pipeline kinds stay single-question and unchanged. `maxRulingsPerStory` doesn't apply to workflow kinds.
  Warm advisor memory is serialised per feature as today. Workflow mode uses `stateless` unless configured.
- **Model ladder (W-R10):** a new file `advisor/ladder.ts`, used by `createAdvisor`
  (`advisor/service.ts:344`), so the pipeline's callers get it too.
  - **Next entry on:** a quota or rate-limit fault, a provider or transport error, a timeout, or an
    unparseable reply after the parse retry.
  - **Skips** any entry whose provider is in quota cooldown (§10).
  - **Audit:** records the answering model and every failed attempt.
- **Visibility:** `decisions.jsonl` (`advisor/ledger.ts:30`), the advisor audit, the workflow ledger, the PR
  body, and heads-ups for flagged rulings.

## 9. Artifacts and telemetry

`<outputDir>/<project>/workflow/<feature>/<runId>/`:
- **`ledger.md`:** the recovery map. The first line identifies the run, then the skill's line format:
  - `US-003: fix round 2/5 (…)`
  - `US-003: deferred-minor: …`
  - `US-003: Ruling: … — why — cost if wrong`
  - `US-003: complete-with-rulings (…)`
  - `US-003: review-skipped`
- **`preflight.json`**.
- **`<storyId>/`:** `brief.md`, `report.md`, `review.json`, `rereview-<R>.json`, `package-<R>.diff`.
- **Feature level:** `branch-review.json`, `branch-rereview.json`, `feature-report.md`.
- **`result.json`:** per-story state and rounds, gate and CI state, PR URL and draft flag, per-step timings,
  token totals per role, and a step marker for the feature workflow.
- **`status.json`** gains an optional `workflow` block (current step, per-story state and round). It's a
  status-writer schema extension.
- **Telemetry:** cost, usage, prompt, tool and transcript audits work as today. The new roles
  (`wf-implementer`, `wf-story-review`, `wf-rereview`, `wf-branch-review`, `wf-branch-fix`) keep the A/B
  separable.

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Crash or restart | **Resume sources: prd.json + `ledger.md` + `result.json` only.** Checkpoints (`execution/checkpoint/`) record pipeline `PhaseKind`s and aren't used in workflow mode. A story with a `complete*` line (and `passed` in prd.json) is skipped. A story stopped mid-loop resumes at its next round. If its warm session is gone, a fresh session on the **same** tier picks up with the "you own it now" framing, `report.md`, and the uncommitted files. The feature workflow resumes at the first step missing from `result.json` |
| Provider quota fault ("usage limit reached", token-plan 429) | **Sticky for the run, keyed by provider.** Today `fail-quota` is agent-scoped (`agents/retry/failure-policy.ts:62-66`). For the multi-provider `native` agent that would cool down every provider, so live runs showed the quota 429 retried on every call. PR1 (1) classifies the token-plan or usage-limit 429 (e.g. MiniMax `2056`) as `fail-quota`, and (2) for multi-provider agents, scopes the `fail-quota` run cooldown to the **provider** (`CooldownStore`, `agents/cooldown-store.ts`, new keying in a new helper file; `agents/manager.ts` doesn't grow). Every role then goes straight to the next `agent.fallback.map` rung, and the advisor ladder skips that provider |
| Step time limit | Interrupt. A review counts as not run. For fix and implement turns, edits stay in the tree (§6) |
| No TDD evidence, or a test that asserts nothing | Story-review spec ❌ finding → fix loop |
| Edits outside the story's `expectedFiles` | No hard scope gate. The story review judges it. The `.nax` write protection stays |
| `execution.costLimit` reached | §6 failure table |
| Implementer didn't commit | Auto-commit, recorded in the ledger |

## 11. Testing

Every new file needs its own tests: the coverage gate is per file (`coverage-per-file-baseline`).

- **Unit tests** (`_deps` injection, TDD):
  - **Story loop:** warm rounds = min(3, max); fresh rounds step up, and stay on the same model at the last
    rung or with a pin; the shared cap; minors deferred; new breakage joins; `maxFixRounds` = 1/3/5.
  - **Stage contract:** `workflowStage` sets only `agentResult` (P2-R1; `storyStartTime`/`storyGitRef` come from
    `iteration-runner`, `storyMetrics` from `completionStage`), returns only
    `continue`, and doesn't mark prd.json (exactly one mark).
  - **End states and run result:** end-state derivation, `RunResult.success` false on gate-open or not-run,
    and the ready/draft rules (CI `pending` vs `failed`).
  - **Normalisation:** a package config with `acceptance.enabled: true` is overridden; parallel is forced
    off; advisor enabled; one warning names the overrides.
  - **Config:** model fallback (`workflow.models.*` → existing keys) and the timeout defaults.
  - **Parsers and prompts:** implementer status, story review, re-review, and the batch reply. The prompt
    builders include the TDD-evidence, report-contract, Decisions & assumptions and no-sub-agents sections.
  - **Advisor:** batch validation and per-item defaults, the `answer` / `carry` ledger round-trip, the ladder,
    and audit of the answering model.
  - **Quota:** the MiniMax `2056` 429 is classed as `fail-quota`; a provider-scoped cooldown leaves other
    providers on `native` usable.
  - **CI wait:** gh and glab outcome mapping (pass / fail / none / timeout / CLI error), with a fake spawn.
  - **Seed:** the merge-base helper.
- **Integration tests** (fake agent + fake forge):
  - the stage swap, with `"pipeline"` running exactly as before;
  - one story end to end;
  - a review that won't parse → `review-skipped`;
  - a session failure → synthetic finding;
  - crash resume with a missing warm session;
  - leftover uncommitted edits after a timeout continue in the next round;
  - the feature workflow single pass, including CI timeout → pending → PR opened;
  - prompt-audit and tool-audit rows exist for the new roles.
- **Live smoke** (billed, approval): one `nax-context-dogfood` fixture with `--profile …,workflow`.
- **Repo gates:** `check:all` before every push, plus typecheck, import cycles, file sizes and the coverage gate.

## 12. Delivery and go-live

Four stacked PRs, each code-reviewed before push:
1. **Foundations:**
   - config, the schema files and normalisation (`execution.mode`, `workflow.*`, `advisor.fallbackModels`,
     the forced keys);
   - provider-scoped quota cooldown + token-plan 429 classification;
   - the advisor ladder.

   This PR helps the pipeline on its own.
2. **Story loop:** `getWorkflowPipeline`, `workflowStage`, the story loop, story ops and builders, the session
   roles, ledger and result. Advisor calls are **stubbed to their deterministic defaults**.
3. **Advisor kinds:** `adviseBatch`, the `answer` / `carry` actions, and the `preflight`,
   `implementer-question` and `residual` kinds wired into PR2's stubs.
4. **Feature workflow:** pre-flight placement, branch review, branch fix, re-review, adjudication, gates,
   the seed helper, CI wait, approval, PR body, and the executor and runner-completion delegates.

**A/B (billed, approval at each launch):**
- **Control:** the two captured 2026-10-12 runs (the baseline is in the private workspace, with `seed` tags
  in each repo).
- **Arm:** each feature from its `seed` tag, on a copy with a unique project name, using the control's
  profile list plus `,workflow`.
- **Metrics:** wall-clock, tokens through the model, $, and the final gate and CI state.
- **Quality:** a blind fresh post-implementation review session on every branch, by severity.
- **Decision rule:** HIGH+ findings no worse than the control **and** at least 30 % lower on wall-clock or
  tokens. A branch-review-only variant runs only if A5 wins on quality but misses the time/token bar.
- The default flips only by user ruling.

## 13. Future

- **#3:** a declarative step graph built from the §5.4 step functions, once A5 wins.
- **B:** an LLM controller session calling the same steps as tools.
- **Per-complexity story-review models,** if reviews on simple stories prove expensive.

## 14. Rev 2 change log (spec review 2026-10-12, 0 blocker / 11 major / 7 minor)

| Finding | Fix |
|---|---|
| M1 | §5.2 stage contract: the ctx fields `workflowStage` sets; marking stays with `completionStage` |
| M2 | §5.3 exact seams (pre/post-run acceptance, deferred review, `skipRegression`, the runFinishPhase delegate); exit reasons |
| M3 | §4 normalisation choke point |
| M4 | §5.1 lazy `getWorkflowPipeline`; parallel-worker and merge-conflict-rectify are guarded, not changed |
| M5 | Parallel forced off |
| M6 | §8 batched questions, new actions, complete touch-point list, per-kind defaults |
| M7 | §10 builds on the existing `fail-quota` / `CooldownStore`: provider scope + token-plan 429 classification; no growth in `agents/manager.ts` |
| M8 | §5.5 naming is by role + endpoint; stages `run` / `review`; role registration |
| M9 | §7.1 CI wait design; the seed helper in §7 step 2; both marked new |
| M10 | §10 resume uses ledger and result only; set-aside dropped in favour of keeping edits in the tree |
| M11 | §6 failure table; §7 `RunResult.success` |
| m1 | File-size budget (§5.4, §4) |
| m2 | Builders under `prompts/builders/` |
| m3 | Root-only keys, config descriptions, timeout naming, `ConfiguredModel[]` |
| m4 | Escalation at the last rung and for pinned stories |
| m5 | §11 tests |
| m6 | 4 PRs |
| m7 | Spec path, package truncation, status block, `leave` destination, `maxFixRounds` minimum |

## 15. PR2 plan rulings (2026-10-12)

| # | Ruling | Why |
|---|---|---|
| P2-R1 | `workflowStage` sets **only** `ctx.agentResult`. It does not set `storyGitRef`, `storyStartTime` or `storyMetrics` | `iteration-runner.ts:114-120,198-199` already sets `storyStartTime` and `storyGitRef`. `storyGitRef` is the story's **start** ref, persisted in prd.json (BUG-114), and `completionStage` diffs from it. Spec §5.2 said "final HEAD", which would break that diff. `completionStage:80-86` computes `storyMetrics` itself. The stage reads `ctx.storyGitRef` as `BASE`, which also makes BASE survive a crash |
| P2-R2 | PR2 registers three roles: `wf-implementer`, `wf-story-review`, `wf-rereview`. PR4 registers `wf-branch-review` and `wf-branch-fix` | YAGNI: nothing in PR2 opens a branch session |
| P2-R3 | The `status.json` `workflow` block and per-role token totals in `result.json` move to PR4 | Both feed the feature report. PR2's `result.json` carries per-story state, rounds, gates and step timings |
| P2-R4 | Step time limits reuse finish's mechanism: implement/fix turns get a **soft interrupt** (`send(prompt, { interrupt })`, as `finish-fix.ts` does) and no handoff turn. Reviews get a step `signal`. `src/finish/step-signal.ts` moves to `src/utils/step-signal.ts` so both can import it | Finish already proved this: the agent's own timeout trails the step limit by `STEP_TIMEOUT_MARGIN_MS`, so a stale-retry never re-runs a stopped turn |
| P2-R5 | A fresh fix round **always** closes the live `wf-implementer` session first, whatever the model | One rule covers both spec cases: a stepped-up model, and the last rung or a pinned story, where the endpoint is the same |
| P2-R6 | The brief takes `rulings` and `redBaseDependencies` inputs. PR2 passes no rulings (pre-flight and carry are PR3/PR4). It computes red-base warnings from this run's `result.json` | The seam exists now, so PR3 only fills it |
| P2-R7 | Spec excerpts in the brief match sections that mention the **story id**. Bare `AC-n` ids are not matched | Every story has an `AC-1`, so matching bare ids would paste most of the spec. The brief always gives the spec path |
| P2-R9 | A prior record whose phase is still `implement` (a crash during the first turn) is **not** resumed: the story starts over, and the new session sees the uncommitted edits in the tree. Records past the first turn resume at the next round | §10 resumes "a story stopped mid-loop". Before the first turn ends there is no review state or finding list to resume into |
| P2-R8 | `parseImplementerReply`, `parseStoryReviewReply` and `parseReReviewReply` and the finding/reply types live in `src/operations/` | `src/workflow` imports `src/operations`. The ops can't import `src/workflow` back without a cycle |

## 16. PR3 plan rulings (2026-10-12)

| # | Ruling | Why |
|---|---|---|
| P3-R1 | `answer` and `carry` take their text from the reply's existing `instruction` field. `carry.toStories` is **fixed by the menu**: the story's not-yet-passed dependents. The carry option appears only when such dependents exist | It reuses the reply contract and validator unchanged. nax knows which stories depend on this one; the advisor can't aim an instruction at an unrelated story |
| P3-R2 | Pre-flight is **one** batch call in "discover" mode. The advisor lists the conflicts it finds, and each one is validated against the fixed four-option pre-flight menu built from that conflict's own AC and spec references. There is no separate scan call | One call, as spec §8 asks. The menu stays closed: nax builds it, the advisor only picks from it |
| P3-R3 | `adviseBatch` never writes a default decision. It returns a result per item (`decision` or `fallbackReason`), and the caller applies the kind's default (`hold`) | Only advisor-written lines reach `decisions.jsonl`, so `readTrustedDecisions` (audit-matched) keeps its meaning |
| P3-R4 | `AdviceDecision` gains an optional `appliesTo?: string[]`: a pre-flight conflict's story ids, or a carry's `toStories`. The brief selects rulings by it | One field answers "which briefs carry this ruling" for both kinds |
| P3-R5 | Batch calls are always stateless and walk the model ladder, whatever `advisor.memory` says. The single `implementer-question` goes through `advise()`, which honours `memory` (default `stateless`) | A warm session is bound to one model and one question chain (spec §8). A batch is a one-shot judgement |
| P3-R6 | `runPreflight` ships here and is tested directly. Calling it once before the first story is PR4's "pre-flight placement" | Spec §12 splits it that way |
| P3-R7 | A batch writes **one audit artifact per decision** (shared prompt, the item's own raw answer, its share of the cost) | `readTrustedDecisions` matches each ledger line to `advisor-audit/<feature>/<D-n>.json`; this keeps that check unchanged |
| P3-R8 | Residual gate diagnoses are free text. They return from the batch and go into the workflow ledger as today; they are not decisions | Spec §8: "a free-text diagnosis for each red gate"; a red gate stays red (D4) |
| P3-R9 | A workflow ruling's "cost if wrong" is derived from the reply: `<confidence> confidence; reversible` or `hard to undo`, plus `; needs confirmation` when flagged | The reply contract has no cost field; the skill's ledger line needs one |
| P3-R10 | PR2 carry-overs: the advisor-answer turn reuses the current round's model and time limit (PR2 final review M1); `adjudicateResidual` keeps the first ruling per finding and warns on duplicates and on rulings for unknown findings (PR2 T9) | Without M1, an answer would open a different session (the routed model) with no context once answers are real |

## 17. PR4 plan rulings (2026-10-12)

| # | Ruling | Why |
|---|---|---|
| P4-R1 | The feature workflow's state is a `WorkflowFeatureRecord` under `featureWorkflow` in the current run's `result.json`, rewritten after every step; an unfinished prior record is resumed at its step; a `done` record at the current HEAD skips the workflow | §10 resume; a re-run must not open a second review or rewrite the PR |
| P4-R2 | Story states for the feature workflow come from every run's `result.json` (newest wins per story); passed-without-record = `complete`; otherwise `not-run` | Resumed and re-run features span run dirs |
| P4-R3 | Draft first: push, draft PR, CI wait on it, approval, then promote or keep the draft | `gh pr checks` / `glab mr view` need a PR; finish's D7 order |
| P4-R4 | CI wait polls through "no checks yet" and running checks until `ciWaitMs` (→ `pending`); a CLI error or unparseable output is `pending` at once | Checks register after the push; W-R9 |
| P4-R5 | Gates again = `runQualityGates` again (its `test` gate is the full suite), only when the branch fix ran; no configured commands = "nothing verified" (draft reason, not red) | `fullSuiteGateOp` is story-scoped |
| P4-R6 | Ready also requires that the branch review ran | Unreviewed cross-story code must not go ready |
| P4-R7 | The fix gets review findings, fix-now minors, red repo gates and gate-open stories; the re-review judges review findings and fix-now minors; gates judge gates; adjudication covers review findings still open; unaddressed fix-now minors become `leave` | Mirrors the story loop |
| P4-R8 | An untriaged minor is `leave` | Fail-safe |
| P4-R9 | The feature-scoped advisor has no heads-up channel in PR4; flagged rulings keep the PR a draft and are listed in the body | No `PipelineContext` at feature level |
| P4-R10 | The advisor is asked to approve only when every deterministic condition holds; menu approve/hold; failure = draft | §7.8, §8 default |
| P4-R11 | Dry run / abort skip the feature workflow; a non-feature branch, no forge, or a failed push end `local-only` | Finish's push rules |
| P4-R12 | The `status.json` `workflow` block is set at each feature step and persisted by the post-finish status write; one `Workflow complete` log line is the exit summary | Heartbeat is stopped before finish |
| P4-R13 | `RunnerCompletionResult.workflowPassed` (optional) ANDs into `RunResult.success`; a feature-workflow throw is `false` | §7 run result |
| P4-R14 | Pre-flight runs in `executeUnified` before the loop, fail-open, over stories not yet passed; a reusable prior `preflight.json` is adopted first | No duplicate pre-flight decisions on resume |
| P4-R15 | Seed = merge-base(origin default) → merge-base(main) → first persisted `storyGitRef`; none → branch review skipped | §7.2 plus a repo without `main` |
| P4-R16 | Finish / workflow delegation lives in `execution/end-phase.ts` | `runner-completion.ts` file-size limit |
| P4-R17 | Prompt-/tool-audit rows for the new roles are checked in the live smoke | Needs a real session |
| P4-R18 | Branch adjudication is PR3's residual batch with no `storyId` (`_run`), no carry, no gate diagnoses | Branch findings are not story-scoped |
| P4-R19 | PR3 carry-overs M2, M5, M6 | Deferred by the PR3 final review |
| P4-R20 | The branch fix reuses the implementer reply contract and parser; one shared `softInterruptTurn` | One write-turn contract |
| P4-R21 | `workflowConfigSelector` gains `finish` for the branch model fallbacks | §4 fallbacks |
