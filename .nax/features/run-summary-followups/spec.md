# SPEC: run-summary-followups — gate-open stories in the run views and story metrics, and a quieter plan secret-shape warning

Closes: #2885

## Summary

`fault-and-run-summary` (#2884) added a `complete-gate-open` count to the run outcome. Three readers still miss it. `nax status --cost` and `nax runs show` print completed and failed counts with no gate-open count, so a gate-open story looks like it vanished. The saved per-story metrics also record a gate-open story as a first-pass success. In addition, the plan-time warning for secret-shaped PRD text (`findPrdSecretShapes`) fires on 16% of existing PRDs, and every hit seen so far has been a test fixture. This feature adds the gate-open count to both views, derives story-metric success from the workflow end state, and limits the plan warning to provider-format keys in a single summary line per plan.

## Motivation

- `nax status --cost` shows e.g. `completed 1 / total 2 / failed 0` for a run where one story closed gate-open, and gives no explanation for the missing story. `buildLastRun` drops `RunMetrics.storiesGateOpen`, and `displayLastRunMetrics` never reads it.
- `nax runs show` prints `storiesCompleted` and `storiesFailed` from the run-summary record, though that record already carries `storiesGateOpen` (`run-completion-phases.ts:400`).
- In workflow mode `workflowStage` always sets `ctx.agentResult.success: true` (`workflow/stage.ts:79`), including when the story closed `complete-gate-open`. `collectStoryMetrics` derives `success` and `firstPassSuccess` from `agentResult.success`, so a gate-open story is saved as a success and lifts `firstPassRate` and the per-model `passRate`. (The issue names only the batch path. The single-story path, which is the one workflow mode uses, has the same defect.)
- The plan warning runs the full log redactor, so structured key/value patterns (`TOKEN=...`, `api_key: ...`, `Bearer ...`, cookies, URL credentials) trigger it. Replayed over 2,955 local PRDs it gave 1,408 warnings on 461 PRDs. Of the 513 distinct flagged strings, about 419 came from structured patterns, and all were deliberate fixtures in security specs. GitHub push protection (the GH013 rejection behind #2879) blocks only provider-format keys. One line per field (37 on one feature) teaches users to ignore the warning.

## Design

### Approach

**Gate-open in `nax status --cost` (`packages/nax/src/metrics/report.ts`, `packages/nax/src/cli/status-cost.ts`).** `CostRunSummary` gains `storiesGateOpen: number`. `buildLastRun` sets it to `last.storiesGateOpen ?? 0`, so a record written before #2884 (no field) reports 0. The `--json` path (`emitCostReportJson` -> `toCostReport`) therefore always carries the number. `displayLastRunMetrics` adds `storiesGateOpen` to the `Last Run: <feature>` info entry's data only when the value is greater than 0, so the human-readable output of older or clean runs is unchanged.

**Gate-open in `nax runs show` (`packages/nax/src/cli/runs.ts`).** `runsShowCommand` adds `storiesGateOpen` to the `Run Summary` info entry's data when the run-summary record's `data.storiesGateOpen` is a number greater than 0. If the field is absent (older record) or 0, the entry is unchanged.

**Story-metric success from the workflow end state (`packages/nax/src/metrics/tracker.ts`).** `collectStoryMetrics` computes `const gateOpen = ctx.workflowEndState === "complete-gate-open"`. Then `success` is `agentResult?.success === true && !gateOpen`, and `firstPassSuccess` adds the same `!gateOpen` term to its existing escalation-free and prior-failure-free terms. `complete` and `complete-with-rulings` still count as success. When `workflowEndState` is undefined (a pipeline-mode story), the old `agentResult` rule holds. The aggregator needs no change: `firstPassRate` and `modelEfficiency.passRate` read these two fields. Other readers of the saved fields change behaviour for a gate-open story as an intended consequence, with no code change: `context/engine/providers/prior-run-failure.ts:91` now lists its attempts as a prior failure in later runs, `metrics/aggregator.ts:243` can add it to `exhaustedStories` when its last swap hop was an availability failure, `replay/reconstruct.ts:105` copies `success: false`, and `routing/calibrate/band-stats.ts:42` no longer counts it as first-pass.

**Provider-format secret shapes, one summary line (`packages/nax/src/prd/secret-shapes.ts`, `packages/nax/src/plan/strategies/persist-prd.ts`).** `findPrdSecretShapes` no longer calls `redactSecrets`. It tests each story field (title, description, each acceptance criterion, in that order) against the `SECRET_VALUE_PATTERNS` entries whose `kind` is in a new exported constant:

```ts
export const PROVIDER_SECRET_KINDS: ReadonlySet<string> = new Set([
  "openai", "github", "github-pat", "npm", "aws", "gitlab", "google",
  "stripe", "slack", "telegram", "pem", "jwt",
]);
```

For each pattern it resets `re.lastIndex = 0` before testing. A field yields at most one finding, carrying the `kind` of the first matching pattern in `SECRET_VALUE_PATTERNS` order. `PrdSecretShape` gains `readonly kind: string`. The structured kinds (`assignment`, `bearer`, `basic`, `api-key-header`, `cookie`, `url-credentials`) and the redactor's structured key/value pass no longer produce findings. `_secretShapesDeps` (whose only member was `redactSecrets`) is deleted.

`finalizeAndWritePrd` (`persist-prd.ts`) replaces its one-warn-per-finding loop with at most one warn per plan:

```ts
getLogger().warn("plan", "PRD story text has secret shapes", {
  count: 3,
  fields: ["US-002 description", "US-004 title", "US-004 acceptanceCriteria[3]"],
  kinds: ["openai", "pem"],
});
```

`fields` lists `"<storyId> <field>"` in finding order. `kinds` holds the distinct kinds, sorted ascending. `count` equals `fields.length`. Nothing is logged when there are no findings. The existing `catch` that logs `PRD secret-shape scan could not run` stays as it is. The warning never carries the matched text.

### Integration (extends existing code)

The baseline below exists only to locate the code. It is never the interface to implement.

Symbols this feature changes:

- `CostRunSummary` (`packages/nax/src/metrics/report.ts:39`). Baseline: `{ runId, feature, startedAt, completedAt, durationMs, totalStories, storiesCompleted, storiesFailed, totalCost, avgCostPerStory, stories }`. Target: the same plus `storiesGateOpen: number`.
- `buildLastRun(runs: RunMetrics[]): CostRunSummary | null` (`report.ts:118`, file-local). Target: also sets `storiesGateOpen: last.storiesGateOpen ?? 0`.
- `displayLastRunMetrics(workdir: string): Promise<void>` (`packages/nax/src/cli/status-cost.ts`). Target: the `Last Run: <feature>` entry's data spreads `{ storiesGateOpen }` when it is > 0.
- `runsShowCommand(options: RunsShowOptions): Promise<void>` (`packages/nax/src/cli/runs.ts:182`). Target: the `Run Summary` entry's data spreads `{ storiesGateOpen }` when `completeEvent.data.storiesGateOpen` is a number > 0.
- `collectStoryMetrics(ctx: PipelineContext, storyStartTime: string): Promise<StoryMetrics>` (`packages/nax/src/metrics/tracker.ts:260`). Target: `success` and `firstPassSuccess` are false when `ctx.workflowEndState === "complete-gate-open"`.
- `PrdSecretShape` (`packages/nax/src/prd/secret-shapes.ts:4`). Baseline: `{ storyId, field }`. Target: `{ storyId, field, kind }`.
- `findPrdSecretShapes(prd: PRD, scope?: ReadonlySet<string>): PrdSecretShape[]` (`secret-shapes.ts:13`). The signature is unchanged; the matching becomes provider-format only, as described in Approach.
- `finalizeAndWritePrd` (`packages/nax/src/plan/strategies/persist-prd.ts`, loop at line 359). Target: one summary warn, as described in Approach.

Symbols this feature only reads:

- `RunMetrics.storiesGateOpen?: number` (`packages/nax/src/metrics/types.ts:326`).
- `PipelineContext.workflowEndState?: StoryState` (`packages/nax/src/pipeline/types.ts:57`); `WorkflowEndState = "complete" | "complete-with-rulings" | "complete-gate-open"` (`packages/nax/src/workflow/types.ts:36`).
- `SECRET_VALUE_PATTERNS: readonly SecretValuePattern[]` and `SecretValuePattern { kind; re; acceptMatch? }`, imported from `@nathapp/nax-agent/internal` (the same entry `packages/nax/src/logger/index.ts:10` uses).
- `findRunSummary(entries)` in `runs.ts` returns the run-summary record whose `data` carries `storiesGateOpen` (written by `run-completion-phases.ts:400`).

Patterns to follow: conditional log fields use the spread form already used in `displayLastRunMetrics` (`...(lastRun.errorCostUsd !== undefined ? { errorCostUsd: ... } : {})`).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A `RunMetrics` record with no `storiesGateOpen` (written before #2884) | `CostRunSummary.storiesGateOpen` is 0; the `Last Run` entry has no `storiesGateOpen` key. |
| A run-summary record with no `storiesGateOpen` | `nax runs show` prints the `Run Summary` entry without the key. |
| `ctx.workflowEndState` undefined (pipeline mode) | `success` and `firstPassSuccess` follow the old `agentResult` rule. |
| `findPrdSecretShapes` throws inside `finalizeAndWritePrd` | One warn `PRD secret-shape scan could not run` with no data, and the PRD is still written (existing behaviour, kept). |

## Out of Scope

- The batch story-metrics path (`collectBatchMetrics`, `success: true` for every batch story) is not changed: batching is pipeline mode only (`workflowStage` throws `WORKFLOW_BATCH_UNREACHABLE` on a batch), and pipeline mode is frozen.
- Gate-open is not added to `nax status` feature views, `nax runs list`, or the aggregate `CostAggregate`; #2885 names only `nax status --cost` last-run and `nax runs show`.
- The log redactor (`redactSecrets`, `SECRET_VALUE_PATTERNS`) and its patterns are not changed; only the plan-time PRD scan narrows which kinds it reports.
- The plan secret-shape scan stays a warning; it never blocks `nax plan` or edits the PRD.
- Existing saved `metrics.json` records are not rewritten; a gate-open story saved as a success before this feature stays as saved.

## Stories

### US-001 — gate-open count in `nax status --cost` and `nax runs show`

Workdir: packages/nax. No dependencies.

`CostRunSummary` carries `storiesGateOpen` (0 for older records), the `--json` cost report includes it, and both human-readable views print it when it is non-zero.

### US-002 — a gate-open story is not a success in story metrics

Workdir: packages/nax. No dependencies.

`collectStoryMetrics` sets `success` and `firstPassSuccess` to false when the story closed `complete-gate-open`, so the run aggregate's first-pass rate and per-model pass rate no longer count it.

### US-003 — the plan secret-shape warning reports provider-format keys in one line

Workdir: packages/nax. No dependencies.

`findPrdSecretShapes` matches only the provider-format kinds in `PROVIDER_SECRET_KINDS` and returns each finding's `kind`; `finalizeAndWritePrd` logs one summary warn per plan instead of one per field.

### Context Files

**US-001**
- `packages/nax/src/metrics/report.ts` — `CostRunSummary`, `buildLastRun`, `toCostReport`
- `packages/nax/src/cli/status-cost.ts` — `displayLastRunMetrics`
- `packages/nax/src/cli/runs.ts` — `runsShowCommand`
- `packages/nax/test/unit/cli/status-cost.test.ts` — existing `Last Run:` entry tests
- `packages/nax/test/unit/cli/runs.test.ts` — existing run-log fixtures

**US-002**
- `packages/nax/src/metrics/tracker.ts` — `collectStoryMetrics`
- `packages/nax/src/workflow/stage.ts` — sets `workflowEndState` and `agentResult.success: true`
- `packages/nax/src/metrics/aggregator.ts` — `firstPassRate` and `modelEfficiency` read `firstPassSuccess` and `success`
- `packages/nax/test/unit/metrics/tracker.test.ts` — existing `collectStoryMetrics` fixtures
- `packages/nax/test/unit/pipeline/stages/completion-skip-persistence.test.ts` — existing `completionStage` gate-open fixtures

**US-003**
- `packages/nax/src/prd/secret-shapes.ts` — `findPrdSecretShapes`
- `packages/nax/src/plan/strategies/persist-prd.ts` — `finalizeAndWritePrd` warning loop
- `packages/nax-agent/src/internal/redact.ts` — `SECRET_VALUE_PATTERNS` kinds and `acceptMatch`
- `packages/nax/test/unit/prd/secret-shapes.test.ts` — existing finder tests
- `packages/nax/test/unit/plan/strategies/persist-prd-profile-log.test.ts` — existing advisory tests

### Creates

None. Every story changes existing files only.

### Modifies

**US-001**
- `packages/nax/test/unit/cli/status-cost.test.ts` — the typed fixture `FIXED_REPORT: CostReportV1` builds a `lastRun` literal without `storiesGateOpen`, which no longer compiles under `bun run typecheck` once `CostRunSummary.storiesGateOpen` is required; the literal gains `storiesGateOpen: 0` and its other assertions stay unchanged.

**US-002**
None. Existing `tracker.test.ts` fixtures leave `workflowEndState` unset, so they keep the old `agentResult` rule.

**US-003**
- `packages/nax/test/unit/prd/secret-shapes.test.ts` — the `toEqual` expectations list findings as `{ storyId, field }`; each finding now also carries `kind` (`"github"` for the `ghp_` value, `"openai"` for the `sk-` value), so the expected objects gain that key.
- `packages/nax/test/unit/plan/strategies/persist-prd-profile-log.test.ts` — the tests expect one `PRD story text has a secret shape` warn per field; the new invariant is one `PRD story text has secret shapes` warn per plan with data `{ count, fields, kinds }`, and the test that makes `_secretShapesDeps.redactSecrets` throw is removed because `_secretShapesDeps` no longer exists (the `_persistPrdDeps.findPrdSecretShapes` throwing test still covers `PRD secret-shape scan could not run`).

### Seams

None. The three stories touch separate modules and add no symbol another story calls. `PROVIDER_SECRET_KINDS` is exported from `secret-shapes.ts` and is exercised by US-003's own tests.

## Acceptance Criteria

### US-001

1. [unit] `toCostReport(runs, deps)` over runs whose last `RunMetrics` has `storiesGateOpen: 1` returns `lastRun.storiesGateOpen === 1`.
2. [unit] `toCostReport(runs, deps)` over runs whose last `RunMetrics` has no `storiesGateOpen` field returns `lastRun.storiesGateOpen === 0`.
3. [unit] `displayLastRunMetrics(workdir)` over a last run with `storiesGateOpen: 1` logs the `Last Run: <feature>` info entry with `data.storiesGateOpen === 1`.
4. [unit] `displayLastRunMetrics(workdir)` over a last run with `storiesGateOpen: 0` logs the `Last Run: <feature>` entry with no `storiesGateOpen` key in its data.
5. [unit] `displayLastRunMetrics(workdir)` over a last run with no `storiesGateOpen` field logs the `Last Run: <feature>` entry with no `storiesGateOpen` key in its data.
6. [unit] `runsShowCommand` over a run log whose run-summary record carries `data.storiesGateOpen: 2` logs the `Run Summary` info entry with `data.storiesGateOpen === 2`.
7. [unit] `runsShowCommand` over a run log whose run-summary record carries `data.storiesGateOpen: 0` logs the `Run Summary` entry with no `storiesGateOpen` key in its data.
8. [unit] `runsShowCommand` over a run log whose run-summary record has no `storiesGateOpen` field logs the `Run Summary` entry with no `storiesGateOpen` key in its data.

### US-002

1. [unit] `collectStoryMetrics(ctx, start)` with `ctx.agentResult.success: true` and `ctx.workflowEndState: "complete-gate-open"` returns `success === false`.
2. [unit] `collectStoryMetrics(ctx, start)` with `ctx.agentResult.success: true`, `ctx.workflowEndState: "complete-gate-open"`, no escalations and no prior failures returns `firstPassSuccess === false`.
3. [unit] `collectStoryMetrics(ctx, start)` with `ctx.agentResult.success: true`, `ctx.workflowEndState: "complete"`, no escalations and no prior failures returns `success === true` and `firstPassSuccess === true`.
4. [unit] `collectStoryMetrics(ctx, start)` with `ctx.agentResult.success: true`, `ctx.workflowEndState: "complete-with-rulings"`, no escalations and no prior failures returns `success === true` and `firstPassSuccess === true`.
5. [unit] `collectStoryMetrics(ctx, start)` with `ctx.agentResult.success: true` and `ctx.workflowEndState` undefined returns `success === true`.
6. [unit] `calculateAggregateMetrics` over one run whose two stories were built by `collectStoryMetrics`, one with `workflowEndState: "complete"` and one with `"complete-gate-open"` (both `agentResult.success: true`, no escalations), returns `firstPassRate === 0.5`.
7. [unit] `completionStage.execute(ctx)` on a single-story context with `ctx.agentResult.success: true` and `ctx.workflowEndState: "complete-gate-open"` leaves `ctx.storyMetrics[0].success === false`.

### US-003

1. [unit] `findPrdSecretShapes` over a story whose description holds `api_key: abcdefghijklmnop` returns no finding.
2. [unit] `findPrdSecretShapes` over a story whose description holds `TOKEN=abcdefghijklmnop` returns no finding.
3. [unit] `findPrdSecretShapes` over a story whose description holds `Authorization: Bearer abc123def456ghi789` returns no finding.
4. [unit] `findPrdSecretShapes` over a story whose title holds `ghp_aaaaaaaaaaaaaaaaaaaa` returns `[{ storyId, field: "title", kind: "github" }]`.
5. [unit] `findPrdSecretShapes` over a story whose fourth acceptance criterion holds `sk-aaaaaaaaaaaaaaaaaaaa` returns `[{ storyId, field: "acceptanceCriteria[3]", kind: "openai" }]`.
6. [unit] `findPrdSecretShapes` over a story whose description holds `AKIAABCDEFGHIJKLMNOP` returns one finding with `kind: "aws"`.
7. [unit] `findPrdSecretShapes` over a story whose description holds a PEM block from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` returns one finding with `kind: "pem"`.
8. [unit] `findPrdSecretShapes` over a story whose description holds both `ghp_aaaaaaaaaaaaaaaaaaaa` and `sk-aaaaaaaaaaaaaaaaaaaa` returns exactly one finding for that field, with `kind: "openai"` (the first matching pattern in `SECRET_VALUE_PATTERNS` order).
9. [unit] `findPrdSecretShapes(prd, new Set(["US-002"]))` over a PRD where US-001 and US-002 both hold `ghp_aaaaaaaaaaaaaaaaaaaa` returns only the US-002 finding.
10. [unit] `findPrdSecretShapes` called twice in a row on the same PRD holding one `ghp_` value returns one finding both times (the global-flag `lastIndex` is reset).
11. [unit] The sorted members of `PROVIDER_SECRET_KINDS` imported from `@/prd/secret-shapes` equal `["aws", "github", "github-pat", "gitlab", "google", "jwt", "npm", "openai", "pem", "slack", "stripe", "telegram"]`.
12. [unit] `finalizeAndWritePrd` over a PRD whose US-002 description holds `sk-aaaaaaaaaaaaaaaaaaaa`, whose US-004 title holds `ghp_aaaaaaaaaaaaaaaaaaaa` and whose US-004 fourth acceptance criterion holds `sk-bbbbbbbbbbbbbbbbbbbb` logs exactly one warn `PRD story text has secret shapes` at stage `plan` with data `{ count: 3, fields: ["US-002 description", "US-004 title", "US-004 acceptanceCriteria[3]"], kinds: ["github", "openai"] }`.
13. [unit] `finalizeAndWritePrd` over a PRD whose only secret-like text is `TOKEN=abcdefghijklmnop` logs no warn whose message starts with `PRD story text has secret shape`.
14. [unit] `finalizeAndWritePrd` over a PRD holding `sk-aaaaaaaaaaaaaaaaaaaa` logs a warn whose data has no value containing `sk-aaaaaaaaaaaaaaaaaaaa`.
15. [unit] `finalizeAndWritePrd` with `_persistPrdDeps.findPrdSecretShapes` throwing logs one warn `PRD secret-shape scan could not run` and still writes the PRD to `outputPath`.
