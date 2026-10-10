# A1 — Advisor: rule on judgment calls instead of stopping the run

**Status:** design, awaiting user review · **Date:** 2026-10-10 · **Baseline:** `main` @ `9611b61a4` (v0.85.1)
**Arc:** autonomy & lean pipeline. A1 is the first of five sub-projects: A2 acceptance retro, A3 NBF
triage, A4 finish as a branch review, A5 lean-workflow A/B. This spec covers A1 only.

---

## 1. Goal

`nax run` and the finish phase stop, pause, or escalate whenever they reach a judgment call. Examples:
a reviewer finding that "needs a human", a fix agent that gives up with `UNRESOLVED:`, a TDD failure
with no category, and the decision to promote a PR. Each stop waits for a person, often for hours, and
a stopped finish run leaves its other findings unfixed.

A1 adds an **advisor**. It knows the whole feature (spec, PRD with every story's ACs, every earlier
decision), rules on these calls, and lets the run continue. Every ruling is recorded, sent as a
heads-up when uncertain, listed in the PR body, and replayable.

**Success:**
- No run stops at an in-scope decision point once the advisor is enabled.
- Every decision is in a committed ledger, in a replayable audit artifact, and in the PR body.
- Before go-live, the offline replay on the eval seed scores ≥ 12/15 agreement with the human rulings
  and 0 unsafe disagreements (§9).

## 2. Evidence (measured over 158 runs / 71 features, 2026-09-10 → 2026-10-10)

- **The finish phase escalated 13 of 15 runs after it moved in-process** and has gone unused since.
  The 15 recorded escalations break down as:
  - 4 reviewer evidence-section gaps;
  - 1 trivial LOW;
  - 4 spec-vs-code contradictions;
  - 6 design calls.

  In every case where the human ruling is on record, the real defects were **fixed** with the
  conservative option. Waivers happened only with a spec-backed reason. Two findings in escalated runs
  were never acted on after the escalation and shipped as live defects (#2435 is one).
- **`routeReview` escalates the whole phase on one `judgment` finding** (`src/finish/route.ts:75`),
  before the fix route, so the phase's other findings are never fixed.
- **Story level:** 85 fix cycles ended `agent-gave-up` (`UNRESOLVED:`). 63 TDD failures had no failure
  category and defaulted to pause. Observed causes of give-ups:
  1. the spec contradicting its ACs;
  2. the three-session TDD role boundary: the implementer may not edit tests, and the test-writer may
     not edit source.
- **The give-up text is not logged.** Only the count is recorded, so these points have no reviewable
  history (§4.12).

## 3. Rulings (user, 2026-10-10)

| # | Ruling |
|---|---|
| R1 | **The advisor acts on every in-scope decision and the run continues.** No live shadow period. An offline replay of the eval seed gates go-live (§9). |
| R2 | **Four callers:** (1) finish judgment findings, (2) `UNRESOLVED:` give-ups in the story fix cycle, (3) uncategorised TDD failure, (4) finish approval before the PR is promoted. **Deferred:** a verifier's "incorrect test" diagnosis; the #1527 rule (terminal human review) stands. **Out of A1:** NBF triage (A3). |
| R3 | **Memory is configurable:** `advisor.memory: "stateless" \| "warm"`, default `stateless`. The decisions ledger is written in both modes and is the source of record. |
| R4 | **Read-only agent session** (Read/Grep/Glob; no write tools, no Bash). **nax writes the ledger**, never the advisor. `advisor.model` is a `ConfiguredModel`, default `"powerful"`. |
| R5 | **Spec amendments live only in the ledger.** `spec.md` and `prd.json` are never edited. A superseding decision goes into every later prompt that reads that AC, and into the PR body's "Spec amendments to apply" section. |
| R6 | **Flagged decisions send a non-blocking heads-up** through the existing notification chain. **Every decision writes a replayable audit artifact.** `nax advisor replay` re-runs a decision. Overriding by reply is out of A1. |
| R7 | **Go-live gate** for callers 1 + 4: ≥ 12/15 agreement and 0 unsafe disagreements on the eval seed, in at least one memory mode. Callers 2 + 3 go live without a seed gate, with every decision audited, and are re-evaluated after ~20 labelled live decisions. |

## 4. Design

### 4.1 Components

| Unit | Location | Purpose |
|---|---|---|
| Types | `src/advisor/types.ts` | `AdviceQuestion`, `AdviceOption`, `AdviceAction`, `AdviceDecision` |
| Option menus + guardrails | `src/advisor/menus.ts` | Per-kind closed option lists; deterministic preconditions; forced `needsHumanConfirm` |
| Ledger | `src/advisor/ledger.ts` | Append and read `.nax/features/<f>/decisions.jsonl`, sequential ids, file lock |
| Audit | `src/advisor/audit.ts` | Write `<outputDir>/advisor-audit/<feature>/<decisionId>.json` and `labels.jsonl` |
| Service | `src/advisor/service.ts` | `advise(question)`: build options → `callOp(adviseOp)` → guardrails → ledger → audit → heads-up |
| Memory | `src/advisor/memory.ts` | `stateless` / `warm` session strategy, per-feature queue for `warm` |
| Op | `src/operations/advise.ts` | `adviseOp`, run-kind, stage `advise`, role `advisor` |
| Prompt | `src/prompts/builders/advisor-builder.ts` | `AdvisorPromptBuilder` (the builder convention requires prompts to live in `src/prompts/builders/`) |
| Context provider | `src/context/engine/providers/advisor-decisions.ts` | Puts relevant decisions (esp. `supersedes`) into later prompts |
| CLI | `src/commands/advisor/*` + `bin/nax.ts` | `nax advisor list \| replay \| label \| import-finish` |
| Barrel | `src/advisor/index.ts` | Public surface |

`src/advisor/` depends on operations, config, logger and the interaction chain. Callers (finish, the
fix cycle, decide-action) depend on `src/advisor` through its barrel. Nothing in `src/advisor` imports
finish or execution modules; callers pass plain data in.

### 4.2 Types

```ts
export type AdviceQuestionKind =
  | "finish-judgment"        // caller 1
  | "fix-cycle-give-up"      // caller 2
  | "uncategorised-failure"  // caller 3
  | "finish-approval";       // caller 4
// Open union by design: A3 adds "nbf-triage", A5 may add workflow kinds (§10).

export interface AdviceEvidence {
  source: "finding" | "ac" | "spec" | "test-output" | "diff" | "agent-diagnosis" | "review-round" | "gate";
  ref?: string;            // e.g. "US-005 AC-3", "src/x.ts:42", "finding #2"
  text: string;
}

export type AdviceAction =
  | { type: "fix"; instruction: string }                                   // fix with the chosen approach
  | { type: "waive"; reason: string }                                      // keep the code as is
  | { type: "supersede"; target: SupersedeTarget; newText: string }      // spec or AC wrong, code right
  | { type: "retry"; instruction: string }                                 // same strategy, one more attempt, with the ruling
  | { type: "retarget"; to: "test" | "source"; instruction: string }       // hand across the TDD boundary
  | { type: "retry-as-lite" }                                               // three-session → lite on the next attempt
  | { type: "escalate-tier"; reason: string }                              // today's behaviour, chosen deliberately
  | { type: "defer"; reason: string }                                      // today's pause, with a diagnosis
  | { type: "approve" }
  | { type: "re-review"; phase: "spec" | "quality" }
  | { type: "hold"; reason: string };                                      // today's finish escalate, with a rationale

export type SupersedeTarget =
  | { kind: "ac"; storyId: string; acId: string }   // an AC in prd.json
  | { kind: "spec"; section: string };              // a spec.md section with no AC of its own (e.g. a design claim)

export interface AdviceOption {
  id: string;              // "A", "B", …: stable within one question
  action: AdviceAction;    // instruction/reason/newText are filled by the advisor in its reply
  label: string;           // human-readable description of the option
}

export interface AdviceQuestion {
  id: string;              // "Q-<ulid>"
  kind: AdviceQuestionKind;
  feature: string;
  storyId?: string;
  askedAtSha: string;      // HEAD when asked; replay checks this out
  summary: string;         // one paragraph: what is in conflict
  evidence: AdviceEvidence[];
  options: AdviceOption[]; // built by menus.ts, never by the advisor
}

export type AdviceConfidence = "high" | "medium" | "low";

export interface AdviceDecision {
  id: string;              // "D-<n>", sequential per feature
  questionId: string;
  kind: AdviceQuestionKind;
  storyId?: string;
  chosenOptionId: string;
  action: AdviceAction;    // with the advisor's instruction/reason/newText filled in
  rationale: string;
  confidence: AdviceConfidence;
  reversible: boolean;
  needsHumanConfirm: boolean; // advisor's flag OR'd with the forced rules in §4.3
  decidedAt: string;
  model: string;           // resolved model id
  memoryMode: "stateless" | "warm";
  auditRef: string;        // path of the audit artifact, relative to outputDir
}
```

**The advisor only chooses from a closed menu.** The caller decides which actions are legal for this
question (§4.3). The advisor picks one option id and fills in its free-text fields. A reply naming an
option that isn't on the menu is a parse failure (§5).

### 4.3 Option menus and guardrails (deterministic, `menus.ts`)

| Kind | Options offered | Preconditions (option omitted when false) |
|---|---|---|
| finish-judgment | `fix`, `waive`, `supersede`, `hold` | `supersede` only when the finding cites an AC (target `ac`) or a spec section (target `spec`) |
| fix-cycle-give-up | `retry`, `retarget`, `supersede`, `escalate-tier`, `defer` | `retry`/`retarget` only when the cycle has attempts left (`maxAttemptsTotal` / per-strategy caps) and the per-story ruling budget remains. `retarget: "test"` only when `isThreeSession` (#1330 invariant); `retarget: "source"` only when the giving-up strategy was the test-writer. `escalate-tier` only when a next tier exists |
| uncategorised-failure | `retry-as-lite`, `escalate-tier`, `defer` | `retry-as-lite` only when three-session and not already lite; `escalate-tier` only when a next tier exists |
| finish-approval | `approve`, `re-review`, `hold` | **`approve` only when every review phase's last round is complete (no evidence gaps) and the repo gates are green.** `re-review` at most once per finish run |

**Forced `needsHumanConfirm`**, regardless of what the advisor says:
- the advisor reported `confidence: "low"` or `reversible: false`;
- the action is `supersede`, `defer` or `hold`;
- the action is `waive` on a finding of severity HIGH or CRITICAL.

**Invariants** (every guardrail traces back to the seed's unsafe list):
- **No decision can change a gate result.** Gates stay deterministic. `approve` is unavailable after an
  incomplete review.
- **A supersede never edits `spec.md` or `prd.json`.** The original text and the override stay visible
  side by side.
- **The advisor has no write tools.** nax writes the ledger, the audit artifact, and any commit.

### 4.4 `adviseOp`

- `kind: "run"`; `name: "advise"`; new pipeline stage `advise` in `PIPELINE_STAGES`; new session role
  `advisor` (register it in the adapter-wiring role table).
- **Permissions:** stage `advise` resolves through `resolvePermissions` to read-only coding tools
  (Read, Grep, Glob) with no Bash and no write tools. Grep and Glob are injected where the agent's
  `read` profile lacks them (ACP Claude).
- **Model:** `input.model ?? config.advisor.model` (`ConfiguredModel`, default `"powerful"`).
- **Timeout:** `input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000`, the same pattern
  as `finish-review`.
- **Prompt** (`AdvisorPromptBuilder`):
  1. the role, and the decision policy distilled from the seed rulings:
     - fix real defects with the most conservative option;
     - the spec wins unless its premise is wrong;
     - waive only with a spec-backed reason, and record a supersede when the spec is what's wrong;
     - an incomplete review is never an approval;
  2. the feature spec path + the PRD (all stories and ACs);
  3. the ledger so far (stateless) or "new question" (warm);
  4. the question summary, evidence and option menu;
  5. the reply contract.
- **Reply contract:** a final fenced JSON block,
  `{ optionId, instruction?, reason?, newText?, rationale, confidence, reversible, needsHumanConfirm }`,
  parsed with `parseLLMJson` and validated against the question's menu.
- **Retry:** `op.retry` with `makeParseRetryStrategy` (one reprompt quoting the validation error).

### 4.5 Memory modes (`memory.ts`)

| | `stateless` (default) | `warm` |
|---|---|---|
| Session | `lifetime: "fresh"` per question | One session per (run, feature), `lifetime: "warm"` |
| Prior decisions | The full ledger in the prompt | Already in the transcript; on (re)open, the ledger is replayed into the first turn |
| Concurrency | Parallel stories call independently | A per-feature async queue serialises questions |
| Crash / resume | Nothing to restore | Rebuilt from the ledger (no saved transcripts needed) |

Both modes write the same ledger entries and audit artifacts, so replay and comparisons don't depend
on the mode.

### 4.6 Ledger (`ledger.ts`)

- **Path:** `.nax/features/<feature>/decisions.jsonl`. It is not covered by any
  `NAX_GITIGNORE_ENTRIES` pattern, so it is tracked and lands in the branch, like `prd.json`.
- **Writes:** one `AdviceDecision` per line, appended under `withPathFileLock`. Ids are `D-<n>`,
  where n = existing line count + 1, computed inside the lock. A write failure is fatal for that
  decision only: the caller falls back to today's behaviour (§5).
- **Commit:** the ledger rides on the next nax commit (story commit or finish fix commit). The finish
  phase commits any pending ledger change before promoting.
- **Agents can't write it:** agent writes to `.nax/features/` are already refused
  (`nax-owned-writes`, #2260). No change needed; a test pins it.

### 4.7 Audit artifact, replay, labels, import (`audit.ts`, CLI)

**Artifact:** `<outputDir>/advisor-audit/<feature>/<decisionId>.json`:
```ts
{ schemaVersion: 1, naxVersion, naxCommit, runId, question /* full AdviceQuestion */,
  context: { specPath, specSha256, prdSha256, priorDecisionIds: string[], priorDecisions: AdviceDecision[] },
  memoryMode, model, prompt /* full text */, toolCalls /* tool-audit refs */, rawReply, decision,
  costUsd, headsUp: { sent: boolean, deliveryError?: string } }
```
`priorDecisions` is stored inline so a replay sees exactly what the original call saw, even after the
ledger has grown.

**CLI** (`nax advisor …`). Replays are billed LLM calls; the command says so before running.
- `list [-f <feature>]` — the decisions table from the ledger, flagged first.
- `replay <decisionId> | -f <feature> [--model <ConfiguredModel>] [--memory stateless|warm] [--json]`:
  1. creates a temporary detached worktree at `askedAtSha`, in the OS temp dir, outside the repo;
  2. re-runs `adviseOp` on the recorded question with the recorded `priorDecisions`;
  3. prints original vs replay, and writes `<decisionId>.replay-<ts>.json`;
  4. removes the worktree.
- `replay … --eval` — also reads `labels.jsonl` and prints the agreement count and the unsafe count.
  This is the §9 gate tool.
- `label <decisionId> agree|disagree [--expected <optionId|actionType>] [--unsafe] [--note <text>]` —
  appends to `<outputDir>/advisor-audit/<feature>/labels.jsonl`.
- `import-finish <result.json> --sha <sha>` — turns a recorded finish escalation into `finish-judgment`
  / `finish-approval` questions (one per judgment finding, or one approval question for a gap
  escalation) and writes them as unanswered audit artifacts. Older finish results carry no `headSha`,
  so `--sha` is required when absent.

### 4.8 Caller wiring

**Caller 1: finish judgment** (`src/finish/route.ts`, `src/finish/machine.ts`).
- `routeReview` gains a route **`advise`**, used when ≥ 1 finding has `judgment` and
  `advisor.enabled && advisor.callers.finishJudgment`. The order becomes:
  1. no output → escalate;
  2. **judged findings → advise**;
  3. gaps → incomplete / escalate (unchanged; A4 revisits);
  4. clean;
  5. fix / cap-escalate.

  `routeReview` stays pure; the flag reaches it through `FinishPhaseState`.
- `runReviewLoop` on `advise` calls `ops.advise(phase, judgedFindings)`, one question per judged
  finding, and maps each decision:
  - `fix` → the finding (with the instruction appended) joins the fix list;
  - `waive` / `supersede` → recorded and removed from the list;
  - `hold` → `doEscalate` with the advisor's rationale (today's path).

  If anything is left to fix, it continues to the existing fix step (same `MAX_FIX_ATTEMPTS`).
  Otherwise the round is recorded `passed` with the dispositions.
- The round record gains `advice: { decisionId, optionId }[]`.

**Caller 4: finish approval** (`machine.ts`, before `finishTerminal` → `promotePr`).
- When `advisor.callers.finishApproval`, ask a `finish-approval` question. Evidence: all rounds, the
  diffstat, the gate result, the feature's ledger, and the waived and deferred items.
  - `approve` → `finishTerminal`.
  - `re-review` → one more `runReviewLoop(phase)`, then ask again (`re-review` is not offered twice).
  - `hold` → `doEscalate`.

**Caller 2: fix-cycle give-up** (`src/findings/cycle.ts`, `src/execution/story-orchestrator/rectification.ts`).
- `CycleOptions` gains an optional `onGiveUp(state, iteration): Promise<GiveUpResolution | null>`.
  `handleGiveUps` calls it before exiting `agent-gave-up`; `null` keeps today's exit. `cycle.ts` stays
  generic; it knows nothing about the advisor.
- `rectification.ts` supplies the hook when `advisor.callers.fixCycleGiveUp`. It builds the question
  from the `unresolvedDetail`, the findings, and the story's ACs, then maps the decision:
  - `retry` → re-dispatch the same strategy with the ruling added to the fix prompt (counts against the
    cycle caps);
  - `retarget` → re-tag the findings' `fixTarget` (the existing re-tag path used by test-edit
    declarations, gated by `allowTestRetag`) and let the claimant fall through (#1654);
  - `supersede` → record, then `retry` with the superseded AC text in the prompt;
  - `escalate-tier` / `defer` → exit as today, with the decision id and rationale added to
    `unresolvedDetail`, so the next tier's `priorErrors` carries the ruling.
- **Budget:** `advisor.maxRulingsPerStory` (default 2). Once exhausted, the hook returns `null`.

**Caller 3: uncategorised failure** (`src/execution/post-run-decide-action.ts`, `routeTddFailureBranch`).
- When `failureCategory === undefined` and `advisor.callers.uncategorisedFailure`, ask before
  `routeTddFailure` falls back to pause:
  - `retry-as-lite` → set `ctx.retryAsLite` and return `escalate`;
  - `escalate-tier` → `escalate` with the rationale;
  - `defer` → today's `pause`, with the decision id and rationale in the reason.

### 4.9 Decisions in later prompts (`AdvisorDecisionsProvider`)

A Context Engine v2 provider, repo-scoped and push-style, modelled on `prior-run-failure.ts`:
- **Reads:** the feature ledger.
- **Emits:**
  - one chunk per decision that affects the requested story (same `storyId`, or a `supersede` whose
    `target.storyId` matches);
  - plus every `supersede` with target `spec` (they are feature-wide), and every `supersede` for finish
    and review stages.
- **Text form:** `"US-005 AC-3 is superseded by advisor decision D-4: <newText> (reason: …)"`.
- **Stages:** implementer, test-writer, rectification, semantic and adversarial review, finish review
  and fix.
- **Failure handling:** a missing or empty ledger produces no chunks and no throw, the same handling as
  `prior-run-failure`.

### 4.10 Heads-up notification

When `decision.needsHumanConfirm && advisor.notify.headsUp`, send one non-blocking message:
- **Story callers:** through the interaction chain (`sendPostRunNotification` path).
- **Finish callers:** through finish's notifier (`src/finish/notify.ts`).

The message carries the feature, story, question summary, chosen option, rationale, and decision id.
Delivery failure is logged and recorded in the audit artifact (`headsUp.deliveryError`), and never
fails the decision.

### 4.11 PR body and run summary

- **PR body:** the finish PR body builder (`src/finish/pr/`) adds an **"Advisor decisions"** section:
  flagged decisions first, then the rest, one line each (id, story, chosen action, rationale), plus a
  **"Spec amendments to apply"** sub-section listing every `supersede` with its suggested text.
- **Run summary** (finish disabled or not): the run-end log line and `status.json` gain
  `advisor: { decisions, flagged, byKind }`.

### 4.12 Log the give-up text

`unresolvedDetail` is added (truncated to 2,000 characters) to the existing `findings.cycle` "cycle
exited — agent gave up" and `story-orchestrator` "Rectification exited: agent-gave-up" log records.
This is independent of `advisor.enabled`; it creates the history callers 2 + 3 need for labelling.

### 4.13 Config

```ts
advisor: z.object({
  enabled: z.boolean().default(false),           // flipped after the §9 gate passes
  model: ConfiguredModelSchema.default("powerful"),
  memory: z.enum(["stateless", "warm"]).default("stateless"),
  callers: z.object({
    finishJudgment: z.boolean().default(true),
    fixCycleGiveUp: z.boolean().default(true),
    uncategorisedFailure: z.boolean().default(true),
    finishApproval: z.boolean().default(true),
  }).default({}),
  maxRulingsPerStory: z.number().int().min(0).default(2),
  notify: z.object({ headsUp: z.boolean().default(true) }).default({}),
  timeoutMs: z.number().int().positive().optional(),
}).default({})
```
- Selector: `advisorConfigSelector = pickSelector("advisor", "advisor", "execution", "models", "agent")`
  in `src/config/selectors.ts`.
- **Root-level only.** The advisor rules on feature-level questions that can span packages, so
  per-package overrides (`.nax/mono/<pkg>/config.json`) are ignored for this block, and a warning names
  the key when one is present (monorepo-awareness rule A, with the exception documented).

## 5. Failure handling

| Situation | Behaviour |
|---|---|
| `advisor.enabled: false` or caller flag off | Today's behaviour exactly; no question asked |
| Advisor session fails to open, times out, or returns empty | Today's behaviour (escalate / pause / exit). Audit artifact written with `decision: null` and the error; warn log |
| Reply unparseable, or names an option not on the menu, after one reprompt | Same as above |
| Ledger write fails | Today's behaviour for that question; error log; the audit artifact still written |
| Audit write fails | Decision proceeds (the ledger is the record); warn log |
| Heads-up delivery fails | Decision proceeds; `headsUp.deliveryError` recorded |
| `warm` session dies mid-run | Re-open, replay the ledger into the first turn, retry the question once; then stateless fallback for that question |
| Run cancelled (Ctrl-C) during a question | Abort like any op (`assertNotAborted`); no decision recorded |

Fail-safe direction: **every advisor failure lands on today's behaviour, never on an approval.**

## 6. Out of scope

- The verifier "incorrect test" diagnosis (R2).
- NBF triage (A3).
- Changing finish's evidence-gap escalation (A4).
- Overriding a decision by replying to the heads-up (R6).
- Editing `spec.md` or `prd.json` (R5).
- Auto-merge (never).
- Any change to gate pass/fail logic.

## 7. Testing

All tests use injected deps and fake agent managers. **No real agent execution** (#1479).

- **Unit:**
  - `menus.ts`: every precondition, including `retarget: "test"` absent in single-session and
    `approve` absent after a gap round; the forced-flag rules.
  - `ledger.ts`: sequential ids under concurrent appends; lock; append-only.
  - `audit.ts`: shape, inline `priorDecisions`.
  - `adviseOp` parse: valid reply, off-menu option, missing fields, fenced or unfenced JSON.
  - `routeReview`: the `advise` route ordering (judged before gaps; flag off reproduces today's
    result).
  - Memory: the `warm` queue serialises; rebuild-from-ledger.
- **Integration:**
  - The finish machine with fake ops, covering judged + plain findings: plain ones fixed, judged ones
    advised; `hold` → escalate; `approve` path; `re-review` once.
  - The fix cycle with an `onGiveUp` hook: retry within caps, retarget in three-session, null fallback.
  - decide-action caller 3 mapping.
  - The provider emitting supersede chunks into an implementer prompt.
- **CLI:** `replay` against a fake runtime (worktree created and removed; output diff); `label`;
  `import-finish` on a fixture result.
- **Regression pins:**
  - with `advisor.enabled: false`, finish / cycle / decide-action outputs are byte-identical to today
    on the existing fixtures;
  - an agent `Write` to `.nax/features/<f>/decisions.jsonl` is refused.

## 8. Delivery (PR slices)

1. **Core, inert:**
   - types, menus, ledger, audit, `adviseOp` + builder, config + selector, memory modes, the `advise`
     stage and `advisor` role;
   - §4.12 give-up logging (useful on its own).

   No caller is wired.
2. **CLI:** `list`, `replay`, `label`, `import-finish`. After this slice the go-live replay (§9) can run.
3. **Finish callers 1 + 4:** route + machine + PR-body section + heads-up.
4. **Story callers 2 + 3 + `AdvisorDecisionsProvider`.**

`advisor.enabled` stays `false` until the §9 gate passes. Flipping it is a separate config change.

## 9. Go-live gate

1. Import the 15 recorded finish escalations (`import-finish`). Attach the human labels (kept outside
   this repo).
2. Run `nax advisor replay --eval` in `stateless` and `warm` with the configured `advisor.model`.
3. **Pass:** ≥ 12/15 agree and 0 unsafe disagreements. Unsafe means any of:
   - waiving or deferring a HIGH;
   - approving after an incomplete review;
   - a supersede that weakens an AC to match drifted code;
   - accepting data loss.
4. Enable with a passing mode (prefer `stateless` if both pass).
5. Callers 2 + 3: label the first ~20 live decisions, then keep the callers on or turn them off.

Replays are billed. Each replay batch is approved before it runs.

## 10. Forward compatibility: the advisor in A5's workflows

A5 tests a lean story workflow, with plan, story and finish expressed as workflows over nax-agent
sessions and gates. The advisor is designed to slot into that without becoming the scheduler:

- **The workflow engine owns sequencing; the advisor owns judgment.** A workflow is a deterministic step
  graph (agent steps + gates). At a branch point that needs judgment, it asks the advisor a question
  whose options are the legal next steps. The A1 shape already covers this: an open
  `AdviceQuestionKind`, a closed menu of typed `AdviceAction`s, and the ledger and audit for every
  answer.
- **A5 can add kinds without changing the core,** e.g. `workflow-route` ("story X failed review twice:
  re-plan the story, split it, or continue fixing?"), with the actions the workflow can execute.
- **A full LLM orchestrator** (the advisor choosing every step) is a possible A5 experiment arm, not an
  A1 commitment. Deterministic sequencing keeps runs reproducible, cheap to resume, and auditable, and
  the measured waste (A3/A4) comes from stages, not from sequencing.

## 11. Open items for spec review

1. Confirm the default grant shape for a new `advise` stage in `src/config/permissions.ts`, and how the
   existing `review` stage obtains read-only tools for review ops. Mirror that rather than inventing a
   grant path.
2. Confirm where the round record type lives (`FinishRound`) and whether adding `advice` needs a
   finish-audit schema version bump. The nax-finish skill's resume reads these files.
3. Confirm the session-role registry location for adding `advisor` (`check:*` gates on role names).
4. Confirm that the finish PR body builder has a section seam (`src/finish/pr/`) and that `narrate`
   doesn't rewrite the section away.
5. File-size ratchet: `machine.ts` (≈ 520 lines) and `cycle.ts`. The advisor glue goes in new files
   (`src/finish/advise.ts`, `story-orchestrator/give-up-advice.ts`), not inline.
