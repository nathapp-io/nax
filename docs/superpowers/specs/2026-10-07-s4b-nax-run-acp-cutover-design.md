# S4b: `nax run` ACP cutover (acpx CLI -> `@nathapp/nax-agent-acp`)

**Status:** design approved section by section in brainstorm 2026-10-07. Not yet final-reviewed.

**Master plan:** `nax-agent-master-plan.md` (maintainer workspace), row S4b; decisions D11, D24, D25.

**Predecessor:** S4 spec `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`, §13 "Handoff to S4b".

**Baseline:** main `d2e88ab27`, `@nathapp/nax-agent` 0.3.0 + unreleased 0.3.1 fixes (#2373), `@nathapp/nax-agent-acp` 0.3.0 + the same unreleased fixes, nax 0.83.4.

## 1. Goal

`nax run` stops driving external coding agents (claude, codex, opencode, gemini, pi) through the `acpx` CLI wrapper in `packages/nax/src/agents/acp/` and drives them through `acpBackend()` from `@nathapp/nax-agent-acp`. Afterwards the wrapper and the `acpx` PATH dependency are deleted.

**The governing rule (user ruling, 2026-10-07): S4b replaces the acpx transport, not the logic inside nax.** Every behaviour nax has today on the ACP path (session naming and reuse, question handling, context-pull tools and their budget, prompt retries, startup and teardown deadlines, rate-card pricing, error classification, retry/swap/stale policy) is kept and re-wired onto the new transport with the same config and semantics. Only acpx plumbing is replaced: argv building, the stdout JSON-line parser, acpx stderr parsing, `sessions ensure|close|stop`, `cancel`, and process spawning. Where a behaviour changes, this spec says so explicitly (§11).

**Success:**
- `nax run` with `agent.default: claude` behaves the same or better on the new transport with no `acpx` installed, proven by a billed Claude smoke (approval at launch).
- Every merge leaves main green and releasable; no released nax version carries both transports by default (the old one exists only behind the transport key during development).

## 2. Context and decisions

### 2.1 What exists today

- **The acpx adapter** (`agents/acp/`, 23 files, ~4,300 lines, 26 unit test files) implements `AgentAdapter` (`agents/types.ts:536`), which extends the S1 `AgentSessionAdapter` owned by nax-agent. It shells out to `acpx` for every prompt, session op and one-shot `complete()`.
- **The native adapter** (`agents/native-agent/index.ts`) drives nax-agent at the same S1 level (`openSession` / `sendTurn`), not through the S3 facade.
- **The ACP backend** (`packages/nax-agent-acp/src/client/`) is a `SessionBackend`: `open(ctx: BackendOpenContext)` returns an `OpenedBackend` whose `adapter` is an S1 `AgentSessionAdapter`. It spawns one agent process per session, supports profiles `none|read|ask|full` (`none`/`read` on Claude only until #2372), an HTTP MCP tool host for embedder tools, resume via `session/resume` or `session/load`, reconnect-once after a crash, and reports usage per turn with `costSource: "reported" | "unpriced"`.
- **The registry** (`agents/registry.ts`) returns `NativeAgentAdapter` for `native` and `AcpAgentAdapter(name)` for every other name. `agent.default` is `native`; the acpx path runs only when a user selects claude, codex and so on.

### 2.2 Decisions (brainstorm 2026-10-07)

| # | Decision |
|---|---|
| B1 | **Scope: Claude is the only agent with end-to-end proof.** codex, opencode, gemini and pi move to the new transport too, but get no billed smoke, and run under `full` only until #2372 lands (a `read` request on them fails closed, §6.4). |
| B2 | **Rollout: key, smoke, flip and delete, all inside S4b.** A transport key (`agent.acp.transport`, default `acpx`) exists only during development; the final slice flips to the new transport and deletes the old folder and the key. Rollback is a git revert or pinning the previous nax patch. |
| B3 | **One-shot `complete()` = a throwaway ACP session per call** (profile `none` on Claude; `full` with no tools on agents without `none`, §6.4), the same per-call spawn cost as acpx today. A warm multi-session process is a later optimisation, not S4b. |
| B4 | **Additive package changes are allowed** (`nax-agent` and `nax-agent-acp` 0.3.x, no breaking change): `effort`, `onProcess`, rate-limit classification, and a tool-result size field if needed (§8). |
| B5 | **Context-pull tools become MCP tools** through the backend's tool host, registered at open, replacing the `<nax_tool_call>` text protocol. Their call budget (`maxInteractions`) is kept (§6.5). |
| B6 | **nax stays on the S1 adapter (D24).** The new adapter calls `acpBackend(...).open(ctx)` itself and drives `OpenedBackend.adapter`, as native is driven today. It does not use `createAgentSession`; nax supplies its own `SessionAskPort` and transcript store. |
| B7 | **Transport, not logic** (§1 governing rule). `agent.acp.promptRetries`, `trackedSpawnDeadlineMs` and `trackedSpawnStartupDeadlineMs` are nax behaviour and are honoured on the new transport (§7.2). |

## 3. Out of scope

- Moving nax onto the S3 facade (D24: later, unscheduled).
- `none`/`read` for codex and opencode (#2372; may be folded in only if small).
- Billed smokes for any agent other than Claude.
- A warm multi-session agent process for `complete()`.
- Client fs/terminal handlers and a stdio MCP bridge (S4 §13 "Later").
- The ACP server wrapper (S5) and koda chat (S6).
- Any change to the retry, swap, stale, cost-ledger or metrics policies themselves.

## 4. Architecture

```
registry.ts ──(agent.acp.transport = "sdk")──► AcpSdkAgentAdapter (agents/acp-sdk/)
                                                    │ open-context ─► BackendOpenContext
                                                    │                 (profile-map, ask-port,
                                                    │                  pull-tools, transcript store)
                                                    ▼
                                    acpBackend({...}).open(ctx)  (@nathapp/nax-agent-acp/client)
                                                    │
                                    OpenedBackend.adapter.sendTurn(..., onTurnEvent)
                                                    │
                                    turn-collector ─► TurnResult, watchdog activity,
                                                      tool audit, pricing, failure-map
```

The folder is `agents/acp-sdk/` while both transports exist and is renamed to `agents/acp/` in the deletion slice.

## 5. Components

### 5.1 New: `packages/nax/src/agents/acp-sdk/`

| Unit | Job | Depends on |
|---|---|---|
| `adapter.ts` `AcpSdkAgentAdapter implements AgentAdapter` | `openSession` / `sendTurn` / `closeSession` / `closePhysicalSession` / `complete` / `isInstalled`. Thin: delegates to the units below, holds the physical-session map and the current-turn slot. | all below |
| `open-context.ts` | Builds `BackendOpenContext` from `OpenSessionOpts` (§6.1). | `profile-map`, `ask-port`, `pull-tools` |
| `profile-map.ts` | Pure: `ResolvedPermissions` + agent name -> `none \| read \| ask \| full` (§6.4). | none |
| `ask-port.ts` | nax's `SessionAskPort` (§6.3). | `InteractionHandler`, logger |
| `pull-tools.ts` | `ToolDescriptor[]` + current-turn `contextToolRuntime` -> `EmbedderTool[]`, with the per-turn budget (§6.5). | none |
| `turn-collector.ts` | Folds `onTurnEvent` events into a `TurnResult`; forwards activity to `onStreamActivity`; writes tool audit; tracks whether the turn has produced output or a tool call (for `promptRetries`). | `pricing` |
| `pricing.ts` | `estimatedCostUsd` from the rate card; `exactCostUsd` from reported cost (§7.3). | `agents/cost` |
| `failure-map.ts` | Pure: backend `NaxError` code / stop reason / cancel cause -> `AdapterFailure` (§7.1). | none |
| `complete.ts` | One-shot `complete()` (§6.6). | `turn-collector`, `failure-map` |
| `entries.ts` | Per-agent rows (display name, tiers, max context) carried from `agent-entries.ts`; exports the agent-name list that `cli/agents.ts` and `bakeoff/preflight.ts` use today via `ACP_ADAPTER_NAMES`. | none |

### 5.2 Moved, not rewritten (nax logic that lives in `agents/acp/` today)

These move out of `agents/acp/` before anything else changes (slice S4b-1), with their tests, and are imported from the new location by both transports:

| Symbol | From | To | Consumers outside `agents/acp/` |
|---|---|---|---|
| `computeAcpHandle` | `adapter-lifecycle.ts:146` | `agents/session-naming.ts` | `operations/call-dispatch-complete.ts:95`, `agents/index.ts` |
| `extractQuestion` | `adapter-output.ts:28` | `agents/interaction/extract-question.ts` | both transports' question loop |
| `buildContextToolPreamble` | `adapter-output.ts:165` | `agents/tool-preamble.ts` (already its consumer) | `agents/tool-preamble.ts` |
| `parseAgentError`, `classifyParsedAgentError` | `parse-agent-error.ts` | `agents/errors/parse-agent-error.ts` | `agents/complete-exception-classifier.ts` (used for every adapter) |
| the `buildRunInteractionHandler` re-export | `adapter-output.ts:198` | removed; callers import `agents/run-interaction-handler.ts` directly | `runtime/session-run-hop.ts`, `operations/build-hop-callback-hop.ts` |

`extractContextToolCall` and the `<nax_tool_call>` loop are not moved: they are replaced by MCP tools (B5). `AcpInteractionBridge` (`interaction-bridge.ts`) has no production reference (tests only) and is deleted with the folder, not ported. In the deletion slice, the acpx-only branches of `parseAgentError` (bracketed `ACPX_*` codes and the flat acpx message) are removed; its structured JSON-field parsing stays.

### 5.3 Routing

`agents/registry.ts` (`adapterFor` and `createAgentRegistry.cachedAdapter`) returns `AcpSdkAgentAdapter(name)` when `agent.acp.transport === "sdk"`, otherwise the old `AcpAgentAdapter(name)`. `native` is unchanged. The `agent.protocol` gate (`config/schemas-protocol-gate.ts`) is unchanged.

## 6. Data flow

### 6.1 `openSession(name, opts)`

1. If the adapter already holds an open physical session for `name`, return its handle (keeps stale-retry session reuse, `test/integration/agents/stale-retry-session-reuse.test.ts`).
2. `open-context` builds `BackendOpenContext`:
   - `sessionId`: `name`; `workdir`: `opts.workdir`.
   - `profile`: `profile-map(opts.resolvedPermissions, agentName)` (§6.4).
   - `tools`: `pull-tools(opts)` when context-pull tools are known at open (§6.5), else `[]`.
   - `transcriptStore`: `createFileTranscriptStore` rooted at the project's artifact dir, `~/.nax/<project-name>/acp-sessions/<feature>/`, one document per `name`. It lives outside the repo, so a run's auto-commit can never pick it up. If a document exists for `name`, it is passed as `resume`.
   - `asks`: `ask-port` (§6.3). `turnSignal` / `currentTurnId`: read the adapter's current-turn slot.
   - `instructions`: `undefined` (nax puts everything in the prompt, as today). `turnTimeoutSeconds`: `opts.timeoutSeconds`. `metadata`: feature, story, role. `openSignal`: `opts.signal`.
3. `acpBackend({ agent, model, effort, env: opts.modelDef.env, inheritEnv, allowUnsandboxed: true, initializeTimeoutMs, cancelGraceMs, onProcess }).open(ctx)`:
   - `model` / `effort` from the parsed model spec (§6.7); `initializeTimeoutMs` / `cancelGraceMs` from §7.2.
   - `onProcess` feeds `opts.onPidSpawned` / `opts.onPidExited` (crash-signal cleanup).
   - **NO_SESSION recovery (kept):** if a resume fails with `AGENT_SESSION_NOT_FOUND`, the stale document is discarded and the open is retried once as a fresh session. This is today's exit-code-4 recovery (`adapter-send-turn.ts` `recoverNoSession`).
4. Call `opts.onSessionEstablished({ sessionId: <ACP session id> }, name)` and return the handle.

### 6.2 `sendTurn(handle, prompt, opts)`

1. Assert no turn is in flight on this session (nax already serialises turns per session; a second concurrent turn is a programming error and throws).
2. Create a per-turn `AbortController` linked to `opts.signal`; register `opts.onActiveCall(callId, cancel)`, where `cancel` marks the cause `watchdog` and aborts.
3. Set the current-turn slot: signal, turnId, `contextToolRuntime`, the pull-tool set offered this turn, the interaction handler.
4. `opened.adapter.sendTurn(opened.handle, prompt, { ...opened.turnOpts(), signal, turnId, onTurnEvent: collector.sink })`.
5. `turn-collector` mirrors events to `opts.onStreamActivity`, writes tool audit (§7.4), accumulates usage, and records whether any output or tool call has happened.
6. **Question loop (kept, unchanged):** if the turn output yields `extractQuestion(output)` and the interaction budget allows, call `interactionHandler.onInteraction({ kind: "question" })` with the human-response timeout, send the reply as the next turn on the same session, and record it in `TurnResult.interactions`. The loop is bounded by `maxInteractions` exactly as in `adapter-send-turn.ts` today. ACP elicitation (`askQuestion` through the ask port, §6.3) is an additional entry into the same handler, not a replacement.
7. Build the `TurnResult`, clear the slot, and map any error through `failure-map` (§7.1). `promptRetries` applies here (§7.2).

### 6.3 `ask-port.ts` (nax's `SessionAskPort`)

- `requestApproval(req)`: only reached under profile `ask`, which nax does not map to today (§6.4); routed to the interaction handler as an approval interaction; a timeout or missing handler denies (`decidedBy: "timeout"`).
- `recordAutoDecision(req, decision)`: logged at debug and written to tool audit as `denied` when the decision is deny.
- `askQuestion(text, { signal })`: routed to `interactionHandler.onInteraction({ kind: "question" })`, counted against the same `maxInteractions` budget; `null` when no handler is set or the budget is spent.
- `noteQuestion(text)`: logged at debug.

### 6.4 Profile mapping (`profile-map.ts`)

| `resolvePermissions().mode` (from `execution.permissionProfile`) | ACP profile | Today on acpx |
|---|---|---|
| `approve-all` (`unrestricted`, the default) | `full` | `--approve-all` |
| `approve-reads` (`safe`, `scoped`, unknown, fail closed) | `read` | no flag (writes denied) |
| session-close (`SESSION_CLOSE_PERMISSION_MODE`) | `read` | no flag |
| `complete()` one-shots | `none` | n/a (text only) |

`read` and `none` are supported on Claude only (S4 §6.4, 10-07 fix bundle). For any other agent the backend rejects the open with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`; the adapter does **not** silently fall back to `full` (§7.1, §11). For `complete()` on a non-Claude agent, `full` is used with no tools, because a one-shot sends no tool-using prompt; this is logged once per run.

`toolGrants`, `denyRules`, `askRules` and `bashApproval` are native-only today and stay native-only; acpx ignores them and so does the new transport.

### 6.5 Context-pull tools (`pull-tools.ts`)

- The catalogue is a fixed vocabulary (`query_neighbor`, `query_feature_context`, `query_scratch`; `context/engine/pull-tools.ts`), with a stage-dependent subset passed per turn as `contextPullTools`.
- At open, the adapter registers the subset known from `opts` (the hop that opens the session also sends its first turn) as `EmbedderTool`s: name, description and JSON schema from the `ToolDescriptor`; `approval: "never"`.
- Each tool's handler dispatches to the **current turn's** `contextToolRuntime.callTool`. A registered tool that the current turn did not offer returns `{ isError: true, content: "not available in this stage" }`. A tool a later turn offers that was not registered at open is not available to the agent; this is logged once per session.
- **Budget (kept):** calls per turn are counted against `maxInteractions`, the same bound the `<nax_tool_call>` loop has today; past it, the handler returns `{ isError: true, content: "context tool budget exhausted" }`.
- The plan's first task confirms whether the subset can differ between hops that share one physical session; if it can, the registered set is the union of the vocabulary entries the session's role can ever receive, with the per-turn gate above.

### 6.6 `complete(prompt, opts)` (`complete.ts`)

1. Open a throwaway backend: profile `none` (Claude) or `full` with no tools (others, §6.4); `createMemoryTranscriptStore()`; workdir = the run's workdir; model and effort from `opts.modelDef`.
2. Send one turn bounded by `opts.timeoutMs` (default 120 s, as today). On timeout: abort, close, throw `NaxError("AGENT_TIMEOUT")`, the same error current callers handle.
3. Close in `finally`; the backend kills the process group, so a failed call leaves no process behind.
4. Return `CompleteResult` with `output`, `tokenUsage`, `estimatedCostUsd`, `exactCostUsd?`, `sessionId`, `pricingSource`. A cancelled call returns the tokens it burned, priced, as today.
5. `opts.sessionName ?? computeAcpHandle(...)` names the call in logs only. `maxTokens` has no ACP equivalent and is ignored with a debug log, as on acpx today. `promptRetries` applies (§7.2).

### 6.7 Model and effort

The model spec string is parsed as today (`spawn-client.ts:76-83` logic, moved with the adapter): `model` goes to `acpBackend({ model })`; the effort suffix goes to the new `effort` option (§8), which sets the agent's thought-level config option, falling back to the per-agent names in `EFFORT_OPTION_BY_AGENT` (`codex: reasoning_effort`, `claude`/`opencode: effort`, `pi: thought_level`). If the agent offers no such option, effort is skipped with a warning, as today.

### 6.8 Close

- `closeSession(handle)`: logical close; the physical session stays for reuse (as today).
- `closePhysicalSession(name, workdir, { force, signal })`: `opened.close()` bounded by `trackedSpawnDeadlineMs` (§7.2); past it, or with `force`, the process group is killed. The transcript document is kept so a later run can resume.
- `isInstalled()`: true when one of the agent's registry launch candidates is found on PATH, using the same candidate resolution the backend uses at spawn (`launch.ts` `findExecutable` over the S4 §6.10 candidates, including the `npx` fallback). `acpx` is no longer consulted.

## 7. Errors, retries, deadlines, pricing, audit

### 7.1 `failure-map.ts`

The retry, swap and stale policies (`agents/manager.ts`, `agents/retry/hop-retry-policy.ts`, `agents/swap-decision.ts`) are unchanged; they keep consuming `AdapterFailure`.

| Backend signal | `outcome` | retriable | category | acpx equivalent |
|---|---|---|---|---|
| `AGENT_SESSION_AUTH_REQUIRED` | `fail-auth` | no | availability | parsed `auth` |
| `AGENT_SESSION_RATE_LIMITED` (new, §8) | `fail-rate-limit` + `retryAfterSeconds` | yes | availability | parsed `rate-limit` |
| `AGENT_SESSION_BACKEND_UNAVAILABLE` | `fail-service-down` | yes | availability | spawn failure |
| `AGENT_SESSION_CAPABILITY_UNSUPPORTED` | `fail-adapter-error` | no | quality | none (new, fail closed) |
| model rejected by `set_config_option` | `fail-adapter-error` | no | quality | parsed `model-not-available` |
| `ACP_STOP_CANCELLED`, cause `watchdog` | `fail-stale` | yes | as today | watchdog cancel |
| `ACP_STOP_CANCELLED`, cause run abort | `fail-aborted` | no | as today | abort |
| turn timeout | `fail-timeout` | yes | as today | timeout |
| `ACP_STOP_MAX_TOKENS`, `ACP_STOP_MAX_TURN_REQUESTS` | `fail-incomplete` | yes | quality | none |
| `ACP_STOP_REFUSAL` | `fail-quality` | no | quality | none |
| `AGENT_SESSION_TURN_FAILED`; `AGENT_SESSION_CLOSED` after the backend's reconnect-once failed | `fail-adapter-error` | yes (counts against `sessionErrorRetryableMaxRetries`) | as today | session error |
| anything else | `fail-unknown` | no | none | none |

The cancel cause is recorded by the adapter before it aborts (§6.2 step 2), never inferred from the stop reason.

### 7.2 Kept running logic (B7)

| Key (unchanged schema and default) | Behaviour | New transport |
|---|---|---|
| `agent.acp.trackedSpawnStartupDeadlineMs` (30 s) | bounds session startup (#1583) | `acpBackend({ initializeTimeoutMs })`: bounds each open-phase request (initialize, session/new or resume/load, set_config_option for model and effort) |
| `agent.acp.trackedSpawnDeadlineMs` (10 s) | bounds teardown so a wedged agent cannot hang the run (PERF-1) | `acpBackend({ cancelGraceMs })` and the bound on `opened.close()`; never reused for startup (#1583) |
| `agent.acp.promptRetries` (0, opt-in) | retry a prompt that failed on a transient fault | in the adapter: up to N retries with jittered backoff, **only when the failed attempt produced no output and no tool call** (from `turn-collector`), and only for the fault classes acpx's `--prompt-retries` retries; a retried attempt is not counted as a turn |

**Matching acpx's retry conditions.** The S4 research does not record which faults acpx 0.19.4 retries under `--prompt-retries` (its error data carries a `retryable` flag). The plan's first task reads the acpx 0.19.4 source and pins the set; the new transport retries exactly the equivalent backend outcomes. The expected set is transport or overload faults (`fail-service-down`, retriable `fail-adapter-error`); `fail-rate-limit` is included only if acpx retries rate limits too. The "no output, no tool call" guard is kept regardless, because a retry must never repeat side effects.

`config/tracked-spawn-deadlines.ts` and `AgentCompleteOptions.promptRetries` resolution stay as they are; only acpx wording in schema comments is updated.

### 7.3 Pricing (`pricing.ts`)

- `resolveRateCard(modelId)` (`agents/cost`) once at open and once per `complete()`, as today.
- `estimatedCostUsd` = tokens x the rate card, always; `pricingSource` and `rates` stamped (`catalog-rates | config-override | fallback-rates`).
- `exactCostUsd` = the backend's reported cost when the usage row has `costSource: "reported"` (Claude); absent when `unpriced`.
- No new cost fields; the cost ledger and `metrics.json` are unchanged.

### 7.4 Tool audit

`turn-collector` writes through `createToolAuditSink` into the same `toolAuditDir`, header and schema version 1 as native. It pairs `tool_call` with `tool_result` by `toolCallId` into one `ToolCallRecord`: `tool`; `input` (already redacted and capped at 8 KiB by the backend); `outcome` `ok | error | denied`; `approval` for ask decisions; `storyId`; `at`; `resultBytes` from the event's size field (§8) or, if the backend has none and the field is not added, the preview length with a `reason: "preview-bytes"` marker. Calls to nax's MCP pull tools are audited too. This is new for the ACP path (acpx had no audit).

## 8. Package changes (additive, B4)

Shipped in one release before nax depends on them, together with the unreleased 0.3.1 fix bundle (#2373). Order: nax-agent -> nax-agent-acp -> nax. Each release needs approval.

| Package | Change |
|---|---|
| `@nathapp/nax-agent` 0.3.x | `AGENT_SESSION_RATE_LIMITED` in the error-code union, with optional `retryAfterSeconds` in error context. |
| `@nathapp/nax-agent-acp` 0.3.x | `effort?: string` option: after `session/new` / resume, set the agent's thought-level config option (category `thought_level`, else the per-agent fallback name); skipped with a logged warning when not offered. |
| | `onProcess?: { spawned(pid), exited(pid) }` option, called for the agent process. |
| | Rate-limit classification from **structured** error data only (`RequestError.data` with HTTP status 429, a `rate_limit_error` type, or a `retry_after` field) -> `AGENT_SESSION_RATE_LIMITED`. No free-text matching. The plan's first task reads the `claude-agent-acp` source for the shape it actually sends; if it sends none, rate limits stay `TURN_FAILED` (retriable `fail-adapter-error`) and this is recorded as a known limitation (§12). |
| | A `resultBytes` (true size before the preview cap) on `tool_result`, only if the event lacks one today. |
| | `isAgentLaunchable(agent, env?)` from `./client`: true when a registry launch candidate resolves on PATH (wraps the existing `launch.ts` resolution), so nax's `isInstalled()` never duplicates the candidate list. |

**nax's dependency on nax-agent-acp.** nax adds `@nathapp/nax-agent-acp: workspace:*` the same way it carries `@nathapp/nax-agent` (bundled into `dist/nax.js`; `dependencies` gains only what the bundle cannot inline, which the plan checks for `@agentclientprotocol/sdk`). `scripts/check-package-boundaries.ts` gains the rule that `packages/nax` reaches nax-agent-acp only through `@nathapp/nax-agent-acp/client`, and `.nax/context.md` drops "No package imports nax-agent-acp until S4b" (then `nax generate`).

## 9. Testing

- **Unit, per pure unit:** `profile-map`, `failure-map`, `pull-tools` (dispatch, stage gate, budget), `pricing`, `turn-collector` (folding, activity, audit pairing, side-effect tracking), `ask-port`.
- **Adapter, against `nax-agent-acp`'s fake ACP agent over real pipes:** open, resume, NOT_FOUND recovery, session reuse, turns, question loop, pull-tool calls, watchdog cancel -> `fail-stale`, run abort -> `fail-aborted`, `promptRetries` (retries before output; no retry after a tool call), startup and teardown deadlines, `complete()` (success, timeout, cancel with priced tokens), PID callbacks.
- **Parity:** the behaviour cases of `test/unit/agents/acp/*` that encode nax logic (question loop, pull-tool budget, NO_SESSION recovery, rate-card pricing, reasoning effort, error classification, session naming) are re-expressed against the new adapter, so "same logic" is tested, not assumed. Cases that test acpx plumbing (argv, line parser, `sessions ensure`) are deleted with the folder.
- **Package:** each §8 addition has tests in its package, with the existing API snapshot updated.
- **Billed Claude smoke (approval at launch):** the S1 recipe on a fixture copy with `agent.default: claude`, `agent.acp.transport: "sdk"`, and no `acpx` on PATH. Pass = stories complete, cost ledger rows carry `estimatedCostUsd` and `exactCostUsd`, tool audit has ACP rows, no orphaned agent process after the run.

## 10. Delivery

Each slice is one PR that leaves main green.

| Slice | Content | Done when |
|---|---|---|
| S4b-0 | Read-only verification first, results recorded in the plan: (a) the rate-limit error shape `claude-agent-acp` sends (§8); (b) the fault classes acpx 0.19.4 retries under `--prompt-retries` (§7.2); (c) whether the pull-tool subset can differ between hops sharing one physical session (§6.5); (d) whether `tool_result` already carries a true size (§7.4). Then the §8 package additions; release nax-agent and nax-agent-acp 0.3.x with the 0.3.1 fixes. | package gates green; API snapshots updated; release approved and published. |
| S4b-1 | §5.2 moves: shared nax logic out of `agents/acp/`, no behaviour change. | nax suite, `typecheck`, `check:all` green; old transport untouched in behaviour. |
| S4b-2 | nax's dependency on nax-agent-acp and the boundary rule (§8); `agents/acp-sdk/` adapter: open, resume, turns, question loop, pull tools, pricing, profile map, ask port; `agent.acp.transport` key and registry routing. | unit + adapter tests green behind the key; default still `acpx`. |
| S4b-3 | `complete()`, watchdog and PIDs, `failure-map`, `promptRetries`, deadlines, tool audit, effort. | full §9 adapter and parity tests green. |
| S4b-4 | Billed Claude smoke on `sdk`; then flip the default, delete `agents/acp/`, rename `acp-sdk/` -> `acp/`, delete the transport key, the `ACPX_` env prefix, acpx-only `parseAgentError` branches; re-point `scripts/check-adapter-no-config-import.sh` at the new folder; update docs; release nax (approval). | smoke passed; nax suite, `typecheck`, `check:all` green; `grep -r acpx packages/nax/src` returns only historical comments or nothing. |

## 11. Behaviour changes (explicit)

1. **Context-pull tools** are called as MCP tools instead of `<nax_tool_call>` text blocks (B5); the vocabulary, handlers and budget are unchanged.
2. **`read` on a non-Claude agent fails closed** with `CAPABILITY_UNSUPPORTED` instead of acpx's "no flag" behaviour, until #2372.
3. **Tool audit gains ACP rows** (acpx had none).
4. **Questions** may also arrive through ACP elicitation, routed to the same handler and budget.
5. **`acpx` is no longer required** on PATH; the ACP launcher per agent is (S4 §6.10).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Claude sends no structured rate-limit signal | §8 first task reads the adapter source; fallback = retriable `fail-adapter-error`, recorded as a known limitation |
| Pull-tool subset differs between hops sharing a session | §6.5: register the role's possible vocabulary, gate per turn |
| Spawn latency of throwaway `complete()` sessions | parity with acpx today; measured in the smoke; warm process deferred (B3) |
| Parity gaps hidden by the rewrite | §9 parity tests from the existing acpx unit suite before deletion |
| `promptRetries` repeating side effects | retry only before any output or tool call (§7.2) |
| Orphaned agent processes | `onProcess` feeds crash-signal cleanup; teardown bounded by `trackedSpawnDeadlineMs`; the smoke checks for orphans |

## 13. Handoff

- #2372 (`none`/`read` for codex and opencode) lifts the fail-closed rule in §6.4 for those agents.
- A warm multi-session process for `complete()` if the smoke shows spawn latency matters.
- Moving nax onto the S3 facade remains D24's unscheduled item.
