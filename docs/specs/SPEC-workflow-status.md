# SPEC: Workflow Status

## Summary

Phase 1 of #2569. `verdict.openItems` in a workflow `result.json` becomes the complete list of what keeps a feature from ready: besides blocking findings, cannot-verify items and red final gates, it lists the advisor's finish-approval hold, decisions flagged for a human, incomplete stories, a CI state that blocks, and every draft reason no other item explains. The feature record keeps the facts this needs (the approval outcome, the CI detail and the story states). A new read-only command, `nax workflow status -f <feature> [--json]`, prints that verdict for the newest workflow run, so a finishing tool reads one list instead of rebuilding it from `result.json`, `branch-rereview.json`, the ledger and the advisor ledger.

## Motivation

`buildOpenItems` (`packages/nax/src/workflow/open-items.ts`) returns only `reviewOpen` findings, the branch review's cannot-verify items and red final gates. On run `auth-relogin-recovery` (PR #2566) the only draft reason was the advisor's finish-approval hold, `advisor held: Green gates are encouraging, but I have not reviewed the whole diff…`; `verdict.openItems` held five cannot-verify items and nothing explaining that reason. Incomplete stories, a failed or conflicting CI state, an uncommitted tree, a missing advisor ledger and a skipped re-review are likewise reasons with no item. A finishing tool (the nax-finish skill today) therefore rebuilds the list by hand from four artifacts whose shapes it has to know: `stories` is an object keyed by id, minors are objects, `newMinors` are strings. In one finish session two of those parses failed on the shapes.

The facts are lost before the verdict is built. `askApproval` (`src/workflow/approval.ts`) returns `{ approved, rationale }` with no decision id; `publish` folds the rationale into `reasons` and drops the rest; the CI wait's `detail` text (the source of the conflicting, no-checks and unavailable reasons) is not stored; and the story states live in `result.stories` and in the run's story summaries, which `buildVerdict(record)` never sees.

## Design

### Integration

Symbols this feature **only reads** (verified on `main` `1421eacde`):

- `readinessReasons(f: ReadinessFacts): string[]` (`packages/nax/src/workflow/approval.ts:62`). Produces, in order: the gate reasons (`gates red: <names>` or `NOTHING_VERIFIED` when no final gate ran), `CI failed`, the conflicting / no-checks / unavailable reason (`f.ciDetail ?? <default text>`), `stories gate-open: <ids>`, `stories not run: <ids>`, `<n> ruling(s) flagged for a human`, `branch review did not run`, `describeUnread(...)`, `RE_REVIEW_SKIPPED`, `COST_LIMITED`.
- `runDirsNewestFirst(featureDir: string): Promise<string[]>` and `readResult(runDir: string): Promise<WorkflowResultFile | null>` (`src/workflow/result.ts:121`, `:33`).
- `workflowFeatureDir(projectDir: string, feature: string): string` (`src/workflow/paths.ts:10`).
- `StorySummary` (`src/workflow/types.ts:159`): `{ id, title, state: StoryState, reason?, rounds, unreviewed, flagged, runDir? }`; `StoryState = WorkflowEndState | "not-run"`, `WorkflowEndState = "complete" | "complete-with-rulings" | "complete-gate-open"`. `complete` and `complete-with-rulings` are finished.
- `WorkflowStoryRecord.state?: WorkflowEndState` and `.reason?: string` (`types.ts:54`), stored under `WorkflowResultFile.stories` keyed by story id.
- `FeatureEnv.facts.stories: readonly StorySummary[]` (`src/workflow/feature-machine.ts`), in scope in `publishStep`.
- `CiWaitResult { outcome: CiWaitOutcome; detail: string }` (`src/workflow/ci-wait.ts`), with `CiWaitOutcome = "green" | "failed" | "pending" | "conflicting" | "no-checks" | "unavailable"`.
- `buildWorkflowPrBody(input: WorkflowPrBodyInput): string` (`src/workflow/pr-body.ts`). `openItemLine` renders any kind other than `gate` as `- [ ] **<id>** (<severity>, <kind>)` or `(<kind>)`, so the new kinds need no rendering change.
- `registerAdvisorCommand(program, deps)` and `_advisorCliDeps` (`src/cli/advisor.ts`): the pattern for a command group with injectable `log` / `logErr` / `exit` and a `guarded` action. `validateFeatureName(feature: string): void` (`src/utils/feature-name.ts:6`) throws a `NaxError` whose message is, for example, `Feature name must be a single path segment: ../x`. `validateDirectory(dirPath: string, baseDir?: string): string` (`src/config/path-security.ts:24`).

Symbols this feature **changes**. The baseline only locates the code; it is never the interface to implement.

- `askApproval` (`src/workflow/approval.ts:98`)
  - Baseline: `Promise<{ approved: boolean; rationale: string }>`
  - Target: `Promise<ApprovalOutcome>`, with `export interface ApprovalOutcome { readonly approved: boolean; readonly rationale: string; readonly decisionId?: string }` in `src/workflow/types.ts`. `decisionId` is the returned `AdviceDecision.id`; it is absent when the advisor returned no decision or threw.
- The CI reason in `readinessReasons`
  - Baseline: inline per-state ternaries.
  - Target: `export function ciReason(ci: FeatureCiState | undefined, detail?: string): string | undefined` in `approval.ts`, returning `CI failed` for `failed`, `detail ?? <the existing default>` for `conflicting` / `no-checks` / `unavailable`, and `undefined` for `green` / `pending` / `skipped` / `undefined`. `readinessReasons` calls it, so its output is unchanged. `approval.ts` also exports `NOTHING_VERIFIED`, `gateReasons` and a `storyReasons(states)` helper producing the `stories gate-open: …` / `stories not run: …` texts, so `open-items.ts` matches the exact texts `readinessReasons` writes.
- `PublishOutcome` (`src/workflow/finalize.ts:37`)
  - Baseline: `{ outcome; ci; url?; reasons }`
  - Target: adds `approval?: ApprovalOutcome` (present only when the advisor was asked) and `ciDetail?: string` (present only when `ci` is `conflicting`, `no-checks` or `unavailable`).
- `WorkflowFeatureRecord` (`src/workflow/types.ts:172`)
  - Target: adds `approval?: ApprovalOutcome`, `ciDetail?: string` and `storyStates?: readonly StoryStateItem[]`, with `export interface StoryStateItem { readonly id: string; readonly state: StoryState; readonly reason?: string }`. All three are absent on records written before this feature.
- `publishStep` (`src/workflow/feature-machine.ts:453`): also returns `approval` and `ciDetail` when the outcome carries them, and `storyStates` built from `env.facts.stories` (`{ id, state, reason? }`, in that order).
- `OpenItem.kind` (`src/workflow/types.ts:96`)
  - Baseline: `"finding" | "ruling" | "cannot-verify" | "gate"`
  - Target: adds `"advisor" | "story" | "ci" | "reason"`.
- `buildOpenItems(rec: WorkflowFeatureRecord): OpenItem[]` (`src/workflow/open-items.ts:31`). Signature unchanged; the items it adds are under "Open items" below. `BLOCKING_KINDS` is unchanged, so `workflowPassed` keeps its meaning.
- `upsertFeatureRecord` (`src/workflow/result.ts:141`): builds the verdict from the record with `storyStates` taken from `result.stories` (`{ id, state: state ?? "not-run", reason? }`) when the record's `storyStates` is undefined; an empty array is kept as it is.
- `PrParts` and `finishPr` (`finalize.ts:194`, `:200`)
  - Baseline: `PrParts { pr; body; draftUrl? }`; `finishPr(fc, parts, ci, reasons, approval: { approved; rationale } | null)`.
  - Target: `PrParts` gains `record: WorkflowFeatureRecord` and `stories: readonly StorySummary[]` (set by `prMode` from `input`), and `finishPr`'s `approval` parameter is `ApprovalOutcome | null`. The record's `reasons` is still empty at publish (`publishStep` is its only writer), so `finishPr` rebuilds the body's `openItems` from `buildOpenItems({ ...parts.record, approval, ci: ci.outcome, ciDetail, storyStates, reasons: finalReasons })`, where `ciDetail` is `ci.detail` only for `conflicting`, `no-checks` and `unavailable`, and `storyStates` comes from `parts.stories`. The draft's "Before marking ready" list then carries the advisor, story, CI and reason items the verdict does, under the same ids. Two exceptions: the flagged-decision items (see below), and reasons `publish` appends after the body is written (`a human already marked the PR ready; nax left it as is`, `PR update failed: …`), which reach only the verdict. Those are always appended after `finalReasons`, so they never shift an earlier reason's position.

### Open items

`buildOpenItems` stays a short composition of per-kind helpers in `open-items.ts` (`advisorItems`, `storyItems`, `ciItem`, `reasonItems`, and `isExplained` for the rule below), each under the complexity limit of 20. It returns, in this order: the existing finding / ruling items, cannot-verify items and gate items, then:

| Kind | Source | `id` | `issue` |
|:--|:--|:--|:--|
| `advisor` | `rec.approval` with `approved: false` | `approval.decisionId`, else `_run:approval` | `approval.rationale` |
| `advisor` | each id in `rec.flaggedDecisions` not already an advisor item | the decision id | `advisor decision <id> needs a human: see nax advisor list` |
| `story` | each `rec.storyStates` entry whose `state` is not `complete` or `complete-with-rulings` | the story id | `<id> did not finish` for `not-run`; otherwise `<id> ended <state>`, followed by `: <reason>` when a reason is set |
| `ci` | `ciReason(rec.ci, rec.ciDetail)` is defined | `_run:ci` | that reason text |
| `reason` | each `rec.reasons` entry not explained (below) | `_run:reason<n>`, where `<n>` is the reason's 1-based position in `rec.reasons` (explained reasons keep their positions, so an id is stable when later reasons are appended) | the reason text |

A reason is **explained** when it equals a text nax produced for a fact that already has an item: a gate reason (`gates red: …`) while a gate item exists; the `ciReason` text while the `ci` item exists; `stories gate-open: <ids>` / `stories not run: <ids>` while a story item exists for every id it names; `approval.rationale` while the approval's advisor item exists; and `<n> ruling(s) flagged for a human` while `flaggedDecisions` yields at least `<n>` advisor items (counting the ids in `flaggedDecisions`, which span every run of the feature, and not the approval item). A flagged count with fewer such items (story flags and pre-flight holds are counted but are not always ledger decisions, and `flaggedDecisions` is absent when the ledger could not be read) is a `reason` item. `NOTHING_VERIFIED` has no gate item, so it is a `reason` item.

Advisor items for `flaggedDecisions` appear in `result.json` only: `publishStep` collects those ids after `publish` returns, so the PR body, written inside `publish`, does not list them, and there the flagged count is a `reason` item. Its "Advisor decisions" section already names every decision.

### CLI Behavior

`nax workflow status -f <feature> [--json] [-d <dir>]`, registered by `registerWorkflowCommand(program, deps?)` in `src/cli/workflow.ts` with `_workflowCliDeps = { log, logErr, exit }` (writing through `console.log` / `console.error` inside the deps, as `_advisorCliDeps` does), exported from `src/cli/index.ts` and called from `bin/nax.ts` beside `registerAdvisorCommand`. Read-only: it reads `.nax/features/<feature>/workflow/*/result.json` and writes nothing.

It validates the feature name with `validateFeatureName` before building any path, takes the newest run directory from `runDirsNewestFirst(workflowFeatureDir(dir, feature))`, and reads its `result.json`. It builds `openItems` with `buildOpenItems` from `featureWorkflow`, with `storyStates` filled from `result.stories` when the record has none (the same rule as `upsertFeatureRecord`), so a `result.json` written by an older nax reports the same items a fresh run would, and a run that never reached publish still reports its items. `workflowPassed` comes from `buildVerdict` and is omitted when the record has no `outcome`. `runId` is the run directory's name.

`--json` prints one object on stdout:

```json
{
  "feature": "auth-relogin-recovery",
  "runId": "336c1511-13b3-42b4-9924-7b8015d4c4f9",
  "runDir": ".nax/features/auth-relogin-recovery/workflow/336c1511-13b3-42b4-9924-7b8015d4c4f9",
  "step": "done",
  "outcome": "draft",
  "ci": "green",
  "url": "https://github.com/nathapp-io/nax/pull/2566",
  "workflowPassed": true,
  "reasons": ["advisor held: …"],
  "openItems": [{ "id": "D-1", "kind": "advisor", "issue": "advisor held: …" }]
}
```

`runDir` is relative to the project directory. `outcome`, `ci`, `url` and `workflowPassed` are omitted when the record has none (a run that never reached publish).

Without `--json` it prints `<feature>: <outcome> <url>` on the first line (`<outcome>` is `not published` when absent), then one line per open item, `- [<kind>] <id> — <issue>`, and `No open items.` when the list is empty.

Exit codes: `0` when the outcome is `ready` and `openItems` is empty; `2` otherwise, including a record with no `outcome` (something needs a human); `1` on an error: an invalid feature name, no `.nax/` directory, no workflow run with a readable `result.json`, or a `result.json` with no `featureWorkflow`. On an error, `--json` prints `{"error":"<message>"}` on stdout and plain mode prints the message on stderr.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `validateFeatureName` rejects the feature name | exit 1 with its message, no file read |
| No run directory holds a `result.json` | exit 1 with `no workflow result for feature <feature>` |
| The newest `result.json` has no `featureWorkflow` | exit 1 with `workflow for <feature> has not started its feature steps (run <runId>)` |
| The newest `result.json` is unreadable or not JSON | `readResult` returns null for it; the command moves to the next-newest run directory |

## Out of Scope

- `nax gates run`, `nax workflow record` and `nax workflow promote` (phases 2 and 3 of #2569).
- Reading live PR checks or mergeability from the forge: `nax workflow status` reports the CI state recorded at publish time.
- Making any of the new kinds blocking for `workflowPassed`: `BLOCKING_KINDS` stays `finding`, `ruling`, `gate`.
- Listing `leave` minors, `newMinors` or fix-now minors as open items.
- Listing flagged advisor decisions in the PR body's "Before marking ready" list.
- Including the full advisor decision objects in the `nax workflow status` output; `nax advisor list -f <feature> --json` stays the source for them.
- Changing `approvalEvidence` or the finish-approval question.
- Pipeline execution mode, which is frozen.
- A test that the built `nax` binary registers the `workflow` group: no test spawns the binary (the test rules forbid it). The `bin/nax.ts` diff review and a `bun run dev workflow status --help` check after merge cover it.
- Updating the nax-finish skill to call `nax workflow status`; that change lands in nathapp-io/nax-toolkit-skills.

## Stories

### US-001 — The feature record keeps the approval outcome, the CI detail and the story states

Workdir: `packages/nax`

No dependencies.

Add `ApprovalOutcome` and `StoryStateItem` to `src/workflow/types.ts` and the three optional `WorkflowFeatureRecord` fields. `askApproval` returns the decision id. Extract `ciReason` from `readinessReasons`. `publish` returns `approval` when the advisor was asked and `ciDetail` for the conflicting, no-checks and unavailable states. `publishStep` writes `approval`, `ciDetail` and `storyStates` into the record.

### US-002 — `verdict.openItems` lists advisor, story, CI and reason items

Workdir: `packages/nax`

Depends on US-001.

Extend `OpenItem.kind` and `buildOpenItems` per the "Open items" table and the explained-reason rule. `upsertFeatureRecord` fills `storyStates` from `result.stories` when the record has none. `finishPr` rebuilds the PR body's open items with the approval, CI and story facts.

### US-003 — `nax workflow status`

Workdir: `packages/nax`

Depends on US-002.

Create `src/cli/workflow.ts` with `registerWorkflowCommand`, `_workflowCliDeps` and `workflowStatusCommand`, export them from `src/cli/index.ts`, and register the group in `bin/nax.ts` beside `registerAdvisorCommand`.

Story split rationale: US-001 changes what the record stores, US-002 changes how the verdict reads it, US-003 adds the command that prints it; each depends on the previous one's output. Every story is within the 24-assertion `maxAcCount`.

### Context Files

**US-001**
- `packages/nax/src/workflow/approval.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts` — the `wire()` publish harness to follow
- `packages/nax/test/helpers/workflow-feature-machine.ts` — the feature-machine harness and its `PUBLISHED` outcome

**US-002**
- `packages/nax/src/workflow/open-items.ts`
- `packages/nax/src/workflow/approval.ts` — `ciReason`, `NOTHING_VERIFIED` and the reason texts the explained rule matches
- `packages/nax/src/workflow/result.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/test/unit/workflow/open-items.test.ts`

**US-003**
- `packages/nax/src/cli/advisor.ts` — the command-group pattern to mirror
- `packages/nax/test/unit/cli/advisor-list-label.test.ts` — the CLI test harness to mirror
- `packages/nax/src/workflow/result.ts`
- `packages/nax/src/workflow/open-items.ts`
- `packages/nax/bin/nax.ts`

### Creates

**US-001**
- `packages/nax/test/unit/workflow/feature-machine-publish-record.test.ts` — ACs 14-17, on the feature-machine harness.

**US-002**
- `packages/nax/test/unit/workflow/open-items-kinds.test.ts` — ACs 1-17.

**US-003**
- `packages/nax/src/cli/workflow.ts`
- `packages/nax/test/unit/cli/workflow-status.test.ts` — ACs 1-15.

### Modifies

**US-001**
- `packages/nax/src/workflow/approval.ts` — `askApproval` returns `ApprovalOutcome` with the decision id, and `ciReason` is extracted from `readinessReasons` with its output unchanged, as the Design states.
- `packages/nax/src/workflow/finalize.ts` — `PublishOutcome` gains `approval` and `ciDetail`, set where the advisor is asked and where the CI wait reported a detail-bearing state.
- `packages/nax/src/workflow/feature-machine.ts` — `publishStep` copies `approval` and `ciDetail` from the outcome and writes `storyStates` from `env.facts.stories`.
- `packages/nax/src/workflow/types.ts` — adds `ApprovalOutcome`, `StoryStateItem` and the three optional record fields.
- `packages/nax/test/helpers/workflow-feature-machine.ts` — the harness's `publish` step always returns the fixed `PUBLISHED` outcome. Add an optional `published?: PublishOutcome` script field that the `publish` step returns instead when set; every existing caller leaves it unset and keeps `PUBLISHED`.
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts` — "AC-21/22/23/24/25: conflict keeps draft" expects the `publish` result to equal exactly `{ outcome: "draft", ci: "conflicting", url, reasons: [...] }`; it now also carries `ciDetail: "PR has merge conflicts with main"`. `wire(ci)` gains an optional second argument `{ hold?: { id: string; rationale: string } }` that makes its advisor return a `hold` decision with that id and rationale instead of the approval; every existing call passes nothing. ACs 10-13 are added to this file.
- `packages/nax/test/unit/workflow/approval.test.ts` — ACs 1-9 are added here, and "asks finish-approval with an approve/hold menu and the evidence" expects exactly `{ approved: true, rationale: "clean" }` and "hold, no decision, or a throw" expects exactly `{ approved: false, rationale: "advisor held: risky" }`. Both now also carry `decisionId`, the id of the decision `makeAdviceDecision` returned; the no-decision and throw cases still carry no `decisionId`.
- `packages/nax/test/unit/workflow/finalize.test.ts` — "happy path: push, draft PR, CI pending, advisor approves -> promoted, ready" expects the outcome to equal exactly `{ outcome: "ready", ci: "pending", url, reasons: [] }`. It now also carries `approval: { approved: true, rationale, decisionId }` from the stub advisor's decision; the other fields are unchanged.

**US-002**
- `packages/nax/src/workflow/open-items.ts` — adds the advisor, story, CI and reason items and the explained-reason rule.
- `packages/nax/src/workflow/types.ts` — `OpenItem.kind` gains `advisor`, `story`, `ci` and `reason`.
- `packages/nax/src/workflow/result.ts` — `upsertFeatureRecord` passes `storyStates` from `result.stories` to `buildVerdict` when the record has none.
- `packages/nax/src/workflow/finalize.ts` — `PrParts` gains `record` and `stories`, `finishPr` takes `ApprovalOutcome | null` and rebuilds the body's `openItems` with the approval, CI, story and reason facts, as the Design states.
- `packages/nax/src/workflow/approval.ts` — also exports `NOTHING_VERIFIED`, `gateReasons` and `storyReasons`; `readinessReasons` uses `storyReasons`, so its output is unchanged.
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts` — ACs 20-23 are added here, using `wire()` with the `hold` option US-001 adds.
- `packages/nax/test/unit/workflow/result.test.ts` — ACs 18-19 are added here, and "upsertFeatureRecord writes a top-level verdict once the outcome is set" expects `openItems: []` for a record whose `reasons` is `["r"]`. `r` is now an unexplained reason, so the expected `openItems` is `[{ id: "_run:reason1", kind: "reason", issue: "r" }]`; `workflowPassed`, `outcome` and `reasons` are unchanged.

**US-003**
- `packages/nax/src/cli/index.ts` — also export `registerWorkflowCommand`, `_workflowCliDeps`, `WorkflowCliDeps` and `workflowStatusCommand`.
- `packages/nax/bin/nax.ts` — calls `registerWorkflowCommand(program)` after `registerAdvisorCommand`.

### Seams

- US-001 records `approval`, `ciDetail` and `storyStates`; US-002 reads them. US-002's seam ACs enter at `publish` (wired as in `finalize-ci-gate.test.ts`) for the PR body and at `upsertFeatureRecord` for `result.json`.
- US-003 consumes `buildVerdict`; its ACs enter at the `workflow status` command parsed by a `commander` program that `registerWorkflowCommand` registered.

## Acceptance Criteria

### US-001

1. [unit] `askApproval` with an advisor whose decision is `{ id: "D-7", action: { type: "approve" }, rationale: "clean" }` returns `{ approved: true, rationale: "clean", decisionId: "D-7" }`.
2. [unit] `askApproval` with an advisor whose decision is `{ id: "D-1", action: { type: "hold", reason: "x" }, rationale: "risky" }` returns `{ approved: false, rationale: "advisor held: risky", decisionId: "D-1" }`.
3. [unit] `askApproval` with an advisor that returns no decision and `fallbackReason` `"all models failed"` returns `{ approved: false, rationale: "advisor unavailable: all models failed" }` with no `decisionId` key.
4. [unit] `askApproval` with an advisor whose `advise` throws `Error("boom")` returns an outcome with no `decisionId` key.
5. [unit] `ciReason("failed")` returns `"CI failed"`.
6. [unit] `ciReason("conflicting", "PR #9 has merge conflicts")` returns `"PR #9 has merge conflicts"`.
7. [unit] `ciReason("conflicting")` with no detail returns `"PR has merge conflicts with its base branch"`.
8. [unit] `ciReason` returns `undefined` for each of `"green"`, `"pending"` and `"skipped"`.
9. [unit] `readinessReasons` with the `READY` facts of `approval.test.ts` overridden by `ci` `"unavailable"` and `ciDetail` `"gh: 502"` returns exactly `["gh: 502"]`.
10. [unit] `publish`, wired with `wire({ outcome: "green", detail: "ok" }, { hold: { id: "D-1", rationale: "risky" } })` (every ready condition met), returns an outcome whose `approval` is `{ approved: false, rationale: "advisor held: risky", decisionId: "D-1" }`.
11. [unit] `publish`, wired with `wire({ outcome: "failed", detail: "1 check failed" })`, returns an outcome with no `approval` key and never asks the advisor.
12. [unit] `publish`, wired with `wire({ outcome: "conflicting", detail: "PR #9 has merge conflicts" })`, returns an outcome whose `ciDetail` is `"PR #9 has merge conflicts"`.
13. [unit] `publish`, wired with `wire({ outcome: "green", detail: "3 checks passed" })`, returns an outcome with no `ciDetail` key.
14. [unit] `runFeatureMachine`, with a harness whose `published` script field holds an outcome with `approval` `{ approved: false, rationale: "advisor held: r", decisionId: "D-1" }`, ends with a record whose `approval` equals that object.
15. [unit] `runFeatureMachine`, with a harness whose `published` script field holds an outcome with `ciDetail` `"PR #9 has merge conflicts"`, ends with a record whose `ciDetail` is `"PR #9 has merge conflicts"`.
16. [unit] `runFeatureMachine` with `facts.stories` `US-001` `complete` and `US-002` `complete-gate-open` with reason `red: lint` ends with a record whose `storyStates` is `[{ id: "US-001", state: "complete" }, { id: "US-002", state: "complete-gate-open", reason: "red: lint" }]`.
17. [unit] `runFeatureMachine` with no `published` script field (the default `PUBLISHED` outcome, which has no `approval`) ends with a record that has no `approval` key.

### US-002

1. [unit] `buildOpenItems` on a record with `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }` returns a list containing `{ id: "D-1", kind: "advisor", issue: "advisor held: x" }`.
2. [unit] `buildOpenItems` on a record with `approval` `{ approved: false, rationale: "advisor unavailable: boom" }` and no `decisionId` returns a list containing `{ id: "_run:approval", kind: "advisor", issue: "advisor unavailable: boom" }`.
3. [unit] `buildOpenItems` on a record with `approval` `{ approved: true, rationale: "clean", decisionId: "D-7" }` returns no item with kind `advisor`.
4. [unit] `buildOpenItems` on a record with `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }` and `flaggedDecisions` `["D-1", "D-3"]` returns exactly two `advisor` items, ids `D-1` then `D-3`, and the `D-3` item's `issue` starts with `advisor decision D-3 needs a human`.
5. [unit] `buildOpenItems` on a record with `storyStates` `US-001` `complete`, `US-002` `complete-with-rulings`, `US-003` `complete-gate-open` with reason `red: lint` and `US-004` `not-run` returns `story` items for exactly `US-003` and `US-004`, with issues `US-003 ended complete-gate-open: red: lint` and `US-004 did not finish`.
6. [unit] `buildOpenItems` on a record with `ci` `"failed"` returns a list containing `{ id: "_run:ci", kind: "ci", issue: "CI failed" }`.
7. [unit] `buildOpenItems` on a record with `ci` `"conflicting"` and `ciDetail` `"PR #9 has merge conflicts"` returns a `ci` item whose `issue` is `PR #9 has merge conflicts`.
8. [unit] `buildOpenItems` on records with `ci` `"green"`, `"pending"` and `"skipped"` returns no item with kind `ci` for any of them.
9. [unit] `buildOpenItems` on a record with `reasons` `["uncommitted changes after the branch fix", "branch review did not run"]` and no other facts returns `reason` items `_run:reason1` and `_run:reason2` carrying those two texts in that order.
10. [unit] `buildOpenItems` on a record with `finalGates` `{ ran: ["lint"], failing: ["lint"] }`, `reasons` `["gates red: lint"]` returns the `lint` gate item and no `reason` item.
11. [unit] `buildOpenItems` on a record with `ci` `"failed"`, a `storyStates` entry `US-003` in state `complete-gate-open`, `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }` and `reasons` `["CI failed", "stories gate-open: US-003", "advisor held: x"]` returns no `reason` item.
12. [unit] `buildOpenItems` on a record with `reasons` `["2 ruling(s) flagged for a human"]` and `flaggedDecisions` `["D-3", "D-4"]` returns no `reason` item.
13. [unit] `buildOpenItems` on a record with `reasons` `["2 ruling(s) flagged for a human"]` and no `flaggedDecisions` returns one `reason` item `_run:reason1` carrying that text.
14. [unit] `buildOpenItems` on a record with `finalGates` `{ ran: ["lint"], failing: ["lint"] }` and `reasons` `["gates red: lint", "branch review did not run"]` returns one `reason` item, with id `_run:reason2`.
15. [unit] `buildOpenItems` on a record whose `finalGates` is `{ ran: [], failing: [] }` and whose `reasons` holds the nothing-verified text `readinessReasons` produces for it returns one `reason` item carrying that text.
16. [unit] `buildOpenItems` on a record with a `reviewOpen` finding, a cannot-verify item, a red gate, a held approval, a story state, a failed CI and an unexplained reason returns kinds in the order `finding`, `cannot-verify`, `gate`, `advisor`, `story`, `ci`, `reason`.
17. [unit] `buildVerdict` on a record with `passed` `true`, `outcome` `"draft"` and `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }` returns `workflowPassed` `true`.
18. [unit] `upsertFeatureRecord` on a record with `outcome` `"draft"` and no `storyStates`, into a run directory whose `result.json` already holds a story record `US-002` with state `complete-gate-open`, writes a `verdict.openItems` containing a `story` item with id `US-002`.
19. [unit] `upsertFeatureRecord` on a record with `outcome` `"draft"` and `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }` writes a `verdict.openItems` containing `{ id: "D-1", kind: "advisor", issue: "advisor held: x" }`.
20. [unit] `publish`, wired with `wire({ outcome: "green", detail: "ok" }, { hold: { id: "D-1", rationale: "risky" } })`, writes a final PR body whose "Before marking ready" section contains a line starting `- [ ] **D-1** (advisor) — advisor held:`.
21. [unit] `publish`, wired with `wire({ outcome: "failed", detail: "1 check failed" })`, writes a final PR body whose "Before marking ready" section contains a line starting `- [ ] **_run:ci** (ci) — CI failed`.
22. [unit] `publish`, wired with `wire({ outcome: "green", detail: "ok" })` and `input.stories` holding one summary `US-002` in state `complete-gate-open`, writes a final PR body whose "Before marking ready" section contains a line starting `- [ ] **US-002** (story)`.
23. [unit] `publish`, wired with `wire({ outcome: "green", detail: "ok" })` and `input.record.reviewRan` `false`, writes a final PR body whose "Before marking ready" section contains a line starting `- [ ] **_run:reason1** (reason) — branch review did not run`.

### US-003

1. [cli] `workflow status -f auth --json -d <dir>`, where `<dir>/.nax/features/auth/workflow/r1/result.json` holds a `featureWorkflow` with `outcome` `"draft"`, `url` `"https://gh/pr/7"`, `ci` `"green"` and `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }`, prints one JSON object whose `feature` is `auth`, `runId` is `r1`, `outcome` is `draft`, `url` is `https://gh/pr/7` and `openItems` contains the `D-1` advisor item.
2. [cli] That call exits with code 2.
3. [cli] `workflow status -f auth --json` on a `result.json` whose `featureWorkflow` has `outcome` `"ready"`, `passed` `true` and nothing open prints `openItems` `[]` and exits with code 0.
4. [cli] `workflow status -f auth --json` on a `result.json` whose `featureWorkflow` has `outcome` `"ready"` and one `cannotVerify` entry exits with code 2.
5. [cli] `workflow status -f auth --json` on a `result.json` with no `verdict` key, whose `featureWorkflow` has `outcome` `"draft"` and no `storyStates`, and whose `stories` holds `US-002` with state `complete-gate-open`, prints `openItems` containing a `story` item with id `US-002`.
6. [cli] With two run directories `r-old` and `r-new` under `.nax/features/auth/workflow/`, where `r-new/result.json` has the later modification time, `workflow status -f auth --json` prints `runId` `r-new`.
7. [cli] When the newer run directory's `result.json` is not valid JSON, `workflow status -f auth --json` prints the older run directory's `runId`.
8. [cli] `workflow status -f auth --json` with no `.nax/features/auth/workflow/` directory prints `{"error":"no workflow result for feature auth"}` and exits with code 1.
9. [cli] `workflow status -f ../x --json` prints an object whose `error` is `Feature name must be a single path segment: ../x`, exits with code 1, and reads no file.
10. [cli] `workflow status -f auth --json` on a `result.json` with no `featureWorkflow` prints an object whose `error` starts with `workflow for auth has not started its feature steps` and exits with code 1.
11. [cli] `workflow status -f auth` without `--json`, on a `result.json` whose `featureWorkflow` has `outcome` `"draft"`, `url` `"https://gh/pr/7"` and `approval` `{ approved: false, rationale: "advisor held: x", decisionId: "D-1" }`, prints `auth: draft https://gh/pr/7` as its first line and a line `- [advisor] D-1 — advisor held: x`.
12. [cli] `workflow status -f auth` without `--json`, on a `result.json` whose `featureWorkflow` has `outcome` `"ready"`, `passed` `true` and nothing open, prints a line `No open items.`.
13. [cli] `workflow status -f auth --json` on a `result.json` whose `featureWorkflow` has no `outcome` and whose `stories` holds `US-002` with state `complete-gate-open` prints `openItems` containing a `story` item with id `US-002`, prints an object with no `outcome` and no `workflowPassed` key, and exits with code 2.
14. [cli] After `workflow status -f auth --json` runs, the bytes of every `result.json` under `.nax/features/auth/workflow/` and the list of entries in that directory are unchanged.
15. [unit] Importing `registerWorkflowCommand` and `workflowStatusCommand` from the nax `cli` barrel succeeds, and `registerWorkflowCommand(new Command())` returns a command group named `workflow` with a subcommand `status`.

Verification note (US-003): the `bin/nax.ts` registration line is checked by `bun run typecheck` and `bun run build`, which catch a wrong call but not a missing one; no unit test spawns the `nax` binary (forbidden by the test rules), so a missing registration is a known gap that the review of the `bin/nax.ts` diff covers.
