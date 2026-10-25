# SPEC: nax-chat-shell — `nax` / `nax chat` opens an interactive coding session over the native agent

## Summary

`nax` with no subcommand, and `nax chat`, open an interactive terminal session in the
current repository over one native `@nathapp/nax-agent` session. The session has two
permission modes, `full` (never asks) and `guarded` (the default; the existing guard
decides and the person answers its asks), set at launch with `--mode` and cycled
mid-session with Shift-Tab. Sessions live in the shared session store the ACP server
reads (the default sessions directory, or `NAX_AGENT_SESSIONS_DIR`), so koda lists and
resumes them when it uses the same directory, and the lock stops two front doors
driving one session. The session gets the repo's `.nax/rules` the way native `nax run`
does: a rules index in the system prompt, and each rule's text pushed on the first
touch of a file it covers (loop-handler role `tui`). An ask left unanswered in the
terminal is offered to the configured interaction chain (Telegram) after a configured
delay, and the first answer wins. Every model round writes a cost-ledger row with stage
`chat`. The ink shell shows the streamed transcript, an input box, the ask prompt and a
status line (model, mode, session id, spend, sandbox state), with slash commands for
help, mode, model, sessions, resume, clear, cost, feature and quit.

This is feature F3 of the nax interactive coding agent, slice 1
(`docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md`, §4.1 to
§4.3, §4.6, §5.1 row F3). It builds on F1 (`agent-session-modes`, #2691) and F2
(`shared-session-storage`, #2692). It changes `packages/nax-agent`,
`packages/nax-agent-acp` and `packages/nax`.

## Motivation

- **One agent for the whole loop.** The user's ruling (2026-10-24): nax becomes a
  full interactive coding agent, so brainstorming, spec-writing and spec-review stop
  needing Claude Code. Today nax has no interactive front door: every native session
  is a `nax run` story or the ACP server behind koda.
- **The session must know the repo's rules.** Claude Code pushes a path-scoped rule's
  full text the first time a matching file is read. nax's native rule delivery does
  the same (and refuses a Write once until the rules are shown), but `roleAllows` in
  `packages/nax/src/context/rules/rule-delivery/index.ts` only fires for workflow
  roles, and a facade session's `loopHandlerContext`
  (`packages/nax-agent/src/session/native-backend.ts`) carries no role at all.
- **koda must see the same sessions.** F2 moved the ACP session storage into
  `@nathapp/nax-agent` so a second host can write the metadata and take the lock.
  Nothing in `packages/nax` writes it yet.
- **"Always allow" must not fork.** The ACP server's per-session approval memory
  (`memoryKey` and `memoryApplies` in
  `packages/nax-agent-acp/src/server/permissions.ts`, hardened by nax#2553) is
  security-sensitive. `packages/nax` cannot import the ACP server
  (`check:package-boundaries`), and a second copy would drift. It moves into
  `@nathapp/nax-agent`, as F2 did for storage.

## Design

### Approach

1. **Loop-handler role (US-001).** `NativeBackendOptions` gains
   `loopHandlerRole?: string`. When set, `openNative` adds `role` to the
   `loopHandlerContext` it builds; when unset the context has no `role` key.
   `parseNativeBackendOptions` accepts it as a non-empty string. `"tui"` is a
   loop-handler and cost-ledger role only; it is not added to `KNOWN_SESSION_ROLES`
   (`src/runtime/session-role.ts`), because chat never dispatches through
   `SessionManager`.
2. **Approval memory in nax-agent (US-002, US-003).** New
   `packages/nax-agent/src/permissions/approval-memory.ts` exports
   `approvalMemoryKey(request)` and `approvalMemoryApplies(request, decision)`,
   carrying `memoryKey` and `memoryApplies` unchanged (same wrappers list, plain-word
   rule, mask marker and shell metacharacters) except that the execute-tool test is a
   local set `APPROVAL_EXECUTE_TOOLS` = `Bash`, `RunCommand`, `Git`, `GitCommit` (the
   tools the ACP `toolKind` maps to `"execute"`). Both take
   `ApprovalMemoryRequest = { readonly tool: string; readonly command?: string }`,
   which an `approval_requested` event satisfies, and are exported from the package
   entry. The ACP server's `permissions.ts` then calls them and deletes its copies
   (`memoryKey`, `memoryApplies`, `WRAPPERS`, `PLAIN_WORD`, `MASK_MARKER`,
   `SHELL_METACHARACTERS`); `toolKind` stays in the ACP server for display.
3. **Modes and the `tui` rule role (US-005).** `packages/nax/src/chat/chat-mode.ts`:

   | `ChatMode` | `profile` | `bashApproval` | `SessionMeta.mode` |
   |---|---|---|---|
   | `full` | `full` | `raw` | `full` |
   | `guarded` (default) | `ask` | `gated` | `ask` |

   `nextChatMode("guarded")` is `"full"` and `nextChatMode("full")` is `"guarded"`.
   `chatModeOfMeta(meta.mode)` maps `ask` to `guarded`, `full` to `full`, and `none`
   or `read` (sessions koda created) to `null`: such a session is refused, never
   widened. `RULE_READ_ROLES` and `RULE_WRITE_ROLES` gain `"tui"`.
4. **Opening a session (US-006).** `openChatSession(request, deps)` in
   `packages/nax/src/chat/open-chat-session.ts`. The request carries `storage`,
   `cwd`, `repoRoot`, `mode?`, `model?` (required for a new session, optional on a
   resume), `resumeId?`, `loopHandlers`, and `config` (the loaded `NaxConfig`). The same
   module exports `resolveChatSessionsDir(env)` (`env.NAX_AGENT_SESSIONS_DIR` when set,
   else `defaultSessionsDir(globalConfigDir())`) and
   `createChatStorage({ env, pid, now, logger })`, which returns
   `createSessionStorage({ dir: resolveChatSessionsDir(env), pid, now, logger })`;
   `chatCommand` builds the one storage the host and every open share. In order:
   1. Transcripts = `createFileTranscriptStore(storage.dir)`; `now` comes from
      `_openChatSessionDeps.now`.
   2. New session: id = `randomUUID()`, `acquireLock(id)`, then
      `writeMeta({ schemaVersion: 1, sessionId, cwd, mode, model, bashApproval, title: null, createdAt: now, updatedAt: null })`.
      Resume: `readMeta(id)` (null refuses `CHAT_SESSION_NOT_FOUND`;
      `SESSION_META_UNREADABLE` propagates), `chatModeOfMeta` (null refuses
      `CHAT_SESSION_MODE_UNSUPPORTED`), then `acquireLock(id)`. The request's `mode`
      and `model` override the stored ones only when the caller passes them (a
      switch); a plain resume uses the stored mode and model.
   3. Rules index: `resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir, overrideMode })`
      (from `config.context.rules`) mapped with `toRulesIndexEntry`; instructions =
      `buildChatInstructions({ mode, rulesIndex })`. The index lists repo-level rules;
      package-scoped rules are still delivered on demand by the handlers.
   4. Backend = `nativeBackend({ model, bashApproval, allowUnsandboxed: true, allowUnsandboxedCommands: true, carryHistoryAcrossModels: true, loopHandlers: request.loopHandlers, loopHandlerRole: "tui", catalogOverrides?, compaction? })`,
      where `catalogOverrides` is `config.agent.native.catalogOverrides` when
      non-empty and `compaction` is `config.execution.compaction` when set. Both modes
      set `allowUnsandboxed: true` (full runs unsandboxed when the sandbox is
      unavailable; guarded asks before every Bash command, so an unwrapped command is
      still asked) and `allowUnsandboxedCommands: true` (F1's per-command escalation).
   5. `transcripts.load(id)`: null -> `createAgentSession`, else
      `resumeAgentSession(id, options)`, with
      `{ backend, sessionId, profile, workdir: cwd, instructions, transcriptStore, approvalTimeoutMs: config.execution.approvalTimeout }`.
   6. If any step after `acquireLock` throws, the lock is released and the error
      rethrown.
   Returns `ChatSessionHandle = { session, meta, release }`. The instructions describe
   the mode only; the sandbox state (`session.backend.sandbox`) is shown by the shell.
5. **Prompt (US-004).** New `packages/nax/src/prompts/builders/chat-builder.ts`
   (Prompt Builder Convention), exported from `src/prompts`:
   - `buildChatInstructions({ mode, rulesIndex })` -> the system prompt: one intro
     paragraph (an interactive coding agent working in this repository with the
     person), a `## Permission mode` section (full: tools run without asking;
     guarded: edits, deletes, commits and every shell command are put to the person),
     a `## Commands outside the sandbox` section (set `unsandboxed: true` with an
     `unsandboxedReason` only when a command needs the network, the Docker socket, a
     local port or a device the sandbox blocks), and
     `buildRulesIndexSection({ entries: rulesIndex, shownAutomatically: true })`.
   - `buildChatFeatureMessage({ feature, spec, prd?, message })` -> the user message
     `/feature` sends: a `## Feature <name>` block with the spec text and, when `prd`
     is given, the PRD JSON, each in a fenced block, then the person's message (which
     may be empty).
6. **Asks (US-007).** `createChatAskController({ mode, answer })` in
   `packages/nax/src/chat/ask-controller.ts`; `answer` is a function the host points
   at the current session (it follows the session across a switch). Events:
   - `approval_requested` with `answerable: false`: ignored (never answered, never pending).
   - full mode: `answer(requestId, { decision: "allow" })` at once.
   - guarded mode: a remembered `allow` stored under `approvalMemoryKey(event)` answers
     at once when `approvalMemoryApplies(event, "allow")` holds and the event is not
     `unsandboxed`; otherwise the ask joins `pending()`. The person resolves it with
     `resolve(requestId, "allow_once" | "allow_session" | "deny")`. `allow_session`
     stores `allow` under the key only when `canRemember(event)`: the key is defined,
     the event is not `unsandboxed`, and the tool is not `Delete`; otherwise it
     answers allow once. `deny` is never remembered.
   - `question` with `answerable !== false` joins `pending()` in both modes and is
     resolved with `answerQuestion(requestId, text)`.
   - `approval_resolved` removes its request from `pending()`.
   - `setMode(mode)` changes the mode for later events; `reset()` clears the memory
     and `pending()`. The host keeps the memory across a mode or model switch (same
     session) and calls `reset()` on `/clear` and on a resume of another session.
   - `onChange(listener)` notifies the shell and the fallback.
7. **Interaction-chain fallback (US-008).** `createAskFallback({ controller, chain, delayMs, logger })`
   in `packages/nax/src/chat/ask-fallback.ts`, timers through
   `_askFallbackDeps.setTimeout` / `clearTimeout` (the `setTimeout` exception in
   `forbidden-patterns-source.md` applies: each handle is cleared when its ask leaves
   `pending()`; say so at the call site). For each pending approval (not questions) a
   timer of `delayMs` starts when it joins `pending()`. On expiry, when `chain` is
   non-null, it calls `chain.prompt(request)` with
   `{ id: "chat-<requestId>", type: "confirm", featureName: "chat", stage: "custom", summary, detail: "<command>\n<reason>", fallback: "skip", createdAt }`,
   where `command` is the event's `command` as the session sent it (already masked)
   and is omitted when absent. Response mapping, applied only while the ask is still
   in `pending()`: `approve` -> `allow_once`; `reject` or `abort` -> `deny`; any other
   action (`skip`, which a chain timeout or `cancel()` produces, `choose`, `input`) is
   ignored and the ask stays in the TUI. A response for an ask no longer in
   `pending()` is ignored. If the ask leaves `pending()` first, its timer is cleared,
   or, when the chain prompt is already out, `chain.cancel("chat-<requestId>")` is
   called once. A rejected `chain.prompt` logs warn `chat ask fallback failed` with
   `errorMessage(err)` only, and the ask stays in the TUI. `dispose()` clears every
   timer. `delayMs` is new config `interaction.defaults.chatAskFallbackMs` (int, 1000
   to 3600000, default 60000).
8. **Turns and cost (US-009).** `runChatTurn({ handle, storage, message, asks, ledger, onEvent, now })`
   in `packages/nax/src/chat/turn-runner.ts` iterates `session.send(message)`, passes
   `approval_requested`, `approval_resolved` and `question` events to `asks.handle`,
   every `usage` event to `ledger.record`, and every event to `onEvent`. After
   `turn_end` it calls `ledger.drain()` and writes the metadata with `updatedAt: now`,
   `costUsd: previous + turn_end.costUsd`, and, when `title` is null, `title` = the
   first message with whitespace collapsed, cut to 80 code points; it returns the
   written `SessionMeta`. When `session.send` throws before any event (for example a
   turn already running), the error is rethrown and neither the ledger nor the
   metadata is touched.
   `createChatLedger({ sessionId, projectKey, model, outputDir, startedAt })` in
   `packages/nax/src/chat/chat-ledger.ts` wraps a
   `CostAggregator(runId, join(outputDir, "cost"))` with
   `runId = "chat-<sessionId>-<startedAt epoch ms>"` (one file per process, since
   `drain()` rewrites its whole file and a resumed session must not overwrite an
   earlier process's rows). `record(event, previousAt)` maps a `usage` event to a
   `CostEvent`: `ts` (epoch ms of `event.at`), `runId`, `projectKey`,
   `schemaVersion: COST_ROW_SCHEMA_VERSION` (from `@/runtime/middleware`),
   `agentName: "native"`, `model`, `stage: "chat"`, `sessionRole: "tui"`, `turnId`,
   `durationMs` = `event.at` minus `previousAt` (the turn's `turn_start` or previous
   `usage` event) in ms, `tokens` (input, output, cacheRead, cacheWrite), `costUsd`,
   and `confidence: "exact"` with `exactCostUsd = costUsd`, `estimatedCostUsd: 0` when
   `costSource` is `computed`, `reported` or absent (absent means computed), else
   (`unpriced`) `confidence: "estimated"` with `estimatedCostUsd = costUsd`,
   `exactCostUsd: 0`. `projectKey` is `getProjectKey(config, repoRoot)`; `outputDir`
   is `projectOutputDir(projectKey, config.outputDir)`.
9. **The host (US-010 core, US-011 resume and switch).** `createChatHost(deps)` in
   `packages/nax/src/chat/chat-host.ts` is the composition root the shell drives.
   `deps`: `config`, `cwd`, `repoRoot`, `chain` (an `InteractionChain` or null),
   `open` (defaults to `openChatSession`), `storage`, `now`, `logger`. It creates one
   rule-delivery handler set (`createRuleDeliveryHandlers`) and one ledger per host
   and reuses them across reopens, one ask controller, and one fallback over the
   controller and `chain` with `config.interaction.defaults.chatAskFallbackMs`.
   Surface:

   ```typescript
   export interface ChatHost {
     readonly repoRoot: string;
     readonly models: readonly string[]; // models.native fast/balanced/powerful, deduplicated
     readonly asks: ChatAskController;
     current(): ChatHostState; // { sessionId, mode, model, meta, sandbox? }
     notice(): string | undefined;
     start(input: { mode: ChatMode; model: string }): Promise<void>;
     clear(): Promise<void>; // new session, same mode and model
     resume(input: { id?: string }): Promise<void>;
     send(message: string, onEvent: (event: SessionEvent) => void): Promise<void>;
     cancel(): void;
     switchTo(input: { mode?: ChatMode; model?: string }): Promise<void>;
     listSessions(): Promise<readonly ChatSessionRow[]>; // { sessionId, title, updatedAt, heldByPid? }
     close(): Promise<void>;
   }
   ```

   - `send` runs `runChatTurn` on the current handle and stores the returned meta, so
     `current().meta.costUsd` is the session spend.
   - `resume({})` walks `storage.list({ cwd })` in order and opens the first entry whose
     metadata reads, whose mode `chatModeOfMeta` accepts, and whose lock
     `readLockHolder` does not report `live`; none -> `CHAT_SESSION_NOT_FOUND` with
     message `no resumable session for <cwd>`. `resume({ id })` opens that id; when its
     `acquireLock` rejects with `SESSION_LOCKED`, the host reads
     `storage.readLockHolder(id)` and throws `CHAT_SESSION_LOCKED` with message
     `session <id> is in use by pid <pid>`.
   - After a resume whose `session.lastTurn?.status` is `interrupted`, `notice()` is
     `The last turn was interrupted. Send a message to continue it.`
   - `switchTo` between turns: `session.close()` (the lock is kept), then reopen the
     same id with the new settings, write the metadata's `mode`, `bashApproval` and
     `model`, and call `asks.setMode`. If the reopen throws, the old settings are
     reopened and the error is rethrown; the metadata keeps the old settings.
   - `listSessions` maps `storage.list({ cwd })` with `heldByPid` set when
     `readLockHolder` reports `live`.
   - `start`, `resume` and `clear` while a session is open open the new session first,
     then close the old one and release its lock; if the open fails, the old session
     stays open and current, and the error is rethrown. `clear()` and a resume of a
     different id call `asks.reset()`, so a remembered decision never crosses sessions.
     The fallback and the chain survive `clear` and `resume`.
   - `close()` is final: it disposes the fallback, closes the session, releases the
     lock and calls `chain.destroy()` when a chain is present.
   - `models` lists `models.native` `fast`, `balanced` and `powerful`, skipping absent
     tiers; a string entry is used as is, a `ModelDef` entry as `<provider>/<model>`.
10. **Shell (US-012, US-013, US-014).** `packages/nax/src/tui/chat/`, rendered with
    ink `render(..., { exitOnCtrlC: false })`:
    - `ChatApp.tsx` (root), `Transcript.tsx`: assistant text streamed from
      `text_delta`; one line per `tool_call`, `<tool> <detail>` where detail is
      `input.path` for Read, Write, Edit and Delete, `input.command` for Bash, and
      nothing otherwise, cut to 60 characters, marked `ok` or `error` by its
      `tool_result`; `thinking_delta` collapsed to one `thinking...` line.
    - `InputBox.tsx`: multi-line on `useInput`; Enter sends; Alt/Option-Enter inserts a
      newline. While a turn runs, Enter does not send and the text stays in the box.
    - `ChatStatusLine.tsx`:
      `<model> | <mode> | <session id first 8> | $<spend 2dp> | sandbox <on|off|unavailable>`;
      sandbox `available` -> `on`, `unavailable` -> `unavailable`, `disabled` or absent
      -> `off`.
    - Notices: the host's `notice()` after a resume; in full mode with the sandbox
      `unavailable`, `sandbox unavailable: commands run outside the sandbox` once at
      start and on each switch into full.
    - `AskPrompt.tsx` (US-013): tool, command, reason; an `unsandboxed` ask says
      `outside the sandbox`; keys `a` allow once, `s` allow for this session (shown
      only when `canRemember`), `d` deny; a question takes a typed answer submitted
      with Enter.
    - Keys (US-013): Shift-Tab cycles the mode (between turns at once; during a turn
      queued and applied after `turn_end`). Ctrl-C during a turn calls `host.cancel()`;
      a second Ctrl-C within 2 seconds, or one between turns, calls `host.close()` and
      exits.
    - `slash-commands.ts` (US-014): a line starting with `/` is a command, never a
      message. During a turn only `/quit` runs (it cancels the turn, then quits); any
      other command renders `wait for the turn to finish (Ctrl-C to interrupt)`.
    No new dependency: the input box is built on ink's `useInput`.
11. **CLI entry (US-015).** `registerChatCommand(program, deps)` in
    `packages/nax/src/cli/chat.ts` registers
    `program.command("chat", { isDefault: true })` with `--resume [id]`,
    `--mode <full|guarded>`, `--model <id>`, `--profile <name>` (repeatable; a collector
    defined in `chat.ts`, since `collectProfile` in `bin/nax.ts` is not importable) and
    `-d, --dir <path>`; its action calls
    `chatCommand(options, deps)`. `bin/nax.ts` only calls `registerChatCommand`.
    `chatCommand`: refuses when stdin is not a TTY; validates `--mode`; finds the
    project with `findProjectDir(dir)` (`repoRoot` = its parent, or `dir` when there is
    none); loads config with `loadConfig(naxDir, { profile })` when `profile` is
    non-empty; resolves the model (`--model`, else `models.native.balanced`, read as for
    `host.models`); builds the storage with `createChatStorage`; builds the
    chain with `initInteractionChain(config, true)` (headless, so a `cli` plugin yields
    null), and on a throw writes `interaction chain unavailable: <message>; asks stay in
    the terminal` to stderr and continues with no chain; builds the host with
    `createChatHost`, starts or resumes, registers `SIGTERM` and `SIGHUP` handlers
    (through `deps.onSignal`) that call `host.close()`, then calls `renderChat`. An
    unknown first argument (`nax rnu`) is an excess argument to the default command
    (commander 13 rejects excess arguments by default) and never opens a session.

### Integration (extends existing code)

The baseline shapes exist only to locate the code; they are never the interface to
implement. Implement the target.

**Read only (verified 2026-10-25 on `main` `aed52cdb2`):**

- `@nathapp/nax-agent` entry: `createAgentSession(options)`,
  `resumeAgentSession(sessionId, options)`, `nativeBackend(options)`,
  `createFileTranscriptStore(dir)`, `createSessionStorage(deps)`,
  `defaultSessionsDir(configDir)`, types `AgentSession`, `SessionEvent`,
  `AnswerReply`, `SessionMeta`, `SessionStorage`, `SandboxState`.
- `CreateAgentSessionOptions` (`packages/nax-agent/src/session/agent-session-types.ts`):
  `{ backend, sessionId?, profile, workdir?, instructions?, tools?, transcriptStore, approvalTimeoutMs?, turnTimeoutSeconds?, metadata? }`.
- `SessionEventBody` `approval_requested`:
  `{ requestId, callId?, tool, summary, command?, reason, expiresAt, unsandboxed?: true, answerable?: false }`;
  `approval_resolved`: `{ requestId, decision, decidedBy }`; `question`:
  `{ requestId, text, expiresAt, answerable?: false }`; `usage`:
  `{ round, inputTokens, outputTokens, cacheRead?, cacheWrite?, costUsd, costSource? }`
  (`costSource` absent means `computed`); `turn_end`:
  `{ status, output, usage, costUsd, costSource?, error? }`; every event carries
  `turnId` and `at` (ISO time).
- `AgentSession`: `{ id, backend: { sandbox?: SandboxState }, lastTurn, send, answer, cancel, close }`.
- `SessionStorage` (F2): `readMeta`, `writeMeta`, `acquireLock`,
  `readLockHolder` -> `{ pid, startedAt, heartbeatAt, state: "live" | "stale" | "own" } | null`,
  `list({ cwd })` -> `{ sessions: { sessionId, cwd, title, updatedAt }[], nextCursor? }`;
  `acquireLock` refusals are `NaxError` `SESSION_LOCKED`; `readMeta` of a corrupt file
  rejects `SESSION_META_UNREADABLE`. `SessionMeta.mode` is one of `none | read | ask | full`.
- `packages/nax/src/context/rules/rule-delivery/index.ts`:
  `createRuleDeliveryHandlers({ repoRoot, overrideDir?, overrideMode }): LoopHandlerSet`;
  `roleAllows(role, mode)` reads `RULE_READ_ROLES` / `RULE_WRITE_ROLES`.
- `packages/nax/src/context/rules/rule-set/index.ts`:
  `resolveRuleSet({ repoRoot, packageDir, storyWorkdir?, overrideDir?, overrideMode })`.
- `packages/nax/src/prompts/builders/rules-index-builder.ts`:
  `toRulesIndexEntry(rule)`, `buildRulesIndexSection({ entries, shownAutomatically })`.
- `packages/nax/src/runtime/index.ts`: `CostAggregator(runId, drainDir)` with
  `record(event)` and `drain()` (rewrites `<drainDir>/<runId>.jsonl` with every row
  recorded so far), `projectOutputDir(projectKey, outputDirOverride)`;
  `packages/nax/src/runtime/middleware/index.ts`: `COST_ROW_SCHEMA_VERSION`;
  `CostEvent` requires `durationMs`.
- `packages/nax/src/interaction/index.ts`: `initInteractionChain(config, headless)`
  -> `InteractionChain | null` (rethrows a plugin init failure); the chain's
  `prompt(request)`, `cancel(id)` and `destroy()`. Telegram's `cancel` resolves the
  pending prompt with action `skip` (`src/interaction/plugins/telegram.ts`).
- `packages/nax/src/config/index.ts`: `loadConfig`, `findProjectDir`,
  `globalConfigDir`, `featureDir`, `getProjectKey(config, projectDir)`.
- `packages/nax/src/cli/status-dispatch.ts`: `registerStatusCommand(program)`, tested
  with `new Command()` (`test/unit/cli/status-dispatch.test.ts`), the pattern
  `registerChatCommand` follows.
- `packages/nax-agent-acp/src/server/translate/tool-kind.ts`: `toolKind` maps
  `Bash`, `RunCommand`, `Git`, `GitCommit` to `"execute"`.

**Changed (baseline -> target):**

`NativeBackendOptions` (`packages/nax-agent/src/session/native-backend-options.ts`)
— Target adds:

```typescript
/** Copied into every turn's loop-handler context as `role` (for example "tui"). */
readonly loopHandlerRole?: string;
```

`openNative` (`packages/nax-agent/src/session/native-backend.ts`) — Baseline:

```typescript
const loopHandlerContext = { sessionName: ctx.sessionId, workdir: ctx.workdir, model: raw.model, provider: resolved.provider };
```

Target: the same object plus `role: raw.loopHandlerRole` when
`raw.loopHandlerRole !== undefined`.

New `packages/nax-agent/src/permissions/approval-memory.ts` — Target:

```typescript
export interface ApprovalMemoryRequest { readonly tool: string; readonly command?: string }
export type ApprovalMemoryDecision = "allow" | "deny";
export function approvalMemoryKey(request: ApprovalMemoryRequest): string | undefined;
export function approvalMemoryApplies(request: ApprovalMemoryRequest, decision: ApprovalMemoryDecision): boolean;
```

`permissions.ts` (`packages/nax-agent-acp/src/server/`) — Baseline: declares
`memoryKey(event)` and `memoryApplies(event, decision)` locally. Target: calls
`approvalMemoryKey` and `approvalMemoryApplies` from `@nathapp/nax-agent`; the local
functions and their constants are gone.

`RULE_READ_ROLES` / `RULE_WRITE_ROLES` — Target: each also contains `"tui"`.

`InteractionConfigSchema.defaults` (`packages/nax/src/config/schemas-infra.ts`) —
Target adds `chatAskFallbackMs: z.number().int().min(1000).max(3600000).default(60000)`;
the literal default object for `interaction` in `src/config/schemas.ts` gains
`chatAskFallbackMs: 60000` beside `timeout`; the hand-written `InteractionConfig`
type (`src/config/runtime-types.ts`) gains the optional `chatAskFallbackMs?: number`
in `defaults` (optional so existing `InteractionConfig` fixtures still typecheck), and
the host uses 60000 when it is absent; `FIELD_DESCRIPTIONS`
(`src/cli/config-descriptions.ts`) gains `interaction.defaults.chatAskFallbackMs`.

New `packages/nax/src/chat/` shapes (exported from `src/chat/index.ts`):

```typescript
export type ChatMode = "full" | "guarded";
export interface ChatSessionSettings { readonly profile: "full" | "ask"; readonly bashApproval: "raw" | "gated"; readonly metaMode: "full" | "ask" }
export function chatSessionSettings(mode: ChatMode): ChatSessionSettings;
export function nextChatMode(mode: ChatMode): ChatMode;
export function chatModeOfMeta(mode: SessionMeta["mode"]): ChatMode | null;
export interface ChatSessionHandle { readonly session: AgentSession; readonly meta: SessionMeta; readonly release: () => Promise<void> }
export type AskChoice = "allow_once" | "allow_session" | "deny";
```

### Failure Handling

| Situation | Behaviour |
|---|---|
| Resume of an id with no metadata | `NaxError` `CHAT_SESSION_NOT_FOUND`, message `no session <id> in <dir>`; no lock taken. |
| Resume with no id and no resumable session for this cwd | `NaxError` `CHAT_SESSION_NOT_FOUND`, message `no resumable session for <cwd>`. |
| Resume of an id whose metadata is corrupt | `NaxError` `SESSION_META_UNREADABLE` propagates; no lock taken. Resume-latest skips such entries. |
| Resume of a session whose stored mode is `none` or `read` | `NaxError` `CHAT_SESSION_MODE_UNSUPPORTED`, message `session <id> was created in mode <mode>; nax chat opens full or ask sessions only`; no lock taken. |
| Resume of an id another live process holds | `NaxError` `CHAT_SESSION_LOCKED`, message `session <id> is in use by pid <pid>`. |
| Opening fails after the lock is taken | The lock is released, then the error is rethrown. |
| Mode or model switch whose reopen throws | The previous settings are reopened on the same id and the switch error is rethrown; the metadata keeps the previous settings. |
| `session.send` throws before any event | The error is rethrown to the shell, which shows it; ledger and metadata untouched. |
| A turn ends `errored` | The error's code and message are shown in the transcript; the session stays open. |
| Interaction chain init throws at startup | stderr `interaction chain unavailable: <message>; asks stay in the terminal`; chat starts with no fallback. |
| Interaction chain prompt rejects | Warn `chat ask fallback failed` with the error message; the ask stays in the TUI. |
| Chain answers `skip` (its timeout or a cancel) | Ignored; the ask stays in the TUI. |
| No interaction chain (none configured, or plugin `cli`) | No fallback; asks wait in the TUI until the session's own approval timeout. |
| `/feature <name>` with no `spec.md` | Notice `no feature <name> (looked in <dir>)`; nothing sent. |
| `/feature <name>` with `spec.md` but no `prd.json` | The message is sent with the spec block only. |
| `start`, `resume` or `clear` fails while a session is open | The open session stays current and open; the error is shown. |
| `nax` / `nax chat` with stdin not a TTY | stderr `nax chat needs an interactive terminal`, exit code 1, no session opened. (Bare `nax` used to print help; a script that runs bare `nax` now gets this error.) |
| `SIGTERM` or `SIGHUP` | `host.close()` releases the lock before exit. |

## Out of Scope

- Offering the RunCommand tool (and its `unsandboxed` argument) to chat sessions is deferred; it needs a `declaredToolsFor` change in nax-agent that also changes koda's ACP sessions. Chat escalates per command through Bash's `unsandboxed` argument.
- Skills, Claude Code plugins, the `Skill` tool and `/skills` / `/plugins` are feature F4.
- `.mcp.json` servers, subagents, the `Agent` tool, `/mcp`, `/agents` and `agent.modelAliases` are feature F5.
- Claude Code hooks are not read or executed.
- Dispatching `nax plan`, `nax run`, `nax bot review` or `nax bot fix` from the session is slice 2.
- A durable tool-call audit directory for chat sessions is not added (`buildSessionToolSupport` passes no `auditDir`).
- A resumed session does not show which mode each earlier turn ran under; the metadata holds the current mode only.
- The design's `nax context` fragments repo summary is not added to the chat prompt: fragments are per-story run notes, and the native session already loads the repo's `AGENTS.md` (generated from `.nax/context.md`) as its repository instructions.
- Questions (`question` events) are not offered to the interaction chain; only approvals are.
- `context.rules.delivery: "push"` is not honoured by chat; chat always uses the index plus on-demand delivery.
- The sessions directory honours `NAX_AGENT_SESSIONS_DIR` and the global config dir only; the ACP server's `--sessions-dir` flag and `agentServer.sessionsDir` config key are not read by chat, so koda shares chat's sessions only when it uses the same directory.
- A process killed by SIGKILL leaves its lock; the existing heartbeat staleness (`LOCK_STALE_MS`) lets the next opener take it over. No new crash recovery.
- `"tui"` is not added to `KNOWN_SESSION_ROLES` or the session role registry; chat never dispatches through `SessionManager`.
- No budget enforcement beyond what config already applies; `/cost` reports spend only.
- The run TUI (`src/tui/App.tsx` and its components) is unchanged.
- US-003 only: the ACP server's permission round trips, `allow_always` / `reject_always` options and broker behaviour are unchanged, and its broker ACs pass before and after the move; the removal of the local helpers is checked by `bun run typecheck`.
- No new npm dependency: the chat input box is built on ink's `useInput`, not an input-component package.
- Updating `.nax/mono/packages/nax/context.md` and `.nax/mono/packages/nax-agent/context.md` to describe `src/chat/`, the `tui` role and `approval-memory.ts`, then running `nax generate`, is a manual step after merge; `.nax/` is read-only to the run.
- No release and no version bump.

## Stories

Paths below are repo-relative. Fifteen stories, one capability: the interactive chat
session (the user ruled one feature on 2026-10-25; the story count grew from the
spec-review AC-cap splits). US-001 to US-003 are the nax-agent and ACP changes the
shell needs; US-004 to US-011 are the headless host in `packages/nax/src/chat/`;
US-012 to US-015 are the ink shell and the CLI entry.

### US-001 — nax-agent: a loop-handler role option

Workdir: packages/nax-agent. No dependencies.

- Add `loopHandlerRole` to `NativeBackendOptions`, validate it, and copy it into the `loopHandlerContext` as `role` (Design §Approach 1).

### US-002 — nax-agent: the approval-memory helpers

Workdir: packages/nax-agent. No dependencies.

- Create `src/permissions/approval-memory.ts` with `approvalMemoryKey` and `approvalMemoryApplies` carrying the ACP logic (Design §Approach 2); export both and the two types through `src/permissions/index.ts` and `src/index.ts`; port the ACP `memoryKey` cases. Regenerate the API snapshot.

### US-003 — The ACP server uses the shared approval-memory helpers

Workdir: packages/nax-agent-acp. Depends on US-002.

- `src/server/permissions.ts` calls the helpers from `@nathapp/nax-agent` and deletes `memoryKey`, `memoryApplies` and their constants; the `memoryKey` describe block leaves `test/unit/server/permissions.test.ts`. Verification note: the removals are checked by `bun run typecheck` and `bun run check:all` in `packages/nax-agent-acp`.

### US-004 — The chat prompt builder

Workdir: packages/nax. No dependencies.

- Create `src/prompts/builders/chat-builder.ts` with `buildChatInstructions` and `buildChatFeatureMessage` (Design §Approach 5), exported from `src/prompts/index.ts`.

### US-005 — Chat modes and the `tui` rule role

Workdir: packages/nax. No dependencies.

- Create `src/chat/chat-mode.ts` and `src/chat/index.ts` (Design §Approach 3); add `"tui"` to `RULE_READ_ROLES` and `RULE_WRITE_ROLES`.

### US-006 — The chat session opener

Workdir: packages/nax. Depends on US-001, US-004, US-005.

- Create `src/chat/open-chat-session.ts` (Design §Approach 4) with a `_openChatSessionDeps` object for `createAgentSession`, `resumeAgentSession`, `nativeBackend`, `createSessionStorage`, `createFileTranscriptStore`, `resolveRuleSet`, `randomUUID` and `env`.

### US-007 — The ask controller

Workdir: packages/nax. Depends on US-002, US-005.

- Create `src/chat/ask-controller.ts` (Design §Approach 6); export it from `src/chat/index.ts`.

### US-008 — Offer unanswered asks to the interaction chain

Workdir: packages/nax. Depends on US-007.

- Create `src/chat/ask-fallback.ts` with `_askFallbackDeps` (Design §Approach 7); add `interaction.defaults.chatAskFallbackMs` to the schema, its literal default and `FIELD_DESCRIPTIONS`.

### US-009 — Turns, the chat cost ledger and metadata updates

Workdir: packages/nax. Depends on US-006, US-007.

- Create `src/chat/chat-ledger.ts` and `src/chat/turn-runner.ts` (Design §Approach 8).

### US-010 — The chat host

Workdir: packages/nax. Depends on US-006, US-007, US-008, US-009.

- Create `src/chat/chat-host.ts` (Design §Approach 9): composition of the opener, rule handlers, controller, fallback and ledger; `start`, `send`, `cancel`, `listSessions`, `close`, `current`, `models`, `repoRoot`.

### US-011 — The chat host: resume and switch

Workdir: packages/nax. Depends on US-010.

- Add `resume`, `notice` and `switchTo` to the host in `src/chat/chat-host.ts` (Design §Approach 9).

### US-012 — The ink shell: transcript, input and status line

Workdir: packages/nax. Depends on US-011.

- Create `src/tui/chat/ChatApp.tsx`, `Transcript.tsx`, `InputBox.tsx`, `ChatStatusLine.tsx` and `src/tui/chat/index.ts` exporting `renderChat(props)` (Design §Approach 10, transcript, input, status line, notices). Tests use ink-testing-library under `test/ui/chat/`.

### US-013 — The ink shell: ask prompt and keys

Workdir: packages/nax. Depends on US-012.

- Create `src/tui/chat/AskPrompt.tsx`; wire the ask prompt, Shift-Tab and Ctrl-C into `ChatApp` (Design §Approach 10).

### US-014 — Slash commands

Workdir: packages/nax. Depends on US-013.

- Create `src/tui/chat/slash-commands.ts` with `parseSlashCommand(text)` (returning `{ name, args, rest }`, where `rest` is the raw text after the command name) and the command handlers, wired into `ChatApp`.

### US-015 — `nax` and `nax chat`

Workdir: packages/nax. Depends on US-014.

- Create `src/cli/chat.ts` with `registerChatCommand(program, deps)`, `chatCommand(options, deps)` and `_chatCommandDeps` (`stdinIsTTY`, `loadConfig`, `findProjectDir`, `initInteractionChain`, `createChatHost`, `renderChat`, `onSignal`, `writeErr`, `setExitCode`); call `registerChatCommand` from `bin/nax.ts` (Design §Approach 11).

### Context Files

**US-001**
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/session/native-backend-options.ts`

**US-002**
- `packages/nax-agent-acp/src/server/permissions.ts`
- `packages/nax-agent-acp/test/unit/server/permissions.test.ts`
- `packages/nax-agent-acp/src/server/translate/tool-kind.ts`
- `packages/nax-agent/src/index.ts`

**US-003**
- `packages/nax-agent-acp/src/server/permissions.ts`
- `packages/nax-agent-acp/test/unit/server/permissions.test.ts`
- `packages/nax-agent-acp/src/server/translate/tool-kind.ts`
- `packages/nax-agent/src/permissions/approval-memory.ts` — created by US-002

**US-004**
- `packages/nax/src/prompts/builders/rules-index-builder.ts`
- `packages/nax/src/prompts/index.ts`

**US-005**
- `packages/nax/src/context/rules/rule-delivery/index.ts`
- `packages/nax/test/unit/context/rules/rule-delivery.test.ts`

**US-006**
- `packages/nax-agent-acp/src/server/open-session.ts`
- `packages/nax/src/workflow/brief.ts`
- `packages/nax-agent/src/session-store/storage.ts`
- `packages/nax/src/prompts/builders/chat-builder.ts` — created by US-004
- `packages/nax/src/chat/chat-mode.ts` — created by US-005

**US-007**
- `packages/nax-agent-acp/src/server/permissions.ts`
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/permissions/approval-memory.ts` — created by US-002

**US-008**
- `packages/nax/src/config/runtime-types.ts`
- `packages/nax/src/interaction/types.ts`
- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/src/config/schemas.ts`
- `packages/nax/src/cli/config-descriptions.ts`

**US-009**
- `packages/nax/src/runtime/cost-aggregator.ts`
- `packages/nax/src/runtime/index.ts`
- `packages/nax/src/runtime/middleware/index.ts`
- `packages/nax/src/config/project-key.ts`
- `packages/nax/src/chat/open-chat-session.ts` — created by US-006

**US-010**
- `packages/nax-agent-acp/src/server/registry-open.ts`
- `packages/nax/src/interaction/init.ts`
- `packages/nax/src/chat/open-chat-session.ts` — created by US-006
- `packages/nax/src/chat/ask-fallback.ts` — created by US-008
- `packages/nax/src/chat/turn-runner.ts` — created by US-009

**US-011**
- `packages/nax-agent-acp/src/server/registry-open.ts`
- `packages/nax-agent-acp/src/server/registry.ts`
- `packages/nax/src/chat/chat-host.ts` — created by US-010
- `packages/nax/src/chat/chat-mode.ts` — created by US-005

**US-012**
- `packages/nax/src/tui/components/StatusBar.tsx`
- `packages/nax/test/ui/tui-ctrl-key.test.tsx`
- `packages/nax/src/chat/chat-host.ts` — created by US-010

**US-013**
- `packages/nax/src/tui/hooks/useKeyboard.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx` — created by US-012
- `packages/nax/src/chat/ask-controller.ts` — created by US-007

**US-014**
- `packages/nax/src/tui/chat/ChatApp.tsx` — created by US-012
- `packages/nax/src/chat/chat-host.ts` — created by US-010

**US-015**
- `packages/nax/bin/nax.ts`
- `packages/nax/bin/run-action.ts`
- `packages/nax/src/cli/status-dispatch.ts`
- `packages/nax/test/unit/cli/status-dispatch.test.ts`

### Creates

**US-001**
- `packages/nax-agent/test/unit/session/native-backend-role.test.ts`

**US-002**
- `packages/nax-agent/src/permissions/approval-memory.ts`
- `packages/nax-agent/test/unit/permissions/approval-memory.test.ts`

**US-004**
- `packages/nax/src/prompts/builders/chat-builder.ts`
- `packages/nax/test/unit/prompts/builders/chat-builder.test.ts`

**US-005**
- `packages/nax/src/chat/chat-mode.ts`
- `packages/nax/src/chat/index.ts`
- `packages/nax/test/unit/chat/chat-mode.test.ts`

**US-006**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/test/unit/chat/open-chat-session.test.ts`

**US-007**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/test/unit/chat/ask-controller.test.ts`

**US-008**
- `packages/nax/src/chat/ask-fallback.ts`
- `packages/nax/test/unit/chat/ask-fallback.test.ts`

**US-009**
- `packages/nax/src/chat/chat-ledger.ts`
- `packages/nax/src/chat/turn-runner.ts`
- `packages/nax/test/unit/chat/turn-runner.test.ts`

**US-010**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/test/unit/chat/chat-host.test.ts`

**US-011**
- `packages/nax/test/unit/chat/chat-host-resume.test.ts`

**US-012**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/Transcript.tsx`
- `packages/nax/src/tui/chat/InputBox.tsx`
- `packages/nax/src/tui/chat/ChatStatusLine.tsx`
- `packages/nax/src/tui/chat/index.ts`
- `packages/nax/test/ui/chat/chat-app.test.tsx`

**US-013**
- `packages/nax/src/tui/chat/AskPrompt.tsx`
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx`

**US-014**
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/test/ui/chat/slash-commands.test.tsx`

**US-015**
- `packages/nax/src/cli/chat.ts`
- `packages/nax/test/unit/cli/chat.test.ts`

### Modifies

**US-001**
None. The API snapshot lists exported names only (NativeBackendOptions appears as one type line), so a new optional field changes no existing assertion.

**US-002**
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated with bun run api:update so it gains approvalMemoryKey, approvalMemoryApplies, type ApprovalMemoryRequest and type ApprovalMemoryDecision.

**US-003**
- `packages/nax-agent-acp/test/unit/server/permissions.test.ts` — its describe block memoryKey (spec §4.3) imports memoryKey from src/server/permissions.ts, which this story deletes; the invariant is that block removed (its cases now live in nax-agent's approval-memory.test.ts from US-002) while every createPermissionBroker case stays unchanged and passing.

**US-004**
None. US-004 adds a new builder file and one barrel export; no existing assertion pins the prompts barrel's export list.

**US-005**
None. Adding "tui" to RULE_READ_ROLES and RULE_WRITE_ROLES keeps every existing assertion in test/unit/context/rules/rule-delivery.test.ts true, since those use toContain on workflow roles; the rest is new files.

**US-006**
None. New files only.

**US-007**
None. New files only.

**US-008**
None. The new key has a schema default, and test/unit/config/schemas-infra.test.ts asserts only that interaction.defaults.fallback stays undefined, which still holds.

**US-009**
None. New files only.

**US-010**
None. New files only.

**US-011**
None. It extends chat-host.ts, which US-010 created, and adds a new test file.

**US-012**
None. New files only; the run TUI under src/tui/ is not changed.

**US-013**
None. New file plus wiring inside ChatApp.tsx, which US-012 created.

**US-014**
None. New file plus wiring inside ChatApp.tsx, which US-012 created.

**US-015**
None. bin/nax.ts gains one registerChatCommand call; no existing test spawns bin/nax.ts without a subcommand, and new tests drive registerChatCommand on a fresh commander Command.

### Seams

- US-002 -> US-003: `approvalMemoryKey` / `approvalMemoryApplies`; US-003 asserts, through `createPermissionBroker` with a fake client, that after `allow_always` for `git status` a later `git status --short` is asked again while `git status` is answered without a client round trip.
- US-001 -> US-006: `loopHandlerRole`; US-006 asserts `openChatSession` passes `nativeBackend` options with `loopHandlerRole: "tui"` and the request's `loopHandlers`.
- US-002 -> US-007: the helpers; US-007 asserts a remembered `allow` for `Bash` `npm test` answers a later `npm test` but not `npm test; rm -rf x`.
- US-004 -> US-006: `buildChatInstructions`; US-006 asserts the `instructions` passed to `createAgentSession` contain the repo rule id `error-handling`.
- US-005 -> US-006: `chatSessionSettings` / `chatModeOfMeta`; US-006 asserts a resumed `read` session is refused.
- US-007 -> US-008: `pending()` and `onChange`; US-008 asserts the chain is prompted only after the delay and is cancelled when the TUI answers first.
- US-006/US-007 -> US-009: the handle and the controller; US-009 asserts, through `runChatTurn` over a fake session, that an `approval_requested` event reaches `asks.handle` and a `usage` event reaches the ledger file.
- US-006/US-008/US-009 -> US-010: the host composes them; US-010 asserts, through `host.send` over a fake session that emits an unanswered guarded ask and a fake chain, that the chain's `prompt` is called once the delay passes, and that the ledger file gains the turn's row.
- US-006/US-010 -> US-011: `openChatSession` and the host's handler set; US-011 asserts `switchTo({ mode: "full" })` reopens the same id with profile `full` and passes the same `loopHandlers` object as the first open.
- US-011 -> US-012: `ChatApp` drives the host; US-012 asserts typing `hello` plus Enter calls `host.send("hello", ...)` and the streamed text appears.
- US-007 -> US-013: `resolve`; US-013 asserts pressing `a` on a rendered ask calls `host.asks.resolve(requestId, "allow_once")`.
- US-013 -> US-014: `ChatApp` routes `/` lines; US-014 asserts typing `/mode full` plus Enter calls `host.switchTo({ mode: "full" })` and never `host.send`.
- US-010/US-014 -> US-015: `createChatHost` and `renderChat`; US-015 asserts, through the commander action registered by `registerChatCommand` with `_chatCommandDeps` fakes, that `nax chat --mode full` builds the host with the chain `initInteractionChain` returned, starts it in mode `full` and calls `renderChat` with it.

## Acceptance Criteria

### US-001 — nax-agent: a loop-handler role option

- [unit] Opening a session through `nativeBackend({ model, loopHandlerRole: "tui" })` yields turn options whose `loopHandlerContext.role` is `"tui"`.
- [unit] Opening a session through `nativeBackend({ model })` with no `loopHandlerRole` yields a `loopHandlerContext` with no `role` key.
- [unit] `nativeBackend({ model, loopHandlerRole: "" })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS`.

### US-002 — nax-agent: the approval-memory helpers

- [unit] `approvalMemoryKey` imported from the package entry `src/index.ts` is a function.
- [unit] `approvalMemoryKey({ tool: "Edit" })` returns `"Edit"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "  git push origin main" })` returns `"Bash:git push"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "npm test -- --watch" })` returns `"Bash:npm test"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "ls" })` returns `"Bash:ls"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "./scripts/build.sh" })` returns `"Bash:./scripts/build.sh"`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "rm -f x" })` returns `undefined`.
- [unit] `approvalMemoryKey` returns `undefined` for each wrapper first word: `bash -c ls`, `sudo make install`, `/usr/bin/env ls`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "FOO=1 npm test" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "git 'status'" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "ls *.ts" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "git $CMD" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash", command: "echo [REDACTED:token]" })` returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "Bash" })` (no command) returns `undefined`.
- [unit] `approvalMemoryKey({ tool: "RunCommand", command: "npm test" })` returns `"RunCommand:npm test"`.
- [unit] `approvalMemoryApplies({ tool: "Bash", command: "git status" }, "allow")` returns `true`.
- [unit] `approvalMemoryApplies({ tool: "Bash", command: "git status; rm -rf x" }, "allow")` returns `false`.
- [unit] `approvalMemoryApplies({ tool: "Bash", command: "git push origin --force" }, "allow")` returns `false`.
- [unit] `approvalMemoryApplies({ tool: "Bash", command: "git push origin --force" }, "deny")` returns `true`.
- [unit] `approvalMemoryApplies({ tool: "Edit" }, "allow")` returns `true`.

### US-003 — The ACP server uses the shared approval-memory helpers

- [unit] Through `createPermissionBroker` with a fake client that answers `allow_always` for an `approval_requested` with tool `Bash` and command `git status`, a second request for `git status` is answered `allow` with no second client permission request.
- [unit] Through the same broker, a later request for `git status --short` produces a client permission request.
- [unit] Through a broker whose client answered `reject_always` for `git push origin main`, a later request for `git push origin --force` is answered `deny` with no client permission request.
- [unit] Importing `src/server/permissions.ts` yields a module with no `memoryKey` export.
- [unit] For every tool name `toolKind` maps to `"execute"`, `approvalMemoryKey({ tool, command: "npm test" })` returns `"<tool>:npm test"`, so a new execute tool cannot fall back to a bare tool-name key.

### US-004 — The chat prompt builder

- [unit] `buildChatInstructions` imported from `src/prompts` is a function.
- [unit] `buildChatInstructions({ mode: "guarded", rulesIndex: [] })` contains `## Permission mode`.
- [unit] Its guarded text states that every shell command is put to the person before it runs.
- [unit] `buildChatInstructions({ mode: "full", rulesIndex: [] })` states that tools run without asking.
- [unit] `buildChatInstructions({ mode: "guarded", rulesIndex: [] })` contains `## Commands outside the sandbox`.
- [unit] That section names the arguments `unsandboxed` and `unsandboxedReason`.
- [unit] With one rules index entry for rule id `error-handling`, `buildChatInstructions` contains `## Rules index` and a line with `` `error-handling` ``.
- [unit] With one entry, the rules section says each rule's full text is shown the first time a file it applies to is read, written or edited.
- [unit] With `rulesIndex: []`, `buildChatInstructions` returns a prompt with no `## Rules index` section.
- [unit] `buildChatFeatureMessage({ feature: "auth", spec: "S", prd: "{}", message: "go" })` starts with `## Feature auth`.
- [unit] That message contains the spec text `S` and the PRD text `{}` before the person's message `go`, which ends the message.
- [unit] `buildChatFeatureMessage({ feature: "auth", spec: "S", message: "go" })` with no `prd` has exactly one fenced block.

### US-005 — Chat modes and the `tui` rule role

- [unit] `chatSessionSettings("full")` returns `{ profile: "full", bashApproval: "raw", metaMode: "full" }`.
- [unit] `chatSessionSettings("guarded")` returns `{ profile: "ask", bashApproval: "gated", metaMode: "ask" }`.
- [unit] `nextChatMode("guarded")` returns `"full"`.
- [unit] `nextChatMode("full")` returns `"guarded"`.
- [unit] `chatModeOfMeta("ask")` returns `"guarded"`.
- [unit] `chatModeOfMeta("full")` returns `"full"`.
- [unit] `chatModeOfMeta("read")` returns `null`.
- [unit] `chatModeOfMeta("none")` returns `null`.
- [unit] `RULE_READ_ROLES` contains `"tui"`.
- [unit] `createRuleDeliveryHandlers` with role `tui` in the loop context refuses a first `Write` to a file a rule covers, as it does for `wf-implementer`.
- [unit] With role `tui`, a `Read` of a file a rule covers is nudged with that rule's text.

### US-006 — The chat session opener

All ACs drive `openChatSession` through `_openChatSessionDeps` fakes; the request's `storage` is a real `createSessionStorage` over a temp directory.

- [unit] Opening a new guarded session passes `nativeBackend` `bashApproval: "gated"`.
- [unit] It passes `nativeBackend` `allowUnsandboxed: true`.
- [unit] It passes `nativeBackend` `allowUnsandboxedCommands: true`.
- [unit] It passes `nativeBackend` `loopHandlerRole: "tui"`.
- [unit] With `agent.native.catalogOverrides` holding one entry, `nativeBackend` receives `catalogOverrides` with that entry.
- [unit] With `execution.compaction.enabled: false`, `nativeBackend` receives `compaction.enabled` false.
- [unit] Opening a new full session passes `createAgentSession` `profile: "full"`.
- [unit] It passes `createAgentSession` `workdir` equal to the request's `cwd`.
- [unit] It passes `createAgentSession` `approvalTimeoutMs` equal to `execution.approvalTimeout`.
- [unit] With a repo whose `.nax/rules/` holds one rule `error-handling`, the `instructions` passed to `createAgentSession` contain `` `error-handling` ``.
- [unit] A new session writes metadata whose `sessionId` is the injected `randomUUID` value.
- [unit] A new session holds the lock: `storage.readLockHolder(id)` returns state `"own"`.
- [unit] Resuming an id whose transcript store has a document calls `resumeAgentSession` with that id and never `createAgentSession`.
- [unit] Resuming an id with metadata but no transcript document calls `createAgentSession` with that `sessionId`.
- [unit] Resuming with no `mode` or `model` in the request opens with the stored mode and model.
- [unit] Resuming an id with no metadata rejects with `NaxError` code `CHAT_SESSION_NOT_FOUND`.
- [unit] Resuming an id whose metadata `mode` is `read` rejects with code `CHAT_SESSION_MODE_UNSUPPORTED`.
- [unit] Resuming an id whose metadata file holds invalid JSON rejects with code `SESSION_META_UNREADABLE`.
- [unit] When `createAgentSession` throws after the lock was taken, `openChatSession` rejects with that error and `readLockHolder(id)` returns null.
- [unit] `resolveChatSessionsDir({ NAX_AGENT_SESSIONS_DIR: "/tmp/s" })` returns `/tmp/s`.
- [unit] `resolveChatSessionsDir({})` returns `defaultSessionsDir(globalConfigDir())`.

### US-007 — The ask controller

- [unit] In full mode, an `approval_requested` event `r1` calls `answer("r1", { decision: "allow" })` once.
- [unit] In full mode, an `approval_requested` event with `answerable: false` calls no `answer`.
- [unit] In guarded mode, an `approval_requested` event joins `pending()` and calls no `answer`.
- [unit] `resolve("r1", "allow_once")` calls `answer("r1", { decision: "allow" })`.
- [unit] `resolve("r1", "deny")` calls `answer("r1", { decision: "deny" })`.
- [unit] After `resolve("r1", "allow_session")` for tool `Bash` command `npm test`, a later request for `npm test` is answered allow without joining `pending()`.
- [unit] After that `allow_session`, a later request for `npm test; rm -rf x` joins `pending()`.
- [unit] After that `allow_session`, a later request for `npm test` with `unsandboxed: true` joins `pending()`.
- [unit] After `resolve("r1", "deny")` for `npm test`, a later request for `npm test` joins `pending()`.
- [unit] `canRemember` returns false for a request whose command is `rm -f x`.
- [unit] `canRemember` returns false for a request with `unsandboxed: true`.
- [unit] `canRemember` returns false for a request whose tool is `Delete`.
- [unit] `resolve("r1", "allow_session")` on a request that cannot be remembered answers allow and stores nothing: a later identical request joins `pending()`.
- [unit] An `approval_resolved` event for `r1` removes `r1` from `pending()` without calling `answer`.
- [unit] In full mode, a `question` event `q1` joins `pending()`.
- [unit] `answerQuestion("q1", "yes")` calls `answer("q1", { text: "yes" })` and removes `q1` from `pending()`.
- [unit] After `setMode("full")`, a new `approval_requested` event is answered allow at once.
- [unit] After `reset()`, a request remembered before is put in `pending()` again.
- [unit] Each change to `pending()` calls every `onChange` listener once.

### US-008 — Offer unanswered asks to the interaction chain

All ACs inject `_askFallbackDeps` timers driven by the shared fake clock helper, and a fake chain.

- [unit] A guarded ask pending for less than `delayMs` has not prompted the chain.
- [unit] Once `delayMs` passes, the chain's `prompt` is called once with `id` `chat-r1`.
- [unit] That request has `type` `confirm`, `stage` `custom`, `featureName` `chat` and `fallback` `skip`.
- [unit] That request's `detail` contains the ask's command and reason.
- [unit] A chain response with `action: "approve"` resolves the ask `allow_once`.
- [unit] A chain response with `action: "reject"` resolves the ask `deny`.
- [unit] A chain response with `action: "skip"` leaves the ask in `pending()`.
- [unit] A chain response that arrives after the ask left `pending()` resolves nothing.
- [unit] When the ask is resolved in the TUI before `delayMs`, the chain is never prompted.
- [unit] When the ask is resolved in the TUI after the prompt went out, `chain.cancel("chat-r1")` is called once.
- [unit] When an `approval_resolved` event removes the ask after the prompt went out, `chain.cancel("chat-r1")` is called once.
- [unit] A rejected `chain.prompt` logs warn `chat ask fallback failed` and the ask stays in `pending()`.
- [unit] With `chain` null, no prompt is made and the ask stays in `pending()`.
- [unit] A pending `question` is never offered to the chain.
- [unit] `dispose()` clears pending timers: advancing the clock past `delayMs` afterwards prompts nothing.
- [unit] Parsing an empty config yields `interaction.defaults.chatAskFallbackMs` equal to `60000`.
- [unit] Parsing a config with `interaction.defaults.chatAskFallbackMs: 500` fails validation.
- [unit] `FIELD_DESCRIPTIONS["interaction.defaults.chatAskFallbackMs"]` is a non-empty string.

### US-009 — Turns, the chat cost ledger and metadata updates

All ACs drive `runChatTurn` over a fake `AgentSession` whose `send` yields scripted events, a real `createSessionStorage` over a temp directory passed as `storage` and a ledger whose `outputDir` is a temp directory.

- [unit] Every scripted event is passed to `onEvent` in order.
- [unit] An `approval_requested` event is passed to `asks.handle`.
- [unit] After a turn with one `usage` event (input 100, output 20, costUsd 0.01, costSource `computed`), `<outputDir>/cost/chat-<sessionId>-<startedAt>.jsonl` holds one row.
- [unit] That row has `stage` `chat` and `sessionRole` `tui`.
- [unit] That row has the session's `model` and `runId` `chat-<sessionId>-<startedAt>`.
- [unit] That row has `tokens` `{ input: 100, output: 20 }`.
- [unit] That row has `confidence` `exact`, `exactCostUsd` 0.01 and `estimatedCostUsd` 0.
- [unit] With `turn_start` at `00:00:00.000Z` and the `usage` event at `00:00:01.500Z`, the row's `durationMs` is 1500.
- [unit] A `usage` event with no `costSource` yields a row with `confidence` `exact`.
- [unit] A `usage` event with `costSource` `unpriced` yields a row with `confidence` `estimated`.
- [unit] Two turns in one process leave one ledger file holding both turns' rows.
- [unit] After a turn ending with `turn_end.costUsd` 0.02 on a session whose metadata `costUsd` was 0.05, the metadata `costUsd` is 0.07.
- [unit] After a turn, the metadata `updatedAt` equals the injected `now`.
- [unit] After the first turn with message `  fix   the\nbug  `, the metadata `title` is `fix the bug`.
- [unit] A first message of 100 characters yields a `title` of 80 code points.
- [unit] A second turn does not change an existing `title`.
- [unit] A turn ending `errored` still updates the metadata `updatedAt`.
- [unit] When `session.send` throws before yielding, `runChatTurn` rejects with that error and the metadata `updatedAt` is unchanged.

### US-010 — The chat host

All ACs build the host over `openChatSession` with `_openChatSessionDeps` fakes, a real storage over a temp directory, and a fake chain.
- [unit] `start({ mode: "guarded", model })` opens a session whose metadata `mode` is `ask`.
- [unit] `current().meta.costUsd` after `send` equals the cost written by that turn.
- [unit] Through `send` over a fake session that emits a guarded `approval_requested` and then waits, the fake chain's `prompt` is called once `chatAskFallbackMs` passes.
- [unit] Through `send`, a `usage` event lands in `<outputDir>/cost/` under a file named `chat-<sessionId>-...jsonl`.
- [unit] `listSessions()` marks a session whose lock live pid 4242 holds with `heldByPid` 4242.
- [unit] `clear()` opens a new session id with the same mode and model, and the old id's `readLockHolder` returns null.
- [unit] After `clear()`, a decision remembered with `allow_session` before it no longer answers a matching ask.
- [unit] After `clear()`, an unanswered guarded ask still reaches the fake chain's `prompt` once the delay passes.
- [unit] When the open inside `clear()` throws, `current().sessionId` is still the old id and its lock is still `"own"`.
- [unit] `close()` makes `readLockHolder(id)` return null and calls the chain's `destroy()`.

### US-011 — The chat host: resume and switch

All ACs build the host over `openChatSession` with `_openChatSessionDeps` fakes and a real storage over a temp directory.

- [unit] `resume({})` with two usable stored sessions for this cwd opens the one `storage.list({ cwd })` returns first.
- [unit] `resume({})` skips a newer session whose mode is `read` and opens the next usable one.
- [unit] `resume({})` skips a newer session whose lock a live pid holds and opens the next usable one.
- [unit] `resume({})` with no usable session rejects with `CHAT_SESSION_NOT_FOUND` and message `no resumable session for <cwd>`.
- [unit] `resume({ id })` for a session whose lock live pid 4242 holds rejects with `CHAT_SESSION_LOCKED` and message `session <id> is in use by pid 4242`.
- [unit] After a resume whose session reports `lastTurn.status` `interrupted`, `notice()` is `The last turn was interrupted. Send a message to continue it.`
- [unit] After a resume whose last turn `completed`, `notice()` is undefined.
- [unit] `resume({ id: other })` while a session is open releases the old id's lock and makes a decision remembered before it no longer answer a matching ask.
- [unit] `switchTo({ mode: "full" })` calls `close()` on the current session, then opens the same session id with profile `full`.
- [unit] After that switch, the metadata `mode` is `full`, `bashApproval` is `raw`, and `readLockHolder(id)` is `"own"`.
- [unit] After that switch, a remembered `allow_session` decision from before the switch still answers a matching ask.
- [unit] `switchTo({ model: "anthropic/claude-sonnet-5-5" })` opens the same id with that model and writes it to the metadata.
- [unit] When the reopen in `switchTo({ mode: "full" })` throws, the host reopens the same id with profile `ask`, rethrows the error, and the metadata `mode` stays `ask`.
- [unit] Two reopens reuse one rule-delivery handler set: the `loopHandlers` passed to both opens are the same object.

### US-012 — The ink shell: transcript, input and status line

All ACs render `ChatApp` with ink-testing-library over a fake host.

- [unit] `renderChat` imported from `src/tui/chat` renders and unmounts without throwing.
- [unit] Typing `hello` and pressing Enter calls `host.send` with `hello`.
- [unit] Typing `a`, pressing Alt-Enter, typing `b` and pressing Enter calls `host.send` with `a\nb`.
- [unit] While a turn runs, pressing Enter does not call `host.send` and the typed text stays in the input box.
- [unit] Two `text_delta` events `Hel` and `lo` render `Hello` in the transcript.
- [unit] A `tool_call` for `Read` with `input.path` `src/a.ts` followed by its `tool_result` with `isError: false` renders one line `Read src/a.ts` marked `ok`.
- [unit] A `tool_result` with `isError: true` marks its line `error`.
- [unit] A `tool_call` for `Bash` renders its `input.command`.
- [unit] `thinking_delta` events render one `thinking...` line, not their text.
- [unit] The status line shows the model and `guarded` for a new guarded session.
- [unit] The status line shows the first 8 characters of the session id and `$0.00`.
- [unit] The status line shows `sandbox on` when `current().sandbox.kind` is `available`.
- [unit] The status line shows `sandbox unavailable` when the kind is `unavailable`.
- [unit] The status line shows `sandbox off` when `current().sandbox` is absent.
- [unit] A host whose `notice()` is the interrupted-turn text renders that text.
- [unit] Starting in full mode with the sandbox `unavailable` renders `sandbox unavailable: commands run outside the sandbox` once.
- [unit] A `turn_end` with status `errored` and error code `X` renders `X` and its message.
- [unit] After that errored turn, typing `next` and pressing Enter calls `host.send` with `next`.
- [unit] A rejected `host.send` renders the error's message.

### US-013 — The ink shell: ask prompt and keys

All ACs render `ChatApp` over a fake host whose `asks.pending()` is scripted.

- [unit] A pending ask for `Bash` `npm test` renders the command and the reason.
- [unit] Pressing `a` calls `host.asks.resolve(requestId, "allow_once")`.
- [unit] Pressing `s` on an ask `canRemember` accepts calls `resolve(requestId, "allow_session")`.
- [unit] An ask `canRemember` rejects does not show the `s` option, and pressing `s` resolves nothing.
- [unit] Pressing `d` calls `resolve(requestId, "deny")`.
- [unit] An ask with `unsandboxed: true` renders `outside the sandbox`.
- [unit] A pending question renders its text, and typing `yes` then Enter calls `host.asks.answerQuestion(requestId, "yes")`.
- [unit] Shift-Tab between turns calls `host.switchTo({ mode: "full" })`.
- [unit] After that switch, the status line shows `full`.
- [unit] Shift-Tab during a turn does not call `switchTo` before the `turn_end` event.
- [unit] After that `turn_end`, `switchTo({ mode: "full" })` has been called once.
- [unit] Switching into full mode with the sandbox `unavailable` renders `sandbox unavailable: commands run outside the sandbox`.
- [unit] Ctrl-C during a turn calls `host.cancel()` and does not call `host.close()`.
- [unit] A second Ctrl-C within 2 seconds calls `host.close()` and exits the app.
- [unit] Ctrl-C between turns calls `host.close()` and exits the app.

### US-014 — Slash commands

All ACs type into a rendered `ChatApp` over a fake host.

- [unit] `parseSlashCommand("/mode full")` returns `{ name: "mode", args: ["full"] }`.
- [unit] `parseSlashCommand("hello")` returns `null`.
- [unit] `/mode full` calls `host.switchTo({ mode: "full" })`.
- [unit] No line starting with `/` is passed to `host.send` as typed, for any command in this section; `/feature` sends only the builder-produced feature message.
- [unit] `/mode` with no argument renders the current mode.
- [unit] `/mode bogus` renders `unknown mode bogus; expected full or guarded` and calls no `switchTo`.
- [unit] `/model anthropic/claude-sonnet-5-5` calls `host.switchTo({ model: "anthropic/claude-sonnet-5-5" })`.
- [unit] `/model` with no argument renders every entry of `host.models`.
- [unit] `/sessions` renders each row of `host.listSessions()` with its id and title.
- [unit] `/sessions` renders `in use by pid 4242` for a row whose `heldByPid` is 4242.
- [unit] `/resume abc` calls `host.resume({ id: "abc" })`.
- [unit] `/clear` calls `host.clear()`.
- [unit] `/cost` renders `current().meta.costUsd` as dollars to 2 decimals.
- [unit] The single line `/feature auth go  now` calls `host.send` with the `buildChatFeatureMessage` output for feature `auth`, message `go  now`, and the `spec.md` and `prd.json` under `featureDir(host.repoRoot, "auth")`.
- [unit] `/feature missing` renders `no feature missing (looked in <dir>)`.
- [unit] `/help` renders every command name.
- [unit] `/quit` calls `host.close()` and exits the app.
- [unit] `/unknown` renders `unknown command /unknown`.
- [unit] `/clear` during a turn renders `wait for the turn to finish (Ctrl-C to interrupt)` and calls no `host.clear()`.
- [unit] `/quit` during a turn calls `host.cancel()`, then `host.close()`.

### US-015 — `nax` and `nax chat`

All ACs drive `chatCommand` or the action that `registerChatCommand` adds to a fresh commander `Command` (with `exitOverride()`), with `_chatCommandDeps` fakes.

- [unit] With `stdinIsTTY` returning false, `chatCommand` writes `nax chat needs an interactive terminal` and sets exit code 1.
- [unit] `chatCommand({ mode: "full" })` starts the host in mode `full` and calls `renderChat` with it.
- [unit] `chatCommand({})` starts the host in mode `guarded`.
- [unit] `chatCommand({ mode: "auto" })` writes `unknown mode auto; expected full or guarded` and sets exit code 1.
- [unit] `chatCommand({})` with config `models.native.balanced` `openai/gpt-6` starts the host with model `openai/gpt-6`.
- [unit] `chatCommand({ model: "anthropic/claude-sonnet-5-5" })` starts the host with that model.
- [unit] `chatCommand({ resume: true })` calls `host.resume({})`.
- [unit] `chatCommand({ resume: "abc" })` calls `host.resume({ id: "abc" })`.
- [unit] `chatCommand({ profile: ["fast"] })` calls `loadConfig` with overrides `{ profile: ["fast"] }`.
- [unit] `chatCommand({ dir: "/repo" })` builds the host with `cwd` `/repo`.
- [unit] When `host.resume` rejects with `CHAT_SESSION_LOCKED`, `chatCommand` writes its message and calls no `renderChat`.
- [unit] `chatCommand` builds the host with the chain `initInteractionChain(config, true)` returned.
- [unit] When `initInteractionChain` throws `bad token`, `chatCommand` writes `interaction chain unavailable: bad token; asks stay in the terminal` and builds the host with chain null.
- [unit] Invoking the handler `chatCommand` registered through `onSignal` for `SIGTERM` calls `host.close()`.
- [cli] Parsing `[]` (no subcommand) on a `Command` set up by `registerChatCommand` invokes the chat action.
- [cli] Parsing `["chat", "--mode", "full"]` invokes the chat action with `mode` `full`.
- [cli] Parsing `["rnu"]` throws a commander error and does not invoke the chat action.
- [cli] Running `bun bin/nax.ts chat --help` (as `test/unit/cli/trust.test.ts` spawns the entry) exits 0 and prints `--mode <full|guarded>`, proving `bin/nax.ts` registers the chat command.
