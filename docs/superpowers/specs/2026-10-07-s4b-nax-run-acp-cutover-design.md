# S4b: `nax run` ACP cutover (acpx CLI -> `@nathapp/nax-agent-acp`)

**Status:** design approved section by section in brainstorm 2026-10-07. Final-reviewed 2026-10-07 by two read-only reviewers (codebase accuracy; feasibility and risk), both "ready after fixes" (4 BLOCKER, 16 MAJOR combined). This revision is the single fix round. The review moved context-pull tools back to the text protocol (B5, user ruling).

**Master plan:** `nax-agent-master-plan.md` (maintainer workspace), row S4b; decisions D11, D24, D25.

**Predecessor:** S4 spec `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`, §13 "Handoff to S4b".

**Baseline:** main `d2e88ab27`; `@nathapp/nax-agent` and `@nathapp/nax-agent-acp` 0.3.0 released, plus the unreleased 0.3.1 fixes (#2373); nax 0.83.4. Both agent packages are `"private": true` in the workspace and publish from a staged manifest (`.publish/`).

## 1. Goal

`nax run` stops driving external coding agents through the `acpx` CLI wrapper in `packages/nax/src/agents/acp/` and drives them through `acpBackend()` from `@nathapp/nax-agent-acp`. Afterwards the wrapper and the `acpx` PATH dependency are deleted.

**Governing rule (user ruling, 2026-10-07): S4b replaces the acpx transport, not the logic inside nax.**
- **Kept, re-wired onto the new transport with the same config and semantics:**
  - the turn loop, with its question and context-tool interactions, the shared `maxInteractions` budget and the human-reply timeouts
  - the turn deadline and the `timedOut` result contract
  - session naming and the close-means-fresh lifecycle
  - mid-turn NO_SESSION recovery
  - the `SESSION_CWD_MISSING` precheck
  - `promptRetries` and the tracked-spawn deadlines
  - the env allowlist
  - rate-card pricing
  - the error-to-`AdapterFailure` classification and retriability
  - the retry, swap and stale policies
  - the idle-watchdog event stream
- **Replaced:** acpx plumbing only:
  - argv building
  - the stdout JSON-line parser
  - acpx stderr parsing
  - `sessions ensure|close|stop`
  - `cancel`
  - process spawning
- Every behaviour that does change is listed in §11. Nothing changes silently.

**Success:**
- `nax run` with `agent.default: claude` behaves the same or better on the new transport with no `acpx` installed. A billed Claude smoke proves it (approval at launch).
- Every merge leaves main green and releasable.
- No released nax version carries both transports. The old one exists only behind the development key, and nax is released only after the deletion slice.

## 2. Context and decisions

### 2.1 What exists today

- **The acpx adapter.**
  - Size: `agents/acp/` is 23 files and 4,306 lines, with 25 unit test files.
  - Interface: it implements `AgentAdapter` (`agents/types.ts:536`), which extends nax-agent's S1 `AgentSessionAdapter`.
  - Transport: every prompt, session op and one-shot `complete()` shells out to `acpx`.
  - Turn loop: lives in `adapter-send-turn.ts`. One `TurnResult` covers the whole loop: usage is summed, output is taken from the last response, and a shared `turnCount` is bounded by `maxInteractions`. The question and `<nax_tool_call>` interactions run through the interaction handler with a 5-minute human-reply timeout. One `createTurnDeadline` spans the loop, and a timeout returns `TurnResult{ timedOut: true }`.
- **Session reuse is owned by `SessionManager`**, not by the adapter (`session/manager.ts:426-433`, `getLiveHandle`; `operations/build-hop-callback-hop.ts:444-455`).
  - `AcpAgentAdapter.closeSession` really closes the session (`agents/acp/adapter.ts:244-251`), and a closed acpx session is not resumable.
  - A timed-out hop closes its session so the retry gets a fresh one (`build-hop-callback-dispatch.ts`; `test/integration/agents/timeout-retry-fresh-session.test.ts`).
- **`complete()` already uses a throwaway session.** acpx creates a session under `sessionName` and force-closes it in `finally` (`adapter-complete-flow.ts:66-176`). Every one-shot gets a fresh session.
- **The native adapter** (`agents/native-agent/index.ts`) drives nax-agent at the same S1 level (`openSession` / `sendTurn`), not through the S3 facade.
- **The ACP backend** (`packages/nax-agent-acp/src/client/`):
  - Shape: `acpBackend(opts).open(ctx: BackendOpenContext)` returns an `OpenedBackend { adapter, handle, info, turnOpts(), close() }`.
  - Processes: it spawns one agent process per session.
  - Profiles: `none|read|ask|full`. `none` and `read` work on Claude only until #2372.
  - Tools: a session with tools needs HTTP MCP plus pre-approval, which only Claude has (`capabilities.ts:80`). S4b opens every session without tools (B5).
  - Resume: via `session/resume` or `session/load`, and it reconnects once after a crash.
  - Turns: `sendTurn` honours the per-turn `signal` (`opts.signal ?? ctx.turnSignal()`) and ignores the handle argument.
  - Usage: reported per turn, with the reported cost in `estimatedCostUsd` plus `costSource: "reported" | "unpriced"`. A failed turn's spend is attached to the thrown error (`attachTurnSpend`).
  - Not supported: it does not read `turnTimeoutSeconds` (the S3 facade enforces that), and emits no idle-watchdog lifecycle events.
- **The registry** (`agents/registry.ts`):
  - Routing: returns `NativeAgentAdapter` for `native` and `AcpAgentAdapter(name)` for every other name in `KNOWN_AGENT_NAMES` (claude, codex, opencode, gemini, aider, pi).
  - Direct construction: `cli/agents.ts:9,41` and `bakeoff/preflight.ts:10` build `AcpAgentAdapter` directly.
  - Re-exports: `agents/index.ts:11-30` re-exports acpx internals.

### 2.2 Decisions (brainstorm and final review, 2026-10-07)

| # | Decision |
|---|---|
| B1 | **Claude is the only agent with end-to-end proof.** codex, opencode, gemini and pi move to the new transport without a billed smoke. A non-`full` profile on them fails closed until #2372 (§6.4). `aider` has no ACP registry entry; on the new transport it fails at open with a clear error (§11). |
| B2 | **Rollout: key, smoke, flip, then delete, all inside S4b.** The development key is `agent.acp.transport`, default `acpx`. The flip and the deletion are separate PRs (S4b-4, S4b-5). nax is released only after S4b-5, so no release carries both transports. Rollback is a revert or pinning the previous nax patch. |
| B3 | **One-shot `complete()` = a throwaway ACP session per call.** This is parity: acpx already force-closes its one-shot session (§2.1). The profile is mapped from `resolvedPermissions` exactly as for sessions, and no tools are registered. A warm multi-session process is a later optimisation. |
| B4 | **Additive package changes are allowed** (`nax-agent` and `nax-agent-acp` 0.3.x, no breaking change), listed in §8. |
| B5 | **Context-pull tools keep the `<nax_tool_call>` text protocol on every agent** (review revision). The loop, `extractContextToolCall`, `buildContextToolPreamble`, the interaction-handler path and the shared budget move unchanged. Sessions open with `tools: []`. MCP pull tools are a follow-up (§13). |
| B6 | **nax stays on the S1 adapter (D24).** The new adapter calls `acpBackend(...).open(ctx)` itself and drives `OpenedBackend.adapter`, as native is driven. Facade duties it skips are taken over by nax (§6). |
| B7 | **Transport, not logic** (§1). `agent.acp.promptRetries`, `trackedSpawnDeadlineMs` and `trackedSpawnStartupDeadlineMs` are nax behaviour and are honoured on the new transport (§7.2). |

## 3. Out of scope

- Moving nax onto the S3 facade (D24: later, unscheduled).
- MCP context-pull tools and pre-approval for non-Claude agents (§13).
- `none`/`read` for codex and opencode (#2372).
- Billed smokes for any agent other than Claude.
- A warm multi-session agent process for `complete()`, and a concurrency cap on agent processes.
- Client fs/terminal handlers and a stdio MCP bridge (S4 §13 "Later").
- The ACP server wrapper (S5) and koda chat (S6).
- Any change to the retry, swap, stale, cost-ledger or metrics policies.

## 4. Architecture

```
SessionManager ─► registry.ts ──(agent.acp.transport = "sdk")──► AcpSdkAgentAdapter (agents/acp-sdk/)
                                                                     │ open: open-context ─► BackendOpenContext
                                                                     │       acpBackend({...}).open(ctx)
                                                                     │ turn: turn-loop (ported adapter-send-turn.ts)
                                                                     │       └─ opened.adapter.sendTurn(..., onTurnEvent)
                                                                     │            └─ stream-bridge ─► AgentStreamEvent (watchdog),
                                                                     │                              tool audit, usage
                                                                     ▼
                                                     TurnResult | SessionTurnError (failure-map, pricing)
```

The folder is `agents/acp-sdk/` while both transports exist. It is renamed to `agents/acp/` in S4b-5.

## 5. Components

### 5.1 New: `packages/nax/src/agents/acp-sdk/`

| Unit | Job | Depends on |
|---|---|---|
| `adapter.ts` `AcpSdkAgentAdapter implements AgentAdapter` | `openSession` / `sendTurn` / `closeSession` / `closePhysicalSession` / `complete` / `isInstalled` / `buildAllowedEnv`. It keeps a live map from nax handle id to the opened backend, used for routing only, never for reuse (§6.1). Otherwise thin. | all below |
| `open-context.ts` | Builds `BackendOpenContext` and the `acpBackend` options from `OpenSessionOpts` (§6.1). | `profile-map`, `ask-port` |
| `profile-map.ts` | Pure: `ResolvedPermissions.mode` + agent name -> ACP profile (§6.4). | none |
| `ask-port.ts` | nax's `SessionAskPort` (§6.3). | `InteractionHandler`, logger |
| `turn-loop.ts` | The `adapter-send-turn.ts` loop with the acpx calls swapped for `opened.adapter.sendTurn`: the deadline, question and context-tool interactions, the shared budget, mid-turn NO_SESSION recovery, `promptRetries`, and one aggregated `TurnResult` (§6.2). | `stream-bridge`, `failure-map`, `pricing` |
| `stream-bridge.ts` | Per backend turn: maps `TurnEvent`s to the `AgentStreamEvent` sequence the acpx client emits today (§6.2.1), writes tool audit (§7.4), collects usage and spend, and tracks whether output or a tool call has happened. | tool-audit sink |
| `pricing.ts` | `estimatedCostUsd` from the rate card; `exactCostUsd` from the reported cost (§7.3). | `agents/cost` |
| `failure-map.ts` | Pure: backend error + cancel cause -> `AdapterFailure` and the `SessionTurnError` fields (§7.1). | none |
| `complete.ts` | One-shot `complete()` (§6.6). | `turn-loop`, `failure-map` |
| `entries.ts` | Per-agent rows carried from `agent-entries.ts` (display name, tiers, max context), minus the acpx binary. Exports the agent-name list that `cli/agents.ts` and `bakeoff/preflight.ts` get today from `ACP_ADAPTER_NAMES`. | none |

### 5.2 Moved, not rewritten (nax logic that lives in `agents/acp/` today)

These move out of `agents/acp/` in S4b-1 with their tests, with no behaviour change. Both transports import them from the new location.

| Symbol(s) | From | To |
|---|---|---|
| `computeAcpHandle` | `adapter-lifecycle.ts:146` | `agents/session-naming.ts` |
| `extractQuestion`, `extractContextToolCall`, `CONTEXT_TOOL_CALL_PATTERN` | `adapter-output.ts` | `agents/interaction/output-parsing.ts` |
| `buildContextToolPreamble` | `adapter-output.ts:165` | `agents/tool-preamble.ts` (its consumer) |
| the interaction-reply helpers used by the loop (`awaitInteractionReply` and the context-tool call shaping in `adapter-send-turn.ts`) | `adapter-send-turn.ts` | `agents/interaction/turn-interactions.ts` |
| `createTurnDeadline` and the `timedOut` result builder | `adapter-send-turn.ts` / `adapter-output.ts:280-` | `agents/turn/turn-deadline.ts` |
| the model-spec effort parsing (`spawn-client.ts:76-83`) and `EFFORT_OPTION_BY_AGENT` | `spawn-client.ts`, `reasoning-effort.ts` | **Not moved in S4b-1 (ruling D1-b, 2026-10-07).** The parsing is `parseModelSpec` from `@nathapp/nax-agent`, which both transports can call directly. nax-agent-acp keeps its own copy of the fallback names (S4b-0), and nax's `EFFORT_OPTION_BY_AGENT` is read only by the acpx `acpx set` path, so it is deleted in S4b-5. `agents/model-effort.ts` is created in S4b-2 only if the model-alias probe needs a mapping table (§6.7). |
| `parseAgentError`, `classifyParsedAgentError` | `parse-agent-error.ts` | `agents/errors/parse-agent-error.ts` (used by `complete-exception-classifier.ts` for every adapter) |
| the `buildRunInteractionHandler` re-export | `adapter-output.ts:198` | removed; callers import `agents/run-interaction-handler.ts` |

The plan's S4b-1 task lists the exact helpers after reading `adapter-send-turn.ts`. The rule is fixed: anything that is not acpx plumbing moves; acpx plumbing stays and is deleted in S4b-5.

`AcpInteractionBridge` (`interaction-bridge.ts`) has no production reference (tests only) and is deleted with the folder. In S4b-5, `parseAgentError` loses its acpx-only branches (bracketed `ACPX_*` codes, the flat acpx message) and keeps its structured JSON-field parsing.

### 5.3 Routing and other consumers

- `agents/registry.ts` (`adapterFor`, `createAgentRegistry.cachedAdapter`) returns `AcpSdkAgentAdapter(name)` when `agent.acp.transport === "sdk"`, otherwise the old adapter. `native` is unchanged, and so is the `agent.protocol` gate.
- `cli/agents.ts` and `bakeoff/preflight.ts` get their adapter from the registry instead of constructing `AcpAgentAdapter` (S4b-2).
- `agents/index.ts` stops re-exporting acpx internals in S4b-5.

## 6. Data flow

### 6.1 Sessions

**Lifecycle parity.**
- `SessionManager` keeps owning reuse. The adapter never hands back an existing session from `openSession`.
- `closeSession` really closes, and a closed session is never resumed.
- The live map exists only to route `sendTurn` and close calls from a nax handle to its `OpenedBackend`.

**`openSession(name, opts)`:**
1. **Precheck (kept):** `SESSION_CWD_MISSING` when `opts.workdir` does not exist, as `adapter-lifecycle.ts:~185` does today.
2. **Build `BackendOpenContext`** (`open-context`):
   - `sessionId`: `name`. `workdir`: `opts.workdir`.
   - `profile`: from `profile-map` (§6.4).
   - `tools`: `[]` (B5). `instructions`: `undefined` (nax puts everything in the prompt, as today).
   - `transcriptStore`: `createFileTranscriptStore(opts.transcriptDir)`. This is the dir `SessionManager` already derives (`manager.ts:462-465`), so the adapter reads no config.
   - `resume` (crash-leftover policy below).
   - `asks`: the ask port (§6.3).
   - `turnSignal`, `currentTurnId`: read the adapter's current-turn slot. Between turns, `turnSignal` returns a never-aborting signal.
   - `turnTimeoutSeconds`: `opts.timeoutSeconds`, informational only; the deadline is enforced by `turn-loop`.
   - `metadata`: feature, story, role.
   - `openSignal`: a per-session close controller linked to `opts.signal`.
3. **Call `acpBackend(...).open(ctx)`** with these options:
   - `agent`: from the nax agent name.
   - `model` and `effort`: from the parsed model spec (§6.7).
   - `env`: `buildAllowedEnv({ modelEnv: opts.modelDef.env })`, today's allowlist (`agents/shared/env.ts`), with `inheritEnv: false`. The backend's own narrower allowlist does not apply.
   - `allowUnsandboxed`: `true`.
   - `initializeTimeoutMs` and `cancelGraceMs`: §7.2.
   - `onProcess`: §8. It feeds `opts.onPidSpawned` / `opts.onPidExited` for every spawn, including a reconnect's new process.
4. **Return the adapter's own `SessionHandle`**, not `opened.handle`, whose `agentName` is `"acp:claude"` and has no `modelDef`.
   - The handle has `agentName` set to the nax agent name, plus the `modelDef`, `modelTier` and `protocolIds` that `SessionManager.closeSession` (`manager.ts:521`), `decideReuse` and the cost rows need.
   - `protocolIds.sessionId` is the ACP session id, read from `transcriptStore.load(name).acp.agentSessionId`.
   - `protocolIds.recordId` is the same ACP session id. acpx's record id has no ACP equivalent; see §11.
   - `opts.onSessionEstablished(protocolIds, name)` is called.
5. **Capture the session-scoped callbacks** for the life of the session: `opts.onActiveCall`, `opts.onStreamActivity` and the run identifiers the stream needs (§6.2.1). These are `OpenSessionOpts` fields, not `SendTurnOpts` fields.

**Crash-leftover policy (parity with acpx `sessions ensure`).**
- A transcript document exists for `name` only when an earlier process died without closing the session (closing deletes it, below).
- If one exists and its `backend`, `agent` and `cwd` match, it is passed as `resume`. That is acpx's `loadSession` of a still-open named session.
- On a mismatch, a corrupt record, `AGENT_SESSION_BACKEND_MISMATCH`, `AGENT_SESSION_INVALID_OPTIONS` or `AGENT_SESSION_NOT_FOUND`, the document is deleted and the session opens fresh. A swap to a fallback agent under the same name (nax#1722) therefore opens fresh, as acpx does.

**`closeSession(handle)`:**
1. Abort any in-flight turn controller.
2. Call `opened.close()`, bounded by `trackedSpawnDeadlineMs`. Past the deadline, the process group is killed.
3. Flush the tool-audit sink.
4. Delete the transcript document.
5. Drop the live entry.

**`closePhysicalSession(handleId, workdir, { force, signal })`:** closes the live entry for that handle, with `force` skipping the cancel grace. An unknown handle is a no-op with a debug log. The adapter never spawns a backend just to close one. The acpx path needed a fresh client to close a session by name; the new transport has no out-of-process session to reach (§11).

### 6.2 `sendTurn(handle, prompt, opts)` (`turn-loop.ts`)

The loop is the `adapter-send-turn.ts` loop with the transport swapped. Concretely:

1. Assert no turn is in flight on this handle; a second concurrent turn throws.
2. Start one `createTurnDeadline(timeoutSeconds)` spanning the whole loop, as today. On expiry, the loop aborts the current backend turn with a typed `TimedOut` reason and **returns** `TurnResult{ timedOut: true, output: "" }` with the spend so far, as `adapter-output.ts:280-` does. `operations/turn-failure-classification.ts:36` keeps classifying from that.
3. For each iteration (bounded by the shared `turnCount < maxInteractions`, counting the first prompt, as today):
   1. Create a per-iteration `AbortController` linked to `opts.signal` and the deadline. Register `onActiveCall(callId, cancel)`, where `cancel` aborts with a fresh `WatchdogCancel` reason. Each cancel uses a new reason object, because `attachTurnSpend` mutates the reason.
   2. Set the current-turn slot: signal, turnId, interaction handler, budget.
   3. Call `opened.adapter.sendTurn(opened.handle, currentPrompt, { ...opened.turnOpts(), signal, turnId, onTurnEvent: bridge.sink })`.
   4. On success: accumulate usage and spend.
      - `extractContextToolCall(output)` routes through `interactionHandler.onInteraction({ kind: "context-tool" })`, with the 5-minute race and error shaping, and the next prompt is the `<nax_tool_result>` block.
      - Otherwise `extractQuestion(output)` (only on `end_turn`) routes through `onInteraction({ kind: "question" })`, with the human-reply timeout, and the next prompt is the reply, recorded in `TurnResult.interactions`.
      - Otherwise the loop ends.
   5. On failure, in order:
      - **Mid-turn NO_SESSION recovery (kept):** if the backend throws `AGENT_SESSION_NOT_FOUND` from `sendTurn` (its reconnect could not restore the session), re-open fresh under the same name once and resend. The dead attempt is not counted, matching today's exit-code-4 recovery (`adapter-send-turn.ts:156-190`).
      - **`promptRetries`:** applied per §7.2.
      - **Anything else:** goes to `failure-map` (§7.1).
4. Return one `TurnResult` for the loop:
   - `output` from the last response
   - usage and cost summed across iterations
   - `internalRoundTrips` = the iteration count
   - `interactions`, `protocolIds`, `pricingSource`, `rates`
   - `exactCostUsd` when any iteration reported cost
   
   On failure, throw `SessionTurnError` (§7.1) carrying the spend summed across all iterations, including the failed one's spend from `readTurnSpend`. That preserves BUG-57's "burned tokens are recorded" contract.

#### 6.2.1 The watchdog event stream (`stream-bridge.ts`)

- The idle watchdog (`runtime/middleware/idle-watchdog/`) and `runtime/in-flight-usage.ts` consume `onStreamActivity`. They need the **same `AgentStreamEvent` sequence the acpx client emits today** (`spawn-client-session.ts:99-342`). That covers:
  - the call-start and call-end lifecycle events, with `callId`, `runId`, `agentName`, `sessionName`, `storyId` and `stage`; call-end is emitted exactly once on every terminal path
  - the process update carrying the pid
  - message, thinking, tool-call and usage updates, with `deltaBytes` computed by the bridge
- The backend's `text_delta`, `thinking_delta`, `tool_call`, `tool_result` and `usage` map onto these.
- **Known difference, checked in S4b-0:**
  - The backend emits `usage` only at turn end, and drops `in_progress` tool updates.
  - So a long-running tool produces no activity between call and result.
  - The S4b-0 check confirms the watchdog thresholds tolerate this. If they don't, the backend gains an additive tool-progress event (§8).
- While the loop or the ask port waits on a human, the bridge emits the same awaiting-human signal the acpx path emits, so the watchdog does not cancel a turn that is waiting on a person.

### 6.3 `ask-port.ts` (nax's `SessionAskPort`)

- `requestApproval`: a deny stub. Profile `ask` is never mapped (§6.4), so it is unreachable; the stub logs and denies.
- `recordAutoDecision(req, decision)`: when the decision is deny, it is written to tool audit as `denied`.
- `askQuestion(text, { signal })`: ACP elicitation. It routes to `interactionHandler.onInteraction({ kind: "question" })`, is counted against the same shared budget, and emits the awaiting-human signal. It returns `null` when there is no handler or the budget is spent. This is an extra way in, not a replacement for the loop's `extractQuestion`.
- `noteQuestion(text)`: logged at debug.

### 6.4 Profile mapping (`profile-map.ts`)

| `ResolvedPermissions.mode` | ACP profile | Today on acpx |
|---|---|---|
| `approve-all` (`unrestricted`, the default) | `full` | `--approve-all` |
| `approve-reads` (`safe`, `scoped`, unknown profile, fail closed) | `read` | no flag |
| `default` | `read` | no flag |

- **Sessions and one-shots both use this mapping.** acpx's `complete()` used `resolvedPermissions.mode` too (B3).
- **Close never opens a session** (§6.1), so the session-close permission mode no longer reaches this transport.
- **Non-Claude agents fail closed.** `read` and `none` work on Claude only. For any other agent the backend rejects the open with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`fail-adapter-error`, non-retriable), and the adapter never falls back to `full` (§11). The default profile maps to `full`, so the default path on every agent is unaffected.
- **S4b-0 check (e).** The "no flag" row assumes acpx without `--approve-all` denies writes in non-interactive mode. S4b-0 verifies that against acpx 0.19.4. If acpx allowed writes there, the mapping is revisited before S4b-2.
- **Native-only fields stay native-only.** `toolGrants`, `denyRules`, `askRules` and `bashApproval` are ignored on this path, as acpx ignores them.

### 6.5 Context-pull tools (B5)

- **Unchanged from today.**
  - The preamble comes from `buildContextToolPreamble`, applied by `agents/tool-preamble.ts` to every non-native agent.
  - The agent replies with a `<nax_tool_call>` block, which `extractContextToolCall` parses.
  - Dispatch goes through `interactionHandler.onInteraction({ kind: "context-tool" })` (`run-interaction-handler.ts`), and the result returns as a `<nax_tool_result>` block in the next prompt.
  - The budget is the shared `turnCount`.
- No session registers MCP tools, so the backend's tools capability check never applies.

### 6.6 `complete(prompt, opts)` (`complete.ts`)

1. Open a throwaway backend:
   - profile from §6.4
   - `tools: []`
   - `createMemoryTranscriptStore()`
   - workdir: the run's workdir
   - env, model and effort as §6.1
   - the startup deadline as §7.2
2. Send one prompt through the same `stream-bridge`, bounded by `opts.timeoutMs` (default 120 s, as today).
   - **Timeout:** abort, close, and throw `NaxError("AGENT_TIMEOUT")`, the same error current callers handle.
   - **Cancelled:** return `cancelled: true` with the burned tokens priced, as today.
3. Close in `finally`. The backend kills the process group.
4. Return `CompleteResult` with:
   - `output`, `tokenUsage`, `estimatedCostUsd`
   - `exactCostUsd?`, `sessionId`, `pricingSource`
5. Errors:
   - Other failures are thrown as an `Error` carrying the pre-classified `adapterFailure` from `failure-map`.
   - `agents/complete-exception-classifier.ts` gains one branch that returns a pre-classified `adapterFailure` as is. Its message parsing stays for every other adapter.
   - `promptRetries` applies (§7.2).
6. Naming and options:
   - `opts.sessionName ?? computeAcpHandle(...)` names the call for logs.
   - `maxTokens` has no ACP equivalent and is ignored with a debug log, as on acpx today.

**Spawn cost.** Each call spawns the agent's ACP launcher and runs `initialize`, `session/new` and up to two `set_config_option` calls, where acpx spawned acpx plus the agent. The smoke records per-call latency (§9). A warm process or a concurrency cap is deferred (§3).

### 6.7 Model and effort

- The model spec string is parsed by the moved `agents/model-effort.ts`.
- `model` goes to `acpBackend({ model })`.
  - The backend requires an exact match with an offered config value (`open.ts`, `modelOptionId`).
  - S4b-0 check (g) confirms that nax's Claude model strings and tier defaults match the values `claude-agent-acp` offers. If they don't, a mapping table in `model-effort.ts` is added.
- The effort suffix goes to the new `effort` option (§8).
  - That option sets the thought-level config option, falling back to `EFFORT_OPTION_BY_AGENT`.
  - When the agent doesn't offer it, effort is skipped with a warning, as today.

### 6.8 `isInstalled()`

- It is true when `isAgentLaunchable(agent)` (§8) finds a launch candidate.
- The backend's candidate list includes the `npx` fallback. So with only `npx` present, `isInstalled()` is true and the first run downloads the launcher inside the startup deadline.
- To make that visible, the precheck logs a warning when only the `npx` candidate resolves (§11).
- `acpx` is no longer consulted.

## 7. Errors, retries, deadlines, pricing, audit

### 7.1 `failure-map.ts`

- **Policies unchanged.** The retry, swap and stale policies (`agents/manager.ts`, `agents/retry/hop-retry-policy.ts`, `agents/swap-decision.ts`) keep consuming `AdapterFailure`.
- **Error type.** The adapter throws `SessionTurnError` with:
  - `adapterFailure`
  - `cancelled` (so `session/watchdog-turn-classification.ts:36` still recognises a watchdog cancel)
  - `retryable`
  - the spend fields (`tokenUsage`, `estimatedCostUsd`, `exactCostUsd`, `pricingSource`)
- **Retriability keeps today's semantics:**
  - `retriable: turnError.retryable ?? false` (`build-hop-callback-dispatch.ts:64`)
  - a crash is non-retriable (`complete-exception-classifier.ts:58`)
  - `retryable` is true only where the table says so

| Backend signal | `outcome` | retryable | Today on acpx |
|---|---|---|---|
| abort with `WatchdogCancel` reason | `fail-stale`, `cancelled: true` | yes | watchdog cancel |
| abort from the run's `opts.signal` | `fail-aborted`, `cancelled: true` | no | abort |
| abort with an unknown or absent reason | `fail-aborted`, `cancelled: true` | no | n/a (fail safe) |
| deadline expiry | not thrown: returns `TurnResult{ timedOut: true }` (§6.2 step 2) | n/a | same |
| `AGENT_SESSION_AUTH_REQUIRED` | `fail-auth` | no | parsed `auth` |
| `AGENT_SESSION_RATE_LIMITED` (new, §8, only if S4b-0 finds a structured signal) | `fail-rate-limit` + `retryAfterSeconds` | yes | parsed `rate-limit` |
| `AGENT_SESSION_CAPABILITY_UNSUPPORTED` with `context.capability === "model"` | `fail-adapter-error` | no | parsed `model-not-available` |
| `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (other, for example `read` on codex) | `fail-adapter-error` | no | none (new, fail closed) |
| `AGENT_SESSION_BACKEND_UNAVAILABLE` (spawn, initialize or an open-phase RPC rejected or timed out) | `fail-adapter-error` | no | crash (non-retriable) |
| `ACP_STOP_CANCELLED` (agent cancelled on its own) | `fail-adapter-error` | no | none |
| `ACP_STOP_MAX_TOKENS`, `ACP_STOP_MAX_TURN_REQUESTS` | `fail-incomplete` | no | none |
| `ACP_STOP_REFUSAL` | `fail-quality` | no | none |
| `AGENT_SESSION_TURN_FAILED`; `AGENT_SESSION_CLOSED` after the backend's reconnect failed | `fail-adapter-error` | no | session error (acpx `retryable` was false unless acpx flagged it) |
| anything else | `fail-unknown` | no | none |

The cancel cause is set on the reason object by whoever aborts, and is never inferred from a stop reason. The plan's parity tests take each "Today" cell from the acpx unit suite, so any row that turns out to differ is caught before deletion.

### 7.2 Kept running logic (B7)

| Key (unchanged schema and default) | Behaviour | New transport |
|---|---|---|
| `agent.acp.trackedSpawnStartupDeadlineMs` (30 s) | bounds session startup (#1583) | `acpBackend({ initializeTimeoutMs })`. It bounds each open-phase request: initialize, session/new or resume/load, and set_config_option for model and effort. |
| `agent.acp.trackedSpawnDeadlineMs` (10 s) | bounds teardown so a wedged agent cannot hang the run (PERF-1) | `acpBackend({ cancelGraceMs })` and the bound on `opened.close()`. Never reused for startup (#1583). |
| `agent.acp.promptRetries` (0, opt-in) | retry a prompt that failed on a transient fault | in `turn-loop` and `complete.ts`: up to N retries with jittered backoff. It applies **only when the failed attempt produced no visible output and no tool call**, meaning no `text_delta` and no `tool_call` (thinking alone does not count). It applies only to the fault classes acpx 0.19.4 retries under `--prompt-retries` (S4b-0 check (b)). The retry resends on the same session, and a retried attempt is not counted as a turn. |

`config/tracked-spawn-deadlines.ts` and the `promptRetries` resolution (`agents/manager-dispatch.ts:384`) stay as they are. Only acpx wording in the schema comments is updated.

### 7.3 Pricing (`pricing.ts`)

- `resolveRateCard(modelId)` (`agents/cost/rate-card.ts:123`) runs once at open and once per `complete()`, as today.
- `estimatedCostUsd` is always tokens x the rate card. `pricingSource` and `rates` are stamped with `catalog-rates | config-override | fallback-rates`.
- `exactCostUsd` is the backend's `estimatedCostUsd` when that turn's `costSource` is `"reported"` (Claude). It is absent when `"unpriced"`.
- No new cost fields. The cost ledger and `metrics.json` are unchanged.

### 7.4 Tool audit

- **Where the inputs come from.**
  - The adapter cannot build the ledger location itself: `toolAuditDir` and the ledger header (runId, featureName, storyId, sessionRole) are resolved in `coding-tool-support-resolve.ts:~208-232`, and the adapter may not read config.
  - So nax-agent 0.3.x adds an optional `OpenSessionOpts.toolAudit?: { dir: string; header: ToolAuditHeader }` (§8).
  - `SessionManager` fills it from the same resolution native uses.
- **How records are written.**
  - `stream-bridge` writes through `createToolAuditSink({ dir, sessionName, header })`, schema version 1.
  - It pairs `tool_call` with `tool_result` by `callId` into one `ToolCallRecord`:
    - `tool`
    - `input`, already redacted and capped at 8 KiB by the backend
    - `outcome`: `ok`, `error` (from `isError`), or `denied` / `denied:ask` (from the ask port's decisions)
    - `storyId`, `at`
    - `resultBytes`, from the new `tool_result` size field (§8; the event has none today, `turn-event.ts:29`)
- **Flush and scope.** The sink is flushed on close. This is new for the ACP path, which had no audit under acpx (§11).

## 8. Package changes (additive, B4)

Shipped in S4b-0, in one release with the unreleased 0.3.1 fix bundle (#2373). Order: nax-agent -> nax-agent-acp -> nax. Each release needs approval.

| Package | Change |
|---|---|
| `@nathapp/nax-agent` 0.3.x | `OpenSessionOpts.toolAudit?: { dir; header }` (§7.4). |
| | `AGENT_SESSION_RATE_LIMITED` in the error-code union with optional `retryAfterSeconds`, **only if** S4b-0 check (a) finds a structured rate-limit signal. |
| `@nathapp/nax-agent-acp` 0.3.x | `effort?: string`: after `session/new` or resume, set the agent's thought-level config option (category `thought_level`, else the per-agent fallback name). Skipped with a warning when it is not offered. |
| | `onProcess?: { spawned(pid); exited(pid) }`, called for every agent process, including after a reconnect. |
| | `resultBytes` on the `tool_result` event: the true size before the preview cap. |
| | `isAgentLaunchable(agent, env?)` and `launchCandidateKind(agent, env?)` from `./client`. Both wrap the existing `launch.ts` candidate resolution and report whether a candidate is the `npx` fallback. |
| | The rate-limit classification from **structured** error data only (`RequestError.data` with HTTP status 429, a `rate_limit_error` type or a `retry_after` field), only if check (a) finds such a shape. |
| | A tool-progress event, only if S4b-0 check (f) finds the watchdog needs one. |

**nax's dependency on nax-agent-acp.**
- nax adds `@nathapp/nax-agent-acp: workspace:*`, carried the same way as `@nathapp/nax-agent`, which is bundled into `dist/nax.js`.
- `scripts/lib/agent-bundling.ts` and `scripts/check-bundle-externals.ts` (invariant 4) add `@agentclientprotocol/sdk`, plus zod if it isn't already listed.
- `packages/nax/scripts/check-package-boundaries.ts` flips its "no nax-agent-acp import" rule (`:138`). nax may reach the package only through `@nathapp/nax-agent-acp/client`.
- `.nax/context.md` drops "No package imports nax-agent-acp until S4b", followed by `nax generate`.

## 9. Testing

- **Unit tests, one per new unit** (`check:test-satellites`):
  - `profile-map`
  - `failure-map`: every §7.1 row
  - `pricing`
  - `stream-bridge`: event mapping, exactly-once call-end, `deltaBytes`, audit pairing, side-effect tracking
  - `ask-port`
  - `entries`
- **Adapter tests**, against `nax-agent-acp`'s fake ACP agent over real pipes:
  - open, including the cwd precheck and the crash-leftover resume and discard cases
  - close-means-fresh, including the timeout-retry fresh-session case
  - turn loop: question and context-tool interactions, the shared budget, the deadline returning `timedOut`
  - mid-turn NOT_FOUND recovery
  - watchdog cancel -> `fail-stale` + `cancelled`; run abort -> `fail-aborted`
  - spend on a failed turn
  - `promptRetries`: retries before output, no retry after a `tool_call`
  - startup and teardown deadlines
  - `complete()`: success, timeout, cancel with priced tokens, pre-classified failure
  - PID callbacks, including after a reconnect
  - env allowlist
- **Parity tests:**
  - The behaviour cases of `test/unit/agents/acp/*` that encode nax logic are re-expressed against the new adapter:
    - the loop, interactions and budget
    - NO_SESSION recovery
    - the deadline
    - rate-card pricing
    - reasoning effort
    - error classification and retriability
    - session naming
  - Plumbing cases (argv, the line parser, `sessions ensure`) are deleted in S4b-5.
  - The acpx-referencing integration tests (`stale-retry-session-reuse`, `fail-stale-watchdog`, `timeout-retry-fresh-session`, `cli-core-agents`) run against both transports while the key exists, then against the new one only.
- **Package tests:** each §8 addition has tests in its package, and the API snapshots are updated.
- **Build:** `bun run build` plus a dist smoke (the bundled CLI starts and lists agents) in S4b-2's done criteria.
- **Billed Claude smoke (approval at launch):**
  - Setup: the S1 recipe on a fixture copy, with `agent.default: claude`, `agent.acp.transport: "sdk"` and no `acpx` on PATH.
  - Pass when:
    - the stories complete
    - cost ledger rows carry `estimatedCostUsd` and `exactCostUsd`
    - tool audit has ACP rows
    - no agent process is left after the run
  - Also record per-call `complete()` latency.

## 10. Delivery

Each slice is one PR that leaves main green. Check gates that every slice must keep green include `check:all`, `typecheck`, `check:test-satellites`, `check:nax-error`, `check:alias-internals`, `check:import-cycles`, `check:dispatch-field-forwarding`, the file-size gate and the complexity ratchet.

| Slice | Content | Done when |
|---|---|---|
| S4b-0 | **First, read-only verification**, recorded in the plan: (a) the rate-limit error shape `claude-agent-acp` sends; (b) the fault classes acpx 0.19.4 retries under `--prompt-retries`; (e) acpx's write behaviour without `--approve-all`; (f) whether the idle-watchdog thresholds tolerate no activity during a long tool call; (g) nax's Claude model strings against the values `claude-agent-acp` offers. **Then** the §8 package additions, and the release of nax-agent and nax-agent-acp 0.3.x with the 0.3.1 fixes. | Findings recorded; package gates green; API snapshots updated; release approved and published. |
| S4b-1 | §5.2 moves: shared nax logic out of `agents/acp/`, no behaviour change. | nax suite, `typecheck` and `check:all` green; the acpx transport behaves the same. |
| S4b-2 | nax's dependency on nax-agent-acp, the bundling and boundary changes (§8); the `agent.acp.transport` schema, its `config-descriptions` entry and `nax config` display; registry routing; `cli/agents.ts` and `bakeoff/preflight.ts` via the registry; `check-adapter-no-config-import.sh` scans `agents/acp-sdk/`; the adapter's open, close, turn loop, stream bridge, ask port, profile map and pricing; `SessionManager` filling `toolAudit`. | unit and adapter tests green behind the key; default still `acpx`; `bun run build` plus dist smoke green. |
| S4b-3 | `complete()` and the classifier branch, `failure-map` in full, `promptRetries`, deadlines, tool audit, effort, PID callbacks, the `npx`-only precheck warning; the parity tests; integration tests on both transports. | the full §9 adapter, parity and integration suites green. |
| S4b-4 | Billed Claude smoke on `sdk` (approval at launch); then flip the default to `sdk`. No release. | smoke passed; suite green with the new default. |
| S4b-5 | Delete `agents/acp/`; rename `acp-sdk/` -> `acp/`; delete the transport key, the `ACPX_` env prefix, the acpx re-exports in `agents/index.ts` and the acpx-only `parseAgentError` branches; delete the plumbing tests; re-point `check-adapter-no-config-import.sh`; update the docs (install: the per-agent ACP launcher replaces `acpx`); release nax (approval). | suite, `typecheck` and `check:all` green; `grep -rn acpx packages/nax/src` returns nothing outside historical comments; release published. |

## 11. Behaviour changes (explicit)

1. **`read` on a non-Claude agent fails closed** with `CAPABILITY_UNSUPPORTED`, where acpx ran with no flag. This lasts until #2372. The default profile (`full`) is unaffected.
2. **`aider`** has no ACP registry entry. On the new transport it fails at open with a clear error. Today it falls to `DEFAULT_ENTRY` (binary `claude`) and acpx.
3. **`protocolIds.recordId`** equals the ACP session id. acpx's separate record id has no ACP equivalent. Its consumers (`runtime/prompt-auditor.ts`, `middleware/review-audit.ts`) see the session id in that field.
4. **Tool audit gains ACP rows**, which acpx never produced.
5. **Questions may also arrive through ACP elicitation**, routed to the same handler and budget.
6. **`closePhysicalSession` for a handle this adapter instance never opened is a no-op.** acpx could close a named session from a fresh client.
7. **`acpx` is no longer required on PATH.** Each agent's ACP launcher is required instead (S4 §6.10). With only `npx` available, the first run downloads the launcher inside the startup deadline, and the precheck warns.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Claude sends no structured rate-limit signal | S4b-0 (a). Fallback: `TURN_FAILED` maps to `fail-adapter-error`, recorded as a known limitation; no new code is added |
| The watchdog cancels a long tool call for lack of activity | S4b-0 (f); an additive tool-progress event if needed |
| Model string mismatch fails every open | S4b-0 (g); a mapping table in `model-effort.ts` |
| Spawn latency or process count of throwaway `complete()` calls | Parity with acpx's throwaway one-shots; latency measured in the smoke; warm process and cap deferred |
| Parity gaps hidden by the rewrite | §9 parity tests taken from the acpx suite, and integration tests on both transports, before the flip |
| `promptRetries` repeating side effects | Retry only before any visible output or tool call (§7.2) |
| Orphaned agent processes | `onProcess` feeds crash-signal cleanup; teardown bounded by `trackedSpawnDeadlineMs`; the smoke checks for orphans |
| A crash-leftover transcript resumes stale context | Resume only on an exact backend, agent and cwd match; otherwise discard (§6.1) |

## 13. Handoff

- **MCP context-pull tools.** These need pre-approval (or an equivalent) for non-Claude agents in `nax-agent-acp`, a per-agent preamble choice so an agent never sees two protocols, and a defined budget for MCP calls.
- **#2372** lifts the fail-closed rule in §6.4 for codex and opencode.
- **A warm multi-session process and an agent-process cap for `complete()`,** if the smoke shows latency or process count matters.
- **Moving nax onto the S3 facade** remains D24's unscheduled item.
