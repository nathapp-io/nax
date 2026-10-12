# Workflow mode (A5): single implementer + bounded review loop

**Date:** 2026-10-12 · **Status:** design approved in brainstorm, spec under review
**Arc:** autonomy plan A5 (D6). Baseline: `main` @ `8e7bfb2b2` (series B merged).

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
- An LLM controller session ("B": the controller is an agent calling nax tools). That comes later, when nax
  becomes a standalone coding agent.
- A generic declarative step-graph engine ("#3"). Comes later, built from the step functions in §6 once A5 has won.
- Parallel stories.
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
- acceptance is off (D5): workflow mode forces `acceptance.enabled = false` whatever the project config says;
- #1801 stays a held scope decision.

## 4. Configuration

```jsonc
"execution": { "mode": "pipeline" },   // "pipeline" (default) | "workflow"
"workflow": {                          // read only when execution.mode = "workflow"
  "models": {                          // all optional (ConfiguredModel)
    "storyReview":  null,              // falls back to review.semantic.model
    "branchReview": null,              // falls back to finish.reviewers.quality
    "branchFix":    null               // falls back to the finish-fix model
  },
  "maxFixRounds": 5,                   // rounds 1-3 warm session; 4..max fresh session, one tier up
  "preflight": true,
  "timeouts": {
    "implementMs": 3600000,
    "fixMs":       3600000,
    "reviewMs":    1800000,            // story review, re-reviews, branch review, pre-flight, advisor calls
    "ciWaitMs":    1200000
  }
},
"advisor": {
  "model": { /* primary, unchanged */ },
  "fallbackModels": []                 // new, ordered list of ConfiguredModel | tier name
}
```

- **Implementer model:** always per-story routing. `routing.complexity` → `complexityToModelTier`
  (`routing/router.ts:99`) → `resolveModelForAgent` (`config/schema-types.ts:263`), with profile pins
  honoured (`storyRoutingModel`, `operations/story-routing-model.ts:17`).
- **Fix rounds 4+** step up one rung with `escalateTier(rung, autoMode.escalation.tierOrder)`
  (`execution/escalation/escalation.ts:34`). On the last rung, they stay there.
- **`routing.testStrategy`** is ignored in workflow mode.
- **Schema:** a new `config/schemas-workflow.ts`. `execution.mode` is added to `ExecutionConfigSchema`.
  `advisor.fallbackModels` defaults to `[]`, so behaviour is unchanged until it's set.
- **Global profile `workflow`** sets `execution.mode: "workflow"`.

## 5. Architecture

- **Selection.**
  - Where the per-story pipeline is chosen (`execution/iteration-runner.ts:237`, `runPipeline(defaultPipeline, …)`,
    and the same call in `parallel-worker.ts`), pick the stage list by `execution.mode`.
  - `buildWorkflowPipeline()` is `buildDefaultPipeline()` (`pipeline/stages/index.ts:44`) with
    **`workflowStage`** in place of `executionStage`.
  - Unchanged: queue check, routing, constitution, context, completion.
  - With `"pipeline"`, nothing new executes.
- **Feature level** (`execution/runner-completion.ts`), in workflow mode:
  - before the first story, run pre-flight (§8);
  - after the last story, run the feature workflow (§7) in place of the post-run acceptance loop and
    `runFinishMachine` (`finish/machine.ts:353`).
  - The deferred regression gate is subsumed by §7's gates.
- **Code:** `src/workflow/`, one file per step. Each is a pure-ish `(ctx, input) => Promise<result>` with an
  injectable `_deps`:
  - `brief.ts`, `implement.ts`, `gates.ts`, `story-review.ts`, `fix-round.ts`, `re-review.ts`,
    `adjudicate.ts`, `close.ts`;
  - `preflight.ts`, `branch-review.ts`, `branch-fix.ts`, `finalize.ts`;
  - `ledger.ts`, `stage.ts` (the `workflowStage` driver), `story-loop.ts` (the state machine).

  These are the units that "#3" promotes to a step graph and that "B" exposes as tools.
- **Ops:** new `RunOperation`s under `operations/workflow-*.ts`, following the `callOp` contract
  (`operations/call.ts:41`, `operations/types.ts:258`): `workflowImplementOp`, `workflowStoryReviewOp`,
  `workflowReReviewOp`, `workflowBranchReviewOp`, `workflowBranchFixOp`. The deterministic gates reuse
  `lintCheckOp`, `typecheckCheckOp`, `verifyScopedOp` and `fullSuiteGateOp`.
- **Warm session:**
  - The implementer's first turn and fix rounds 1-3 use **one session** (role `wf-implementer`, one shared
    `stage` key), opened with `lifetime: "warm"` and kept open across rounds.
  - Session reuse keys on role and stage (`runtime/session-name.ts:12`). Today the implementer (`"run"`)
    and the rectifier (`"rectification"`) differ in stage, which is why they get separate sessions.
  - Follow-up turns go through `SessionManager.getLiveHandle` + `sendPrompt` (`session/manager.ts:388`,
    `:539`), or the op's hop `send`.
  - The session closes at story close, or before round 4.

## 6. Story workflow (`workflowStage`, one story)

Record `BASE = HEAD` first. Per-story artifacts live under `<storyDir>` =
`<outputDir>/<project>/workflow/<feature>/<runId>/<storyId>/`.

1. **Brief** (`brief.md`):
   - the story description, ACs word for word, `contextFiles`, `expectedFiles`;
   - the spec sections the story cites;
   - pre-flight rulings for the story, and rulings carried from earlier stories;
   - the global constraints: the cited spec sections plus project rules from the context bundle.

   Report path: `<storyDir>/report.md`.
2. **Implement** (`workflowImplementOp`, warm, routed model, write tools, `implementMs`).
   - The prompt follows the skill's implementer template:
     - TDD for each AC with evidence (W-R2);
     - focused tests while iterating;
     - commit;
     - self-review: completeness, quality, YAGNI, real-behaviour tests;
     - write `report.md` with what was built, TDD evidence, files changed, and **Decisions & assumptions**;
     - never dispatch sub-agents or reviewers.
   - It returns `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` plus commits and a one-line test
     summary. On `NEEDS_CONTEXT` / `BLOCKED`, the advisor (`implementer-question`, §8) answers into the
     same session, at most 2 times per story. After that, the work goes on to review with the concern attached.
   - If the implementer didn't commit, auto-commit and note it in the ledger.
3. **Gates:** lint, typecheck, scoped tests. Red → the failures become findings and go to a fix round
   with no review spent.
4. **Story review** (`workflowStoryReviewOp`, fresh, `storyReview` model, tools Read/Glob/Grep/Git, `reviewMs`).
   - Inputs: `brief.md`, `report.md`, the global constraints, and a **review package** for `BASE..HEAD`
     (commit list, `--stat`, `diff -U10`, all in one file).
   - The prompt follows the skill's task-reviewer template.
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
   - **Rounds 1-3:** the open findings go word for word into the warm session.
   - **Rounds 4..`maxFixRounds`:** a fresh session one tier up, with the brief, the report and the findings,
     framed as "a prior implementer tried N times; you own it now; read the report".
   - **Each round:**
     - the implementer fixes, re-runs the covering tests, and appends a fix report (changes, commands,
       output, decisions);
     - then gates;
     - then a **scoped re-review** (`workflowReReviewOp`, fresh, `storyReview` model). It gets the findings,
       brief, report and only the `FIX_BASE..HEAD` package, and returns `ADDRESSED | NOT_ADDRESSED` per
       finding plus new breakage *in the fix diff only*. New critical/important breakage joins the open
       list. Anything else goes to deferred minors.
   - Gate rounds and review rounds share the one cap.
   - The diff mechanism follows the existing fix review (ADR-033, `review/fix-review/run/index.ts:233`).
6. **Regression:** the full-suite gate once the loop closes. Red with rounds left → loop. Red at the cap → carried.
7. **Cap:** anything open after the last round → advisor `residual` (§8), one call for the whole story.
   - Review findings → parked or ruled load-bearing. A load-bearing instruction goes into the briefs of
     the stories that depend on this one.
   - A red gate gets a diagnosis and stays red.
8. **Close:**
   - **State:**
     - `complete`: clean;
     - `complete-with-rulings`: review items parked;
     - `complete-gate-open`: a gate red at the cap.
   - prd.json: `markStoryPassed` (`prd/index.ts:271`) in all three cases, so resume skips the story and
     dependents run. The true gate state lives in the ledger and in `result.json`, and decides ready vs draft (§7).
   - Close the session.

## 7. Feature workflow (after the last story)

1. **Repo gates:** `runQualityGates` (`finish/gates/quality.ts:125`) across every package. Red results
   become branch findings.
2. **Branch review** (`workflowBranchReviewOp`, fresh, `branchReview` model, tools Read/Glob/Grep/Git, `reviewMs`).
   - Inputs:
     - the spec, `prd.json` and the pre-flight rulings;
     - a review package for `seed..HEAD`, where `seed` is the merge base with the default branch;
     - the ledger's deferred minors, parked rulings, `complete-gate-open` stories and `cannotVerify` items;
     - the repo-gate findings.
   - Remit:
     - cross-story integration and contracts (a client path against its server route, wire-shape mismatches);
     - reachability of new code, consistency and duplication across stories;
     - **triage each deferred minor** as `fix-now | leave`.
   - It reads code where it needs to. There's **no mandatory per-function walk**: that walk was the
     measured token cost of the A4 quality lens.
   - Output: the §6 finding JSON plus `minorTriage`.
3. **One branch fix** (`workflowBranchFixOp`, `branchFix` model, write tools, `fixMs`). It gets the complete
   list (findings, fix-now minors, red repo gates, failures from gate-open stories), and fixes, tests,
   commits and appends to `feature-report.md`.
4. **One scoped re-review** of the branch-fix diff.
5. **Adjudication:** the advisor `residual` covers whatever is still open. **No second fix pass.**
6. **Gates again:** repo gates + full suite. Red → the PR is draft. There's no further fix.
7. **Push, then CI wait** (`ciWaitMs`). Outcomes: `green | failed | pending`. `pending` (timeout, or the
   forge reports no CI) doesn't block anything (W-R9).
8. **Approval:** the advisor `finish-approval` (existing). **Ready** only if:
   - every gate is green;
   - CI isn't `failed`;
   - no story is `complete-gate-open`;
   - no ruling is flagged for a human;
   - and the advisor approves.

   Otherwise **draft**.
9. **PR:** `openDraftFinishPr` (`finish/pr/open.ts:203`) or `openPr` (`forge/pr.ts:77`) with `draft` set from
   step 8, after `commitAndPush` (`finish/commit.ts:167`). The body holds:
   - a summary;
   - per-story states and round counts;
   - pre-flight rulings and every advisor decision;
   - parked findings, and deferred minors left as-is;
   - gate and CI state ("CI pending at the 20-min mark" when pending);
   - each story's Decisions & assumptions, condensed.

   nax never merges.

## 8. Advisor

- **Always on in workflow mode**, whatever `advisor.callers` says, using `advisor.model` and then
  `advisor.fallbackModels`. If every model fails, a deterministic default applies: park the item, flag it
  for a human, draft PR.
- **New question kinds**, each added in four places: `AdviceQuestionKind` (`advisor/types.ts:2`),
  `MenuFacts` (`:107`), a `buildMenu` case (`advisor/menus.ts:89`), and a prompt in
  `prompts/builders/advisor-builder.ts`.

  | Kind | When | Menu | Effect |
  |---|---|---|---|
  | `preflight` | Once, before the first story (if `workflow.preflight`) | Per conflict: `follow-ac` / `follow-spec` / `reconcile` (with an instruction) / `flag-human` (runs under a stated default) | Inputs: spec, prd.json, and read access to the repo, so it can check design docs and existing code. Output: an **overlap table** (stories sharing files or interfaces, producer → consumer) and **conflicts** (AC vs AC, AC vs spec, AC vs existing design or code). Rulings go to the ledger, tied to story ids, and into the affected briefs. The PRD is never edited (A1: amendments are ledger-only) |
  | `implementer-question` | `NEEDS_CONTEXT` / `BLOCKED` (≤ 2 per story) | `answer` / `answer+ruling` | The answer goes into the warm session |
  | `residual` | Story cap (§6.7) and branch adjudication (§7.5) | Per item: `park-reviewer-wrong` / `park-real-deferred` / `load-bearing` (story scope only, with an instruction) / `flag-human`. Plus a diagnosis for each red gate | One call per cap (batched). Every item becomes a ruling |
  | `finish-approval` | §7.8 | existing | existing |
- **Pipeline callers** (`finish-judgment`, `fix-cycle-give-up`, `uncategorised-failure`) are unchanged and
  stay pipeline-only. `maxRulingsPerStory` doesn't apply to workflow kinds, which the workflow already bounds.
- **Model ladder (W-R10):** try `advisor.model`, then each `fallbackModels` entry in order. Move to the
  next entry on:
  - a quota or rate-limit 429;
  - a provider or transport error;
  - a timeout (`reviewMs`);
  - a reply that won't parse after the existing parse retry.

  A provider that returns a quota 429 is skipped for the rest of the run (sticky, §10). The audit records
  the answering model and every failed attempt. The pipeline's advisor callers get the ladder too
  (`createAdvisor`, `advisor/service.ts:344`).
- **Visibility:** every ruling goes in `decisions.jsonl` (`advisor/ledger.ts:30`), the advisor audit, the
  workflow ledger, and under "Advisor decisions" in the PR body. Flagged rulings also trigger a heads-up.

## 9. Artifacts and telemetry

`<outputDir>/<project>/workflow/<feature>/<runId>/`:
- **`ledger.md`:** the recovery map. The first line identifies the run, then one line per event, in the
  skill's ledger format:
  - `US-003: fix round 2/5 (3 addressed, 1 open — …; commits a..b)`
  - `US-003: deferred-minor: …`
  - `US-003: Ruling: … — why — cost if wrong`
  - `US-003: complete-with-rulings (commits a..b, 1 parked)`
- **`preflight.json`**.
- **`<storyId>/`:** `brief.md`, `report.md`, `review.json`, `rereview-<R>.json`, `package-<R>.diff`.
- **Feature level:** `branch-review.json`, `branch-rereview.json`, `feature-report.md`.
- **`result.json`:** per-story state and rounds, gate and CI state, PR URL and draft flag, per-step timings,
  and token totals per role.
- **Also written:**
  - `status.json` gains a `workflow` block: current step, and per-story state and round;
  - cost, usage, prompt, tool and transcript audits work as today (everything goes through `callOp`).
- **New session roles:** `wf-implementer`, `wf-story-review`, `wf-rereview`, `wf-branch-review`,
  `wf-branch-fix`. Advisor kinds keep role `advisor`.

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Crash or restart | Resume from prd.json, `ledger.md` and the existing checkpoints (`execution/checkpoint/`). A story with a `complete*` line is skipped. A story stopped mid-loop resumes at its next round. If its warm session is gone, a fresh session on the **same** tier picks up with the "you own it now" framing and `report.md`. The feature workflow resumes at the first step missing from `result.json` |
| Provider quota 429 ("usage limit reached") | Classed as non-retryable. **Sticky for the run, for every role:** that provider is skipped, and calls go straight to the next rung (`agent.fallback.map`, or `advisor.fallbackModels`). No per-call fail-then-swap |
| Step time limit | Interrupt the session. A fix or implement turn's edits are set aside (patch + handoff note, #2472's mechanism) and the next round re-applies them. A review that runs out counts as not run, and its items stay open into the next step |
| No TDD evidence, or a test that asserts nothing | Story-review spec ❌ finding → fix loop |
| Edits outside the story's `expectedFiles` | No hard scope gate. The story review judges it. The `.nax` write protection stays |
| `execution.costLimit` reached | Remaining stories become `not-run` in the ledger. The feature workflow runs on what exists. Draft PR, with the reason in the body. Never a pause |
| Implementer didn't commit | Auto-commit, recorded in the ledger |

## 11. Testing

- **Unit tests** (`_deps` injection, TDD):
  - the story-loop state machine: warm rounds 1-3, fresh tier-up rounds 4+, gates and reviews sharing the
    cap, minors deferred, new breakage joining the open list;
  - end-state derivation and the ready/draft rules, including CI `pending` vs `failed`;
  - model fallback resolution (`workflow.models.*` → existing keys) and the `workflow.timeouts` defaults;
  - parsers: implementer status, story review, re-review;
  - prompt builders: the TDD evidence, report contract, Decisions & assumptions and no-sub-agents sections
    are present;
  - the advisor ladder, sticky quota skip, and audit of the answering model;
  - forcing `acceptance.enabled = false`.
- **Integration tests** (fake agent + fake forge):
  - `execution.mode` swaps the stage while `"pipeline"` runs exactly as before;
  - one story through the whole loop;
  - mid-loop crash resume from the ledger;
  - the single-pass feature workflow, including CI timeout → pending → PR opened.
- **Live smoke** (billed, approval): one `nax-context-dogfood` fixture with `--profile …,workflow`.
- **Repo gates:** `check:all` before every push, plus typecheck and the coverage gate.

## 12. Delivery and go-live

Three stacked PRs, each code-reviewed before push:
1. **Foundations:** config (`execution.mode`, `workflow.*`, `advisor.fallbackModels`), the advisor ladder,
   and sticky quota fallback for every role. This one helps the pipeline immediately.
2. **Story workflow:** `workflowStage`, the story loop, story ops, and the `implementer-question` and
   `residual` kinds.
3. **Feature workflow:** pre-flight, branch review, branch fix, re-review, adjudication, gates, CI wait,
   approval, PR.

**A/B (billed, approval at each launch):**
- **Control:** the two captured 2026-10-12 runs. Baseline is in the private workspace, with `seed` tags in
  each repo.
- **Arm:** each feature from its `seed` tag, on a copy with a unique project name, using the control's
  profile list plus `,workflow`. That gives the same per-story routing and models.
- **Metrics:** wall-clock, tokens through the model (`input + cacheRead + cacheWrite + output`), $, and the
  final gate and CI state.
- **Quality:** a blind fresh post-implementation review session on every branch, the control's included:
  same model, reviewer sees only the branch. Findings counted by severity.
- **Decision rule:** HIGH+ findings no worse than the control **and** at least 30 % lower on wall-clock or
  tokens. A branch-review-only variant runs only if A5 wins on quality but misses the time/token bar.
- The default flips to `"workflow"` only by user ruling.

## 13. Future

- **#3:** promote the §5 step functions to a declarative step graph (steps, edges, caps, branch points)
  once A5 wins.
- **B:** an LLM controller session that calls the same steps as tools, when nax becomes a standalone
  coding agent.
- **Per-complexity story-review models,** if the A/B shows reviews on simple stories are expensive.
