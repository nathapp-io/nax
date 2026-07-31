# OTLP Logs Exporter — Fleet Log Shipping

**Date:** 2026-07-31
**Status:** Design approved, pending nax spec
**Branch:** `feat/otlp-logs-exporter`
**Supersedes one non-goal of:** `2026-07-29-otel-telemetry-expansion-design.md` (see §2a)
**Scope:** `src/logger/`, `src/plugins/builtin/otel-reporter/`, `src/config/schemas-reporters.ts`

---

## 1. Problem

`otel-reporter` exports two of the three OTLP signals. It POSTs `/v1/traces` and
`/v1/metrics` (`index.ts:138,179,219-220`) and has no logs path at all — there is no
`resourceLogs` or `logRecords` construction anywhere in `src/`.

Run logs therefore live in exactly one place: a per-run JSONL file written by
`src/logger/logger.ts`, readable only via `nax logs` on the machine that produced it.
An operator running nax on other machines or in CI has to reach the box to read them.

The result is two monitoring paths for one system — an OTLP backend holding traces and
metrics, and a separate log-shipping arrangement (or an SSH session) for the logs that
explain them. Correlating a failed phase span with the log lines emitted during it means
switching tools and matching timestamps by hand.

A second, smaller gap compounds it. `buildResourceAttributes` (`otlp.ts:69-71`) emits
only `service.name` and `nax.run_id`, so telemetry from different projects and features
is indistinguishable at the resource level. See §2b.

## 2. Goals

1. Export nax's structured logs as OTLP logs (`/v1/logs`), so one backend holds all
   three signals.
2. Give the exporter a log stream to export, via a general sink seam on the logger that
   does not couple the logger to OTLP.
3. Inherit the existing secret redaction rather than reimplementing it.
4. Emit the full resource-attribute set the prior design specified, on all three
   signals, so runs are attributable by project and feature.
5. Stay Bun-native and dependency-free, consistent with the exporter's existing
   hand-rolled OTLP/JSON approach.

## 2a. Relationship to the 2026-07-29 telemetry expansion design

That design listed OTLP logs export as a **non-goal** (§3: "OTLP **logs** export
(`/v1/logs`). The structured JSONL logger stays as it is."). The corresponding nax spec
used softer wording — "OTLP logs export (`/v1/logs`) is **deferred**"
(`docs/specs/SPEC-otel-telemetry-expansion.md:243`).

| Prior non-goal | Now in scope | Why the constraint lifted |
|:---|:---|:---|
| OTLP logs export (`/v1/logs`) | §4, §5 | The constraint was scope control, not a design objection — the nax spec says "deferred". The pieces the prior design built make it cheap now: `batch-queue.ts` is already generic `<T>`, `otlp.ts` has the attribute and timestamp helpers, and `reporter-shared/post-json.ts` plus the `PostJsonDeps` seam make the transport testable without network. What remained was a log stream to export, which §4 supplies |

Every other non-goal of that design still stands and is restated in §3.

## 2b. The resource-attribute gap this design closes

`SPEC-otel-telemetry-expansion.md:190` and §5.1 of the 2026-07-29 design both specify
**nine** resource attributes:

```
service.name, nax.version, nax.run_id, nax.feature,
nax.project, host.name, nax.git.branch, nax.git.sha, process.pid
```

The shipped implementation emits **two** (`otlp.ts:69-71`):

```ts
export function buildResourceAttributes(serviceName: string, runId: string): KeyValue[] {
  return [attr("service.name", serviceName), attr("nax.run_id", runId)];
}
```

The cause is visible in the acceptance criteria. Lines 511-512 of that spec are the only
two ACs covering resource attributes, and they assert exactly `service.name` and
`nax.run_id`. The remaining seven had no AC, so the implementation went green while
dropping them. This is an AC-coverage gap, not a coding defect.

The consequence is user-visible today: `feature` and `project` are tracked in the
reporter's `RunState` (`index.ts:36-37`, populated at `:231-232`) but reach the wire only
as heartbeat **datapoint** attributes (`heartbeat.ts:85-86`). Metrics can be filtered by
feature; **traces cannot**.

§5 closes this as part of the same change, because the logs payload needs the same
resource block and building a third divergent one would entrench the inconsistency.

## 3. Non-Goals

- **Crash-path log delivery.** `src/execution/crash-writer.ts` writes fatal entries with
  `appendFileSync` directly from signal and exception handlers (`:34,:87,:152`),
  bypassing the `Logger` entirely, so a logger sink cannot observe them. Signal handlers
  are synchronous and OTLP export is an async fetch; there is no reliable delivery from a
  hard kill. Fatal entries stay JSONL-only. A run that dies is still inferable from the
  backend: the last shipped log plus an absent run-end span. See §8.
- **Trace correlation.** Stamping `traceId`/`spanId` onto log records so logs are
  clickable from a phase span. Deferred, not rejected — see §9.
- **OTLP/protobuf encoding.** The exporter stays OTLP/HTTP with JSON encoding. An OTel
  Collector accepts JSON and re-exports protobuf to any downstream backend, so protobuf
  buys the ability to skip a collector, not to reach a backend otherwise unreachable —
  at the cost of either a dependency tree in a 9-dependency project or hand-rolled
  varint encoding whose failure mode is silent field loss.
- **Changes to heartbeat *datapoint* attributes.** §5.3 of the prior design deliberately
  puts bare `run_id`/`feature`/`project` on the heartbeat gauges under distinct metric
  names so a collector can drop them wholesale. Resource attributes and datapoint labels
  are not interchangeable in Prometheus-backed stores, so removing the datapoint copies
  would change query semantics. They stay exactly as they are. The heartbeat's *resource*
  block is a separate matter and is corrected in §5.1.
- **A log-shipping agent or JSONL tailer.** Export is in-process and live.
- **Sampling, filtering rules, or retention.** These belong to the collector or backend.

---

## 4. The Sink Seam

### 4.1 Why the logger needs one

The logger is a global singleton (`initLogger`/`getLogger`/`getSafeLogger`) with two
hardcoded sinks — console and file. The exporter is a lifecycle-scoped plugin whose
`IReporter` hooks (`onRunStart`, `onStoryComplete`, `onRunEnd`, `onPhaseStart`,
`onPhaseComplete`) carry no log lines. There is no path from one to the other.

Two alternatives were considered and rejected:

| Alternative | Rejected because |
|:---|:---|
| Synthesize log records from `IReporter` events | These are traces re-encoded, not logs. Lines like `[verify] No test command configured` never reach a reporter hook, and those are the lines an operator is reading logs to find |
| Bulk-ship the run's JSONL from a post-run action | Nothing appears until the run ends, and a hard-killed run ships nothing — the worst case is exactly the case it exists for. Its one genuine advantage, capturing crash-writer entries, lies in territory §3 descopes anyway. nax runs can last hours; a live signal matters |

### 4.2 The tap point

`src/logger/logger.ts:126`, immediately after `redactEntry(rawEntry)` and before the
console and file sinks:

```ts
// Redact once, up front, so BOTH sinks see the sanitized entry.
const entry = redactEntry(rawEntry);
```

Tapping here rather than at the call sites means registered sinks inherit secret
redaction by construction. The existing comment states the invariant the seam depends
on: redaction happens once, up front, so every sink sees the sanitized entry. A sink
added below that line cannot observe unredacted data.

### 4.3 API

```ts
// src/logger/types.ts
export type LogSink = (entry: LogEntry) => void;

// src/logger/logger.ts — Logger method, exported through the barrel
addSink(sink: LogSink): () => void;   // returns unsubscribe
```

Sinks are synchronous and fire-and-forget. Each invocation is wrapped in try/catch inside
the logger, so a throwing sink cannot break logging or fail a run. A sink that needs to
do I/O queues internally and returns immediately — which is what the exporter does.

Registration is scoped to a run: `onRunStart` registers, `onRunEnd` and `teardown()`
unsubscribe.

### 4.4 Assumption: one run per process

`LogEntry` carries `timestamp`, `level`, `stage`, `storyId`, `sessionRole`, `message`,
and `data` — it has **no `runId`**. The exporter keys state by run (`states.set(runId, …)`),
which structurally permits concurrent runs in one process; with two, a sink could not
attribute a line to a run.

In the CLI one process is one run (`runner.ts:156` mints a `runId` per `Runner.run()`).
This design assumes that and does not plumb `runId` through `LogEntry`. The sink
attributes entries to the single active run, and **warns rather than silently
mis-attributing** if a second run registers while one is active.

---

## 5. OTel Model

### 5.1 Resource attributes

`buildResourceAttributes` widens to an options object and is used by every payload
builder — traces, aggregate metrics, heartbeat metrics, and logs:

```ts
buildResourceAttributes({
  serviceName, runId, feature, project, gitBranch, gitSha,
}): KeyValue[]
```

| attribute | source | notes |
|:---|:---|:---|
| `service.name` | `cfg.serviceName` | existing |
| `nax.run_id` | `RunStartEvent.runId` | existing. Format `run-<flattened ISO>` (`runner.ts:156`) — sortable, start time embedded |
| `nax.version` | `NAX_VERSION` (`src/version.ts`) | nax's own version |
| `nax.feature` | `RunState.feature` | already in memory (`index.ts:36`) |
| `nax.project` | `RunState.project` | basename of workdir |
| `host.name` | `os.hostname()` | process constant |
| `process.pid` | `process.pid` | process constant |
| `nax.git.branch` | target repo | see below |
| `nax.git.sha` | target repo | see below |

**`nax.git.*` means the target repository**, not nax's own build commit — the branch and
sha the run is working on. `nax.version` already covers which nax produced the telemetry.
The prior spec did not disambiguate this; for fleet use the target repo is the useful one.

Resolved **once at `onRunStart`** from the run's workdir via `src/utils/git.ts`, and
**best-effort**: on failure (detached HEAD, non-git directory, timeout) the attribute is
**omitted rather than emitted empty**, and resolution never fails a run. Process
constants are computed once at module init.

`nax.project` + `nax.feature` + `nax.run_id` form the composite identity. Collision
requires the same project, the same feature, and the same millisecond, so the composite
is safe to group on across a fleet.

**`heartbeat.ts` builds its own resource block** containing only `service.name`
(`heartbeat.ts:110`), so heartbeat ticks currently lack even `nax.run_id` at resource
level. It adopts `buildResourceAttributes` too. This is additive — its **datapoint**
attributes (`:84-90`) are untouched per §3, so existing heartbeat queries keep matching.

### 5.2 `LogEntry` to OTLP `LogRecord`

| `LogEntry` field | OTLP `LogRecord` |
|:---|:---|
| `timestamp` (ISO) | `timeUnixNano` via the existing `msToUnixNano` |
| `level` | `severityNumber` + `severityText` |
| `message` | `body.stringValue` |
| `stage` | attribute `nax.stage` |
| `storyId` | attribute `nax.story_id`, when present |
| `sessionRole` | attribute `nax.session_role`, when present |
| `data` | see below |

Severity mapping follows the OTLP severity number ranges:

| `LogLevel` | `severityNumber` | `severityText` |
|:---|:---|:---|
| `error` | 17 | `ERROR` |
| `warn` | 13 | `WARN` |
| `info` | 9 | `INFO` |
| `debug` | 5 | `DEBUG` |

`silent` is a threshold, never an emitted entry level, so it has no mapping.

**`data` handling.** `LogEntry.data` is `Record<string, unknown>` — arbitrary and
nestable — while `otlp.ts`'s `KeyValue` is deliberately a `string | double` subset.
Top-level scalar values (string, number, boolean) become attributes directly, prefixed
`nax.data.`; booleans stringify. Everything remaining is JSON-serialized into a single
`nax.data_json` attribute **capped at 2048 characters**, truncated with a trailing
marker. The cap bounds payload size against an unbounded field; without it one large
`data` object could dominate a batch.

The leftover key is `nax.data_json`, not `nax.data`, so it cannot collide with a
flattened `nax.data.<key>` attribute — OTLP attribute keys are a flat namespace, and a
payload carrying both `nax.data` and `nax.data.stage` reads as a malformed nesting.

### 5.3 Payload

`buildLogsPayload` mirrors the existing traces and metrics builders:

```
resourceLogs[0].resource.attributes  = buildResourceAttributes(...)
resourceLogs[0].scopeLogs[0].scope   = { name: "nax" }
resourceLogs[0].scopeLogs[0].logRecords = LogRecord[]
```

POSTed to `${endpoint}/v1/logs` through the existing `postJson` with
`Content-Type: application/json`, reusing `PostJsonDeps` so every path is unit-testable
without network.

### 5.4 Queue

Logs get their **own** `createBatchQueue` instance, reusing the existing
`maxBatchSize` / `flushIntervalMs` / `maxQueueSize` config values rather than adding new
keys. A separate instance matters: logs are higher-volume than spans, and a shared queue
would let a log burst evict queued spans through the drop-oldest overflow path.

Flush joins the existing lifecycle — `onRunEnd` (which covers both the bus and the
`run-cleanup.ts` direct delivery paths documented in §5.4a of the prior design) plus the
idempotent `teardown()` backstop, which must not double-POST after a normal `onRunEnd`.

### 5.5 Config

```jsonc
"reporters": {
  "otel": {
    "enabled": true,
    "endpoint": "http://localhost:5080/api/default",
    "headers": { "Authorization": "Basic ${OO_TOKEN}" },
    "logs": {
      "enabled": false,
      "level": "info"
    }
  }
}
```

| key | default | meaning |
|:---|:---|:---|
| `logs.enabled` | `false` | opt-in, independent of traces and metrics |
| `logs.level` | `"info"` | floor: `error` \| `warn` \| `info` \| `debug` |

**`logs.level` is deliberately separate from `detail`.** `detail` controls *what content
leaves the machine* (§5.5 of the prior design: `counts` emits non-sensitive scalars,
`verbose` adds finding titles and repo-relative paths), under an absolute rule that "code
excerpts, prompts, agent output, and diffs are never exported at any detail level".
Overloading it as a verbosity floor would couple two unrelated knobs and, more seriously,
make `detail: "verbose"` silently widen what leaves the machine into a channel that is
not audited against that invariant — `redactSecrets` strips credential-shaped values and
has no notion of prompt or agent output. `detail` keeps its existing meaning untouched.

**Header interpolation is unchanged and already correct.** `interpolateHeaders`
(`reporter-shared/interpolate.ts`) resolves `${VAR}` from `process.env`, matching
`[A-Z0-9_]+` only, and returns the referenced-but-unset names. The exporter warns and
skips the export rather than sending a broken header, and deliberately does not burn a
batch-queue retry (`index.ts:125-129,169-173`). The logs path reuses this verbatim.
`endpoint` is not interpolated.

---

## 6. Files

**New**

- `src/plugins/builtin/otel-reporter/logs.ts` — `LogEntry` to `LogRecord` mapping,
  severity table, `data` flattening and cap, `buildLogsPayload`

**Modified**

- `src/logger/types.ts` — `LogSink` type
- `src/logger/logger.ts` — sink registry, `addSink`, dispatch at line 126 wrapped in
  try/catch
- `src/logger/index.ts` — export `LogSink`
- `src/plugins/builtin/otel-reporter/otlp.ts` — widen `buildResourceAttributes` to the
  options object and the full nine attributes
- `src/plugins/builtin/otel-reporter/heartbeat.ts` — resource block adopts
  `buildResourceAttributes` (§5.1); datapoint attributes untouched
- `src/plugins/builtin/otel-reporter/index.ts` — register and unsubscribe the sink,
  resolve git attributes at `onRunStart`, own logs queue, flush on both paths
- `src/config/schemas-reporters.ts` — `logs` block on `OtelReporterConfigSchema`

**Unchanged**

- `batch-queue.ts` — already generic `<T>`
- `reporter-shared/` — `postJson` and `interpolateHeaders` reused verbatim
- `heartbeat.ts` datapoint attributes and cadence logic — per §3

`index.ts` is 352 lines against the 600-line limit; the mapping lives in `logs.ts`
specifically to keep it clear of that ceiling. No file approaches the limit.

## 7. Testing

Unit tests under `test/unit/` mirroring source layout, `_deps` injection, no
`mock.module()`, per `.claude/rules/forbidden-patterns.md`.

- **sink seam** — `addSink` receives entries; the returned unsubscribe stops delivery; a
  sink that throws does not break console output, file output, or other sinks; sinks
  receive the **redacted** entry.
- **redaction end-to-end** — a secret-shaped value in `data` and a token interpolated
  into `message` both reach the sink already `[REDACTED]`, and never appear anywhere in
  the serialized logs payload. This is the assumption §4.2 rests on and is asserted
  directly rather than inferred.
- **re-entrancy guard** — entries from stages `otel-reporter`, `otel-batch-queue`, and
  `otel-logs` are dropped; an export failure that logs a warning does not enqueue a
  record and does not amplify.
- **level floor** — at each `logs.level` setting, entries below the floor are dropped and
  entries at or above pass; `logs.enabled: false` registers no sink at all.
- **mapping** — each `LogLevel` produces the right `severityNumber`/`severityText`;
  `storyId` and `sessionRole` attributes appear only when present; top-level scalars in
  `data` become `nax.data.*` attributes; non-scalars serialize into `nax.data_json`; a
  `data` object exceeding 2048 characters is truncated with a marker and the payload
  stays bounded.
- **resource attributes** — all nine appear on the traces, aggregate-metrics,
  heartbeat-metrics **and** logs payloads; `nax.git.branch`/`nax.git.sha` are **omitted,
  not empty**, when git resolution fails; a git resolution failure at `onRunStart` does
  not fail the run; heartbeat **datapoint** attributes are unchanged.
- **queue isolation** — a log burst that overflows `maxQueueSize` drops log records only
  and does not evict queued spans.
- **flush lifecycle** — logs flush on `onRunEnd` via the bus path and via the
  `run-cleanup.ts` direct path; `teardown()` after a normal `onRunEnd` does not
  double-POST; unresolved header env vars skip the export with a warning without
  consuming a retry.
- **one-run assumption** — a second concurrent run registering a sink emits a warning
  rather than silently attributing its logs to the first run.

## 8. Risks

| risk | mitigation |
|:---|:---|
| Exporter's own logs feed back into the exporter | Stage-based re-entrancy guard; asserted in §7 |
| A throwing or slow sink breaks logging or stalls a run | Sinks are sync, fire-and-forget, individually try/caught; the exporter's sink only enqueues |
| Log volume evicts queued spans | Separate queue instance; asserted in §7 |
| Unbounded `data` field dominates a batch | 2048-character cap with truncation marker |
| Secrets or prompts leaving the machine | Tap sits after `redactEntry`; `detail` semantics left untouched so §5.5's invariant stays enforced; `logs.level` defaults to `info`, not `debug` |
| Fatal crash entries never shipped | Accepted and documented (§3). Death remains inferable from last-log plus absent run-end span |
| Resource-attribute widening breaks existing queries | Additive only — `service.name` and `nax.run_id` keep their names and values; `heartbeat.ts` datapoint attributes untouched |
| Git resolution slow or hanging at run start | Resolved once, best-effort, through the existing `gitWithTimeout` helper; omitted on failure |
| Logs arriving with no preceding `onRunStart` | Same best-effort root handling the prior design established for spans (`index.ts:149-156`) |

## 9. Open Items

None.

**Deferred — trace correlation.** Stamping `traceId`/`spanId` onto log records would make
logs clickable from a phase span in the trace view. It is cheap to add later: `SpanTree`
already tracks the active story and phase spans, and `.claude/rules/project-conventions.md`
mandates `storyId` on every pipeline log entry, so the join key is present. It is out of
v1 because the driving use case is fleet debugging — searching logs across hosts by
`nax.project`/`nax.feature`/`level` — and shipping a half-built correlation is worse than
shipping none. The sink seam makes it additive.

**Alternatives considered and rejected:** synthesizing log records from `IReporter`
events (§4.1); bulk-shipping the JSONL from a post-run action (§4.1); adopting
`@opentelemetry/*` for logs (rejected for the same reason the prior design rejected
`@opentelemetry/sdk-node` — transitive Node-API dependencies in a Bun-native CLI with 9
runtime dependencies); adding OTLP/protobuf encoding (§3); threading `runId` through
`LogEntry` to support concurrent runs (§4.4 — not a real CLI shape, and it would touch
every log call site).
