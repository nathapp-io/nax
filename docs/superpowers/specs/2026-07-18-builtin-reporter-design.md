# Built-in Reporter Plugins — webhook + OTel

**Date:** 2026-07-18
**Status:** Design approved, pending spec review
**Branch:** `feat/builtin-reporter-plugins`

## Problem

The `IReporter` extension point is fully plumbed — interface
(`src/plugins/extensions.ts`), registry accessor
(`PluginRegistry.getReporters()`), event wiring (`wireReporters` in
`src/pipeline/subscribers/reporters.ts`), and validator
(`src/plugins/validator.ts`) all exist — but **no built-in implementation ships**.
`src/plugins/builtin/` holds only `auto-pr`, `auto-route`, and `curator`. To get
run telemetry into Datadog / Grafana / Slack / a CI dashboard today, a user must
hand-write and hand-wire an entire plugin. This is the "backend built, front door
missing" gap flagged in `docs/reviews/CODEBASE-GAP-ANALYSIS-2026-07-18.md`
(recommendation #13).

## Goal

Ship two opt-in built-in reporters that turn nax run telemetry into external
signals with zero custom plugin code:

- **`webhook-reporter`** — POSTs a JSON envelope per run/story event.
- **`otel-reporter`** — emits OTLP/HTTP-JSON traces + metrics.

Both are fire-and-forget, `enabled: false` by default, and mirror the existing
`autoPr` config/loader convention.

## Non-goals (YAGNI)

- Batching or queuing telemetry across runs
- Retry / backoff on delivery failure
- OTel Logs signal
- Histogram bucket configuration (metrics use Sum + Gauge)
- Synthetic per-story child spans with reconstructed timing
- `nax plugins install/enable/disable` CLI (separate gap item)

## Event data available

The `IReporter` interface (`src/plugins/extensions.ts`) exposes three events.
Their payloads bound what the reporters can honestly represent:

| Event | Payload |
|:------|:--------|
| `onRunStart` | `runId`, `feature`, `totalStories`, `startTime` (ISO string) |
| `onStoryComplete` | `runId`, `storyId`, `status` (`completed`\|`failed`\|`skipped`\|`paused`), `runElapsedMs`, `cost`, `tier`, `testStrategy` |
| `onRunEnd` | `runId`, `totalDurationMs`, `totalCost`, `storySummary` `{completed,failed,skipped,paused}` |

**Key constraint:** there is no `onStoryStart` and no per-story duration — only
`runElapsedMs` (elapsed since run start) at completion. Honest per-story child
spans are therefore impossible; the OTel reporter uses span **events** on the root
span instead of synthesizing child-span timing.

## Architecture

Two new built-in plugins plus a small shared helper module. No changes to the
`IReporter` interface, the event bus, or `wireReporters`.

```
src/plugins/builtin/
  reporter-shared/           # shared, dependency-free helpers
    index.ts                 # barrel
    interpolate.ts           # ${ENV} header resolution
    post-json.ts             # bounded fetch POST with _deps injection
    types.ts
  webhook-reporter/
    index.ts                 # createWebhookReporterPlugin(cfg): NaxPlugin
    types.ts
  otel-reporter/
    index.ts                 # createOtelReporterPlugin(cfg): NaxPlugin
    otlp.ts                  # OTLP/HTTP-JSON payload builders (traces, metrics)
    ids.ts                   # traceId/spanId generation via crypto.getRandomValues
    types.ts
```

Both plugins are **factory functions** returning a `NaxPlugin`, because
`IReporter` methods receive only the event (no config/ctx). The factory closes
over the plugin's config slice so the reporter instance can read its endpoint and
headers at emit time.

## Config surface

New top-level `reporters` block in `src/config/schemas.ts` (Zod, with
`.default()`s per `config-patterns.md`; per-package layerable via
`.nax/mono/<pkg>/config.json`):

```jsonc
{
  "reporters": {
    "webhook": {
      "enabled": false,
      "url": "https://example.com/nax-events",
      "headers": { "Authorization": "Bearer ${DD_API_KEY}" },
      "events": ["onRunStart", "onStoryComplete", "onRunEnd"],
      "timeoutMs": 5000
    },
    "otel": {
      "enabled": false,
      "endpoint": "https://otlp.example.com",
      "headers": { "Authorization": "Bearer ${OTLP_TOKEN}" },
      "serviceName": "nax",
      "timeoutMs": 5000
    }
  }
}
```

- `webhook.events` is an optional filter (default: all three).
- `otel.endpoint` is a base URL; `/v1/traces` and `/v1/metrics` are appended.
- `timeoutMs` bounds each `fetch` so a hung endpoint cannot stall run teardown.
- Defaults are declared in the Zod schema; `DEFAULT_CONFIG` stays schema-derived.

## Shared helpers (`reporter-shared/`)

### `interpolateHeaders(headers): { resolved, missing }`

Resolves `${VAR}` placeholders in header values from `process.env`. Returns the
resolved header map and a list of missing variable names. A reporter that gets a
non-empty `missing` list logs a warning **once per run** and skips emitting —
never throws.

### `postJson(url, body, { headers, timeoutMs, _deps })`

Bounded `fetch` POST with `Content-Type: application/json` and
`AbortSignal.timeout(timeoutMs)`. `_deps.fetch` (default `globalThis.fetch`) is
injectable for tests. Non-2xx responses and thrown network errors are logged at
`warn` and swallowed. **Resolved header values are never logged** (secret
redaction).

## `webhook-reporter`

Stateless. For each enabled event, POST a JSON envelope:

```jsonc
{
  "type": "onStoryComplete",
  "emittedAt": "2026-07-18T12:34:56.000Z",
  "data": { /* the raw event payload */ }
}
```

Behaviour:
- Respects the `events` filter — a filtered-out event is a no-op.
- Missing `${ENV}` header var → warn once + skip (via `interpolateHeaders`).
- Delivery failure → warn + swallow (via `postJson`).
- Disabled (or not registered) → never constructed.

## `otel-reporter`

OTLP/HTTP-JSON, hand-built (no `@opentelemetry/*` dependency — stays Bun-native
and unit-testable against golden payloads). Holds `Map<runId, RunState>`, created
at `onRunStart` and deleted at `onRunEnd`, so memory is bounded to in-flight runs.

**`onRunStart`**
- Generate 16-byte `traceId` and 8-byte root `spanId` via
  `crypto.getRandomValues` (`ids.ts`).
- Record `startUnixNano` derived from `event.startTime`.
- Initialise an empty span-events buffer.

**`onStoryComplete`**
- Append a span **event**:
  `{ timeUnixNano: startUnixNano + runElapsedMs * 1e6, name: "story.complete",
     attributes: { storyId, status, cost, tier, testStrategy } }`.

**`onRunEnd`**
- Build one `ResourceSpans` with a root span `nax.run`:
  - `startTimeUnixNano = startUnixNano`
  - `endTimeUnixNano = startUnixNano + totalDurationMs * 1e6`
  - attributes: `feature`, `runId`, `stories.completed/failed/skipped/paused`,
    `cost.total`
  - `status = storySummary.failed > 0 ? ERROR : OK`
  - `events` = the buffered story-complete events
  - resource attributes: `service.name = serviceName`
  - POST to `${endpoint}/v1/traces`.
- Build metrics and POST to `${endpoint}/v1/metrics`:
  - `nax.stories.total` — Sum (counter), one data point per `status`
  - `nax.run.cost` — Gauge, value `totalCost`
  - `nax.run.duration_ms` — Gauge, value `totalDurationMs`
- Delete the run's `RunState`.

One traces POST + one metrics POST per run. Missing `${ENV}` header var → warn
once + skip both. Delivery failure → warn + swallow.

## Integration seam

`IReporter` methods receive only the event, so the reporters must close over
their config. The reporter config must therefore reach plugin load time.

- `run-setup.ts:413` calls `loadPlugins(...)` and already has `config` in scope
  but does not pass it.
- **Change:** add one optional `reporters?: ReportersConfig` parameter to
  `loadPlugins`. Defaulted, so the other callers (`src/pipeline/stages/context.ts`,
  `src/cli/plugins.ts`) are unaffected.
- In `src/plugins/loader.ts`, in the built-in loading block (section 0), register
  each reporter **only when its `enabled === true`**, via
  `createWebhookReporterPlugin(cfg.webhook)` / `createOtelReporterPlugin(cfg.otel)`.
  Reporters are full `IReporter`-providing plugins, so they are added to
  `loadedPlugins` (unlike the side-channel post-run actions) and surface through
  `getReporters()`.
- `disabledPlugins` still wins: a name in `disabledPlugins` skips registration
  even when `enabled === true`.

## Event delivery guarantees

Verified against `unified-executor.ts`, `reporters.ts`, `run-completion.ts`, and
`run-cleanup.ts`:

- `wireReporters` subscribes **once per run** (via the `_prevRunUnsubscribers`
  teardown in `unified-executor.ts`), so `onRunStart` and `onRunEnd` each fire at
  most once per run. Reporter instances are stable across a run's events, so the
  OTel `Map<runId, RunState>` is sound.
- `onRunEnd` has **two mutually exclusive delivery paths**: the success path emits
  `run:completed`, which the `reporters.ts` subscriber turns into `onRunEnd`;
  abnormal exits (failure / abort / SIGTERM) call `onRunEnd` directly from
  `run-cleanup.ts`, guarded by `!runCompleted` to prevent duplicates. Net effect:
  `onRunEnd` fires exactly once.
- **Edge case:** on an early abort, `onRunEnd` can arrive with **no preceding
  `onRunStart`** (no buffered `RunState`). The OTel reporter must handle this
  gracefully — emit metrics from the `onRunEnd` payload and either skip the trace
  or emit a best-effort root span whose start is back-computed as
  `endUnixNano - totalDurationMs * 1e6`. It must never throw. The webhook reporter
  is stateless and unaffected.

## Error handling

Fire-and-forget end to end:
- `wireReporters` already catches and logs per-reporter errors.
- `interpolateHeaders` returns a `missing` list rather than throwing.
- `postJson` swallows non-2xx and network errors after logging `warn`.
- `AbortSignal.timeout(timeoutMs)` bounds every request so run teardown cannot
  hang on a slow or dead endpoint.

Log lines follow project conventions (`[stage]` prefix, no emojis, structured
fields). Resolved secret header values are never logged.

## Security

- Secrets are supplied only through `${ENV}` interpolation — never stored in
  `config.json`, never logged, never persisted to run artifacts.
- Endpoint URLs and header **names** are declarative config; only values may
  reference env vars.

## Testing

- `interpolateHeaders`: single var, multiple vars, missing var, no placeholders.
- `postJson`: 2xx success, non-2xx, timeout (AbortSignal), thrown network error —
  all via injected `_deps.fetch`.
- `webhook-reporter`: envelope shape per event, `events` filter, disabled no-op,
  missing-env skip, delivery-failure swallow.
- `otel-reporter`: golden OTLP-JSON for traces and metrics; multi-story event
  buffering; root-span timing from `startTime` + `totalDurationMs`; `status`
  ERROR when failures present; `RunState` deleted after `onRunEnd`; missing-env
  skip.
- `loader`: reporter registered when `enabled === true`; not registered when
  disabled or absent; `disabledPlugins` overrides `enabled`.

Follows the `_deps` injection pattern and Bun-native rules throughout. No new
runtime dependencies.
