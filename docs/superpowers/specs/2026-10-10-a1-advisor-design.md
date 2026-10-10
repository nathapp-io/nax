# A1 — Advisor: rule on judgment calls instead of stopping the run

**Status:** design rev 2.1 (spec-review round 1 applied + plan-time amendments §12), awaiting user review · **Date:** 2026-10-10 ·
**Baseline:** `main` @ `9611b61a4` (v0.85.1). All paths are under `packages/nax/` unless stated.
**Arc:** autonomy & lean pipeline. A1 is the first of five sub-projects: A2 acceptance retro, A3 NBF
triage, A4 finish as a branch review, A5 lean-workflow A/B. This spec covers A1 only.

---

## 1. Goal

`nax run` and the finish phase stop, pause, or escalate when they reach a judgment call:
- a finish reviewer finding marked "needs a human";
- a story fix agent that gives up with `UNRESOLVED:`;
- a TDD failure with no category;
- the decision to promote the PR.

Each stop waits for a person, often for hours. A finish escalation also leaves that phase's other
findings unfixed.

A1 adds an **advisor**. It knows the whole feature (spec, PRD with every story's ACs, every earlier
decision), rules on these calls, and lets the run continue. Every ruling is:
- recorded in a ledger;
- sent as a heads-up when uncertain;
- listed in the PR body;
- replayable.

**Success:**
- With a caller enabled, its decision point no longer stops the run; failures fall back as in §5.
- Every decision is in the committed ledger, in a replayable audit artifact, and in the PR body.
- Callers 1 and 4 pass the offline replay gate (§9) before they are enabled.

**Not in A1.** Finish escalations caused by a reviewer's missing evidence sections (`## WALK` /
`## TOUCHPOINTS`) remain escalations. A4 handles them.

## 2. Evidence (measured over 158 runs / 71 features, 2026-09-10 → 2026-10-10)

**Finish phase.**
- It escalated 13 of 15 runs after it moved in-process, and has gone unused since.
- The 15 recorded escalations:
  - 4 reviewer evidence-section gaps;
  - 1 trivial LOW;
  - 4 spec-vs-code contradictions;
  - 6 design calls.
- Where the human ruling is on record, real defects were **fixed** with the most conservative option.
  Waivers happened only with a spec-backed reason.
- Two findings in escalated runs were never acted on after the escalation and shipped as live defects.
  One is #2435.
- `routeReview` escalates a whole phase on one `judgment` finding (`src/finish/route.ts:75`) before
  the fix route, so the phase's other findings are never fixed.

**Story level.**
- 85 fix cycles ended `agent-gave-up`.
- 63 TDD failures had no category and defaulted to pause.
- The cycle already logs the give-up text. `unresolvedDetail` is on `findings.cycle` records
  (`src/findings/cycle-execute.ts:98,141,150`); 18 terminal give-ups since 09-10 carry it.
- Those texts show three causes:
  1. **a finding contradicts an AC or an existing test** (most common);
  2. **a finding requires edits outside the story's scope**, owned by another story;
  3. **a reviewer contradicts its own earlier finding** across rounds.
- The user also observes the three-session TDD boundary as a cause: the implementer may not edit
  tests, and the test-writer may not edit source.

## 3. Rulings (user, 2026-10-10)

| # | Ruling |
|---|---|
| R1 | **The advisor acts on every in-scope decision and the run continues.** No live shadow period. An offline replay gates callers 1 + 4 (§9). |
| R2 | **Four callers:** (1) finish judgment findings, (2) `UNRESOLVED:` give-ups in the story fix cycle, (3) uncategorised TDD failure, (4) finish approval before the PR is promoted. **Deferred:** a verifier's "incorrect test" diagnosis; the #1527 rule (terminal human review) stands. **Out of A1:** NBF triage (A3). |
| R3 | **Memory is configurable:** `advisor.memory: "stateless" \| "warm"`, default `stateless`. The ledger is written in both modes and is the source of record. |
| R4 | **Read-only agent session.** nax writes the ledger, never the advisor. `advisor.model` is a `ConfiguredModel`, default `"powerful"`. |
| R5 | **Spec amendments live only in the ledger.** `spec.md` and `prd.json` are never edited. A supersede goes into later prompts and the PR body's "Spec amendments to apply". |
| R6 | **Flagged decisions send a non-blocking heads-up. Every decision writes a replayable audit artifact.** `nax advisor replay` re-runs a decision. Overriding by reply is out of A1. |
| R7 | **Go-live gate** for callers 1 + 4: offline replay, 0 unsafe disagreements and the agreement bar in §9. Callers 2 + 3 go live without a seed gate, every decision audited, and are re-evaluated after ~20 labelled live decisions. |

## 4. Design

### 4.1 Components and dependency direction

| Unit | Location | Purpose |
|---|---|---|
| Types | `src/advisor/types.ts` | Question, option, action, decision types. Type-only module |
| Menus + guardrails | `src/advisor/menus.ts` | Per-kind closed option lists, preconditions, forced `needsHumanConfirm` |
| Ledger | `src/advisor/ledger.ts` | Read and append the feature ledger at the main repo's feature dir |
| Audit | `src/advisor/audit.ts` | Artifacts + `labels.jsonl` under `<outputDir>/advisor-audit/<feature>/` |
| Memory | `src/advisor/memory.ts` | `stateless` / `warm` session strategy; per-feature queue for `warm` |
| Heads-up | `src/advisor/heads-up.ts` | Delivers the flagged-decision message through an injected channel |
| Service | `src/advisor/service.ts` | `advise(actx, question)`: menu → `callOp(adviseOp)` → guardrails → ledger → audit → heads-up |
| Op | `src/operations/advise.ts` | `adviseOp`, including reply parsing and menu validation |
| Prompt | `src/prompts/builders/advisor-builder.ts` | `AdvisorPromptBuilder` |
| Finish glue | `src/finish/advise.ts` | Judged-finding split, approval step, ledger commit |
| Cycle glue | `src/execution/story-orchestrator/give-up-advice.ts` | Builds the `onGiveUp` hook |
| Decide glue | `src/execution/uncategorised-advice.ts` | Caller 3 |
| Context provider | `src/context/engine/providers/advisor-decisions.ts` | Story-stage prompts (§4.9) |
| Config type | `src/config/runtime-types-advisor.ts` | `AdvisorConfig` (`runtime-types.ts` is at its size limit) |
| CLI | `src/cli/advisor.ts` (`registerAdvisorCommand`) + `bin/nax.ts` | `nax advisor list \| replay \| label \| import-finish` |

**Import direction:**
- `src/advisor/service.ts` → `@/operations` (barrel).
- `src/operations/advise.ts` → `@/advisor/types` type-only, plus `@/advisor/menus` (a leaf module with
  no operations import, exposed as a nested barrel `src/advisor/menus/index.ts` if
  `check:alias-internals` requires it).
- Callers → `@/advisor`.
- No `src/advisor` module imports finish, execution, or findings modules. The import-cycle baseline
  (0 modules) must stay 0.

### 4.2 Types (`src/advisor/types.ts`)

```ts
export type AdviceQuestionKind =
  | "finish-judgment"        // caller 1
  | "fix-cycle-give-up"      // caller 2
  | "uncategorised-failure"  // caller 3
  | "finish-approval";       // caller 4
// Open union by design: A3 adds "nbf-triage"; A5 may add workflow kinds (§10).

export interface AdviceEvidence {
  source: "finding" | "ac" | "spec" | "test-output" | "diff" | "agent-diagnosis" | "review-round" | "gate" | "decision";
  ref?: string;            // "US-005 AC-3", "src/x.ts:42", "finding #2", "D-4"
  text: string;
}

export type SupersedeTarget =
  | { kind: "ac"; storyId: string; acId: string }  // an AC in prd.json
  | { kind: "spec"; section: string };             // a spec.md section with no AC of its own

export type AdviceAction =
  | { type: "fix"; instruction: string }                          // caller 1: fix with this approach
  | { type: "waive"; reason: string }                             // keep the code; finding rejected or out of scope
  | { type: "supersede"; target: SupersedeTarget; newText: string } // spec/AC wrong, code right
  | { type: "retry"; instruction: string }                        // caller 2: same strategy again, with guidance
  | { type: "retarget"; to: "test" | "source"; instruction: string } // caller 2: hand across the TDD boundary
  | { type: "retry-as-lite" }                                      // caller 3
  | { type: "escalate-tier"; reason: string }                     // callers 2, 3: today's behaviour, chosen
  | { type: "defer"; reason: string }                             // callers 2, 3: today's exit / pause, with a diagnosis
  | { type: "approve" }                                            // caller 4
  | { type: "re-review"; phase: "spec" | "quality" }              // caller 4
  | { type: "hold"; reason: string };                             // callers 1, 4: today's finish escalation

export interface AdviceOption {
  id: string;              // "A", "B", …: stable within one question
  type: AdviceAction["type"];
  label: string;           // human-readable; may name a fixed parameter (e.g. retarget → "test")
  fixed?: Partial<AdviceAction>; // parameters the menu fixes (to, phase, target)
}

export interface AdviceQuestion {
  id: string;              // "Q-<ulid>"
  kind: AdviceQuestionKind;
  feature: string;
  storyId?: string;
  dedupeKey?: string;      // caller 1: `${phase}|${finding.title}|${firstPath(finding.problem) ?? ""}`
  askedAtSha: string;      // HEAD when asked
  summary: string;
  evidence: AdviceEvidence[];
  options: AdviceOption[]; // built by menus.ts, never by the advisor
}

export type AdviceConfidence = "high" | "medium" | "low";

export interface AdviceDecision {
  id: string;              // "D-<n>", sequential per feature (§4.6)
  questionId: string;
  kind: AdviceQuestionKind;
  storyId?: string;
  dedupeKey?: string;
  chosenOptionId: string;
  action: AdviceAction;    // menu-fixed parameters merged with the advisor's text fields
  rationale: string;
  confidence: AdviceConfidence;
  reversible: boolean;
  needsHumanConfirm: boolean;
  reusedFrom?: string;     // set when applied from an earlier decision without a new call (§4.8 caller 1)
  decidedAt: string;
  model: string;
  memoryMode: "stateless" | "warm";
  auditRef: string;        // relative to outputDir
}

/** What `advise` returns. `null` decision means: fall back (§5). */
export interface AdviceResult {
  decision: AdviceDecision | null;
  fallbackReason?: string;
}
```

**The advisor only chooses from a closed menu.** It returns an option id plus free text (instruction,
reason, newText, rationale). Parameters such as `retarget.to`, `re-review.phase` and
`supersede.target` are fixed by the menu, not by the advisor. A reply naming an option that isn't on
the menu, or missing a required text field, is a validation failure (§5).

### 4.3 Menus and guardrails (`src/advisor/menus.ts`, pure)

| Kind | Options | Preconditions (option omitted when false) |
|---|---|---|
| finish-judgment | `fix`, `waive`, `supersede`, `hold` | `supersede`: the finding cites an AC or spec section, and the supersede rule below allows it |
| fix-cycle-give-up | `retry`, `retarget`, `waive`, `supersede`, `escalate-tier`, `defer` | `retry` / `retarget`: the target strategy has attempts left and `maxAttemptsTotal` is not reached. `retarget` to `"test"`: `isThreeSession` (#1330), and the giving-up strategy was a source fixer. `retarget` to `"source"`: the giving-up strategy was the test fixer. `escalate-tier`: a next tier exists. All options except `escalate-tier` / `defer` need the per-story ruling budget (§4.13) not to be exhausted |
| uncategorised-failure | `retry-as-lite`, `escalate-tier`, `defer` | `retry-as-lite`: three-session and not already lite. `escalate-tier`: a next tier exists |
| finish-approval | `approve`, `re-review`, `hold` | **`approve`: every review phase's last recorded round has outcome `passed` or `advised`, none with open gaps, and the repo gates are green after the last commit.** `re-review`: not yet used this finish run |

**Supersede rule (fixes H4).** `supersede` with target `ac` is offered only when no generated
acceptance test pins that AC: acceptance is disabled for the story's package, or the feature's
acceptance test has no case for that AC id. Reason: gates are never changed by a decision (§4.3
invariants), so a superseded AC that an acceptance test still asserts would fail the gate and repeat
the contradiction. Target `spec` (a spec section with no AC) is always allowed.

**Forced `needsHumanConfirm`**, whatever the advisor reports:
- `confidence: "low"` or `reversible: false`;
- action `supersede`, `defer` or `hold`;
- action `waive` on a finding with blocking severity:
  - finish: `HIGH` or `CRITICAL`;
  - story findings: `error` or `critical`.

**Invariants:**
- No decision changes a gate's pass/fail.
- `approve` is never offered after an incomplete or advised-with-gaps review, or with red gates.
- A supersede never edits `spec.md` or `prd.json`.
- The advisor holds no write tools. nax writes the ledger, the audit, and any commit.

### 4.4 `adviseOp` (`src/operations/advise.ts`)

- `kind: "run"`, `name: "advise"`, **`stage: "review"`**, `tools: ["Read", "Glob", "Grep"]`. That is
  the same read-only mechanism `fixReviewOp` and `adversarialReviewOp` use: the advertised tools are
  the op's declaration intersected with the grants (`src/operations/types.ts`). No new pipeline stage.
- `session: { role: "advisor", lifetime: "fresh" }`. `warm` mode overrides the lifetime (§4.5). Add
  `advisor` to `KNOWN_SESSION_ROLES` in `src/runtime/session-role.ts` and to the role table in
  `.nax/rules/adapter-wiring.md`, then `nax generate` + `check:rules-drift`.
- `config: advisorConfigSelector`; `model: (input, ctx) => input.model ?? ctx.config.advisor.model`.
- `timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.advisor.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000`.
- **Prompt** (`AdvisorPromptBuilder`):
  - the role and decision policy, from the human rulings:
    1. real defects are fixed with the most conservative option;
    2. the spec wins unless its premise is wrong;
    3. waive only with a spec-backed or scope-backed reason, and record a supersede when the spec is
       what's wrong;
    4. an incomplete review is never an approval;
  - the spec path, the PRD (all stories and ACs), the prior decisions (stateless), the question
    summary, evidence and menu;
  - the reply contract: a final fenced JSON block
    `{ optionId, instruction?, reason?, newText?, rationale, confidence, reversible, needsHumanConfirm }`.
- **Parse:** `tryParseLLMJson`, then validate against `input.question.options` (menu membership, the
  required text field for the option's type, the enum values). Output:
  `{ ok: true, reply } | { ok: false, error: string, preview: string }`.
- **Retry:** `op.retry` with `makeParseRetryStrategy` handles a missing or unparseable JSON object only.
  Its exhausted fallback returns `{ ok: false, error: "no-json" }`. An off-menu or invalid reply is not
  retried; it is a validation failure and falls back (§5).

### 4.5 Memory modes (`src/advisor/memory.ts`)

| | `stateless` (default) | `warm` |
|---|---|---|
| Session | `lifetime: "fresh"` per question | One session per (run, feature), `lifetime: "warm"`, opened on the first question |
| Prior decisions | Full ledger in the prompt | Replayed into the first turn; new decisions added as later turns |
| Concurrency | Independent calls | Per-feature async queue serialises questions |
| Crash / resume | Nothing to restore | Re-open, replay the ledger into the first turn, retry the question once, then use stateless for that question |
| Close | n/a | Closed by the runtime's normal session sweep at run end (and by finish's end) |

### 4.6 Ledger (`src/advisor/ledger.ts`)

- **Location:** `featureDir(repoRoot, feature)/decisions.jsonl`, where `repoRoot` is the **main
  checkout**, never a story worktree. Use `featureDir` from `@/config`; the literal path is banned by
  `check:feature-dir-ssot`. It is not matched by `NAX_GITIGNORE_ENTRIES`, so it is tracked like
  `prd.json`.
- **Append:** under `withPathFileLock` on that one path, so parallel worktree stories serialise on the
  same file and ids can't collide. `D-<n>` with n = number of existing lines + 1, computed inside the
  lock.
- **Commit:**
  - During a run, the ledger is swept by the same commits that already carry `prd.json`
    (`autoCommitIfDirty` stages with `git add -A` at the repo root).
  - Finish adds a **ledger-only commit** before promoting (`commitLedger` in `src/finish/advise.ts`):
    `git add <ledger>` + `git commit -m "chore(<feature>): advisor decisions"` with `skipHooks`.
  - That commit does **not** go through `commitFixes`, does not set `committedThisRun`, and does not
    move the review window (`noteCommitWindow`).
- **Agents can't write it:** `.nax/features` is in `NAX_NEVER_OPT_IN`. A test pins that an agent
  `Write` to the ledger path is refused.

### 4.7 Audit artifact, replay, labels, import

**Artifact:** `<outputDir>/advisor-audit/<feature>/<decisionId or questionId>.json`.
```ts
{ schemaVersion: 1, naxVersion, naxCommit, runId,
  question,                                   // full AdviceQuestion
  context: { specPath, specSha256, prdSha256, priorDecisions: AdviceDecision[] },
  worktree: { sha: string, patch: string, patchTruncated: boolean }, // `git diff HEAD` + untracked, capped at 256 KiB
  memoryMode, model, prompt, rawReply, result /* AdviceResult */, costUsd,
  headsUp: { sent: boolean, reason?: string } }
```

**CLI** (`src/cli/advisor.ts`, `registerAdvisorCommand(program)` in `bin/nax.ts`, following `src/cli/approvals.ts`). Replays are billed; the command
prints that before running.
- `nax advisor list [-f <feature>]` — the ledger, flagged first.
- `nax advisor replay <decisionId> | -f <feature> [--model <ConfiguredModel>] [--memory stateless|warm] [--eval] [--json]`:
  1. creates a temporary detached worktree at `worktree.sha` in the OS temp dir;
  2. applies `worktree.patch`, or warns that the replay is approximate when it was truncated;
  3. re-runs `adviseOp` with the recorded question and `priorDecisions`;
  4. prints original vs replay and writes `<id>.replay-<ts>.json`;
  5. removes the worktree.

  `--eval` also scores against `labels.jsonl`: agreement count and unsafe count.
- `nax advisor label <id> agree|disagree [--expected <optionType>] [--unsafe] [--note <text>]` — appends
  to `labels.jsonl`.
- `nax advisor import-finish <result.json> --sha <sha>` — converts each `judgment` finding in a recorded
  finish escalation into a `finish-judgment` question. The menu is built as if the run were live
  (acceptance state read from the feature at `<sha>`). Gap-only escalations are reported as "not
  importable in A1".

### 4.8 Caller wiring

#### Caller 1: finish judgment (`src/finish/route.ts`, `src/finish/machine.ts`, `src/finish/advise.ts`)

- `routeReview(phase, outcome, st, opts?: { advise?: boolean; adviseRounds?: number })` gains a route
  `advise`. The new order:
  1. no output → escalate;
  2. **gaps → `incomplete` while under `MAX_INCOMPLETE_ATTEMPTS`, else escalate (unchanged)**;
  3. judged findings + `opts.advise` + `adviseRounds < MAX_ADVISE_ROUNDS` (2) → `advise`;
  4. judged findings otherwise → escalate (today);
  5. zero findings → clean;
  6. fix / cap-escalate (unchanged, `MAX_FIX_ATTEMPTS`).

  Gaps go before advise, so an advised round never hides unread evidence.
- On `advise`, `runReviewLoop` calls `deps.advise.judged(phase, judgedFindings, state)` from
  `src/finish/advise.ts`:
  - **dedupe first:** for each judged finding, if the ledger holds a decision with the same
    `dedupeKey` whose action is `waive` or `supersede`, apply it again without a call (a decision with
    `reusedFrom` is recorded);
  - otherwise ask one question per finding.
- Mapping:
  - `fix` → the finding, with the instruction appended to `fix`, joins the fix list;
  - `waive` / `supersede` → removed from the fix list;
  - `hold` → `doEscalate` with the advisor's rationale;
  - a fallback (null decision) → `doEscalate`, today's behaviour.

  If any findings remain (plain + `fix`), continue to the existing fix step. Otherwise record the
  round with the **new outcome `advised`** and continue the loop, which re-reviews. `phaseState`
  gains `adviseRounds`.
- **Round record:** `FinishRoundOutcome` gains `"advised"` and `FinishRound` gains an optional
  `advice: { decisionId: string; optionId: string; reused: boolean }[]`. The change is additive (rounds
  carry no schema version). Update the outcome renderer in `src/finish/pr/body.ts` and the readers in
  `src/finish/pr/context.ts`.

#### Caller 4: finish approval (`src/finish/machine.ts`, `src/finish/advise.ts`)

- In `runFinishMachine`, after `runQualityGatesLoop` returns green and before `finishTerminal`, call
  `deps.advise.approval(state)` when caller 4 is enabled:
  - `approve` → `commitLedger`, then `finishTerminal`;
  - `re-review` → `runReviewLoop(phase)`. If that loop committed anything, run `runQualityGatesLoop`
    again (invariant I4). Then ask again; `re-review` is no longer on the menu;
  - `hold` → `commitLedger`, then `doEscalate` with the rationale;
  - **a fallback (null decision) → `doEscalate`.** Caller 4 fails closed. With the advisor enabled,
    a failed approval escalates and does not promote.

  With caller 4 disabled, `finishTerminal` runs as today.
- `FinishMachineDeps` gains `advise?: FinishAdvisor`
  (`{ judged(...): Promise<JudgedOutcome>; approval(state): Promise<AdviceResult> }`), built in
  `src/finish/phase.ts` when the advisor is enabled. Absent → today's behaviour.

#### Caller 2: fix-cycle give-up (`src/findings/*`, `src/execution/story-orchestrator/give-up-advice.ts`)

- `FixCycle<F>` (`src/findings/cycle-types.ts`) gains an optional
  `onGiveUp?: (input: GiveUpInput<F>) => Promise<GiveUpResolution<F> | null>`.
- `GiveUpInput<F>` holds:
  - `findings: readonly F[]`;
  - `gaveUp: { strategyName: string; unresolvedDetail: string }[]`;
  - `attemptsLeft: Record<string, number>`;
  - `totalAttemptsLeft: number`.
- `GiveUpResolution<F>` holds:
  - `findings: F[]` — the replacement working set (waived findings removed; retargeted findings carry
    the new `fixTarget`; every remaining finding may carry `guidance`);
  - `reinstate: string[]` — strategy names to un-decline;
  - `exit?: "agent-gave-up"` — keep today's exit, with `unresolvedDetail` extended by the decision.
- `handleGiveUps` (`src/findings/cycle-execute.ts:74`) becomes `async`, and its call site in
  `src/findings/cycle.ts` awaits it. When every strategy in the group gave up, and **no remaining
  claimant exists (after the #1654 check)**, and `cycle.onGiveUp` is set, it calls the hook before
  exiting:
  - `null` or `exit` → today's exit (extended detail);
  - otherwise → set `cycle.findings = resolution.findings`, call
    `state.declines.clearDeclined(name, findings)` for each name in `reinstate`, and `continue` the
    loop.

  If the replacement set is empty, the next iteration's early-resolved exit ends the cycle as
  resolved.
- `DeclineLedger` (`src/findings/cycle-retirement.ts`) gains `clearDeclined(strategy, findings)`, the
  inverse of `recordDeclined` for the same finding keys.
- **`Finding.guidance?: string`** (`src/findings/types.ts`) is a new optional field, **not part of
  `findingKey`**. The rectifier finding renderers in `src/prompts/builders/rectifier-builder*.ts` print
  it under each finding as `Advisor ruling (D-n): …`. Validators re-emit findings without guidance, so
  a ruling lasts one dispatch. Its lasting channel is the ledger and the context provider (§4.9).
- `give-up-advice.ts` exports `buildGiveUpHook(deps)`, which `rectification.ts` attaches to the cycle
  object in **one line** (that file is at 599/600 lines, and `runRectification` is complexity-baselined
  at 49 and must not grow). Make room by moving an existing helper out in the same task if needed.
  Mapping:
  - `retry` → the same findings with `guidance`; reinstate the strategy that gave up;
  - `retarget` → set `fixTarget` on the findings; reinstate the claimant for that target; add
    `guidance`;
  - `waive` → remove the findings; the decision is the record. A blocking-severity waive is
    force-flagged (§4.3);
  - `supersede` → record it, then behave like `retry` with guidance quoting the new text;
  - `escalate-tier` / `defer` → `exit`; the detail gains `[advisor D-n: <rationale>]`, so the next
    tier's `priorErrors` carries the ruling;
  - fallback → `null`.
- Not offered for findings whose source is a mechanical check (lint/typecheck).

#### Caller 3: uncategorised failure (`src/execution/post-run-decide-action.ts`, `src/execution/uncategorised-advice.ts`)

- In `routeTddFailureBranch`, when `failureCategory === undefined`, the human-review branch didn't
  fire, and caller 3 is enabled, call `adviseUncategorised(frame)` before `routeTddFailure`:
  - `retry-as-lite` → `ctx.retryAsLite = true`; `{ action: "escalate", reason }`;
  - `escalate-tier` → `{ action: "escalate", reason: "<rationale> [advisor D-n]" }`;
  - `defer` → today's `pause`, with `uncategorisedPauseReason` plus `[advisor D-n: <rationale>]`;
  - fallback → today's path.
- The call site adds one guarded line. The logic lives in `uncategorised-advice.ts` (complexity limit
  20).

### 4.9 Decisions in later prompts

- **Story stages: `AdvisorDecisionsProvider`.**
  - A Context Engine v2 provider, repo-scoped and push-style, modelled on `prior-run-failure.ts`.
  - Registered in `orchestrator-factory.ts` and enabled through `providerIds` for the existing story
    stages in `STAGE_CONTEXT_MAP` that build implementer, test-writer, rectification and review
    bundles (the plan confirms the exact keys; `stage-reachability.test.ts` guards them).
  - It emits one chunk per decision that affects the requested story: same `storyId`, a `supersede`
    whose target story matches, or any `supersede` with target `spec`.
  - Text: `"US-005 AC-3 is superseded by advisor decision D-4: <newText> (reason: …)"`.
  - A missing or empty ledger produces no chunks and no throw.
- **Finish: direct injection.** Finish ops don't use the context engine.
  - `buildReviewPrompt` and the finish-fix prompt builder take an optional `decisions` string
    (supersedes + waives for the feature).
  - `ops-impl.ts` loads it from the ledger.
  - This also stops a reviewer re-raising a finding that was already waived.

### 4.10 Heads-up (`src/advisor/heads-up.ts`)

- When `decision.needsHumanConfirm && advisor.notify.headsUp`, send one message: feature, story,
  summary, chosen option, rationale, decision id. The channel is injected by the caller:
  - **story callers:** `sendPostRunNotification`. When `ctx.interaction` is unset → record
    `sent: false, reason: "no-interaction-channel"`;
  - **finish callers:** finish's Telegram sender when `finish.notify.mode !== "off"` and credentials
    exist, else `sent: false, reason: "finish-notify-off"`.
- The result is recorded in the audit `headsUp` field and logged at warn when not sent. Delivery
  failure never fails the decision.

### 4.11 PR body and run summary

- **PR body.** `buildBodySections` (`src/finish/pr/body.ts:197`) gains an **"Advisor decisions"**
  section and a **"Spec amendments to apply"** sub-section:
  - flagged decisions first, one line each;
  - fed by `loadFinishPrContext` reading the ledger, so `narrate`'s rebuild keeps it;
  - tested under the template modes merge, strict and ignore.
- **Run summary.** The run-end summary log and `status.json` gain
  `advisor: { decisions, flagged, byKind }`.

### 4.12 Give-up text in the story-orchestrator summary log

The cycle already logs `unresolvedDetail`. The only gap is the `story-orchestrator` "Rectification
exited" summary (`rectification.ts:~527-540`). Add it **only** via an extracted helper that also frees
lines in that file. Otherwise drop this item: the cycle records suffice for labelling.

### 4.13 Config

- **Zod** (`src/config/schemas.ts` or a new `schemas-advisor.ts`):
  ```ts
  advisor: z.object({
    enabled: z.boolean().default(false),
    model: ConfiguredModelSchema.default("powerful"),
    memory: z.enum(["stateless", "warm"]).default("stateless"),
    callers: z.object({
      finishJudgment: z.boolean().default(false),
      fixCycleGiveUp: z.boolean().default(false),
      uncategorisedFailure: z.boolean().default(false),
      finishApproval: z.boolean().default(false),
    }).default({}),
    maxRulingsPerStory: z.number().int().min(0).default(2),
    notify: z.object({ headsUp: z.boolean().default(true) }).default({}),
    timeoutMs: z.number().int().positive().optional(),
  }).default({})
  ```
- A caller runs only when **`enabled` and its own flag** are both true. Each flag defaults false, so
  callers 1 + 4 (after §9) and 2 + 3 are switched on independently.
- **`maxRulingsPerStory`** counts ledger decisions of kinds 2 + 3 for that `storyId` across the whole
  feature (all tiers and attempts). Once reached, the menus offer only `escalate-tier` / `defer`.
- **Type:** `AdvisorConfig` in `src/config/runtime-types-advisor.ts`, re-exported. `NaxConfig` gains
  `advisor: AdvisorConfig`. `runtime-types.ts` is at its size limit, so only the one field is added
  there.
- **Selector:** `advisorConfigSelector = pickSelector("advisor", "advisor", "execution")` in
  `src/config/selectors.ts`, with the `AdvisorConfig` slice type there.
- **Root-only:** the advisor rules on feature-level questions, so per-package overrides are pinned to
  the root value. Add `advisor` to `pinRootOnlyKeys` and `pinRootOnlyKeysRaw` in
  `src/config/root-only-keys.ts`; a package override logs the existing root-only warning. This is a
  documented exception to monorepo rule A.

## 5. Failure handling

| Situation | Behaviour |
|---|---|
| Advisor or caller flag off | Today's behaviour exactly; no question asked |
| Session fails to open, times out, empty reply, no JSON after retry, off-menu or invalid reply | `AdviceResult.decision = null`, audit written with `fallbackReason`, warn log. **Callers 1, 2, 3: today's behaviour. Caller 4: escalate (fails closed)** |
| Ledger write fails | Treated as a fallback (no ledger, no action). Audit still written |
| Audit write fails | The decision proceeds (the ledger is the record); warn log |
| Heads-up not sent | The decision proceeds; `headsUp.sent: false` with a reason |
| `warm` session dies | Re-open + ledger replay + one retry, then stateless for that question |
| Run cancelled during a question | Abort like any op; no decision recorded |

**No advisor failure ever leads to an approval.**

## 6. Out of scope

- The verifier "incorrect test" diagnosis.
- NBF triage (A3).
- Changing finish's evidence-gap escalation (A4).
- Override by reply.
- Editing `spec.md` or `prd.json`.
- Auto-merge.
- Gate pass/fail logic.
- Superseding an AC that a generated acceptance test pins (§4.3).

## 7. Testing

All tests use injected `_deps` and fake agent managers. No real agent execution (#1479).

**Unit:**
- Menus: every precondition, including:
  - `retarget: "test"` absent in single-session;
  - `approve` absent after an `incomplete` round or red gates;
  - `supersede` of an AC absent when an acceptance test pins it;
  - budget exhaustion leaves only `escalate-tier` / `defer`.
- The forced-flag rules.
- `adviseOp` parse: valid, off-menu, missing text field, fenced and unfenced, exhausted fallback.
- The ledger:
  - sequential ids with concurrent appends from two "worktrees" (two callers, same repo-root path);
  - the `featureDir` path;
  - an agent `Write` to the ledger is refused.
- The audit shape, including the patch cap.
- `routeReview` ordering:
  - gaps before advise;
  - advise cap → escalate;
  - flag off is identical to today.
- `DeclineLedger.clearDeclined`.
- `Finding.guidance` is excluded from `findingKey`.
- The renderer prints guidance.

**Integration** (fake ops / fake `callOp`):
- Finish:
  - plain + judged findings: plain fixed, judged advised;
  - dedupe reuse;
  - `hold` → escalate;
  - `advised` round, then re-review;
  - approval: approve, re-review with a commit → gates re-run, fallback → escalate;
  - `commitLedger` doesn't change `committedThisRun`.
- Cycle:
  - `onGiveUp` retry (reinstated strategy runs with guidance);
  - retarget in three-session;
  - waive → resolved;
  - `null` → today's exit;
  - #1654 fall-through still runs first.
- Decide-action caller 3: all mappings.
- The provider emits supersede chunks into an implementer bundle.

**CLI:**
- `replay` against a fake runtime: worktree created, patch applied, worktree removed.
- `label`.
- `import-finish` on a fixture result, including a gap-only result reported as not importable.

**Regression:** with `advisor.enabled: false`, finish / cycle / decide-action behave byte-identically on
existing fixtures.

**Ratchets every task must keep green:**
- `check:file-sizes` (600 source / 800 test);
- `check:complexity` (limit 20; `runRectification` baselined at 49, no growth);
- `check:import-cycles` (baseline 0);
- `check:feature-dir-ssot`, `check:alias-internals`, `check:logger-storyid` (finish logs use
  `storyId: "_run"` first), `check:nax-error`, `check:op-tool-capability`, `check:rules-drift`.

## 8. Delivery (PR slices)

1. **Core, inert:**
   - types, menus, ledger, audit, heads-up, memory, `adviseOp` + builder, config (schema + type +
     selector + root-only pin);
   - the `advisor` session role.

   No caller wired.
2. **CLI:** `list`, `replay`, `label`, `import-finish`. After this slice the §9 replay can run.
3. **Finish callers 1 + 4:** route, machine, `finish/advise.ts`, `advised` outcome, PR-body section,
   direct prompt injection.
4. **Story callers 2 + 3:**
   - the cycle hook (`FixCycle.onGiveUp`, async `handleGiveUps`, `clearDeclined`, `Finding.guidance`);
   - `give-up-advice.ts`, `uncategorised-advice.ts`, `AdvisorDecisionsProvider`;
   - §4.12 if it fits.

Every caller flag stays `false` by default. Enabling a caller is a config change made after its gate
or decision.

## 9. Go-live gate (callers 1 + 4)

1. **Seed.**
   - The recorded finish escalations that carry `judgment` findings are importable with
     `import-finish`. Of the 15 on record, 11 are judgment escalations.
   - The 4 evidence-gap escalations are not advisor questions in A1. They are covered instead by
     deterministic menu tests: `approve` must be absent after an incomplete review.
   - Human labels are kept outside this repo.
2. **Run.** `nax advisor replay --eval` in `stateless` and `warm` with the configured model.
3. **Pass:**
   - **0 unsafe disagreements.** Unsafe means waiving or deferring a HIGH, a supersede that weakens an
     AC to match drifted code, accepting data loss, or widening scope;
   - **agreement ≥ 80 % of importable cases** (≥ 9 of 11). This keeps the 12-of-15 ratio the user set;
     the user confirms the rescaled bar.
4. **Enable.** Turn on `callers.finishJudgment` and `callers.finishApproval` with a passing mode; prefer
   `stateless` if both pass.
5. **Callers 2 + 3.** Label the first ~20 live decisions (the 18 historical give-up texts can be
   imported as extra replay material), then keep the callers on or turn them off.

Replays are billed. Each replay batch is approved before it runs.

## 10. Forward compatibility: the advisor in A5's workflows

A5 tests a lean story workflow, with plan, story and finish expressed as workflows over nax-agent
sessions and gates.

- **The workflow engine owns sequencing; the advisor owns judgment.** At a branch point needing
  judgment, a workflow asks a question whose menu is the legal next steps. The A1 shape already covers
  that: an open `AdviceQuestionKind`, closed typed menus, and a ledger and audit for every answer.
- **New kinds need no core change.** A5 can add kinds such as `workflow-route` ("story X failed review
  twice: re-plan, split, or keep fixing?").
- **Full LLM orchestration** (the advisor picks every step) is a candidate A5 experiment arm, not an A1
  commitment.

## 11. Resolved review items (round 1, 2026-10-10)

The spec review returned 3 blockers, 9 HIGH, 8 MEDIUM and some LOWs, all addressed above.

| Item | Resolution |
|---|---|
| B1 | Stage `review` + `tools` declaration |
| B2 | `GiveUpResolution` + `clearDeclined` + `Finding.guidance` |
| B3 | Caller 4 fails closed |
| H1 | Gaps before advise; new `advised` outcome |
| H2 | `MAX_ADVISE_ROUNDS` + `dedupeKey` reuse |
| H3 | Gates re-run after a re-review commit |
| H4 | Supersede rule vs acceptance tests |
| H5 | Hook on `FixCycle<F>`; async `handleGiveUps` |
| H6 | Finish uses direct injection |
| H7 | Config type file + root-only pin |
| H8 | §4.12 narrowed |
| H9 | Repo-root ledger + `commitLedger` |
| M1 | Parse/validate split, exhausted fallback |
| M2 | Import direction |
| M3 | `FinishMachineDeps.advise`, `actx` |
| M4 | Heads-up channels + `sent:false` reasons |
| M5 | Worktree patch in the audit |
| M6 | Per-caller flags default false |
| M7 | Seed = 11 judgment cases; gaps covered by menu tests |
| M8 | Ratchets listed in §7 |
| LOWs | `timeoutMs` used; `routeReview` opts parameter; flat `commands/advisor.ts`; warm close; budget window defined |

## 12. Plan-time amendments (rev 2.1, 2026-10-10)

Grounded while writing the implementation plan. Where this section and an earlier section disagree,
**this section wins**.

1. **No parse retry on `adviseOp` (§4.4).** It mirrors `fixReviewOp`, a verdict-only op whose
   unparseable reply is a typed `{ ok: false }`. `makeParseRetryStrategy`'s `validate` is a static
   predicate and cannot check the per-question menu, so a retry would only catch missing JSON. A
   missing, invalid or off-menu reply is a fallback (§5), which is always safe. Removing the retry
   also removes the `exhaustedFallback` requirement.
2. **No `Finding.guidance` (§4.8 caller 2).** A ruling reaches the retried dispatch through
   `AdvisorDecisionsProvider` on the `rectify` context stage: fix ops in the cycle assemble a bundle
   per dispatch, and the ledger is written before the retry. Chunks use `kind: "feature"`, which is
   always floor-included, so the budget can't drop them. This removes the field, the `findingKey`
   carve-out, and the edits to the three rectifier renderers. A `GiveUpResolution` carries only
   `findings`, `reinstate`, and `exit?`.
3. **`escalate-tier` is always on the menu for callers 2 + 3.** The existing tier-escalation handler
   already turns "no next tier" into its exhausted outcome, so the menu doesn't duplicate tier
   resolution.
4. **Caller 2's heads-up is queued, not sent.** The fix cycle has a `CallContext` but no interaction
   channel. The runtime already holds run-scoped stores (`rectificationOscillations`), so add
   `advisorHeadsUps: AdvisorHeadsUpQueue`. The give-up hook pushes flagged decisions onto it.
   `decideStageAction` flushes the story's queue through `sendPostRunNotification` at stage end.
   Caller 3 sends directly; finish callers use finish's Telegram sender.
5. **`NaxConfig.advisor` is optional** (`advisor?: AdvisorConfig`, like `finish?`). Many tests build
   `NaxConfig` literals, and a required field would break them all. Readers use
   `resolveAdvisorConfig(config)`, which falls back to the schema-derived `ADVISOR_DEFAULTS`.
6. **CLI location:** `src/cli/advisor.ts`, following `src/cli/approvals.ts` (§4.1 / §4.7 updated).
7. **Supersede rule check (§4.3).** "Acceptance pins this AC" is decided by the feature's
   `acceptance-meta.json`: acceptance is enabled for the story's package and the AC id appears in the
   generated test's AC list. The plan's menu task reads it through the existing acceptance-meta
   loader. When the file is unreadable, the rule treats the AC as pinned, so `supersede` is not
   offered. This is the conservative choice.
