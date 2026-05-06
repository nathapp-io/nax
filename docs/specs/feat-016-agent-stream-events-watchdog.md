# FEAT-016 — Agent Stream Events & Idle Watchdog

**Status:** Proposal  
**Date:** 2026-05-05  
**Scope:** ACP agent telemetry, stale prompt detection, retry/fallback plumbing

## 1. Problem

Long-running agent prompts can become stale while the nax parent process remains healthy.

Observed run:

- `2026-05-05T13:50:25Z`: opencode prompt started with `--timeout 3600`.
- For the next hour, only parent heartbeat logs appeared.
- `2026-05-05T14:50:25Z`: nax killed the prompt at wall-clock timeout.
- `acpx` reported `agent needs reconnect`.
- Acceptance generation degraded to skeleton tests.

The existing heartbeat is a parent-process liveness signal. It cannot distinguish:

- a slow model that is actively thinking or streaming;
- a wedged `acpx` / agent session that has produced no ACP updates for a long time.

We need prompt-level activity telemetry and a policy layer that can cancel and retry stale prompts before the full wall-clock timeout.

## 2. Goals

- Standardize a reusable agent stream event channel for live agent activity.
- Keep adapters primitive: spawn, parse, close/cancel; no policy decisions.
- Add an idle watchdog subscriber that cancels stale prompts based on agent stream activity, not parent heartbeat.
- Keep memory flat by emitting metadata-only activity events by default.
- Support future consumers: TUI streaming, cost streaming, prompt audit, diagnostics, and model-specific watchdog policy.

## 3. Non-Goals

- Do not store raw thought content by default.
- Do not replace final dispatch events (`session-turn`, `complete`).
- Do not use parent heartbeat as an agent staleness signal.
- Do not shorten the existing wall-clock timeout as the primary fix.

## 4. Event Channel

Add a runtime-level `AgentStreamEventBus`, separate from the final dispatch bus.

```ts
type AgentStreamEvent =
  | AgentCallStartedEvent
  | AgentMessageUpdateEvent
  | AgentThinkingUpdateEvent
  | AgentUsageUpdateEvent
  | AgentProcessUpdateEvent
  | AgentCallEndedEvent;

interface AgentStreamEventBase {
  readonly callId: string;
  readonly runId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly pid?: number;
  readonly timestamp: number;
}
```

Event kinds:

```ts
interface AgentCallStartedEvent extends AgentStreamEventBase {
  readonly kind: "agent.call_started";
  readonly model: string;
  readonly timeoutSeconds: number;
}

interface AgentMessageUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.message_update";
  readonly deltaBytes?: number;
}

interface AgentThinkingUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.thinking_update";
  readonly deltaBytes?: number;
}

interface AgentUsageUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.usage_update";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

interface AgentProcessUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.process_update";
  readonly status: "spawned" | "stderr" | "cancelled" | "exited";
  readonly exitCode?: number;
}

interface AgentCallEndedEvent extends AgentStreamEventBase {
  readonly kind: "agent.call_ended";
  readonly status: "success" | "error" | "cancelled" | "timeout";
  readonly exitCode?: number;
}
```

Default payloads are metadata only. Content fields may be added later behind explicit audit/UI config, but the watchdog must not require or retain content.

## 5. ACP Mapping

Map ACP JSON-RPC `session/update` events to stream events:

| ACP update | Stream event | Watchdog activity |
|---|---|---|
| `agent_message_chunk` | `agent.message_update` | reset idle timer |
| `agent_thought_chunk` | `agent.thinking_update` | reset idle timer |
| `usage_update` | `agent.usage_update` | reset idle timer |
| process spawn | `agent.process_update` `spawned` | diagnostic |
| stderr/banner | `agent.process_update` `stderr` | diagnostic only |
| process exit | `agent.process_update` `exited` + `agent.call_ended` | cleanup |

`agent_thought_chunk` is considered liveness/progress. It resets the idle timer, but its content is not logged or retained by default.

## 6. Idle Watchdog

Add a subscriber: `attachAgentIdleWatchdog(bus, controller, config)`.

For each active `callId`, track only:

```ts
interface WatchdogState {
  readonly callId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly pid?: number;
  startedAt: number;
  lastActivityAt: number;
  messageUpdates: number;
  thinkingUpdates: number;
  usageUpdates: number;
}
```

Idle timer resets on:

- `agent.message_update`
- `agent.thinking_update`
- `agent.usage_update`

It does not reset on parent heartbeat. It should not reset on PID-alive checks alone.

When idle exceeds the configured threshold:

1. emit warning log: `agent-watchdog`, `Agent prompt idle timeout`;
2. cancel active prompt via existing session cancellation path;
3. classify as retriable availability failure (`fail-stale`);
4. let AgentManager retry or fallback according to existing policy.

## 7. Configuration

The watchdog must be configurable. For the first release, use one global idle
timeout to keep the policy simple and predictable. More granular overrides can
be added later if real run data shows they are needed.

The watchdog config lives at `agent.idleWatchdog` (top-level under `agent`,
not nested under `agent.acp`). The watchdog operates on the protocol-agnostic
`AgentStreamEvent` channel, so it does not belong under any single protocol
namespace.

```jsonc
{
  "agent": {
    "acp": {
      "promptRetries": 2
    },
    "idleWatchdog": {
      "enabled": true,
      "mode": "warn-then-cancel",
      "idleTimeoutSeconds": 900,
      "activityKinds": ["message_update", "thinking_update", "usage_update"],
      "cancelGraceSeconds": 10,
      "maxRetryAttempts": 3
    }
  }
}
```

Defaults:

- `enabled: true`
- `mode: "warn-then-cancel"`
- `idleTimeoutSeconds: 900` (15 minutes)
- `activityKinds`: message, thinking, usage
- `cancelGraceSeconds: 10`
- `maxRetryAttempts: 3`

Supported modes:

| Mode | Behavior |
|---|---|
| `off` | No watchdog state or timers. |
| `observe` | Track and log idle calls, but do not cancel. Useful for rollout. |
| `warn-then-cancel` | Log at idle threshold, then cancel after `cancelGraceSeconds` unless activity resumes. |
| `cancel` | Cancel immediately when idle threshold is exceeded. |

Schema notes:

- `idleTimeoutSeconds`: positive integer; required unless `mode: "off"`.
- `activityKinds`: non-empty array when enabled. Valid values:
  - `message_update`
  - `thinking_update`
  - `usage_update`
- `cancelGraceSeconds`: non-negative integer; `0` means no grace window.
- `maxRetryAttempts`: positive integer, default `3`. Prevents infinite retry loops after repeated stale cancellations.

Retry attempt semantics:

- Counts retries caused by watchdog stale cancellation for the same logical agent operation.
- Once `maxRetryAttempts` is exhausted, return a terminal `fail-stale` availability failure.
- Existing AgentManager fallback policy can still choose another agent if configured.
- Wall-clock timeout failures remain separate from stale-idle retry accounting.

## 8. Implementation Phases

### Phase 1 — Event Types and Bus

Files:

- `src/runtime/agent-stream-events.ts`
- `src/runtime/index.ts`
- `test/unit/runtime/agent-stream-events.test.ts`

Tasks:

- Define the `AgentStreamEvent` union and concrete event interfaces from §4.
- Implement `AgentStreamEventBus` with:
  - `onAgentStream(listener): () => void`
  - `emitAgentStream(event): void`
  - listener exception isolation, matching `DispatchEventBus`.
- Add `agentStreamEvents` to `NaxRuntime`.
- Construct the bus in `createRuntime()`.
- Export the types and bus from `src/runtime/index.ts`.
- Keep `DispatchEventBus` unchanged. Final result events and live stream events are separate channels.

Acceptance checks:

- Multiple listeners receive the same event.
- Unsubscribed listeners stop receiving events.
- A throwing listener is logged and does not block other listeners.
- Emitting events does not retain them.

### Phase 2 — ACP Activity Emission

Files:

- `src/agents/acp/adapter-session-types.ts`
- `src/agents/acp/adapter-lifecycle.ts`
- `src/agents/acp/adapter.ts`
- `src/agents/acp/spawn-client.ts`
- `src/agents/acp/parser.ts`
- `src/agents/types.ts`
- `src/agents/manager.ts`
- `test/unit/agents/acp/parser.test.ts`
- `test/unit/agents/acp/spawn-client.test.ts`

Tasks:

- Add an optional stream callback to ACP client/session construction. The callback receives metadata-only `AgentStreamEvent` values.
- Add a stable `callId` per physical prompt invocation. Use a UUID generated at prompt start, not the session name, because one session can have multiple turns.
- Thread call metadata through `openSession()` and `complete()`:
  - `runId`
  - `agentName`
  - `sessionName`
  - `storyId`
  - `stage`
  - `model`
  - `timeoutSeconds`
- Emit `agent.call_started` after spawn succeeds and the PID is registered, then
  emit `agent.process_update { status: "spawned" }`. Emitting after spawn keeps
  `call_started`/`call_ended` paired exactly once: a synchronous spawn failure
  emits a single `call_ended { status: "error" }` with no orphan `call_started`.
- Update `parseAcpxJsonLine()` so it returns activity metadata for the current line while still updating parse state:
  - `agent_message_chunk` → `agent.message_update`
  - `agent_thought_chunk` → `agent.thinking_update`
  - `usage_update` → `agent.usage_update`
- Do not include raw message or thought content in the emitted events. Use `deltaBytes` only.
- Emit activity events immediately while reading stdout lines. Do not wait for `proc.exited`.
- Emit `agent.process_update { status: "stderr" }` only as diagnostic metadata, without retaining stderr text in watchdog state.
- Emit `agent.process_update { status: "exited" }` and `agent.call_ended` in all terminal paths:
  - success;
  - non-zero exit;
  - cancel;
  - parse failure;
  - thrown spawn/stream errors.

Acceptance checks:

- A mocked `agent_message_chunk` line emits `agent.message_update`.
- A mocked `agent_thought_chunk` line emits `agent.thinking_update`.
- A mocked `usage_update` line emits `agent.usage_update`.
- Thought content is not present in the event object.
- Activity events are emitted before process exit.
- `agent.call_ended` is emitted exactly once per `agent.call_started`.

### Phase 3 — Watchdog Subscriber

Files:

- `src/runtime/middleware/agent-idle-watchdog.ts`
- `src/runtime/middleware/index.ts`
- `src/runtime/index.ts`
- `src/config/schemas-infra.ts`
- `src/config/runtime-types-agent.ts`
- `test/unit/runtime/middleware/agent-idle-watchdog.test.ts`
- `test/unit/config/agent-schema.test.ts`

Tasks:

- Add `agent.acp.idleWatchdog` schema and runtime types:
  - `enabled`
  - `mode`
  - `idleTimeoutSeconds`
  - `activityKinds`
  - `cancelGraceSeconds`
  - `maxRetryAttempts`
- Implement `attachAgentIdleWatchdog(agentStreamEvents, controllerRegistry, config)`.
- Maintain a `Map<callId, WatchdogState>`.
- Initialize `lastActivityAt` on `agent.call_started`.
- Reset `lastActivityAt` only for configured activity kinds.
- Ignore parent heartbeat and PID liveness.
- Ignore `agent.process_update` for idle reset unless a future config explicitly enables it.
- Use one bounded interval for all active calls, or per-call timers. Either approach must delete timers/state on `agent.call_ended`.
- Implement `observe` mode first: log idle calls without cancellation.
- Implement `warn-then-cancel`: log at threshold, wait `cancelGraceSeconds`, cancel if still idle.
- Implement `cancel`: cancel immediately at threshold.
- Add a prompt controller registry keyed by `callId`, with a minimal cancellation function.

Acceptance checks:

- `message_update`, `thinking_update`, and `usage_update` reset idle when configured.
- Activity kinds not listed in config do not reset idle.
- `process_update` alone does not reset idle.
- `observe` mode logs but does not cancel.
- `warn-then-cancel` does not cancel if activity arrives during grace.
- State is deleted on `agent.call_ended`.
- Repeated stale cancellation cannot exceed `maxRetryAttempts`.

### Phase 4 — Failure Classification and Retry

Files:

- `src/context/engine/types.ts`
- `src/agents/types.ts`
- `src/agents/acp/adapter.ts`
- `src/agents/manager.ts`
- `src/agents/retry/default-strategy.ts`
- `src/operations/call.ts`
- `src/runtime/session-run-hop.ts`
- `src/operations/build-hop-callback.ts`
- `test/unit/agents/manager-*.test.ts`
- `test/unit/operations/call*.test.ts`

Tasks:

- Add `fail-stale` to `AdapterFailure.outcome`.
- Classify watchdog cancellation as:
  - `category: "availability"`
  - `outcome: "fail-stale"`
  - `retriable: true` until `maxRetryAttempts` is exhausted.
- Ensure `complete()` returns or throws a structured failure that `completeWithFallback()` can interpret. It must not hand failure text to operation parsers as if it were model output.
- Ensure `sendTurn()`/`runAsSession()` propagates `SessionFailureError` for `fail-stale`.
- Extend retry strategy so stale failures can retry same agent up to `maxRetryAttempts` when fallback is not configured or before fallback, according to AgentManager policy.
- Preserve distinction:
  - `fail-stale`: no configured stream activity within idle timeout.
  - `fail-timeout`: wall-clock timeout exceeded.
- Log recovery path:
  - same-agent retry;
  - fallback agent selected;
  - retry exhausted;
  - terminal stale failure.

Acceptance checks:

- `fail-stale` triggers retry/fallback as an availability failure.
- `fail-stale` does not trigger quality escalation.
- Retry stops after `maxRetryAttempts`.
- `fail-timeout` behavior remains unchanged except for clearer logging.
- Complete operations do not parse stale failure text as successful output.

### Phase 5 — Observability

Files:

- `src/runtime/middleware/logging.ts` or new `src/runtime/middleware/agent-stream-logging.ts`
- `src/tui/**`
- `src/cli/status.ts` if status output is extended in this phase
- `test/unit/runtime/middleware/logging.test.ts`
- TUI tests where practical

Tasks:

- Add lightweight stream logs:
  - call started;
  - call ended;
  - idle warning;
  - stale cancellation;
  - completion counters.
- Completion counters should include:
  - `messageUpdates`
  - `thinkingUpdates`
  - `usageUpdates`
  - `lastActivityAt`
  - `idleMs`
- TUI subscribes to `AgentStreamEventBus` read-only.
- TUI may render:
  - active agent;
  - current story/stage;
  - elapsed call time;
  - last activity age;
  - activity counters;
  - idle countdown when watchdog is enabled.
- TUI must not cancel prompts or mutate watchdog state.
- TUI must not display raw thinking content.

Acceptance checks:

- Logs show enough data to diagnose a stale prompt without raw output.
- TUI continues to work when stream events are absent.
- TUI handles multiple active prompts without accumulating per-chunk history.
- No raw `agent_thought_chunk` text appears in logs or TUI by default.

### Phase 6 — End-to-End Validation

Files:

- `test/integration/agents/acp-watchdog.test.ts`
- Existing ACP test helpers/mocks

Tasks:

- Add an integration fixture for a prompt that never emits ACP activity.
- Add an integration fixture for a prompt that periodically emits `agent_thought_chunk`.
- Add an integration fixture for a prompt that periodically emits `usage_update`.
- Verify stale prompt is cancelled before full wall-clock timeout.
- Verify active slow prompt is not cancelled.
- Verify stale retry respects `maxRetryAttempts`.
- Verify fallback is invoked when configured and same-agent retries are exhausted.

## 9. Memory Safety

The stream channel must be O(active prompts), not O(output size).

Rules:

- Do not buffer raw stream events in the bus.
- Do not store message or thought chunks in watchdog state.
- Emit `deltaBytes` and counters only by default.
- Do not expose raw thinking content by default.
- Delete watchdog state on `agent.call_ended`.
- Avoid arrays of per-chunk events in subscribers.

Expected memory footprint: one small record per active prompt.

## 10. Test Plan

Unit tests:

- `agent.message_update` resets idle timer.
- `agent.thinking_update` resets idle timer.
- `agent.usage_update` resets idle timer.
- `agent.process_update` alone does not reset idle timer after call start.
- Watchdog cancels when no activity exceeds threshold.
- Watchdog removes state on `agent.call_ended`.
- ACP parser maps `agent_thought_chunk` without exposing content.
- Complete/session paths classify idle timeout as retriable availability failure.

Integration tests:

- Hanging ACP prompt with no stream activity is cancelled before wall-clock timeout.
- Slow prompt with periodic `agent_thought_chunk` is not cancelled.
- Slow prompt with periodic `usage_update` is not cancelled.
- After idle cancellation, AgentManager retry/fallback path is invoked.

## 11. Open Questions

- Should raw message content be exposed through this channel for TUI later, or only through a separate explicit audit/streaming API?

Resolved decisions:

- First release uses one global idle timeout.
- Add a specific `fail-stale` outcome for idle watchdog cancellations.
- TUI should subscribe to the same stream bus in read-only mode.
- Raw thinking content is not exposed by default.
