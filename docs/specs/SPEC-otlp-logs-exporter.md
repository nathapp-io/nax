# SPEC: OTLP Logs Exporter

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Add OTLP logs (`/v1/logs`) as a third exported signal to the built-in `otel-reporter`
plugin, so nax's structured run logs reach the same backend that already receives its
traces and metrics. Delivery works through a new general-purpose sink seam on the
logger, tapped after secret redaction. The same change completes the resource-attribute
set that the telemetry-expansion spec specified but never shipped, so every signal
becomes attributable by project and feature.

## Motivation

`otel-reporter` exports two of the three OTLP signals. It POSTs to `/v1/traces` and
`/v1/metrics` (`src/plugins/builtin/otel-reporter/index.ts:138,179,219-220`) and has no
logs path at all — there is no `resourceLogs` or `logRecords` construction anywhere in
`src/`.

Run logs therefore live in exactly one place: a per-run JSONL file written by
`src/logger/logger.ts`, readable only via `nax logs` on the machine that produced it. An
operator running nax on other machines or in CI must reach the box to read them. That
leaves two monitoring paths for one system — an OTLP backend holding traces and metrics,
and a separate arrangement for the logs that explain them.

A second gap compounds it. `buildResourceAttributes`
(`src/plugins/builtin/otel-reporter/otlp.ts:69-71`) emits only `service.name` and
`nax.run_id`:

```ts
export function buildResourceAttributes(serviceName: string, runId: string): KeyValue[] {
  return [attr("service.name", serviceName), attr("nax.run_id", runId)];
}
```

`docs/specs/SPEC-otel-telemetry-expansion.md:190` specifies **nine** resource attributes
(`service.name`, `nax.version`, `nax.run_id`, `nax.feature`, `nax.project`, `host.name`,
`nax.git.branch`, `nax.git.sha`, `process.pid`). Lines 511-512 of that spec are the only
two acceptance criteria covering resource attributes, and they assert exactly the two
that shipped. The remaining seven had no covering AC, so the implementation went green
while dropping them — an AC-coverage gap rather than a coding defect.

The gap is wider than the builder itself. Five sites construct a resource block, and
`buildResourceAttributes` is called by exactly **one** of them:

| Site | Attributes emitted today |
|:---|:---|
| `span-tree.ts:205` | `buildResourceAttributes(serviceName, runId)` — `service.name`, `nax.run_id` |
| `otlp.ts:115` (`buildTracesPayload`) | `service.name` only |
| `otlp.ts:153` (`buildMetricsPayload`) | `service.name` only |
| `heartbeat.ts:110` | `service.name` only |
| `index.ts:133` (incremental span flush) | `service.name` only |

So four of the five paths omit even `nax.run_id`, which means that spec's own AC at line
512 — "every exported payload carries a `nax.run_id` resource attribute" — is unsatisfied
on four paths today. Adopting one shared builder across all five is therefore part of
this work, not an incidental cleanup.

The user-visible consequence: `feature` and `project` are held in the reporter's
`RunState` (`index.ts:36-37`, populated at `:231-232`) but reach the wire only as
heartbeat **datapoint** attributes (`heartbeat.ts:85-86`). Metrics can be filtered by
feature; **traces cannot**. The logs payload needs the same resource block, and building
a third divergent one would entrench the inconsistency.

## Design

Full design rationale, rejected alternatives, and risk table:
`docs/superpowers/specs/2026-07-31-otlp-logs-exporter-design.md`.

### Integration

**Tap point.** `src/logger/logger.ts:126`, immediately after `redactEntry(rawEntry)` and
before the existing console and file sinks:

```ts
// Redact once, up front, so BOTH sinks see the sanitized entry.
const entry = redactEntry(rawEntry);
```

Registered sinks therefore inherit secret redaction by construction. A sink added below
that line cannot observe unredacted data.

**Verified existing symbols:**

| Symbol | Location | Current signature / shape |
|:---|:---|:---|
| `LogEntry` | `src/logger/types.ts:11-28` | `{ timestamp: string; level: LogLevel; stage: string; storyId?: string; sessionRole?: string; message: string; data?: Record<string, unknown> }` |
| `LogLevel` | `src/logger/types.ts:4` | `"silent" \| "error" \| "warn" \| "info" \| "debug"` |
| `redactEntry` | `src/logger/redact.ts` | `<T extends { message: string; data?: Record<string, unknown> }>(entry: T) => T` |
| `initLogger` | `src/logger/logger.ts:295-301` | **Throws** when already initialized — the instance is never silently replaced |
| `buildResourceAttributes` | `src/plugins/builtin/otel-reporter/otlp.ts:69-71` | `(serviceName: string, runId: string) => KeyValue[]` — widened by this spec |
| `attr` | `otlp.ts:22-24` | `(key: string, value: string \| number) => KeyValue`; numbers become `doubleValue`, strings `stringValue` |
| `msToUnixNano` | `otlp.ts:27-29` | `(ms: number) => string` |
| `createBatchQueue` | `otel-reporter/batch-queue.ts:32` | Generic `<T>`; reused unchanged |
| `postJson` | `otel-reporter/../reporter-shared/post-json.ts:25-28` | Sends `Content-Type: application/json`; injectable via `PostJsonDeps` |
| `interpolateHeaders` | `reporter-shared/interpolate.ts:9-26` | Resolves `${VAR}` from `process.env`, matching `[A-Z0-9_]+`; returns `{ resolved, missing }` |
| `NAX_VERSION` | `src/version.ts:13` | `string`, from `package.json` |
| `gitWithTimeout` | `src/utils/git.ts:53` | Bounded git invocation used for best-effort branch/sha resolution |
| `RunStartEvent` | `src/plugins/extensions.ts:313-320` | Carries `runId`, `feature`, `totalStories`, `startTime`, `project?` |

**Patterns mirrored.** The logs path follows the existing traces path in `index.ts`
exactly: resolve headers via `interpolateHeaders`, skip-with-warning on unresolved env
vars without consuming a retry (`index.ts:125-129`), enqueue through a `createBatchQueue`
instance, POST via `postJson` with `PostJsonDeps` injection, flush from `onRunEnd` and
the idempotent `teardown()` backstop (`index.ts:309-341`).

**Ordering is safe.** `initLogger` throws on double-initialization, so exactly one
`Logger` exists per process and a sink registered at `onRunStart` cannot be orphaned by a
later re-init. (`resetLogger()` drops sinks but is test-only.)

### Approach

**Sink seam, not event synthesis and not JSONL bulk-shipping.** The logger is a global
singleton with two hardcoded sinks; the exporter is a lifecycle-scoped plugin whose
`IReporter` hooks carry no log lines. Two alternatives were rejected:

- *Synthesizing records from `IReporter` events* produces traces re-encoded, not logs.
  Lines such as `[verify] No test command configured` never reach a reporter hook, and
  those are what an operator reads logs to find.
- *Bulk-shipping the run's JSONL from a post-run action* surfaces nothing until the run
  ends, and a hard-killed run ships nothing — the worst case is the case it exists for.
  nax runs can last hours.

**Encoding stays OTLP/HTTP with JSON**, consistent with the existing hand-rolled
exporter and the 9-dependency, Bun-native constraint.

### Data Model

`LogEntry` maps to an OTLP `LogRecord`:

| `LogEntry` field | `LogRecord` |
|:---|:---|
| `timestamp` (ISO) | `timeUnixNano` via `msToUnixNano` |
| `level` | `severityNumber` + `severityText` |
| `message` | `body.stringValue` |
| `stage` | attribute `nax.stage` |
| `storyId` | attribute `nax.story_id`, omitted when absent |
| `sessionRole` | attribute `nax.session_role`, omitted when absent |
| `data` | flattened / serialized, see below |

Severity follows the OTLP severity-number ranges:

| `LogLevel` | `severityNumber` | `severityText` |
|:---|:---|:---|
| `error` | 17 | `ERROR` |
| `warn` | 13 | `WARN` |
| `info` | 9 | `INFO` |
| `debug` | 5 | `DEBUG` |

`silent` is a threshold, never an emitted entry level, so it has no mapping.

**`data` handling.** `LogEntry.data` is `Record<string, unknown>` — arbitrary and
nestable — while `KeyValue` is deliberately a `string | double` subset. Top-level scalar
values become attributes prefixed `nax.data.`; strings map to `stringValue`, numbers to
`doubleValue`, booleans stringify. Every remaining value is JSON-serialized into a single
`nax.data_json` attribute capped at **2048 characters**, truncated with a trailing
marker. The leftover key is `nax.data_json` rather than `nax.data` because OTLP attribute
keys are a flat namespace: a payload carrying both `nax.data` and `nax.data.stage` reads
as malformed nesting.

**Resource attributes.** `buildResourceAttributes` widens to an options object and is
used by every payload builder — traces, aggregate metrics, heartbeat metrics, and logs:

| attribute | source |
|:---|:---|
| `service.name` | `cfg.serviceName` |
| `nax.run_id` | `RunStartEvent.runId` — format `run-<flattened ISO>` (`src/execution/runner.ts:156`) |
| `nax.version` | `NAX_VERSION` |
| `nax.feature` | `RunState.feature` |
| `nax.project` | `RunState.project` |
| `host.name` | `os.hostname()` |
| `process.pid` | `process.pid` |
| `nax.git.branch` | target repository, resolved at `onRunStart` |
| `nax.git.sha` | target repository, resolved at `onRunStart` |

`nax.git.*` means the **target repository** the run is working on, not nax's own build
commit — `nax.version` already identifies the nax that produced the telemetry. Both are
best-effort: on failure the attribute is **omitted, never emitted empty**.

`nax.project` + `nax.feature` + `nax.run_id` form the composite identity. Collision
requires the same project, the same feature, and the same millisecond.

All five resource-block sites listed in Motivation adopt the shared builder:
`buildTracesPayload` (`otlp.ts:115`), `buildMetricsPayload` (`otlp.ts:153`),
`buildHeartbeatMetricsPayload` (`heartbeat.ts:110`), the incremental span flush
(`index.ts:133`), and `span-tree.ts:205` (already calling it, updated for the new
signature).

Heartbeat's **datapoint** attributes (`heartbeat.ts:84-90`) are untouched, so existing
heartbeat queries keep matching.

One caveat governs which payload is worth asserting on. At `index.ts:214` the
`PhaseMetricsAggregator.buildMetricsPayload` method produces a second metrics payload
whose `metrics` array is merged into the first at `:217`; **its resource block is
discarded**. Only the resource block from `buildMetricsPayload` (`otlp.ts:153`) reaches
the wire. Note the two same-named symbols — the free function in `otlp.ts` and the
aggregator method — are distinct.

### Config

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

`logs.level` is deliberately **separate from `detail`**. `detail` controls what content
leaves the machine (`counts` emits non-sensitive scalars; `verbose` adds finding titles
and repo-relative paths) under the rule that code excerpts, prompts, agent output, and
diffs are never exported at any detail level. Overloading it as a verbosity floor would
make `detail: "verbose"` silently widen what leaves the machine into a channel not
audited against that invariant — `redactSecrets` strips credential-shaped values and has
no notion of prompt or agent output.

The logs queue is a **separate** `createBatchQueue` instance reusing the existing
`maxBatchSize` / `flushIntervalMs` / `maxQueueSize` values. A shared queue would let a
log burst evict queued spans through drop-oldest overflow.

### Failure Handling

| condition | behaviour |
|:---|:---|
| A registered sink throws | Caught inside the logger; console output, file output, and other sinks are unaffected; the throw does not propagate to the caller |
| Header env var referenced but unset | Export skipped with a warning naming the missing variables; no POST; no batch-queue retry consumed |
| Git branch/sha resolution fails or times out | Attributes omitted from the resource block; `onRunStart` completes and the run continues |
| `data` serializes beyond 2048 characters | `nax.data_json` truncated with a trailing marker; the record is still exported |
| Exporter's own log entries | Dropped by stage before enqueue, so an export failure that logs a warning cannot amplify |

## Out of Scope

- Crash-path log delivery is deferred. `src/execution/crash-writer.ts` writes fatal
  entries with `appendFileSync` directly from signal and exception handlers, bypassing
  the `Logger`, so a logger sink cannot observe them; signal handlers are synchronous and
  OTLP export is an async fetch. Fatal entries remain JSONL-only, and an abnormally
  terminated run stays inferable from the last shipped log plus an absent run-end span.
- Trace correlation is deferred: log records will not carry `traceId` or `spanId`, so
  logs are not clickable from a phase span in the trace view.
- OTLP/protobuf encoding is deferred. The exporter stays OTLP/HTTP with JSON encoding; an
  OTel Collector accepts JSON and re-exports protobuf to any downstream backend.
- Heartbeat **datapoint** attributes are not changed. The bare `run_id`, `feature`, and
  `project` labels on the heartbeat gauges keep their current names and values so
  existing dashboard queries continue to match.
- No log-shipping agent, JSONL tailer, or aggregator daemon is added. Export is
  in-process and live.
- Sampling, filtering rules, and retention policy are not implemented; they belong to the
  collector or backend.
- Content filtering beyond credential redaction is deferred. `redactSecrets` strips
  credential-shaped keys and values only; it does not strip prompts, agent output, or
  diffs that a caller places in `LogEntry.data`, and `logs.level` defaults to `info`
  rather than `debug` to limit exposure.
- Batch-queue retry and backoff behaviour is unchanged. The existing single-retry-then-
  drop policy applies to the logs queue as-is.
- Concurrent runs within a single process are not supported for log attribution.
  `LogEntry` carries no `runId`, this spec does not add one, and no behaviour is
  specified for the case where a second run registers a sink while another is active. The
  CLI mints one run identifier per `Runner.run()` and `initLogger` throws on
  re-initialization, so one process is one run.

## Stories

Five stories. `US-005` is terminal and depends on US-001, US-003, and US-004.

### US-001 — Logger sink seam

Add a general sink-registration API to the logger, dispatching after redaction alongside
the existing console and file sinks. No OTLP awareness in the logger.

- **Context Files:** `src/logger/logger.ts`, `src/logger/types.ts`, `src/logger/index.ts`, `src/logger/redact.ts`
- **Creates:** none
- **Depends on:** none

### US-002 — Resource attribute builder

Widen `buildResourceAttributes` to accept an options object and return the full nine
attributes, omitting the git attributes when unresolved.

- **Context Files:** `src/plugins/builtin/otel-reporter/otlp.ts`, `src/version.ts`
- **Creates:** none
- **Depends on:** none

### US-003 — Resource attribute adoption

Adopt the widened builder at all five resource-block construction sites, replacing the
hardcoded `service.name`-only blocks, and resolve the git attributes once at
`onRunStart`.

- **Context Files:** `src/plugins/builtin/otel-reporter/otlp.ts`, `src/plugins/builtin/otel-reporter/heartbeat.ts`, `src/plugins/builtin/otel-reporter/span-tree.ts`, `src/plugins/builtin/otel-reporter/index.ts`, `src/utils/git.ts`
- **Creates:** none
- **Depends on:** US-002

### US-004 — LogEntry to LogRecord mapping

A pure mapping module: severity table, attribute derivation, `data` flattening with the
2048-character cap, and the OTLP logs payload envelope.

- **Context Files:** `src/logger/types.ts`, `src/plugins/builtin/otel-reporter/otlp.ts`
- **Creates:** `src/plugins/builtin/otel-reporter/logs.ts`
- **Depends on:** none

### US-005 — Exporter wiring and lifecycle

Register the sink at `onRunStart`, apply the level floor and re-entrancy guard, enqueue
to a dedicated logs queue, POST to `/v1/logs`, and flush on both run-end paths.

- **Context Files:** `src/plugins/builtin/otel-reporter/index.ts`, `src/config/schemas-reporters.ts`, `src/plugins/builtin/otel-reporter/batch-queue.ts`, `src/plugins/builtin/otel-reporter/logs.ts` — created by US-004, consumed here
- **Creates:** none
- **Depends on:** US-001, US-003, US-004

### Seams

| Producer | New externally-visible symbol | Consumer | Invariant |
|:---|:---|:---|:---|
| US-001 | `addSink` exported from the `@/logger` barrel | US-005 | US-005 AC5 stubs `addSink`, triggers the reporter's `onRunStart` hook with `logs.enabled: true`, and asserts `addSink` was invoked. AC4 is the negative counterpart: with `logs.enabled: false`, `addSink` is not invoked |
| US-004 | `toLogRecord` and `buildLogsPayload` exported from `otel-reporter/logs.ts` | US-005 | US-005 AC9 drives a log entry through the registered sink and asserts the posted body contains a log record whose body string value equals the logged message, proving the mapping is wired rather than merely present |
| US-002 | `buildResourceAttributes` (existing symbol, widened signature) | US-003 | US-003 ACs 1-5 assert each payload builder's resource block carries `nax.feature`, proving every site uses the shared builder rather than a divergent copy |
| US-003 | widened resource block on the logs path | US-005 | US-005 AC1 asserts the logs payload's resource block carries `nax.feature` |

Signature-widening of `buildResourceAttributes` migrates its existing caller in
`span-tree.ts:205`. Caller migration is verified by the build/static gate:
`bun run typecheck`.

## Acceptance Criteria

### US-001 — Logger sink seam

1. `[unit]` `addSink` is importable from the `@/logger` barrel and returns a function when called with a no-op sink.
2. `[unit]` After registering a sink and calling `logger.info` with stage `"verify"` and message `"no test command"`, the sink receives an entry whose `message` equals `"no test command"`.
3. `[unit]` The entry a registered sink receives carries `stage` equal to the stage passed to the log call.
4. `[unit]` The entry a registered sink receives carries `level` equal to the severity of the log method invoked.
5. `[unit]` The entry a registered sink receives carries a `timestamp` parseable as an ISO-8601 date.
6. `[unit]` When a story-scoped log call supplies a story identifier, the entry the sink receives carries that value in `storyId`.
7. `[unit]` Logging with `data` containing an `apiKey` value of `"sk-live-abc123"` delivers an entry to the sink whose corresponding `data` value equals `"[REDACTED]"`.
8. `[unit]` Logging the message text `token ghp_0123456789abcdefghij failed` delivers an entry to the sink whose `message` equals `token [REDACTED] failed`.
9. `[unit]` Invoking the function returned by `addSink` stops the sink receiving any entry from a subsequent log call.
10. `[unit]` With two sinks registered, a single log call delivers an entry to both.
11. `[unit]` With a sink that throws registered first and a second sink registered after it, a log call still delivers the entry to the second sink.
12. `[unit]` With a sink that throws registered and a file path configured, the JSONL file still receives the entry for that log call.
13. `[unit]` A log call does not throw when a registered sink throws.

### US-002 — Resource attribute builder

1. `[unit]` `buildResourceAttributes` called with a service name returns an attribute `service.name` whose value equals that service name.
2. `[unit]` The returned attributes include `nax.run_id` equal to the supplied run identifier.
3. `[unit]` The returned attributes include `nax.feature` equal to the supplied feature name.
4. `[unit]` The returned attributes include `nax.project` equal to the supplied project name.
5. `[unit]` The returned attributes include `nax.version` equal to `NAX_VERSION`.
6. `[unit]` The returned attributes include `host.name` equal to the operating system's hostname.
7. `[unit]` The returned attributes include `process.pid` equal to the current process identifier, encoded as a numeric attribute value.
8. `[unit]` The returned attributes include `nax.git.branch` equal to the supplied branch name when one is supplied.
9. `[unit]` The returned attributes include `nax.git.sha` equal to the supplied commit sha when one is supplied.
10. `[unit]` When no branch is supplied, no attribute with key `nax.git.branch` is present in the returned list.
11. `[unit]` When no commit sha is supplied, no attribute with key `nax.git.sha` is present in the returned list.

### US-003 — Resource attribute adoption

1. `[unit]` `buildTracesPayload` produces a payload whose resource attributes include `nax.feature`.
2. `[unit]` `buildMetricsPayload` from the OTLP payload module produces a payload whose resource attributes include `nax.feature`.
3. `[unit]` `buildHeartbeatMetricsPayload` produces a payload whose resource attributes include `nax.run_id`.
4. `[unit]` `buildHeartbeatMetricsPayload` still produces gauge data points carrying an attribute with the bare key `feature`.
5. `[unit]` The span-tree payload builder produces a payload whose resource attributes include `nax.project`.
6. `[integration]` The incremental span-flush request issued before run end carries resource attributes including `nax.run_id`.
7. `[integration]` When git branch and sha resolution fails at `onRunStart`, the hook completes without throwing.
8. `[integration]` When git branch resolution fails at `onRunStart`, the subsequent exported payload contains no attribute keyed `nax.git.branch`.

### US-004 — LogEntry to LogRecord mapping

1. `[unit]` `toLogRecord` maps an entry whose `timestamp` is a known ISO-8601 instant to a `timeUnixNano` equal to that instant expressed in nanoseconds as a string.
2. `[unit]` An entry with level `error` maps to `severityNumber` 17.
3. `[unit]` An entry with level `error` maps to `severityText` `"ERROR"`.
4. `[unit]` An entry with level `warn` maps to `severityNumber` 13.
5. `[unit]` An entry with level `info` maps to `severityNumber` 9.
6. `[unit]` An entry with level `debug` maps to `severityNumber` 5.
7. `[unit]` An entry's `message` maps to the record's `body` string value.
8. `[unit]` An entry's `stage` maps to an attribute with key `nax.stage`.
9. `[unit]` An entry carrying a `storyId` maps to an attribute with key `nax.story_id` equal to that value.
10. `[unit]` An entry with no `storyId` produces a record with no attribute keyed `nax.story_id`.
11. `[unit]` An entry carrying a `sessionRole` maps to an attribute with key `nax.session_role` equal to that value.
12. `[unit]` An entry whose `data` holds a top-level string value under key `phase` maps to an attribute `nax.data.phase` carrying that string.
13. `[unit]` An entry whose `data` holds a top-level numeric value under key `count` maps to an attribute `nax.data.count` carrying it as a numeric attribute value.
14. `[unit]` An entry whose `data` holds a nested object under key `findings` produces an attribute `nax.data_json` whose value is a JSON string containing that nested content.
15. `[unit]` An entry whose `data` serializes beyond 2048 characters produces a `nax.data_json` attribute whose value is at most 2048 characters and ends with a truncation marker.

### US-005 — Exporter wiring and lifecycle

1. `[unit]` `buildLogsPayload` produces a payload whose resource attributes include `nax.feature`.
2. `[unit]` Constructing the reporter configuration with `logs.enabled` unset resolves that value to `false`.
3. `[unit]` Constructing the reporter configuration with `logs.level` unset resolves that value to `"info"`.
4. `[integration]` With `logs.enabled` set to `false`, invoking the reporter's `onRunStart` hook does not invoke the stubbed `addSink`.
5. `[integration]` With `logs.enabled` set to `true`, invoking the reporter's `onRunStart` hook invokes the stubbed `addSink` exactly once.
6. `[integration]` With `logs.level` set to `"warn"`, a subsequent `info`-level log entry results in no log record being posted.
7. `[integration]` With `logs.level` set to `"warn"`, a subsequent `warn`-level log entry results in a log record being posted.
8. `[integration]` A log entry whose stage is `"otel-batch-queue"` results in no log record being posted, so the exporter's own warnings cannot amplify.
9. `[integration]` After `onRunStart` with `logs.enabled` true, logging the message `"no test command"` and flushing results in a posted body containing a log record whose body string value equals `"no test command"`.
10. `[integration]` The logs export request targets a URL ending in `/v1/logs`.
11. `[integration]` Invoking the reporter's `onRunEnd` hook posts log records that were queued but not yet flushed.
12. `[integration]` Invoking `teardown` after `onRunEnd` has already completed posts no further logs request.
13. `[integration]` With a header value referencing an environment variable that is unset, a queued log entry results in no logs request being posted.

**Out of scope:** `US-005 only:` retry and backoff tuning for the logs queue — the
existing single-retry-then-drop policy in `batch-queue.ts` applies unchanged and is not
re-verified here.
