# SPEC: OTel Telemetry Expansion — Phase Events + Fleet Monitoring

<!-- spec-writing: completed-through-phase-5 -->

## Summary

Expand nax run telemetry from three run-level reporter hooks to per-phase visibility, and turn the built-in `otel-reporter` from a single end-of-run flush into an incremental exporter that supports monitoring several concurrent `nax run` processes from one collector. Every orchestrator phase — test-writer, implementer, verifier, verify-scoped, semantic review, adversarial review, the gates, and every fix-cycle rectification — emits a typed completion event carrying duration, cost, outcome, and phase-specific detail. The pre-run acceptance setup, final acceptance, deferred regression, and deferred review phases are enriched the same way. `IReporter` grows by exactly two optional hooks. The OTel reporter exports real span trees plus aggregate metrics as work completes, and emits a periodic heartbeat gauge so a stalled run is visible before it ends.

## Motivation

**Observability gap.** `IReporter` exposes exactly three hooks — `onRunStart`, `onStoryComplete`, `onRunEnd`. Everything inside a story is invisible to reporters. The pre-run `acceptance-setup` stage emits no bus event at all; final acceptance, deferred regression, and deferred review emit `postrun:phase:*` carrying only a boolean `passed`. There is no way to answer "which phase consumed the time and money", "how often does adversarial review reject", or "how many rectification iterations did this story need".

**Fleet gap.** The existing `otel-reporter` buffers all state in memory and flushes one `/v1/traces` POST plus one `/v1/metrics` POST at `onRunEnd`. Nothing is visible while a run is in flight, so several concurrent runs cannot be monitored — the data arrives only after the fact, and a run that hangs mid-phase emits nothing at all.

Both gaps share one root: there is no per-phase event on the pipeline bus, and no incremental export path.

Full design rationale, alternatives considered, and the corrections applied during review: `docs/superpowers/specs/2026-07-29-otel-telemetry-expansion-design.md`.

## Design

### Approach

Telemetry is emitted from the **pipeline event bus**, not from the runtime dispatch-event channel (`src/runtime/dispatch-events.ts`), because reporters are wired to the pipeline bus by existing convention (`wireReporters`). The OTLP payloads stay **hand-built** — no `@opentelemetry/*` dependency — matching the existing `otlp.ts` and keeping the CLI Bun-native and dependency-free. Export is **incremental**: spans are enqueued the moment they end and flushed on a size or time trigger, rather than accumulated until run end.

### Integration

Existing types and symbols this feature extends — all verified present:

- `PipelineEvent` union in `src/pipeline/event-bus.ts:171-187` — add `StoryPhaseCompletedEvent`; widen `PostRunPhaseStartedEvent["phase"]` and `PostRunPhaseCompletedEvent["phase"]` (currently `"regression" | "acceptance" | "review"`, lines 159-168) to include `"acceptance-setup"`, and add `durationMs` / `costUsd` / `details` to the completed event.
- `CallContext` in `src/operations/types.ts:15-62` — add a readonly `phaseTelemetry` slice (see below).
- `IReporter` in `src/plugins/extensions.ts` — add optional `onPhaseStart` / `onPhaseComplete`; the existing three hooks are unchanged.
- `wireReporters` in `src/pipeline/subscribers/reporters.ts:28-176` — add fan-out for four bus events. The file's repeated per-reporter fan-out block is extracted into a local helper as part of this wiring rather than copy-pasted four more times; this is an implementation detail of the same change, not separate refactoring.
- `OtelReporterConfigSchema` in `src/config/schemas-reporters.ts:22-35` — add `detail`, `heartbeatIntervalMs`, `maxBatchSize`, `flushIntervalMs`, `maxQueueSize`, `phases`. `ReporterEventSchema` (line 6) widens to include `onPhaseStart` / `onPhaseComplete`.
- `buildPhaseOutcomeLogData` in `src/execution/story-orchestrator-logging.ts:18-42` — reused as the outcome SSOT (see below).
- `runPhase` in `src/execution/story-orchestrator/run-phase.ts:142` — emission point; its existing `finally` block (lines 255-258) already computes the phase's exact cost via `scope.snapshot().totalCostUsd`.
- Pattern to follow: `createOtelReporterPlugin` / `createWebhookReporterPlugin` factory shape in `src/plugins/builtin/otel-reporter/index.ts:26` and the `PostJsonDeps` injection in `src/plugins/builtin/reporter-shared/post-json.ts`.

#### `story:phase:completed`

```ts
export interface StoryPhaseCompletedEvent {
  type: "story:phase:completed";
  storyId: string;
  phase: string;                 // op name — same vocabulary as story:step
  outcome: "passed" | "failed" | "skipped" | "error";
  durationMs: number;
  costUsd: number;
  tier?: string;
  testStrategy?: TestStrategy;
  sessionModel?: "single-session" | "three-session";
  details?: PhaseDetails;
}
```

`story:step` (line 151) is unchanged and serves as the start half. There is no `attempt` field: the *N*th `story:phase:completed` for a given `(storyId, phase)` pair is attempt *N*.

```ts
/** Per-finding summary carried only when `detail` is "verbose". */
interface ReviewFindingSummary {
  message: string;             // Finding.message — there is no `title` field
  rule?: string;               // Finding.rule
  file?: string;               // Finding.file — already workdir-relative by contract
  severity: FindingSeverity;
}

type PhaseDetails =
  | { kind: "authoring"; role: "test-writer" | "implementer"; filesChanged: number; isolationPassed?: boolean }
  | { kind: "verdict"; role: "verifier" | "verify-scoped"; passed: boolean; failureCount: number }
  | { kind: "gate"; gate: "greenfield" | "full-suite" | "test-presence" | "lint" | "typecheck"; failureCount: number }
  | { kind: "review"; reviewer: "semantic" | "adversarial"; iteration: number;
      bySeverity: Record<FindingSeverity, number>;
      blockingCount: number; advisoryCount: number;
      items?: ReviewFindingSummary[] }
  | { kind: "fix"; strategy: string; findingsBefore: number; findingsAfter: number };
```

`isolationPassed` is set only when `sessionModel === "three-session"` — under single-session, `runPhase` captures no `beforeRef` and no isolation boundary exists.

**Severity keys come from the real enum.** `FindingSeverity` (`src/findings/types.ts:50`) is `"critical" | "error" | "warning" | "info" | "low" | "unverifiable"` — there is no `high` and no `medium`. `bySeverity` is keyed by those six members. `blockingCount` counts findings for which `isBlockingSeverity(finding.severity, threshold)` (`src/review/severity.ts:15`) is true, and `advisoryCount` counts the rest; both use that predicate rather than re-ranking severities, since `SEVERITY_RANK` (`severity.ts:6-13`) is the SSOT.

**`items` is the only per-finding payload and is gated.** It is populated exclusively when `detail` is `"verbose"`, and carries `Finding.message` — `Finding` has no `title` field. Under the default `"counts"` it is absent entirely.

**Per-phase cost is the invocation's own scope total.** `runPhase`'s `finally` writes `phaseCosts[opName] = (phaseCosts[opName] ?? 0) + scope.snapshot().totalCostUsd` — that map **accumulates** across repeat invocations of the same op (every fix-cycle re-run). The emitted `costUsd` is `scope.snapshot().totalCostUsd` for that single invocation, never the accumulated `phaseCosts` entry.

#### `phaseTelemetry` — why a context slice, not a parameter

`sessionModel`, `testStrategy`, and `tier` are **not reachable** from `runPhase` as it stands:

| field | actual source | why the naive read is wrong |
|:---|:---|:---|
| `sessionModel` | `isThreeSession`, a `runPhase` positional parameter | `rectification.ts:240` and `:297` call `runPhase` **without** it, so it defaults to `false` — every fix-cycle phase in a three-session run would be labelled `single-session` |
| `testStrategy` | `ctx.routing.testStrategy` on `PipelineContext` (`execution.ts:113,127`) | `CallContext` has no `routing`. It must be the **routing** value, not `story.testStrategy` — `buildPlanForStrategy` is called with `ctx.routing.testStrategy`, so routing determined the op set |
| `tier` | `ctx.routing.modelTier`, post-clamp (`execution.ts:67-70`) | absent from `CallContext` |

Resolution — one readonly input-side slice on `CallContext`, populated where `ctx.routing` is in scope (`execution.ts:89-99`):

```ts
readonly phaseTelemetry?: {
  readonly testStrategy: TestStrategy;
  readonly sessionModel: "single-session" | "three-session";
  readonly tier: string;
};
```

Every `runPhase` call site inherits it through `ctx`, so correctness does not depend on remembering an argument. `sessionModel` comes from `isThreeSessionStrategy(ctx.routing.testStrategy)` — the existing SSOT. This complies with `adapter-wiring.md` Rule 6: these are input-side dispatch metadata, not result-side data.

`rectification.ts:236` dispatches via `wrappedCallOp(cycleCtx: FixCycleContext, …)`; the slice must survive that hop.

#### Outcome derivation

`buildPhaseOutcomeLogData` already answers "did this phase pass?" for arbitrary op output (`success = r.success === true || r.passed === true`, plus `findingsCount`, `status`, `failureCategory`). The phase event **reuses it** rather than introducing a second derivation — two independent verdicts for the same phase would eventually disagree, and telemetry contradicting the run's own logs is worse than neither.

- `success === true` -> `"passed"`; `status === "skipped"` -> `"skipped"`; a thrown error -> `"error"`; otherwise `"failed"`.
- The function returns `null` for non-object output — emit `"passed"` with no `details`.
- `logDeterministicPhaseOutcome` returns early for TDD and review phases (lines 53-54) for **log-noise** reasons only; the phase event calls `buildPhaseOutcomeLogData` directly so those phases still get an outcome.

#### Run-level phases

`acceptance-setup` (initial acceptance) is newly emitted from `src/pipeline/stages/acceptance-setup.ts`. `acceptance`, `regression`, and `review` already emit and are enriched.

| phase | `details` |
|:---|:---|
| `acceptance-setup` | `totalCriteria`, `testableCount`, `redFailCount`, `regenerated` |
| `acceptance` | `retries`, `failedACCount`, `fixStoriesCreated` |
| `regression` | `mode: "deferred" \| "per-story"`, `failedTests`, `quarantined` |
| `review` | `findingCount`, `anyFailed` |

#### `IReporter`

```ts
interface PhaseEventBase {
  runId: string;
  scope: "story" | "run";
  phase: string;
  storyId?: string;   // present iff scope === "story"
}
interface PhaseStartEvent extends PhaseEventBase { startTime: string }
interface PhaseCompleteEvent extends PhaseEventBase {
  outcome: "passed" | "failed" | "skipped" | "error";
  durationMs: number;
  costUsd: number;
  tier?: string;
  testStrategy?: TestStrategy;
  sessionModel?: "single-session" | "three-session";
  details?: PhaseDetails | RunPhaseDetails;
}
```

Both hooks optional; existing reporters are unaffected.

#### Span tree and metrics

```
nax.run                      root; parent = W3C TRACEPARENT env when valid, else root
├── nax.story                one per story
│   └── nax.phase            one per story:phase:completed
├── nax.phase acceptance-setup / acceptance / regression / review
```

Span attributes: `nax.phase`, `nax.outcome`, `nax.cost_usd`, `nax.tier`, `nax.test_strategy`, `nax.session_model`, plus scalar `details` fields. Resource attributes: `service.name`, `nax.version`, `nax.run_id`, `nax.feature`, `nax.project`, `host.name`, `nax.git.branch`, `nax.git.sha`, `process.pid`.

| instrument | type | dimensions |
|:---|:---|:---|
| `nax.phase.duration` | histogram (ms) | phase, outcome, tier, test_strategy, session_model |
| `nax.phase.cost_usd` | histogram | phase, outcome, tier, test_strategy, session_model |
| `nax.review.findings` | counter | reviewer, severity |
| `nax.fix.iterations` | counter | strategy, phase |
| `nax.escalations` | counter | from_tier, to_tier |

`run_id` and `story_id` are excluded from every dimension above — unbounded cardinality. Fixed histogram boundaries: duration `[100, 500, 1000, 5000, 15000, 60000, 300000, 900000]` ms; cost `[0.001, 0.01, 0.05, 0.1, 0.5, 1, 5]` USD. `buildHistogramPoint` in `otlp.ts` emits `explicitBounds` + `bucketCounts` + `count` + `sum`.

**Heartbeat.** Every `heartbeatIntervalMs` (default 10000; `0` disables) the run emits gauges `nax.run.active` (=1), `nax.run.phase_elapsed_ms`, and `nax.run.cost_usd`, with attributes `{run_id, feature, project, story_id, phase, tier, test_strategy}`. These carry high-cardinality ids deliberately and sit behind distinct metric names so a collector filter can drop them without touching the aggregates above.

#### Exporter

Bounded FIFO queue. Flush on `maxBatchSize` (64), on `flushIntervalMs` (5000) via a re-armed `setTimeout` + `clearTimeout` (`setInterval` is banned by `forbidden-patterns.md`; the cancellable-handle exception applies and is documented at the call site), or on `flushNow()`. Overflow at `maxQueueSize` (2048) drops oldest and counts drops. One retry per failed batch, then drop. All I/O through the existing `PostJsonDeps` injection.

**Flush lifecycle.** `onRunEnd` has two mutually exclusive delivery paths (`run-cleanup.ts:116-140`): the bus path via `run:completed`, and a **direct call** from `run-cleanup.ts` on failure / abort / SIGTERM, guarded by `!runCompleted`. Flushing only from the bus subscriber would discard every queued span on abort — precisely the runs a fleet view exists to catch. The flush and the heartbeat stop are therefore driven from the reporter's own `onRunEnd`, with `NaxPlugin.teardown()` as an idempotent backstop.

**Seam altitude note for the flush.** The flush ACs trigger at `onRunEnd`, which sits below the `!options.runCompleted` guard in `run-cleanup.ts:120`. This is deliberate and is **not** a seam-altitude violation: `onRunEnd` is the reporter plugin's own public entry point, and both endpoints already exist — `run-cleanup.ts:122-127` calls `reporter.onRunEnd` directly on the abnormal path, verified against current code. The guard selects *which* path delivers the call; it does not sit between the entry point and the flush.

#### Detail level

`reporters.otel.detail`: `"counts"` (default) exports non-sensitive scalars only; `"verbose"` additionally attaches finding titles and repo-relative paths as span events. Agent prompts, agent output, diffs, and source excerpts are never exported at any level, and resolved header values are never logged.

### Configuration

| key | default |
|:---|:---|
| `reporters.otel.detail` | `"counts"` |
| `reporters.otel.heartbeatIntervalMs` | `10000` |
| `reporters.otel.maxBatchSize` | `64` |
| `reporters.otel.flushIntervalMs` | `5000` |
| `reporters.otel.maxQueueSize` | `2048` |
| `reporters.otel.phases` | unset (export all) |

### Failure Handling

| condition | behaviour |
|:---|:---|
| Event-bus subscriber throws during phase emission | Fail-open — `runPhase` returns the op output normally; telemetry never fails a phase |
| Op output is not an object | Emit `outcome: "passed"` with no `details`; do not throw |
| OTLP POST returns non-2xx or throws | Retry once; then drop the batch and log a warning. Never block the run |
| Queue exceeds `maxQueueSize` | Drop oldest entries, report an accurate drop count, and log a warning once per threshold crossing |
| `onRunEnd` arrives with no preceding `onRunStart` | Export a best-effort root span; never throw |
| `TRACEPARENT` malformed or all-zero | Ignore it; the run span becomes its own root |
| Reporter hook throws | Caught per reporter; remaining reporters still receive the event |

Unresolved `${ENV}` header variables keep their existing behaviour — `interpolateHeaders` returns the missing names and the reporter warns once and skips the export. This spec does not change it.

## Out of Scope

- OTLP logs export (`/v1/logs`) is deferred; the existing structured JSONL logger is unchanged.
- A nax-side aggregator daemon (a `nax monitor` process) is not built; each run exports directly to its configured collector.
- Trace sampling, gRPC OTLP transport, and alerting rules are delegated to the OTel collector and backend, not implemented in nax.
- Histogram bucket boundaries are fixed constants and are deliberately not configurable.
- Adopting `@opentelemetry/*` SDK packages is rejected; OTLP payloads stay hand-built and dependency-free.
- Changes to cost accounting are excluded; costs are read from the existing `CostAggregator` scopes.
- Exporting agent prompts, agent output, diffs, or source-code excerpts is excluded at every detail level.
- US-006 only: de-duplicating spans when two processes export under the same run id is deferred.
- US-008 only: persisting heartbeat state across a process restart is deferred; a restarted run emits a new series.

## Stories

1. **US-001: Telemetry event types and reporter config schema** — no dependencies
2. **US-002: Story-phase event emission and outcome derivation** — depends on US-001
3. **US-003: Phase telemetry context and detail payloads** — depends on US-002
4. **US-004: Run-level phase events and enrichment** — depends on US-001
5. **US-005: Reporter fan-out for phase hooks** — depends on US-003, US-004
6. **US-006: Batch queue and traceparent** — depends on US-005
7. **US-007: Span tree and phase metrics** — depends on US-006
8. **US-008: Heartbeat, redaction, and flush lifecycle** — depends on US-007

Two pairs here are sizing splits, not separable capabilities. US-002/US-003 split one emission concern: US-002 lands the event and its outcome derivation, US-003 adds the `phaseTelemetry` context slice and the `PhaseDetails` payloads that ride on it. US-006/US-007/US-008 split the exporter the same way. Each pair exceeds the per-story AC cap when combined, and the cap is a must-split rule that takes precedence over the soft story-count ceiling.

### Seams

- **SEAM-1 (US-002 -> US-005):** `story:phase:completed` is emitted by `runPhase` and consumed by `wireReporters`. Declared as a seam AC in US-005: stub a reporter, emit the event on the bus, assert `onPhaseComplete` was invoked with the mapped payload.
- **SEAM-2 (US-004 -> US-005):** `postrun:phase:started` / `postrun:phase:completed`, including the new `acceptance-setup` value, are consumed by `wireReporters` and mapped to `scope: "run"`.
- **SEAM-3 (US-001 -> US-005):** the new `IReporter.onPhaseComplete` hook must actually be invoked by the subscriber, not merely declared.
- **SEAM-4 (US-006 -> US-008):** the batch queue's `flushNow` must be invoked by the reporter's `onRunEnd`, including on the abnormal-exit path where no `run:completed` event reaches the bus. Altitude is discussed in Design § Exporter.
- **SEAM-5 (US-002 -> US-007):** `buildHistogramPoint` must actually be reached by a completed phase. US-007 asserts that emitting `story:phase:completed` produces a `nax.phase.duration` data point whose recorded value equals the event's `durationMs` — without it the histogram builder can ship fully unit-tested and never be called.
- **SEAM-6 (US-003 -> US-008):** `PhaseDetails.review.items` is produced only under `detail: "verbose"` and consumed by the verbose span-event export. US-008 asserts the exported payload carries a finding's `message` from that array.

### US-001: Telemetry event types and reporter config schema

Extend the pipeline event union and the reporter config schema with the new phase-telemetry surface. No emitters and no consumers yet — this is the type and config foundation the other stories build on.

**Context Files**
- `src/pipeline/event-bus.ts` — event interfaces and the `PipelineEvent` union to extend
- `src/config/schemas-reporters.ts` — reporter config schemas to extend
- `src/plugins/extensions.ts` — `IReporter` interface and its event types
- `src/operations/types.ts` — `CallContext` to extend with `phaseTelemetry`
- `test/unit/config/reporters-schema.test.ts` — existing config-default test patterns

### US-002: Story-phase event emission and outcome derivation

Emit `story:phase:completed` from `runPhase`'s existing `finally` block, deriving the outcome from `buildPhaseOutcomeLogData` so telemetry and logs cannot disagree, and recording the phase's own cost scope total.

**Context Files**
- `src/execution/story-orchestrator/run-phase.ts` — emission point and its cost scope
- `src/execution/story-orchestrator-logging.ts` — `buildPhaseOutcomeLogData`, the outcome SSOT
- `src/pipeline/event-bus.ts` — event type created by US-001
- `test/unit/execution/story-orchestrator-logs.test.ts` — existing `runPhase` test patterns

### US-003: Phase telemetry context and detail payloads

Add the `phaseTelemetry` slice to `CallContext`, populate it in the execution stage from `ctx.routing`, ensure it survives the `FixCycleContext` hop, and attach the `PhaseDetails` payload arms to emitted events.

**Context Files**
- `src/pipeline/stages/execution.ts` — where `callCtx` is built and `ctx.routing` is in scope
- `src/execution/story-orchestrator/rectification.ts` — the `FixCycleContext` hop the slice must survive
- `src/execution/story-orchestrator/run-phase.ts` — reads the slice; extended by US-002
- `src/operations/types.ts` — `CallContext`, extended by US-001
- `src/config/schema-types.ts` — `TestStrategy` union and `isThreeSessionStrategy`

### US-004: Run-level phase events and enrichment

Emit the new `acceptance-setup` phase from the pre-run stage, and enrich the three existing post-run phase completions with duration and phase-specific detail. Update the TUI subscriber to tolerate the fourth phase value.

**Context Files**
- `src/pipeline/stages/acceptance-setup.ts` — pre-run stage that gains the new emission
- `src/execution/runner-completion.ts` — final-acceptance emission to enrich
- `src/execution/lifecycle/run-completion.ts` — regression and review emissions to enrich
- `src/tui/hooks/usePipelineBusEvents.ts` — post-run phase subscriber to widen
- `src/pipeline/event-bus.ts` — created by US-001, consumed here

### US-005: Reporter fan-out for phase hooks

Map the four phase bus events onto the two new `IReporter` hooks with correct `scope` discrimination, preserving per-reporter error isolation. Extend the webhook reporter's event filter to cover them.

**Context Files**
- `src/pipeline/subscribers/reporters.ts` — the fan-out to extend
- `src/plugins/builtin/webhook-reporter/index.ts` — event-filter behaviour to extend
- `src/plugins/extensions.ts` — hooks declared by US-001, invoked here
- `test/unit/pipeline/subscribers/reporters.test.ts` — existing fan-out test patterns

### US-006: Batch queue and traceparent

Replace the end-of-run flush with a bounded batch queue that exports as work completes, and add W3C traceparent adoption so a CI job can parent several runs into one trace.

**Context Files**
- `src/plugins/builtin/otel-reporter/index.ts` — reporter to rebuild around the queue
- `src/plugins/builtin/reporter-shared/post-json.ts` — `PostJsonDeps` injection pattern
- `src/plugins/builtin/otel-reporter/ids.ts` — trace/span id generation
- `test/unit/plugins/builtin/otel-reporter.test.ts` — existing golden-payload patterns

**Creates**
- `src/plugins/builtin/otel-reporter/batch-queue.ts` — bounded FIFO with size/time/explicit flush
- `src/plugins/builtin/otel-reporter/traceparent.ts` — W3C traceparent parsing

**Verification note:** this story replaces the existing single end-of-run flush. Removal of the old flush path is verified by `bun run typecheck && bun run lint`; the capability it provided is preserved by the first AC below.

### US-007: Span tree and phase metrics

Build the run/story/phase span tree, and emit the aggregate phase metrics — including the histogram data points that prove `buildHistogramPoint` is actually reached by a completed phase.

**Context Files**
- `src/plugins/builtin/otel-reporter/otlp.ts` — existing OTLP payload builders to extend
- `src/plugins/builtin/otel-reporter/batch-queue.ts` — created by US-006, enqueued into here
- `src/plugins/builtin/otel-reporter/index.ts` — reporter wiring
- `src/pipeline/event-bus.ts` — the phase events consumed here
- `test/unit/plugins/builtin/otel-reporter.test.ts` — existing golden-payload patterns

**Creates**
- `src/plugins/builtin/otel-reporter/span-tree.ts` — run/story/phase span parenting

### US-008: Heartbeat, redaction, and flush lifecycle

Add the periodic heartbeat that makes in-flight runs visible, the detail-level redaction boundary, and the flush lifecycle that survives abnormal exit.

**Context Files**
- `src/plugins/builtin/otel-reporter/index.ts` — reporter lifecycle hooks and teardown
- `src/plugins/builtin/otel-reporter/batch-queue.ts` — created by US-006, flushed here
- `src/execution/lifecycle/run-cleanup.ts` — the abnormal-exit `onRunEnd` path
- `src/plugins/types.ts` — `NaxPlugin.teardown` contract
- `src/findings/types.ts` — `Finding` shape backing `ReviewFindingSummary`

**Creates**
- `src/plugins/builtin/otel-reporter/heartbeat.ts` — cadence timer emitting the run gauges

## Acceptance Criteria

### US-001: Telemetry event types and reporter config schema

- [unit] A subscriber registered via `bus.on("story:phase:completed", fn)` receives an event whose `phase` equals the value passed to `bus.emit`.
- [unit] A subscriber registered for `story:phase:completed` receives an event whose `costUsd` equals the emitted value.
- [unit] A `postrun:phase:started` event whose `phase` is `"acceptance-setup"` delivers that phase value unchanged to its subscriber.
- [unit] A `postrun:phase:completed` event carrying a `details` payload delivers it unmodified to its subscriber.
- [unit] `bus.onAll` receives an emitted `story:phase:completed` event, confirming it is a member of the `PipelineEvent` union.
- [unit] Parsing an empty configuration object yields `reporters.otel.detail` equal to `"counts"`.
- [unit] Parsing an empty configuration object yields `reporters.otel.heartbeatIntervalMs` equal to `10000`.
- [unit] Parsing an empty configuration object yields `reporters.otel.maxBatchSize` equal to `64`.
- [unit] Parsing an empty configuration object yields `reporters.otel.flushIntervalMs` equal to `5000`.
- [unit] Parsing an empty configuration object yields `reporters.otel.maxQueueSize` equal to `2048`.
- [unit] Parsing an empty configuration object yields a `reporters.otel.phases` value that is absent, denoting that all phases export.
- [unit] Parsing a configuration whose `reporters.otel.detail` is `"trace"` is rejected by configuration validation.
- [unit] Parsing a configuration whose `reporters.webhook.events` contains `"onPhaseComplete"` retains that entry in the parsed value.

### US-002: Story-phase event emission and outcome derivation

- [unit] `runPhase` with an operation returning `{ passed: true }` emits exactly one `story:phase:completed` event.
- [unit] The emitted event's `phase` equals the dispatched operation's `name`.
- [unit] `runPhase` with an operation returning `{ passed: true }` emits `outcome` equal to `"passed"`.
- [unit] `runPhase` with an operation returning `{ passed: false }` emits `outcome` equal to `"failed"`.
- [unit] `runPhase` with an operation returning `{ status: "skipped" }` emits `outcome` equal to `"skipped"`.
- [unit] When the dispatched operation throws, the emitted `outcome` is `"error"`.
- [unit] When the dispatched operation throws, `runPhase` rethrows the original error unchanged.
- [unit] When the operation returns a non-object value, the emitted `outcome` is `"passed"`.
- [unit] When the operation returns a non-object value, the emitted event has no `details` field.
- [unit] The emitted `outcome` is `"passed"` exactly when `buildPhaseOutcomeLogData` reports `success` true for the same operation output.
- [unit] A `semantic-review` operation produces an emitted `outcome`, despite `logDeterministicPhaseOutcome` returning early for that operation name.
- [unit] The emitted `costUsd` equals the total cost recorded in that phase's own cost scope snapshot.
- [unit] The emitted `durationMs` equals the elapsed time measured across the operation dispatch.
- [unit] When a subscriber registered for `story:phase:completed` throws, `runPhase` still returns the operation's output to its caller.

### US-003: Phase telemetry context and detail payloads

- [integration] Running the execution stage for a story routed with `testStrategy` `"three-session-tdd"` emits phase events whose `sessionModel` is `"three-session"`.
- [integration] Running the execution stage for a story routed with `testStrategy` `"three-session-tdd"` emits phase events whose `testStrategy` is `"three-session-tdd"`.
- [integration] Running the execution stage for a story routed with `testStrategy` `"no-test"` emits phase events whose `sessionModel` is `"single-session"`.
- [integration] Emitted phase events carry a `tier` equal to the model tier the execution stage resolved after its supported-tier clamp.
- [integration] A phase dispatched through `runFixCycle` during a story routed as `"three-session-tdd"` emits `sessionModel` equal to `"three-session"`.
- [unit] An `adversarial-review` operation emits `details` whose `kind` is `"review"`.
- [unit] An `adversarial-review` operation emits `details.bySeverity` counts keyed by the members of `FindingSeverity`, matching its normalized findings.
- [unit] An `adversarial-review` operation emits a `details.blockingCount` equal to the number of its findings for which `isBlockingSeverity` returns true at the configured threshold.
- [unit] An `implementer` operation in a three-session context emits `details.isolationPassed` equal to the operation's isolation result.
- [unit] An `implementer` operation in a single-session context emits `details` with no `isolationPassed` field.
- [unit] A `full-suite-gate` operation emits `details` whose `kind` is `"gate"`.

### US-004: Run-level phase events and enrichment

- [integration] Running the acceptance-setup stage emits a `postrun:phase:started` event whose `phase` is `"acceptance-setup"` before any acceptance test file is generated.
- [integration] Running the acceptance-setup stage with a RED gate that fails emits `postrun:phase:completed` for `"acceptance-setup"` with `passed` true.
- [integration] The `"acceptance-setup"` completion event's `details` carries `totalCriteria`, `testableCount`, and `redFailCount` equal to the values the stage records.
- [integration] When every acceptance test already passes and the stage returns a skip result, the `"acceptance-setup"` completion event is still emitted.
- [integration] The `"acceptance"` completion event's `details.retries` equals the retry count returned by the acceptance loop.
- [integration] The `"acceptance"` completion event's `details.failedACCount` equals the number of failed acceptance criteria returned by the acceptance loop.
- [integration] The `"regression"` completion event's `details.mode` equals the configured regression gate mode.
- [integration] The `"review"` completion event's `details.findingCount` equals the number of findings the deferred review produced.
- [unit] Every `postrun:phase:completed` event carries a `durationMs` measured from its matching `postrun:phase:started` event.
- [unit] The TUI pipeline-bus subscriber handles a `postrun:phase:started` event with `phase` `"acceptance-setup"` without throwing and records it as a running phase.

### US-005: Reporter fan-out for phase hooks

- [unit] After `wireReporters`, emitting `story:step` invokes the registered reporter's `onPhaseStart` with `scope` `"story"`.
- [unit] The `onPhaseStart` invocation triggered by `story:step` carries a `phase` equal to the event's `step`.
- [unit] After `wireReporters`, emitting `story:phase:completed` invokes `onPhaseComplete` with `scope` `"story"`.
- [unit] The `onPhaseComplete` invocation triggered by `story:phase:completed` carries an `outcome` equal to the event's `outcome`.
- [unit] The `onPhaseComplete` invocation triggered by `story:phase:completed` carries a `costUsd` equal to the event's `costUsd`.
- [unit] After `wireReporters`, emitting `postrun:phase:started` invokes `onPhaseStart` with `scope` equal to `"run"`.
- [unit] The `onPhaseStart` invocation triggered by `postrun:phase:started` has no `storyId` field.
- [unit] After `wireReporters`, emitting `postrun:phase:completed` invokes `onPhaseComplete` with `scope` `"run"`.
- [unit] Every phase event delivered to a reporter hook carries the `runId` that `wireReporters` was constructed with.
- [unit] A registered reporter that does not implement `onPhaseComplete` is skipped when `story:phase:completed` is emitted.
- [unit] When the first of two registered reporters throws from `onPhaseComplete`, the second reporter's `onPhaseComplete` is still invoked.
- [unit] Emitting `run:started` after the new wiring still invokes the reporter's `onRunStart`.
- [unit] Invoking the unsubscribe function returned by `wireReporters` stops further `onPhaseComplete` invocations for subsequently emitted events.
- [unit] A webhook reporter configured with `events` containing only `"onPhaseComplete"` posts an envelope whose `type` is `"onPhaseComplete"` when that hook fires.
- [unit] A webhook reporter configured with `events` containing only `"onPhaseComplete"` performs no request when `onPhaseStart` fires.

### US-006: Batch queue and traceparent

**Out of scope:** de-duplicating spans when two processes export under the same run id — deferred because run identity is process-scoped and collisions require an operator to reuse a run id deliberately.

- [unit] A run whose stories all complete still exports a run span carrying the run's total cost, preserving the end-of-run export behaviour this story replaces.
- [unit] Enqueuing `maxBatchSize` spans issues exactly one export request carrying every enqueued span.
- [unit] Enqueuing fewer than `maxBatchSize` spans issues an export request once `flushIntervalMs` has elapsed.
- [unit] Calling `flushNow` exports pending spans before `flushIntervalMs` has elapsed.
- [unit] Enqueuing beyond `maxQueueSize` discards the oldest entries.
- [unit] After an overflow, the queue reports a drop count equal to the number of entries discarded.
- [unit] An overflow logs one warning per threshold crossing rather than one per discarded entry.
- [unit] A failed export request is retried exactly once.
- [unit] `flushNow` completes without throwing once the retry budget for a failing export is exhausted.
- [unit] A span enqueued while an export request is in flight is included in a subsequent export.
- [unit] After the queue is torn down, no export request is issued even once `flushIntervalMs` has elapsed.
- [unit] A valid W3C traceparent value produces a run span whose parent span id equals that value's span id.
- [unit] A malformed traceparent value produces a run span with no parent span id.
- [unit] A traceparent whose trace id is all zeros produces a run span with no parent span id.

### US-007: Span tree and phase metrics

- [integration] A `story:phase:completed` event produces a span whose parent span id equals its story span's id.
- [integration] A story's span carries a parent span id equal to the run span's id.
- [integration] A run-scope phase completion produces a span whose parent span id equals the run span's id.
- [integration] Emitting a `story:phase:completed` event produces an exported `nax.phase.duration` data point whose recorded value equals the event's `durationMs`.
- [integration] Emitting a `story:phase:completed` event produces an exported `nax.phase.cost_usd` data point whose recorded value equals the event's `costUsd`.
- [unit] A histogram data point's bucket-count list has exactly one more entry than its explicit-bounds list.
- [unit] A histogram data point's `sum` equals the total of the values recorded into it.
- [unit] A phase-duration metric data point carries no attribute named `run_id`.
- [unit] A phase-duration metric data point carries no attribute named `story_id`.
- [unit] A phase span carries a `nax.test_strategy` attribute equal to the event's `testStrategy`.
- [integration] An `adversarial-review` phase event produces an exported `nax.review.findings` counter data point carrying a `severity` attribute.
- [integration] A rectification phase event produces an exported `nax.fix.iterations` counter data point carrying a `strategy` attribute.
- [integration] A `story:escalated` event produces an exported `nax.escalations` counter data point carrying a `to_tier` attribute.
- [unit] Every exported payload carries a `service.name` resource attribute equal to the configured service name.
- [unit] Every exported payload carries a `nax.run_id` resource attribute equal to the current run's id.

### US-008: Heartbeat, redaction, and flush lifecycle

**Out of scope:** persisting heartbeat state across a process restart — a restarted run emits a fresh series, deferred because run identity is process-scoped.

- [unit] With `heartbeatIntervalMs` set to a positive value, an export request containing a `nax.run.active` gauge of value 1 is issued once that interval has elapsed.
- [unit] A heartbeat export request contains a `nax.run.phase_elapsed_ms` gauge whose value is the elapsed time since the most recent phase event.
- [unit] A heartbeat export request contains a `nax.run.cost_usd` gauge whose value equals the run's accumulated cost.
- [unit] A heartbeat gauge carries a `phase` attribute equal to the most recently completed phase's name.
- [unit] With `heartbeatIntervalMs` set to 0, no heartbeat export request is issued regardless of elapsed time.
- [unit] After `onRunEnd`, no further heartbeat export request is issued.
- [unit] With `detail` set to `"counts"`, an emitted review phase's `details` carries no `items` array.
- [unit] With `detail` set to `"counts"`, no exported payload contains any review finding's `message` text.
- [unit] With `detail` set to `"verbose"`, an exported payload contains a span event carrying a review finding's `message`.
- [unit] With `detail` set to `"verbose"`, every exported file path is relative to the repository root.
- [unit] No log record produced during export contains a resolved header value.
- [unit] Invoking `onRunEnd` without any preceding `run:completed` bus event exports every queued span.
- [unit] Invoking `onRunEnd` without any preceding `run:completed` bus event stops the heartbeat.
- [unit] Invoking the plugin's `teardown` after `onRunEnd` has already completed issues no additional export request.
- [unit] Invoking `onRunEnd` with no preceding `onRunStart` exports a run span whose start time is back-computed from the reported run duration.
