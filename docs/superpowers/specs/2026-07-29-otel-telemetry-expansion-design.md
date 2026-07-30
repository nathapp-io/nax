# OTel Telemetry Expansion — Phase Events + Fleet Monitoring

**Date:** 2026-07-29
**Status:** Design approved, pending nax spec
**Branch:** `feat/otel-telemetry-expansion`
**Supersedes parts of:** `2026-07-18-builtin-reporter-design.md` (see §2a)
**Scope:** `src/plugins/builtin/otel-reporter/`, `src/pipeline/event-bus.ts`, `src/pipeline/subscribers/reporters.ts`, `src/plugins/extensions.ts`, `src/config/schemas-reporters.ts`, `src/execution/story-orchestrator/run-phase.ts`, post-run lifecycle emitters

---

## 1. Problem

Two gaps, one shared root.

**Observability gap.** `IReporter` exposes exactly three hooks — `onRunStart`, `onStoryComplete`, `onRunEnd`. Everything that happens *inside* a story is invisible to reporters: the test-writer, implementer, verifier, semantic review, adversarial review, lint/typecheck checks, the gates, and every fix-cycle rectification. Initial acceptance (the pre-run `acceptance-setup` stage) emits no bus event at all; final acceptance and deferred regression emit `postrun:phase:*` carrying only a boolean `passed`.

**Fleet gap.** The existing `otel-reporter` buffers all state in memory and flushes one `/v1/traces` POST plus one `/v1/metrics` POST at `onRunEnd`. Nothing is visible while a run is in flight, so several concurrent `nax run` processes cannot be monitored — you learn what happened only after it has already happened.

The shared root: there is no per-phase event on the pipeline bus, and no incremental export path.

## 2. Goals

1. Emit a uniform, typed completion event for every orchestrator phase, covering current and future ops without further API churn.
2. Enrich the pre-run and post-run phase events (initial acceptance, final acceptance, deferred regression, deferred review) with duration, cost, and phase-specific outcome detail.
3. Grow `IReporter` by exactly two hooks, without breaking existing reporters.
4. Export traces and metrics **incrementally** so a live fleet view across concurrent runs is possible.
5. Keep the exporter Bun-native and dependency-free, consistent with the repo's `_deps` injection conventions.

## 2a. Relationship to the 2026-07-18 built-in reporter design

This design **supersedes three declared non-goals** of `2026-07-18-builtin-reporter-design.md`:

| Prior non-goal | Now in scope | Why the constraint lifted |
|:---|:---|:---|
| Batching or queuing telemetry | §5.4 batch queue | Incremental export is the whole point of a live fleet view; a single end-of-run POST cannot provide it |
| Retry / backoff on delivery failure | §5.4 single retry | With a long-lived queue, one transient collector blip would otherwise drop a whole run's spans |
| Synthetic per-story child spans with reconstructed timing | §5.1 real story and phase spans | The prior doc's blocker was explicit: "there is no `onStoryStart` and no per-story duration — only `runElapsedMs`". That is no longer true. `story:started` exists on the bus, and §4.1 adds real per-phase `durationMs` measured at the source. The spans are **measured, not reconstructed** — the objection does not carry over |

Two prior non-goals still stand and are restated in §3: OTel Logs, and histogram **bucket configuration** (see §5.2).

## 3. Non-Goals

- OTLP **logs** export (`/v1/logs`). The structured JSONL logger stays as it is.
- A nax-side aggregator daemon. Each run exports directly to the collector.
- Sampling, gRPC OTLP, or alerting rules. These belong to the collector/backend.
- **Configurable histogram buckets.** §5.2 uses fixed boundaries (see §5.2).
- Any change to cost accounting. Costs are read from the existing `CostAggregator` scopes.

---

## 4. Event Model

### 4.1 New bus event: `story:phase:completed`

Added to `src/pipeline/event-bus.ts` and to the `PipelineEvent` union.

```ts
export interface StoryPhaseCompletedEvent {
  type: "story:phase:completed";
  storyId: string;
  phase: string;                 // op name — same vocabulary as story:step
  outcome: "passed" | "failed" | "skipped" | "error";
  durationMs: number;
  costUsd: number;               // from the phase's own CostAggregator scope
  tier?: string;
  testStrategy: TestStrategy;
  sessionModel: "single-session" | "three-session";
  details?: PhaseDetails;
}
```

**No `attempt` field.** The fix-cycle iteration counter lives on `cycle.iterations` inside `runFixCycle` and is not reachable at the emission point. It is also unnecessary: the *N*th `story:phase:completed` for a given `(storyId, phase)` pair **is** attempt *N*. Consumers count; nothing is plumbed.

#### Reachability — why these fields need a context slice

Three of the fields above are **not reachable** from `runPhase` as it stands, and the naive fixes are wrong:

| field | where it actually lives | why the naive read fails |
|:---|:---|:---|
| `sessionModel` | `isThreeSession`, already a `runPhase` **positional parameter** | **Two of the four call sites omit it.** `rectification.ts:240` and `:297` call `runPhase` without the argument, so it defaults to `false`. Reading the parameter would label **every fix-cycle phase in a three-session run as `single-session`** — the exact discriminator this design exists to provide, silently inverted on the rectification path |
| `testStrategy` | `ctx.routing.testStrategy` on the **`PipelineContext`** (`execution.ts:113,127`) | `CallContext` has no `routing`. And it must be the **routing** value, not `story.testStrategy`: `buildPlanForStrategy` is called with `ctx.routing.testStrategy`, so routing is what determined the op set. Reading the PRD field would mislabel precisely the runs where routing overrode it |
| `tier` | `ctx.routing.modelTier` (`execution.ts:67-70`, post-clamp) | Same — absent from `CallContext`. The clamped `effectiveTier` is the one actually used |

**Resolution — one input-side context slice, not four positional parameters.** `execution.ts` builds `callCtx` at `execution.ts:89-99` with `ctx.routing` and `ctx.story` both in scope. Add a readonly `phaseTelemetry` slice there:

```ts
readonly phaseTelemetry?: {
  readonly testStrategy: TestStrategy;
  readonly sessionModel: "single-session" | "three-session";
  readonly tier: string;
};
```

Every `runPhase` call site inherits it through `ctx` — including the two rectification sites and any future one — so correctness does not depend on remembering an argument. `sessionModel` is set from `isThreeSessionStrategy(ctx.routing.testStrategy)`, the existing SSOT.

This is compliant with `adapter-wiring.md` Rule 6 ("`CallContext` fields — input only, no result-side data"): strategy, tier, and session model are **input-side** metadata describing how the phase was dispatched, not result data flowing back to a caller.

**Implementation note.** `rectification.ts:236` dispatches through `wrappedCallOp(cycleCtx: FixCycleContext, ...)`. The slice reaches `runPhase` only if `cycleCtx` carries the field through — verify `FixCycleContext` construction preserves it, and cover it with the rectification test in §7.

`story:step` is left untouched and serves as the *start* half. This avoids a duplicate start event and keeps the TUI's existing subscription working unchanged.

**Emission point.** `runPhase()` in `src/execution/story-orchestrator/run-phase.ts`. Its existing `finally` block already computes the exact per-phase cost from `scope.snapshot().totalCostUsd`, and runs on both the success and the throw path. Emission must be synchronous and must never throw — a telemetry failure cannot fail a story.

Because every orchestrator op — including all fix-cycle rectification, which dispatches through the same `runPhase` — flows through this single point, one emission covers `test-writer`, `implementer`, `verifier`, `verify-scoped`, `semantic-review`, `adversarial-review`, `lint-check`, `typecheck-check`, `greenfield-gate`, `full-suite-gate`, `test-presence-gate`, and any op added later.

### 4.2 Strategy is a first-class field, not an inference

The orchestrator schedules different op sets per `testStrategy`:

| `testStrategy` | scheduled ops |
|:---|:---|
| `no-test`, `test-after`, `tdd-simple` | implementer -> test-presence-gate -> [full-suite-gate if `regressionGate.mode === "per-story"`] -> verify-scoped -> reviews |
| `three-session-tdd`, `three-session-tdd-lite` | test-writer -> greenfield-gate -> implementer -> full-suite-gate -> verifier -> reviews |

`implementer` is therefore the same phase *name* denoting different work. Under single-session it is one warm session that also authored the tests; under three-session it is source-only and carries isolation semantics. Aggregating "implementer duration" across both without a discriminator produces a meaningless number.

`sessionModel` is derived from `isThreeSessionStrategy(ctx.routing.testStrategy)` — the existing SSOT in `src/config` — never re-derived by string matching, and never read from the `isThreeSession` positional parameter (see the reachability table in §4.1).

### 4.2a Outcome derivation reuses the existing SSOT

`buildPhaseOutcomeLogData()` in `src/execution/story-orchestrator-logging.ts:18-42` already answers "did this phase pass?" for an arbitrary op output: `success = r.success === true || r.passed === true`, plus `findingsCount` (from `normalizedFindings` or `findings`), `status`, and `failureCategory`. `runPhase` already calls it via `logDeterministicPhaseOutcome` at line 203.

The phase event **reuses this function** rather than introducing a parallel derivation. Two independent answers to "did this phase pass" would eventually disagree, and a telemetry backend contradicting the run's own logs about the same phase is worse than having neither.

Consequences:

- `outcome` maps from its result: `success === true` -> `"passed"`; `status === "skipped"` -> `"skipped"` (a real value — `formatPhaseResultMessage` handles it at line 9); a throw -> `"error"`; otherwise `"failed"`.
- The function returns `null` when the output is not an object. That is not an error: emit `outcome: "passed"` with no `details`, since ops returning non-objects have no verdict to report.
- `logDeterministicPhaseOutcome` deliberately returns early for TDD phases and for `semantic-review` / `adversarial-review` (lines 53-54). That early return is about **log noise**, not verdict availability — the phase event must call `buildPhaseOutcomeLogData` directly so those phases still get an outcome.

### 4.3 `PhaseDetails`

A discriminated union whose arms describe **payload shape**, not strategy:

```ts
type PhaseDetails =
  | { kind: "authoring"; role: "test-writer" | "implementer"; filesChanged: number; isolationPassed?: boolean }
  | { kind: "verdict"; role: "verifier" | "verify-scoped"; passed: boolean; failureCount: number }
  | { kind: "gate"; gate: "greenfield" | "full-suite" | "test-presence" | "lint" | "typecheck"; failureCount: number }
  | { kind: "review"; reviewer: "semantic" | "adversarial"; iteration: number;
      blocking: { critical: number; high: number; medium: number; low: number }; advisory: number }
  | { kind: "fix"; strategy: string; findingsBefore: number; findingsAfter: number };
```

`isolationPassed` is populated **only** when `sessionModel === "three-session"`. Under single-session, `runPhase` does not capture `beforeRef` and no isolation boundary exists, so reporting one would be fabricated. This matches the advisory-isolation rule documented in `run-phase.ts`.

### 4.4 Run-level phases

`PostRunPhaseStartedEvent["phase"]` and `PostRunPhaseCompletedEvent["phase"]` widen from `"regression" | "acceptance" | "review"` to include `"acceptance-setup"`.

- **`acceptance-setup`** (initial acceptance) is newly emitted from `src/pipeline/stages/acceptance-setup.ts`, wrapping AC generation, refinement, and the RED gate.
- **`acceptance`** (final acceptance) is already emitted from `src/execution/runner-completion.ts`.
- **`regression`** (deferred regression) and **`review`** are already emitted from `src/execution/lifecycle/run-completion.ts` and `src/execution/unified-executor.ts`.

`PostRunPhaseCompletedEvent` gains `durationMs`, `costUsd?`, and `details`:

| phase | details |
|:---|:---|
| `acceptance-setup` | `totalCriteria`, `testableCount`, `redFailCount`, `regenerated` |
| `acceptance` | `retries`, `failedACCount`, `fixStoriesCreated` |
| `regression` | `mode: "deferred" \| "per-story"`, `failedTests`, `quarantined` |
| `review` | `findingCount`, `anyFailed` |

These four shapes form the `RunPhaseDetails` discriminated union (discriminated on `phase`), the run-scope counterpart to `PhaseDetails` in 4.3.

`src/tui/hooks/usePipelineBusEvents.ts` subscribes to `postrun:phase:*` and must tolerate the fourth phase value. This is a required change, not optional.

### 4.5 `IReporter` — two new hooks

Both story-scope and run-scope phases ride the same pair, discriminated by `scope`:

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
  testStrategy?: TestStrategy;                         // story scope only
  sessionModel?: "single-session" | "three-session";   // story scope only
  details?: PhaseDetails | RunPhaseDetails;
}

interface IReporter {
  // ... existing three hooks, unchanged
  onPhaseStart?(e: PhaseStartEvent): Promise<void>;
  onPhaseComplete?(e: PhaseCompleteEvent): Promise<void>;
}
```

Both hooks are optional. Every existing reporter keeps working with no change.

`wireReporters` in `src/pipeline/subscribers/reporters.ts` maps `story:step` -> `onPhaseStart(scope:"story")`, `story:phase:completed` -> `onPhaseComplete(scope:"story")`, `postrun:phase:started` -> `onPhaseStart(scope:"run")`, `postrun:phase:completed` -> `onPhaseComplete(scope:"run")`. The existing per-reporter try/catch isolation is preserved. The file's repeated fan-out block is extracted into a local helper as part of this change rather than copy-pasted four more times.

---

## 5. OTel Model

### 5.1 Span tree

```
nax.run                              root; parent = W3C TRACEPARENT from env when valid, else root
├── nax.story                        one per story (story:started -> story:completed | story:failed)
│   └── nax.phase                    one per story:phase:completed
├── nax.phase  acceptance-setup
├── nax.phase  acceptance
├── nax.phase  regression
└── nax.phase  review
```

Incremental export falls out of the tree shape: a phase span is already ended when its event fires, so it is enqueued and exported immediately. Story spans flush at story end; the run span flushes last. No partial-span or span-update mechanism is needed.

**Span attributes:** `nax.phase`, `nax.outcome`, `nax.cost_usd`, `nax.tier`, `nax.test_strategy`, `nax.session_model`, plus the scalar fields of `details`.

**Resource attributes:** `service.name`, `nax.version`, `nax.run_id`, `nax.feature`, `nax.project`, `host.name`, `nax.git.branch`, `nax.git.sha`, `process.pid`.

**Parent trace.** When the `TRACEPARENT` environment variable holds a valid W3C traceparent, the run span adopts it as parent, so a CI job or a batch launcher can present several runs as one trace. When unset or malformed, the run is its own root. Opt-in, zero cost when unused.

### 5.2 Metrics

| instrument | type | dimensions |
|:---|:---|:---|
| `nax.phase.duration` | histogram (ms) | phase, outcome, tier, test_strategy, session_model |
| `nax.phase.cost_usd` | histogram | phase, outcome, tier, test_strategy, session_model |
| `nax.review.findings` | counter | reviewer, severity |
| `nax.fix.iterations` | counter | strategy, phase |
| `nax.escalations` | counter | from_tier, to_tier |

The existing `otlp.ts` builds only Sum and Gauge points — the prior design listed histogram bucket configuration as a non-goal. Histograms are retained here because duration and cost distributions are the point of the exercise (a mean phase duration hides exactly the tail you are hunting), but the non-goal is honoured by making the boundaries **fixed and non-configurable**, so no new config surface appears:

- `nax.phase.duration` (ms): `[100, 500, 1000, 5000, 15000, 60000, 300000, 900000]`
- `nax.phase.cost_usd`: `[0.001, 0.01, 0.05, 0.1, 0.5, 1, 5]`

This requires a new `buildHistogramPoint` helper in `otlp.ts` emitting `explicitBounds` + `bucketCounts` + `count` + `sum` per OTLP JSON.

`run_id` and `story_id` are **deliberately excluded** from every metric dimension above — they are unbounded over time and would produce runaway series counts in any Prometheus-backed store. Per-run identity belongs on spans.

### 5.3 Heartbeat — the live fleet signal

A span reaches the backend only when it ends, so a run span open for an hour tells you nothing about the run's current state. Worse, a run *stuck* inside a phase — the case most worth catching — emits no span at all.

Every `heartbeatIntervalMs` (default `10000`; `0` disables), each run emits:

- `nax.run.active` — gauge, value `1`
- `nax.run.phase_elapsed_ms` — gauge
- `nax.run.cost_usd` — gauge

with attributes `{run_id, feature, project, story_id, phase, tier, test_strategy}`.

A table over the latest sample of `nax.run.active`, grouped by `run_id`, *is* the fleet view. An absent or stale series means the run died.

These gauges do carry `run_id` and `story_id`. That is accepted: the series are short-lived, and they are given distinct metric names precisely so a collector filter can drop them wholesale without touching the aggregate histograms in 5.2.

### 5.4 Exporter — `batch-queue.ts`

A bounded FIFO of ended spans and metric points:

- **Flush triggers:** `queue.length >= maxBatchSize` (default 64), `flushIntervalMs` elapsed (default 5000), or explicit `flushNow()` at run end.
- **Overflow:** at `maxQueueSize` (default 2048), drop oldest and increment a drop counter; warn once per threshold crossing rather than per drop.
- **Failure:** one retry at a fixed delay, then drop the batch. A slow or dead collector must never block, stall, or fail a run.
- **Timer:** re-armed `setTimeout` + `clearTimeout`, cancelled on teardown. `setInterval` is banned by `.claude/rules/forbidden-patterns.md`; the `setTimeout` exception for cancellable handles applies and is documented at the call site.
- **I/O:** through the existing `PostJsonDeps` injection in `reporter-shared`, so every path is unit-testable without network.

### 5.4a Flush lifecycle — the abnormal-exit path

`2026-07-18-builtin-reporter-design.md` §"Event delivery guarantees" documents two mutually exclusive `onRunEnd` delivery paths, verified again here against `src/execution/lifecycle/run-cleanup.ts:116-140`:

1. **Success** — `run:completed` on the bus -> the `reporters.ts` subscriber calls `onRunEnd`.
2. **Abnormal exit** (failure / abort / SIGTERM) — `run-cleanup.ts` calls `reporter.onRunEnd(...)` **directly**, guarded by `!options.runCompleted` so it fires exactly once.

A queue that flushes only on path 1 would **silently discard every buffered span on abort or SIGTERM** — precisely the runs a fleet view exists to catch. Three requirements follow:

- `flushNow()` must run on **both** paths. Since both terminate in `onRunEnd`, flushing from the reporter's own `onRunEnd` covers both — but the implementation must not move that flush into a bus-only subscriber.
- The heartbeat timer must be **stopped on both paths**, or an aborted run leaks a re-arming `setTimeout` past teardown.
- `NaxPlugin.teardown()` (`src/plugins/types.ts:95`) is the belt-and-braces stop: it must stop the heartbeat and attempt a final flush, and must be idempotent with `onRunEnd` so a normal exit does not double-POST.

The final flush is bounded by the existing `timeoutMs` so a dead collector cannot stall run teardown.

**Early abort with no preceding `onRunStart`.** The prior design already documents that `onRunEnd` can arrive with no buffered `RunState`, and the current `otel-reporter/index.ts:90-103` handles it by back-computing the start. The span tree inherits this requirement: a story span, phase span, or final flush arriving with no run span must synthesize a best-effort root rather than throw or drop.

### 5.5 Detail level and redaction

`reporters.otel.detail` controls what leaves the machine:

- **`"counts"` (default)** — non-sensitive scalars only: outcome, finding counts by severity, files-changed count, failure counts, attempt number, tier, cost, duration.
- **`"verbose"`** — additionally attaches finding titles and repo-relative file paths as span events.

Code excerpts, prompts, agent output, and diffs are **never** exported at any detail level.

### 5.6 Config

Added to `reporters.otel` in `src/config/schemas-reporters.ts`. Existing keys are unchanged.

| key | default | meaning |
|:---|:---|:---|
| `detail` | `"counts"` | `"counts"` \| `"verbose"` (see 5.5) |
| `heartbeatIntervalMs` | `10000` | `0` disables the heartbeat |
| `maxBatchSize` | `64` | spans/points per flush |
| `flushIntervalMs` | `5000` | time-based flush |
| `maxQueueSize` | `2048` | drop-oldest threshold |
| `phases` | unset | optional allow-list of phase names to export |

The `webhook-reporter` `ReporterEventSchema` enum widens to include `onPhaseStart` and `onPhaseComplete`.

---

## 6. Files

**New**

- `src/plugins/builtin/otel-reporter/batch-queue.ts`
- `src/plugins/builtin/otel-reporter/heartbeat.ts`
- `src/plugins/builtin/otel-reporter/span-tree.ts`
- `src/plugins/builtin/otel-reporter/traceparent.ts`

**Modified**

- `src/pipeline/event-bus.ts` — `StoryPhaseCompletedEvent`; widen and enrich the post-run phase events
- `src/execution/story-orchestrator/run-phase.ts` — emit from the existing `finally`; read telemetry from `ctx.phaseTelemetry`, reuse `buildPhaseOutcomeLogData`
- `src/operations/types.ts` — add the readonly `phaseTelemetry` slice to `CallContext`
- `src/pipeline/stages/execution.ts` — populate `phaseTelemetry` on `callCtx` from `ctx.routing` (line 89-99)
- `src/execution/story-orchestrator/rectification.ts` — ensure `FixCycleContext` preserves `phaseTelemetry` across the `wrappedCallOp` hop
- `src/pipeline/stages/acceptance-setup.ts` — emit `acceptance-setup` started/completed
- `src/execution/runner-completion.ts` — enrich the `acceptance` completed event
- `src/execution/lifecycle/run-completion.ts` — enrich the `regression` and `review` completed events
- `src/pipeline/subscribers/reporters.ts` — wire the two new hooks; extract the repeated fan-out helper
- `src/plugins/extensions.ts` — `IReporter` hooks and event types
- `src/config/schemas-reporters.ts` — new `otel` keys; widen the webhook event enum
- `src/plugins/builtin/otel-reporter/index.ts` — rebuild around the span tree and batch queue
- `src/tui/hooks/usePipelineBusEvents.ts` — tolerate the `acceptance-setup` phase value

All new and modified source files stay under the 600-line limit; `reporters.ts` is refactored rather than grown linearly.

## 7. Testing

Unit tests under `test/unit/` mirroring source layout, using `_deps` injection — no network, no `mock.module()`.

- **batch-queue** — size-triggered flush, interval-triggered flush, `flushNow`, drop-oldest at `maxQueueSize` with an accurate drop count, single retry then give up, teardown cancels the pending timer.
- **span-tree** — phase spans parent to their story span; story spans parent to the run span; run-level phases parent to the run span; a phase arriving for an unknown story does not throw.
- **traceparent** — valid header adopted as parent; malformed, empty, and all-zero values fall back to a root span.
- **heartbeat** — emits at the configured cadence, carries the current phase, stops on teardown, and is fully disabled at `0`.
- **detail redaction** — under `"counts"`, no finding title or file path appears anywhere in the serialized payload; under `"verbose"`, titles and relative paths appear and absolute paths do not.
- **reporters subscriber** — all four bus events fan out to the right hook with the right `scope`; one throwing reporter does not prevent the others from being called.
- **run-phase emission** — success path emits `outcome: "passed"` with the scope cost; throw path emits `outcome: "error"` and rethrows the original error; a throwing event bus does not fail the phase.
- **abnormal-exit flush** — `onRunEnd` reached via the `run-cleanup.ts` direct path (no `run:completed` on the bus) still flushes every queued span and stops the heartbeat; `teardown()` after a normal `onRunEnd` does not double-POST; `onRunEnd` with no preceding `onRunStart` synthesizes a root span instead of throwing.
- **histogram payload** — `buildHistogramPoint` emits `bucketCounts.length === explicitBounds.length + 1`, and `sum`/`count` agree with the recorded values.
- **strategy discrimination** — a `no-test` story's `implementer` event carries `sessionModel: "single-session"` and no `isolationPassed`; a `three-session-tdd` story's carries `"three-session"` and populates it.
- **rectification telemetry inheritance** — a phase dispatched through `runFixCycle` during a `three-session-tdd` story emits `sessionModel: "three-session"`, proving the context slice survives the `FixCycleContext` hop and that the value is not read from the defaulted `isThreeSession` parameter. This is the regression test for the §4.1 reachability defect.
- **outcome SSOT agreement** — for the same op output, the phase event's `outcome` agrees with `buildPhaseOutcomeLogData`'s `success`; a non-object output yields `"passed"` with no `details` rather than throwing; a `semantic-review` output still produces an outcome despite `logDeterministicPhaseOutcome`'s early return.

## 8. Risks

| risk | mitigation |
|:---|:---|
| `sessionModel` silently wrong on the rectification path | Carried on an input-side `ctx.phaseTelemetry` slice, never the defaulted `isThreeSession` parameter; regression test in §7 |
| Telemetry and logs disagree about a phase's verdict | Both derive from `buildPhaseOutcomeLogData`; agreement asserted in §7 |
| `runPhase` is the hot path | Emission is synchronous, allocation-light, and wrapped so it cannot throw |
| Slow or dead collector stalls runs | Bounded queue, fire-and-forget POST, single retry, drop-on-overflow |
| Metric cardinality explosion | `run_id`/`story_id` excluded from aggregate metrics; heartbeat isolated behind its own metric names |
| Leaking source content to a third-party backend | `"counts"` default; excerpts and prompts never exported at any level |
| Queued spans lost on abort/SIGTERM | Flush driven from `onRunEnd` (both delivery paths) plus an idempotent `teardown()`; see §5.4a |
| Heartbeat timer leaks past an aborted run | Stopped on both `onRunEnd` paths and in `teardown()` |
| Post-run phase union widening breaks the TUI | `usePipelineBusEvents.ts` updated in the same change; covered by a test |

## 9. Open Items

None. Alternatives considered and rejected during design: adopting `@opentelemetry/sdk-node` (rejected — transitive Node-API dependencies in a Bun-native CLI); a generic `onEvent(PipelineEvent)` reporter hook (rejected — couples third-party plugins to internal bus shapes); a `nax monitor` aggregator daemon (rejected — a long-lived component to build and supervise for no gain when runs can reach the collector directly); hanging reporters off `src/runtime/dispatch-events.ts` instead of the pipeline bus (rejected — that channel is middleware observation, while reporters are wired to the pipeline bus by existing convention).
