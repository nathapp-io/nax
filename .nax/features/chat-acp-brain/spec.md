# SPEC: chat-acp-brain — Claude Code, Codex and Cursor as the brain of `nax chat`

## Summary

`nax chat` runs only on nax's native agent today: `openChatSession` always builds `nativeBackend`
(`packages/nax/src/chat/open-chat-session.ts`). This feature lets the person pick Claude Code, Codex
or Cursor in the chat's model picker and talk to that agent over ACP instead. The agent runs with
its own full setup and login, nax's workflow tools (`nax-workflow`, `nax-jobs`) reach it as MCP
tools, guarded mode turns the agent's permission requests into nax approval cards, and native-only
chat features step aside while an agent is the brain.

It is feature F2 of the design `docs/superpowers/specs/2026-10-29-nax-chat-acp-agents-design.md`
(§5.2–§5.4, §5.7). F1 (`acp-tools-codex-cursor`, #2739) let Codex and Cursor receive embedder
tools. F3 (history carry and resume) follows.

## Motivation

- The user wants to use the subscriptions already paid for (Claude, Codex, Cursor) and each agent's
  own skills from inside the nax chat TUI, while keeping nax's plan / run / bot tools and the job
  list (design §1, G1–G5).
- Rulings 2026-10-29: an ACP agent is a main model choice in the chat picker; Claude Code, Codex
  and Cursor ship together; each loads its own full setup (its own allow rules and hooks act without
  a nax card); koda's ACP-server side is a separate feature.
- Rulings 2026-10-30 (this spec): the picker shows the models (and effort levels) an agent offers
  after its first open; an agent whose binary is missing is shown as unavailable with the reason;
  while a chat-started `nax plan` / `nax run` job holds the checkout, guarded mode rejects the
  agent's file-edit permission requests (full mode cannot be guarded, because the agent never asks).
- A stored session document refuses to reopen on another backend (`checkBackendKind` in
  `packages/nax-agent/src/session/agent-session-resume.ts`, `AGENT_SESSION_BACKEND_MISMATCH`), and
  the chat keeps one session id across model switches. So each brain keeps its own transcript
  document: the native one where it is today, each agent's under `<sessions dir>/acp-<agent>/`.
  Carrying the conversation from one brain to the next is F3.

## Design

### Approach

1. **Offered choices (nax-agent-acp).** After an agent session opens, the backend reports the
   model ids and effort values the agent offers in `AgentSession.backend.capabilities`
   (`offeredModels`, `offeredEfforts`), so nax never starts an agent just to list them.
2. **Chat model strings.** An ACP brain is named `acp:<agent>` or `acp:<agent>/<model>`, optionally
   followed by nax's effort suffix `[<effort>]` (`parseModelSpec`). `<agent>` is `claude`, `codex`
   or `cursor`. The `acp:` prefix cannot collide with a native `<provider>/<model>` string.
3. **One transcript per brain.** `openChatSession` reads the session's model. For an ACP model it
   opens `acpBackend` with a file transcript store in `<sessions dir>/acp-<agent>/` (same session
   id), creating the agent session when that store has no document and resuming it otherwise. The
   handle's `history` is always the native document's messages, so `/resume` keeps replaying what
   the native brain said.
4. **Own setup.** The agent gets the whole environment (`inheritEnv: true`), no nax sandbox, no
   nax rules, no command shadow, no background-command port and no nax loop handlers. Guarded mode
   opens ACP profile `ask`, full mode ACP profile `full`.
5. **Workflow tools.** Of the chat's tool providers, only `nax-workflow` and `nax-jobs` are
   delivered, resolved with nax-agent's `resolveProviderTools` and turned into embedder tools with
   nax's existing `toEmbedderTools` (`approval: "never"`: the jobs tools already ask the person
   themselves through `ChatAskController.requestHostApproval`). Their instructions are rendered
   with `renderProviderInstructions` into the ACP brain's system instructions.
6. **Availability.** A new chat-side catalog lists the three agent rows, learns each agent's
   offered models and effort levels from a successful open, remembers an auth or launch failure,
   and knows whether each agent's binary resolves on this machine (`launchCandidateKind`). The host
   exposes it through `models`, `effortLevels` and a new optional `modelNote`.
7. **Write guard.** A new optional `refuse` hook on `ChatAskController` rejects an approval before
   it becomes a card. The host wires it so that, on an ACP brain, an approval for an ACP `edit`,
   `delete` or `move` tool call is rejected while a chat-started plan or run job is running in this
   checkout — the same condition `createJobWriteGuard` uses for the native brain.
8. **Step aside.** On an ACP brain `/skills`, `/mcp` and `/agents` say they are not available, any
   slash command that is not a built-in is sent to the agent as typed (agents have their own
   commands), `/help` and the slash menu list built-ins only, and `!` commands say they run on
   native models only.

`packages/nax/src/chat/chat-host.ts` is at the 600-line limit and must stay at or under it
(`check:file-sizes`). US-002 first makes room with two pure moves: the session listing
(`allSessions` / `latestId`) into new `session-listing.ts`, and the final resource close
(`closeSessionAndResources`) into `session-hygiene.ts` as `closeChatResources`, bringing the file to
at most 560 lines. US-008, US-009 and US-010 then put the ACP glue in `src/chat/acp/acp-host.ts`
and `acp-write-guard.ts`, leaving one-line call sites in the host: the host wraps its opener once
(`this.open = reportAcpOpens(...)`, replacing the three `this.deps.open ?? openChatSession` sites),
calls `assertAcpInstalled` before opening or closing anything, and passes `acpRefusal(...)` as the
ask controller's `refuse`. `primeContextWindow` and `_chatHostDeps` stay in the host
(`chat-host-context-window.test.ts` stubs that seam).

The ACP brain's system instructions are mode-neutral: an ACP session receives them once (a reopen
by resume does not resend them, `instructionsSent` in nax-agent-acp's `backend.ts`), so a mode
toggle must not leave them stating the wrong mode.

nax's pid registry rule (forward `onPidSpawned`) is for `nax run` teardown; `nax chat` has no run
runtime or pid registry, and its agent process is closed with the chat session (`session.close()` in
`createSessionHygiene`). This exception is recorded in Out of Scope.

### Model string grammar

| Model string | Parsed |
|:---|:---|
| `acp:claude` | `{ agent: "claude" }` |
| `acp:codex/gpt-5.5` | `{ agent: "codex", model: "gpt-5.5" }` |
| `acp:codex/gpt-5.5[high]` | `{ agent: "codex", model: "gpt-5.5", effort: "high" }` |
| `acp:codex[high]` | `{ agent: "codex", effort: "high" }` |
| `openai/gpt-6` | `undefined` (not an ACP model) |
| `acp:gemini`, `acp:`, `acp:claude/`, `acp:claude/x]y` | throws `CHAT_ACP_MODEL_INVALID` |

`acpModelLabel` names an ACP model as `<agent label>`, then ` · <model>` when there is one, then the
effort suffix `[<effort>]` when there is one (`"Codex · gpt-5.5[high]"`, `"Codex[high]"`). It never
throws: a malformed `acp:` string is labelled as the raw string, because labels are drawn at render
time from stored metadata.

Picker rows from offered ids (`acpModelRows`), duplicates removed (first kept), in offer order:

- **Cursor** (its ids carry their settings, e.g. `gpt-5.5[context=272k,reasoning=medium]`): an
  offered id loses one trailing `[...]` group and becomes `acp:cursor/<bare>`; the backend resolves
  a bare name to the unique offered id starting `<bare>[` (`resolveModelValue`). A bare name that two
  or more distinct offered ids share is not listed: the backend refuses it as ambiguous, and the
  bracketed form collides with nax's effort suffix.
- **Claude and Codex**: `resolveModelValue` resolves nothing for them, so an offered id containing
  `[` or `]` is not listed, and every bracket-free offered id is listed exactly as offered.

### Integration (extends existing code)

The **Baseline** lines exist only to locate the code; they are never the interface to implement.
Implement the **Target**.

Read only (verified at main `80863ed03`):

- `packages/nax-agent-acp/src/client/capabilities.ts` — `selectValues(option)`,
  `EFFORT_FALLBACK_IDS` (`claude: "effort"`, `codex: "reasoning_effort"`, ...),
  `MODEL_ID_MAX_CHARS = 100`.
- `packages/nax-agent-acp/src/client/text.ts` — `cleanLabel(value, secrets, maxChars): string | undefined`.
- `packages/nax-agent-acp/src/client/session-offers.ts` — `SessionOffers { configOptions; modeIds; modelIds }`.
- `packages/nax-agent-acp/src/client/launchable.ts` — `launchCandidateKind(agent, env): "local" | "npx" | undefined`, exported from `./client`.
- `packages/nax-agent-acp/src/client/options.ts` — `AcpBackendOptions { agent; allowUnsandboxed: true; model?; effort?; inheritEnv?; ... }`.
- `packages/nax-agent/src/tools/provider-advertise.ts` — `resolveProviderTools(providers, stage, workdir)` returns `{ tools, instructions?, ... }`; a provider whose `tools()` rejects is dropped. Exported from `@nathapp/nax-agent`, as is `renderProviderInstructions(entries)`.
- `packages/nax/src/agents/acp/provider-embedder.ts` — `toEmbedderTools(tools: readonly CodingTool[], workdir: string): EmbedderTool[]` (each `approval: "never"`; a throw becomes an `isError` result).
- `packages/nax/src/chat/chat-effort.ts` — `EffortLevel`, `EFFORT_LEVELS`, `effortLevelsFor`, `withEffort`.
- `packages/nax/src/chat/jobs/job-write-guard.ts` — `createJobWriteGuard(jobs, repoRoot)`: the newest running job with `cwd === repoRoot` and kind `plan` or `run` blocks, message `[nax-jobs] <tool> refused: nax <kind> job <id> is running in this checkout; wait for it to end or cancel it`.
- `packages/nax/src/chat/workflow/workflow-provider.ts` (`id: "nax-workflow"`), `packages/nax/src/chat/jobs/jobs-provider.ts` (`id: "nax-jobs"`, includes the chain tools).

Changed:

- `packages/nax-agent-acp/src/client/open.ts`
  - Baseline: `applyConfig(o, sessionId, offers): Promise<void>`; `OpenedAcp { launched; link; record; agentSessionId; cwd; restoredWith?; startupBanner? }`.
  - Target: `applyConfig` returns the offers after the mode and model steps (`Promise<SessionOffers>`); `OpenedAcp` gains `readonly offered: OfferedChoices` = `offeredChoices(thoseOffers, options.agentName, options.secrets)`.
- `packages/nax-agent-acp/src/client/backend.ts`
  - Baseline: `infoOf(s)` reports `{ ...record }` (plus `restoredWith`).
  - Target: also `offeredModels: s.live.acp.offered.models` and `offeredEfforts: s.live.acp.offered.efforts` (a reconnect's process reports its own).
- `packages/nax/src/chat/chat-host.ts`
  - Baseline: `readonly models: readonly string[]` set in the constructor; private `allSessions()` / `latestId()`; `effortLevels(model)` reads `deps.effortLevels`; `runCommand` returns `"this session cannot run commands"` when `session.runCommand` is absent; `ChatHostDeps` has no ACP field.
  - Target: US-002 moves `allSessions` / `latestId` into `session-listing.ts` and `closeSessionAndResources` into `session-hygiene.ts` (`closeChatResources`). US-008 and US-009: `ChatHostDeps.acp?: AcpCatalog`; `models` is a getter returning the deps' models followed by `acp.rows()`; `effortLevels(model)` for an ACP model returns `acp.effortLevels(model)` (`["default"]` without a catalog); new `modelNote(model)` returns `acp?.unavailable(model)`; every open goes through `reportAcpOpens` (reports `acp.opened` / `acp.failed` for ACP models); start and switch to an ACP model whose agent is not installed throw `CHAT_ACP_AGENT_UNAVAILABLE` (via `assertAcpInstalled`) before the current session is closed; `primeContextWindow` never looks up an ACP model; `runCommand` on an ACP model returns `ACP_RUN_COMMAND_UNSUPPORTED`; `notice()` returns the resume notice, else the current handle's `notice`. US-010 passes `acpRefusal(...)` as `refuse`. The file stays at or under 600 lines.
- `packages/nax/src/chat/open-chat-session.ts`
  - Baseline: `sessionOptions` always builds `deps.nativeBackend(...)`; one `createFileTranscriptStore(request.storage.dir)`.
  - Target: for an ACP model (US-006) the options come from `acpSessionOptions`, the agent store is `createFileTranscriptStore(acpTranscriptDir(storage.dir, agent))`, no command shadow is built, and `history` is read from the native store. `parseChatAcpModel(meta.model)` runs before the storage lock is acquired, so an invalid model string never holds the lock. A resume of the agent document that fails with an error `isFreshFallback` accepts (code `AGENT_SESSION_NOT_FOUND`, `AGENT_SESSION_BACKEND_MISMATCH` or `TRANSCRIPT_CORRUPT`, or `AGENT_SESSION_CAPABILITY_UNSUPPORTED` whose `context.capability` is `"resume"`: the stored agent session is unusable) retains the document (`retainFailed`), creates a fresh agent session, and returns a handle whose new optional `notice` is `ACP_FRESH_SESSION_NOTICE(label)`; any other failure propagates. `ChatSessionHandle` gains `readonly notice?: string`.
- `packages/nax/src/chat/ask-controller.ts`
  - Baseline: `ChatAskControllerOptions { mode; approvalTimeoutMs?; now?; answer }`.
  - Target: gains `readonly refuse?: (event: ChatApproval) => string | undefined`. In `handle`, an answerable `approval_requested` (not host-owned) for which `refuse` returns a string is answered `{ decision: "deny" }` and never becomes pending; this check runs before the full-mode and remembered-allow paths.
- `packages/nax/src/prompts/builders/chat-builder.ts`
  - Target: new export `buildChatAcpInstructions(input: { agentLabel: string; toolInstructions?: string }): string` (mode-neutral), re-exported from the `src/prompts/index.ts` barrel beside `buildChatInstructions`.
- `packages/nax/src/agents/acp/index.ts` — re-exports `toEmbedderTools`.
- `packages/nax/src/cli/chat.ts` — `_chatCommandDeps.createAcpCatalog` (production `createAcpCatalog`); `composeChat` passes `acp: deps.createAcpCatalog({ env: deps.env })` to `createChatHost`.
- `packages/nax/src/tui/chat/chat-status.ts` — `modelParts(raw)` names an ACP model by `acpModelLabel` (name = the label without its effort suffix, suffix = `[<effort>]`), so `shortModel` and the header use it.
- `packages/nax/src/tui/chat/picker-model.ts` — `PickerModelInput` gains `modelNote?: (model: string) => string | undefined`; an ACP row's label is `acpModelLabel(base)`; a row with a note shows `unavailable: <note>` as its detail. `useChatPicker` passes `modelNote: (model) => host.modelNote?.(model)` (a bound call, never the bare method).
- `packages/nax/src/tui/chat/use-switch-notices.ts` — the model notice names a model as `shortModel` does (an ACP model by `acpModelLabel`, a native one by its name after the last `/`, effort suffix kept); a brain change (native to ACP, ACP to native, or one agent to another) adds a second notice `<new name> does not see <old name>'s turns`.
- `packages/nax/src/tui/chat/slash-commands.ts`, `packages/nax/src/tui/chat/slash-menu.ts` — the ACP step-aside (US-012). `SlashMenuHost` becomes `Pick<ChatHost, "catalog"> & Partial<Pick<ChatHost, "current">>`; when `current` is absent or throws (no session open yet), the menu offers built-ins plus the catalog, as today.
- `packages/nax/src/tui/chat/ChatApp.tsx`
  - Baseline: `const menuItems = useMemo(() => slashMenuItems(host), [host]);` (built once per host).
  - Target: the memo also depends on the session's current model, so the menu changes when the brain switches between native and ACP.
- `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts`, `script.ts`
  - Baseline: the `session/set_config_option` handler always returns the `configOptions` that session/new returned.
  - Target: `FakeScript` gains `readonly setConfigOptionsAnswer?: readonly SessionConfigOption[]`; when set, the handler returns it as `configOptions` (still refusing an unknown `configId` as today).

### New module: `packages/nax-agent-acp/src/client/offered-choices.ts`

```ts
import type { SessionOffers } from "#src/client/session-offers";

export interface OfferedChoices {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

/** At most this many ids per list. */
export const MAX_OFFERED_CHOICES = 50;

/**
 * Models: every category "model" config option's values in offer order, then offers.modelIds.
 * Efforts: the first category "thought_level" option's values, else the values of the option
 * whose id is EFFORT_FALLBACK_IDS[agentName], else none. Both lists drop duplicates (first kept)
 * and any id that cleanLabel(id, secrets, MODEL_ID_MAX_CHARS) does not return unchanged, then cap.
 * cleanLabel scrubs only secrets of at least MIN_SECRET_LENGTH (8) characters (text.ts).
 */
export function offeredChoices(offers: SessionOffers, agentName: string, secrets: readonly string[]): OfferedChoices;
```

### New modules: `packages/nax/src/chat/acp/`

```ts
// acp-model.ts
export const ACP_CHAT_AGENTS = ["claude", "codex", "cursor"] as const;
export type AcpChatAgent = (typeof ACP_CHAT_AGENTS)[number];
export interface ChatAcpModel { readonly agent: AcpChatAgent; readonly model?: string; readonly effort?: string }
export function isChatAcpModel(model: string): boolean;               // starts with "acp:"
export function parseChatAcpModel(model: string): ChatAcpModel | undefined; // throws CHAT_ACP_MODEL_INVALID
export function acpAgentLabel(agent: AcpChatAgent): string;          // "Claude Code" | "Codex" | "Cursor"
export function acpModelLabel(model: string): string;                // "Claude Code", "Codex · gpt-5.5"
export function acpModelRows(agent: AcpChatAgent, offeredModels: readonly string[]): readonly string[];
export function acpEffortLevels(offeredEfforts: readonly string[]): readonly EffortLevel[];
/** What a `!` command on an ACP brain returns. */
export const ACP_RUN_COMMAND_UNSUPPORTED =
  "! commands run on nax's own models only; the agent runs commands with its own tools";

// acp-tools.ts
export const ACP_CHAT_PROVIDER_IDS: readonly string[]; // ["nax-workflow", "nax-jobs"]
export interface ChatAcpTools { readonly tools: readonly EmbedderTool[]; readonly instructions?: string }
export function chatAcpTools(providers: readonly ToolProvider[], workdir: string): Promise<ChatAcpTools>;

// acp-session-options.ts
/** True for an error that means the stored agent session is unusable (see open-chat-session Target). */
export function isFreshFallback(error: unknown): boolean;
export function ACP_FRESH_SESSION_NOTICE(label: string): string;
//   `${label}'s earlier session could not be resumed; it starts a new one`
export const _acpSessionDeps: { acpBackend: typeof acpBackend; chatAcpTools: typeof chatAcpTools };
export function acpTranscriptDir(sessionsDir: string, agent: AcpChatAgent): string; // join(sessionsDir, `acp-${agent}`)
export function acpSessionOptions(input: {
  readonly acp: ChatAcpModel;
  readonly mode: ChatMode;
  readonly sessionId: string;
  readonly cwd: string;
  readonly toolProviders: readonly ToolProvider[];
  readonly approvalTimeoutMs?: number;
}): Promise<Omit<CreateAgentSessionOptions, "transcriptStore">>;

// acp-catalog.ts
export const _acpCatalogDeps: { launchCandidateKind: typeof launchCandidateKind };
export interface AcpCatalog {
  rows(): readonly string[];
  effortLevels(model: string): readonly EffortLevel[];
  installed(model: string): boolean;
  unavailable(model: string): string | undefined;
  opened(model: string, capabilities: Readonly<Record<string, unknown>>): void;
  failed(model: string, error: unknown): void;
}
export function createAcpCatalog(input: { readonly env: Readonly<Record<string, string | undefined>> }): AcpCatalog;

// acp-write-guard.ts
export const ACP_WRITE_KINDS: readonly string[]; // ["edit", "delete", "move"]
export function acpWriteRefusal(jobs: Pick<ChatJobs, "running">, repoRoot: string, event: ChatApproval): string | undefined;
/** The host's `refuse`: acpWriteRefusal while the current model is an ACP model and jobs exist, else undefined. */
export function acpRefusal(input: {
  readonly jobs: () => Pick<ChatJobs, "running"> | undefined;
  readonly repoRoot: string;
  readonly model: () => string;
}): (event: ChatApproval) => string | undefined;

// acp-host.ts
/**
 * Wraps an opener, forwarding (request, deps) unchanged. On success it reports
 * catalog.opened(handle.meta.model, handle.session.backend.capabilities) when that model is an
 * ACP model; on failure it reports catalog.failed(request.model, error) when request.model is an
 * ACP model (a resume request carries no model, so its failure is not recorded), then rethrows.
 */
export function reportAcpOpens(open: typeof openChatSession, catalog: AcpCatalog | undefined): typeof openChatSession;
/** Throws CHAT_ACP_AGENT_UNAVAILABLE for an ACP model whose agent is not installed; no-op otherwise or without a catalog. */
export function assertAcpInstalled(catalog: AcpCatalog | undefined, model: string): void;

// index.ts — barrel; @/chat re-exports isChatAcpModel, parseChatAcpModel, acpAgentLabel,
// acpModelLabel, ACP_RUN_COMMAND_UNSUPPORTED, createAcpCatalog and the AcpCatalog /
// AcpChatAgent / ChatAcpModel types. ChatHost gains the optional `modelNote?(model: string): string | undefined`.
```

`_acpSessionDeps.acpBackend` is `acpBackend` from `@nathapp/nax-agent-acp/client`. `rows()` lists,
for each agent in `ACP_CHAT_AGENTS` order, `acp:<agent>` followed by that agent's learned
`acpModelRows`. A catalog learns from `opened` only `offeredModels` / `offeredEfforts` entries that
are arrays, keeping their string elements, and only when at least one string remains: an absent,
non-array or empty report keeps that agent's previous list (a `session/resume` or `session/load`
answer often carries no config options, so a reopen reports none).

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A model string starts `acp:` but names another agent, no model after `/`, or a model with `[` / `]` | `parseChatAcpModel` throws `NaxError` `CHAT_ACP_MODEL_INVALID` (`stage: "chat"`). |
| Start or switch to an ACP model whose agent's binary does not resolve | `CHAT_ACP_AGENT_UNAVAILABLE` (`stage: "chat"`, message names the agent label and `not installed`); the current session stays open and unchanged. |
| An ACP open fails with `AGENT_SESSION_AUTH_REQUIRED` | The catalog records `not logged in`; the error propagates as today (a switch reopens the previous brain, `switchSession`'s rollback). |
| An ACP open fails with `AGENT_SESSION_BACKEND_UNAVAILABLE` | The catalog records the first line of the message, at most 120 characters (the picker shows it as `unavailable: <reason>`); the error propagates. |
| A later open of that agent succeeds | The recorded failure is cleared. |
| Resuming the agent's stored document fails with an error `isFreshFallback` accepts | The document is retained (`retainFailed`), a fresh agent session is created on the same session id, and the handle's `notice` says so (`host.notice()` returns it). |
| Resuming it fails with any other error (`AGENT_SESSION_AUTH_REQUIRED`, `AGENT_SESSION_BACKEND_UNAVAILABLE`, a timeout, or `AGENT_SESSION_CAPABILITY_UNSUPPORTED` for `"model"` when the restored session offers no model option) | The error propagates and the document is kept; a switch rolls back to the previous brain (`switchSession`). |
| Any other ACP open failure (`AGENT_SESSION_CAPABILITY_UNSUPPORTED` on a new session, `AGENT_SESSION_MODEL_MISMATCH`, a timeout) | Propagates; the catalog records nothing. |
| A workflow or jobs provider's `tools()` rejects | That provider contributes no tools (`resolveProviderTools`); the session opens. |
| A guarded ACP brain asks to edit, delete or move while a chat-started plan or run job holds this checkout | Answered `deny` without a card (the refusal text is not delivered to the agent; the answer carries no reason). |
| The same request in full mode | Not seen by nax (the ACP `full` profile allows); not guarded. |
| `!` command on an ACP brain | `{ isError: true, content: ACP_RUN_COMMAND_UNSUPPORTED }`. |

## Out of Scope

- Carrying the conversation across a brain switch, recording ACP turns in nax's transcript, and replaying earlier turns into a newly opened agent; feature F3. Until then each brain sees only its own turns.
- Showing an ACP brain's own earlier turns when a session is resumed; `history` replays the native document only (F3).
- Gemini, OpenCode and pi as chat brains; not listed.
- Workflow tools on the `nax-agent` ACP server that koda connects to; a separate later feature.
- Guarding an ACP brain's writes in full mode, and guarding writes done through a shell command (`execute` kind) or a tool call of kind `other` in either mode.
- Changing an agent's model when its restored session offers no model option: nax-agent-acp refuses (`capability: "model"`), the error propagates and the switch rolls back; nax does not start a fresh agent session for it.
- Shrinking an agent's learned effort or model list when a later report is empty; the previous list is kept.
- Applying the 50-id cap after Cursor's bare-name reduction; the cap applies to the offered ids, so a Cursor offer with many settings variants may list few rows.
- Bridging nax's background Bash and ctrl+b, nax subagents, the nax skill loader, nax's MCP pool, nax compaction, the command shadow or nax's rules delivery to an ACP brain; they step aside (the agent's own equivalents apply).
- Cursor models whose bare name several offered ids share; they are not listed as rows.
- Removing an empty session's ACP transcript document or the agent's own session when the empty chat session's metadata is removed.
- A nax sandbox or nax permission rules around an ACP brain; the agent's own settings apply (user ruling 2026-10-29).
- Starting an agent only to list its models; rows fill in after the agent's first open in this chat process and are not persisted.
- Running the real claude-agent-acp, codex-acp or cursor-agent in CI; live checks stay a maintainer-run probe.
- Registering the chat ACP agent's pid with a pid registry (`onPidSpawned`): `nax chat` has no run runtime; the process is closed with the session, and one left by a SIGKILL of nax is not reaped.
- Detecting an auth failure that first appears at a turn rather than at open; the catalog records only open failures.
- An agent that supports neither `session/resume` nor `session/load`: each reopen of it (mode toggle, effort or model change, `/resume`) starts a fresh agent session with the `ACP_FRESH_SESSION_NOTICE` notice.
- Resending the ACP brain's system instructions on a reopen; they are mode-neutral, so nothing in them goes stale.
- Sharing the newest-blocking-job selection between `createJobWriteGuard` and `acpWriteRefusal`; the ACP guard repeats the same three-condition selection.
- Delivering a write refusal's reason text to the agent; it receives a plain deny.
- Updating `.nax/mono/packages/nax/context.md` or `.nax/mono/packages/nax-agent-acp/context.md`, which are read-only to the run; a manual follow-up after merge.


## Stories

Twelve stories, one capability (`nax chat` on an ACP brain). US-001 is in
`packages/nax-agent-acp`; the rest are in `packages/nax`.

### US-001 — the backend reports the models and efforts an agent offers

Workdir: packages/nax-agent-acp. No dependencies.

New `src/client/offered-choices.ts` (`offeredChoices`, `MAX_OFFERED_CHOICES`), `applyConfig`
returning its final offers, `OpenedAcp.offered`, `offeredModels` / `offeredEfforts` in the
backend's capability report, and the fake agent's `setConfigOptionsAnswer`.

### US-002 — make room in the chat host

Workdir: packages/nax. No dependencies.

Two pure moves out of `chat-host.ts`: `allSessions` / `latestId` become
`listCwdSessions(storage, cwd)` and `latestResumableId({ storage, cwd, logger })` in new
`src/chat/session-listing.ts`, and `closeSessionAndResources` becomes
`closeChatResources({ hygiene, handle, tasks, resources, chain })` in `src/chat/session-hygiene.ts`.
The host calls them; behaviour is unchanged and `chat-host.ts` ends at most 560 lines.

### US-003 — chat ACP model strings

Workdir: packages/nax. No dependencies.

New `src/chat/acp/acp-model.ts` and the `src/chat/acp/index.ts` barrel, re-exported from `@/chat`.

### US-004 — the workflow tools and instructions for an ACP brain

Workdir: packages/nax. Depends on US-003.

New `src/chat/acp/acp-tools.ts`, `toEmbedderTools` re-exported from `@/agents/acp`, and the
mode-neutral `buildChatAcpInstructions` in the chat prompt builder, exported from `@/prompts`.
Verification note: `bun run check:import-cycles` stays green with `@/chat` importing `@/agents/acp`.

### US-005 — ACP session options

Workdir: packages/nax. Depends on US-003, US-004.

New `src/chat/acp/acp-session-options.ts`: `acpTranscriptDir`, `acpSessionOptions`,
`isFreshFallback`, `ACP_FRESH_SESSION_NOTICE` and the `_acpSessionDeps` seam.

### US-006 — opening a chat session on an ACP agent

Workdir: packages/nax. Depends on US-005.

The ACP branch of `openChatSession`: model parsed before the lock, the agent store, create or
resume, the retained-and-fresh fallback with its handle `notice`, and native history.

### US-007 — the ACP agent catalog

Workdir: packages/nax. Depends on US-001, US-003.

New `src/chat/acp/acp-catalog.ts`: rows, learned models and efforts, installed check, recorded
failures.

### US-008 — the host lists the agents

Workdir: packages/nax. Depends on US-002, US-007.

`ChatHostDeps.acp`, the `models` getter, `effortLevels`, `ChatHost.modelNote`, and `nax chat`
passing the catalog.

### US-009 — the host opens, refuses and reports ACP brains

Workdir: packages/nax. Depends on US-006, US-008.

New `src/chat/acp/acp-host.ts` (`reportAcpOpens`, `assertAcpInstalled`) and the host's call sites:
open reporting, the not-installed refusal, no context-window lookup, the `!` command message, and
`notice()` reading the handle's notice. `chat-host.ts` stays at or under 600 lines.

### US-010 — guarded write refusal while a job holds the checkout

Workdir: packages/nax. Depends on US-003, US-009.

New `src/chat/acp/acp-write-guard.ts` (`acpWriteRefusal`, `acpRefusal`),
`ChatAskControllerOptions.refuse`, and the host's one-line wiring.

### US-011 — the picker, status line and switch notices name the agent

Workdir: packages/nax. Depends on US-003, US-008.

`modelParts` / `shortModel`, picker labels and `unavailable:` details, `useChatPicker` passing a
bound `modelNote`, and the brain-change notice.

### US-012 — native-only slash commands step aside

Workdir: packages/nax. Depends on US-003, US-008.

`/skills`, `/mcp`, `/agents`, unknown slash commands, `/help` and the slash menu on an ACP brain,
and `ChatApp`'s menu memo following the current model. Every other built-in (`/plugins`,
`/feature`, `/jobs`, `/cost`, `/sessions`, `/resume`, `/clear`, `/mode`, `/model`, `/effort`,
`/quit`) behaves on an ACP brain as it does today.

### Context Files

**US-001**
- `packages/nax-agent-acp/src/client/open.ts`
- `packages/nax-agent-acp/src/client/backend.ts`
- `packages/nax-agent-acp/src/client/capabilities.ts`
- `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts`
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`

**US-002**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/session-hygiene.ts`
- `packages/nax/test/unit/chat/chat-host.test.ts`

**US-003**
- `packages/nax/src/chat/chat-effort.ts`
- `packages/nax/src/chat/index.ts`
- `packages/nax-agent/src/cost/model-spec.ts`

**US-004**
- `packages/nax/src/agents/acp/provider-embedder.ts`
- `packages/nax/src/agents/acp/index.ts`
- `packages/nax/src/prompts/builders/chat-builder.ts`
- `packages/nax/src/prompts/index.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`

**US-005**
- `packages/nax-agent-acp/src/client/options.ts`
- `packages/nax-agent-acp/src/client/errors.ts`
- `packages/nax/src/chat/chat-mode.ts`
- `packages/nax/src/chat/acp/acp-tools.ts` — created by US-004, used here

**US-006**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/test/unit/chat/open-chat-session.test.ts`
- `packages/nax/src/chat/acp/acp-session-options.ts` — created by US-005, used here

**US-007**
- `packages/nax-agent-acp/src/client/launchable.ts`
- `packages/nax/src/chat/acp/acp-model.ts` — created by US-003, used here
- `packages/nax-agent-acp/src/client/offered-choices.ts` — created by US-001; the field names it reports are the contract read here

**US-008**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/chat/acp/acp-catalog.ts` — created by US-007, wired here
- `packages/nax/test/unit/chat/chat-host.test.ts`

**US-009**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/chat/acp/acp-catalog.ts` — created by US-007
- `packages/nax/test/unit/chat/chat-host-context-window.test.ts`

**US-010**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/chat/jobs/job-write-guard.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts`
- `packages/nax-agent-acp/src/client/tool-display.ts`

**US-011**
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/picker-model.ts`
- `packages/nax/src/tui/chat/useChatPicker.ts`
- `packages/nax/src/tui/chat/use-switch-notices.ts`
- `packages/nax/src/chat/acp/acp-model.ts` — created by US-003

**US-012**
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/slash-menu.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/chat/acp/acp-model.ts` — created by US-003

### Creates

**US-001**
- `packages/nax-agent-acp/src/client/offered-choices.ts`
- `packages/nax-agent-acp/test/unit/client/offered-choices.test.ts`
- `packages/nax-agent-acp/test/unit/client/backend-offered-choices.test.ts`

**US-002**
- `packages/nax/src/chat/session-listing.ts`
- `packages/nax/test/unit/chat/session-listing.test.ts`
- `packages/nax/test/unit/chat/close-chat-resources.test.ts`

**US-003**
- `packages/nax/src/chat/acp/acp-model.ts`
- `packages/nax/src/chat/acp/index.ts`
- `packages/nax/test/unit/chat/acp/acp-model.test.ts`

**US-004**
- `packages/nax/src/chat/acp/acp-tools.ts`
- `packages/nax/test/unit/chat/acp/acp-tools.test.ts`

**US-005**
- `packages/nax/src/chat/acp/acp-session-options.ts`
- `packages/nax/test/unit/chat/acp/acp-session-options.test.ts`

**US-006**
- `packages/nax/test/unit/chat/open-chat-session-acp.test.ts`

**US-007**
- `packages/nax/src/chat/acp/acp-catalog.ts`
- `packages/nax/test/unit/chat/acp/acp-catalog.test.ts`

**US-008**
- `packages/nax/test/unit/chat/chat-host-acp-models.test.ts`

**US-009**
- `packages/nax/src/chat/acp/acp-host.ts`
- `packages/nax/test/unit/chat/chat-host-acp.test.ts`

**US-010**
- `packages/nax/src/chat/acp/acp-write-guard.ts`
- `packages/nax/test/unit/chat/acp/acp-write-guard.test.ts`

**US-011**
- `packages/nax/test/unit/tui/chat/acp-labels.test.ts`

**US-012**
- `packages/nax/test/unit/tui/chat/slash-commands-acp.test.ts`

### Modifies

Apart from the two fixture files below, every change is additive or keeps today's behaviour for native models, so no existing assertion breaks. US-001's capability report only gains fields, the existing backend tests compare it with toMatchObject, and applyConfig is module-private. US-002 is a pure move, and the host tests drive the host's public methods. US-003, US-004, US-005 and US-007 add new modules and barrel exports only; buildChatInstructions and its output are unchanged. US-006 keeps the native branch of openChatSession as it is (its options, its single native transcript store call and its history), and the ACP seams live on the new _acpSessionDeps. US-008's ChatHostDeps.acp and ChatHost.modelNote are optional, and a host without a catalog keeps today's models list, so the existing CLI and host model assertions hold. US-009's reportAcpOpens forwards every open's arguments unchanged, so existing assertions on the open stub's calls hold. US-010's ChatAskControllerOptions.refuse is optional. US-011 and US-012 keep today's labels, details, notices, commands and menu for native model strings, and SlashMenuHost's new current member is optional.

**US-001**
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — `FakeScript` gains the optional field `setConfigOptionsAnswer?: readonly SessionConfigOption[]` (the configOptions a set_config_option answer returns). No existing field or default changes.
- `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts` — the set_config_option handler returns `{ configOptions: script.setConfigOptionsAnswer }` when that field is set, and `{ configOptions }` exactly as today otherwise; the unknown-`configId` refusal is unchanged.

### Seams

- US-001 → US-007 → US-009: the capability report's `offeredModels` / `offeredEfforts` reach the catalog through the host's open reporting (US-009 ACs open a stubbed ACP session whose `backend.capabilities` carries them and read `host.models`).
- US-003 → US-006: `parseChatAcpModel` selects the ACP branch (US-006 ACs call `openChatSession` with an `acp:` model and observe `_acpSessionDeps.acpBackend`).
- US-004 → US-005 → US-006: `chatAcpTools` and `buildChatAcpInstructions` feed the options (US-006 ACs observe the `tools` and `instructions` `createAgentSession` receives from `openChatSession`).
- US-007 → US-008: `createAcpCatalog` is built by `chatCommand` (US-008 AC stubs `_chatCommandDeps.createAcpCatalog` and observes `createChatHost`'s input).
- US-009 → US-010: the host passes `refuse` to its ask controller (US-010 ACs drive `host.send` with a stubbed session emitting an approval).
- US-008 → US-011: `host.modelNote` reaches the picker through `useChatPicker` (US-011 AC renders the picker through the hook for a host built by `createChatHost`).
- US-008 → US-012: the host's current model reaches the slash menu through `ChatApp` (US-012 AC renders `ChatApp` and switches the model).

## Acceptance Criteria

### US-001

1. [unit] `offeredChoices` for offers whose config options are one category `"model"` select option with values `"a"` and `"b"` and whose `modelIds` are `["c"]` returns `models` equal to `["a", "b", "c"]`.
2. [unit] `offeredChoices` for config model values `["a"]` and `modelIds` `["a"]` returns `models` equal to `["a"]`.
3. [unit] `offeredChoices` for a category `"thought_level"` select option with values `"low"` and `"high"` returns `efforts` equal to `["low", "high"]`.
4. [unit] `offeredChoices` for agent `"codex"` with no `"thought_level"` option and an option with id `"reasoning_effort"` and values `"low"`, `"medium"` returns `efforts` equal to `["low", "medium"]`.
5. [unit] `offeredChoices` for agent `"cursor"` with no `"thought_level"` option and an option with id `"reasoning_effort"` returns `efforts` equal to `[]`.
6. [unit] `offeredChoices` drops a model id containing a newline character and keeps the others.
7. [unit] `offeredChoices` with secrets `["s3cret-value"]` drops the model id `"x-s3cret-value"`.
8. [unit] `offeredChoices` drops a model id longer than `MODEL_ID_MAX_CHARS` characters.
9. [unit] `offeredChoices` for 60 distinct offered model ids returns exactly `MAX_OFFERED_CHOICES` (50) models, the first 50 in offer order.
10. [unit] `offeredChoices` for offers with no config options and no model ids returns `{ models: [], efforts: [] }`.
11. [integration] An `acpBackend({ agent: "codex" })` session against a fake agent whose session/new offers `CODEX_CONFIG_OPTIONS` (the fixture's mode option) plus a `"model"` option with values `"gpt-5.5"` and `"gpt-5.4"` reports `backend.capabilities.offeredModels` equal to `["gpt-5.5", "gpt-5.4"]`.
12. [integration] That session, whose session/new also offers a `"thought_level"` option with values `"low"` and `"high"`, reports `backend.capabilities.offeredEfforts` equal to `["low", "high"]`.
13. [integration] A codex session opened with `model: "gpt-5.4"` against a fake agent whose `setConfigOptionsAnswer` carries the mode option plus a `"model"` option with the single value `"gpt-5.4"` reports `offeredModels` equal to `["gpt-5.4"]` (the offers after the model step).
14. [integration] A fake agent with `setConfigOptionsAnswer` set answers set_config_option with exactly those options.
15. [integration] A fake agent without `setConfigOptionsAnswer` answers set_config_option with its session/new options, as today.
16. [integration] A session against a fake agent offering no config options reports `offeredModels` equal to `[]` and `offeredEfforts` equal to `[]`.

### US-002

1. [unit] `listCwdSessions(storage, "/repo")` for a storage whose `list` returns two pages joined by a `nextCursor` returns the sessions of both pages in page order.
2. [unit] `listCwdSessions` passes `{ cwd: "/repo" }` on the first `list` call and `{ cwd: "/repo", cursor }` on the second.
3. [unit] `latestResumableId` returns the first listed session whose metadata has `updatedAt` set, whose `mode` is `ask` or `full`, and whose lock holder is not `live`.
4. [unit] `latestResumableId` skips a session whose lock holder state is `live`.
5. [unit] `latestResumableId` skips a session whose metadata `updatedAt` is `null`.
6. [unit] `latestResumableId` skips a session whose `readMeta` returns `null`.
7. [unit] `latestResumableId` skips a session whose metadata `sessionId` differs from the listed id.
8. [unit] `latestResumableId` skips a session whose `readMeta` throws `SESSION_META_UNREADABLE`, and calls `logger.warn` with `"chat"`, `"skipping unreadable session metadata"`.
9. [unit] `latestResumableId` rethrows an error from `readMeta` whose code is not `SESSION_META_UNREADABLE`.
10. [unit] `latestResumableId` with no resumable session throws `NaxError` `CHAT_SESSION_NOT_FOUND` whose message names the cwd.
11. [unit] `closeChatResources` with a `hygiene.close` that rejects still calls `tasks.stopAll`, `resources.teardown` and `chain.destroy`, then rejects with the `hygiene.close` error.
12. [unit] `closeChatResources` with no handle calls `tasks.stopAll`, then `resources.teardown`, then `chain.destroy`, in that order.
13. [integration] `host.resume({})` on a host whose storage lists three sessions, the first held `live`, resumes the second.
14. [integration] `host.listSessions()` on a host whose storage lists 60 sessions across two pages returns rows for sessions on both pages.
15. [integration] `host.close()` on a host with an open session closes that session and calls the resources' `teardown` once.

### US-003

1. [unit] `parseChatAcpModel("acp:claude")` returns `{ agent: "claude" }`.
2. [unit] `parseChatAcpModel("acp:codex/gpt-5.5")` returns `{ agent: "codex", model: "gpt-5.5" }`.
3. [unit] `parseChatAcpModel("acp:codex/gpt-5.5[high]")` returns `{ agent: "codex", model: "gpt-5.5", effort: "high" }`.
4. [unit] `parseChatAcpModel("acp:codex[high]")` returns `{ agent: "codex", effort: "high" }`.
5. [unit] `parseChatAcpModel("openai/gpt-6")` returns `undefined`.
6. [unit] `parseChatAcpModel("acp:gemini")` throws `NaxError` with code `CHAT_ACP_MODEL_INVALID`.
7. [unit] `parseChatAcpModel("acp:claude/")` throws `CHAT_ACP_MODEL_INVALID`.
8. [unit] `parseChatAcpModel("acp:claude/x]y")` throws `CHAT_ACP_MODEL_INVALID`.
9. [unit] `isChatAcpModel("acp:cursor")` is `true` and `isChatAcpModel("anthropic/claude-sonnet-4-5")` is `false`.
10. [unit] `acpAgentLabel("codex")` returns `"Codex"` and `acpAgentLabel("cursor")` returns `"Cursor"`.
11. [unit] `acpModelLabel("acp:claude")` returns `"Claude Code"`.
12. [unit] `acpModelLabel("acp:codex/gpt-5.5[high]")` returns `"Codex · gpt-5.5[high]"`.
13. [unit] `acpModelLabel("acp:codex[high]")` returns `"Codex[high]"`.
14. [unit] `acpModelLabel("acp:gemini")` returns `"acp:gemini"` without throwing.
15. [unit] `acpModelRows("codex", ["gpt-5.5", "gpt-5.4"])` returns `["acp:codex/gpt-5.5", "acp:codex/gpt-5.4"]`.
16. [unit] `acpModelRows("claude", ["sonnet", "sonnet[1m]", "opus"])` returns `["acp:claude/sonnet", "acp:claude/opus"]`.
17. [unit] `acpModelRows("cursor", ["default[]", "sonnet-4.5[thinking=true]", "auto", "auto"])` returns `["acp:cursor/default", "acp:cursor/sonnet-4.5", "acp:cursor/auto"]`.
18. [unit] `acpModelRows("cursor", ["gpt-5.5[reasoning=low]", "gpt-5.5[reasoning=high]", "auto"])` returns `["acp:cursor/auto"]`.
19. [unit] `acpEffortLevels(["low", "high", "turbo"])` returns `["default", "low", "high"]` (unknown values dropped, canonical order).
20. [unit] `acpEffortLevels([])` returns `["default"]`.
21. [unit] `acpModelLabel` imported from `@/chat` returns `"Cursor"` for `"acp:cursor"`.

### US-004

1. [unit] `chatAcpTools([workflowProvider, jobsProvider, skillsProvider], "/repo")`, where the providers have ids `nax-workflow`, `nax-jobs` and `nax-skills`, returns tools whose names all start with `nax-workflow__` or `nax-jobs__`.
2. [unit] That result contains the tool `nax-workflow__state`.
3. [unit] Every tool in that result has `approval` equal to `"never"`.
4. [unit] A `nax-workflow` provider whose `stages` is `["chat"]` still contributes its tools (the stage passed to `resolveProviderTools` is `"chat"`).
5. [unit] Running the returned `nax-workflow__state` tool calls the provider tool's `run` with the given input and a context whose `root` is `"/repo"`.
6. [unit] A returned tool whose provider tool throws `new Error("boom")` resolves to `{ content: "boom", isError: true }`.
7. [unit] `chatAcpTools` with a `nax-jobs` provider whose `tools()` rejects returns only the `nax-workflow` tools.
8. [unit] `chatAcpTools` for providers whose `instructions()` return `"W"` and `"J"` returns `instructions` that contain `"W"` and `"J"`.
9. [unit] `chatAcpTools` for providers with no `instructions` returns a result without an `instructions` field.
10. [unit] `chatAcpTools([], "/repo")` returns `{ tools: [] }`.
11. [unit] `buildChatAcpInstructions({ agentLabel: "Codex" })` returns text naming `"Codex"` and `"nax chat"`.
12. [unit] `buildChatAcpInstructions({ agentLabel: "Codex" })` names neither `"guarded"` nor `"full"` and never mentions `unsandboxed`.
13. [unit] `buildChatAcpInstructions({ agentLabel: "Codex", toolInstructions: "T" })` ends with `"T"`.
14. [unit] `buildChatAcpInstructions` imported from `@/prompts` returns the same text as the builder module's export.
15. [unit] `toEmbedderTools` imported from `@/agents/acp` turns one `CodingTool` named `x__y` into one embedder tool named `x__y`.

### US-005

1. [unit] `acpTranscriptDir("/s", "codex")` returns `"/s/acp-codex"`.
2. [unit] `acpSessionOptions` for `{ agent: "codex", model: "gpt-5.5", effort: "high" }` calls `_acpSessionDeps.acpBackend` with `{ agent: "codex", allowUnsandboxed: true, inheritEnv: true, model: "gpt-5.5", effort: "high" }`.
3. [unit] `acpSessionOptions` for `{ agent: "claude" }` calls `_acpSessionDeps.acpBackend` with `{ agent: "claude", allowUnsandboxed: true, inheritEnv: true }` (no `model`, no `effort` key).
4. [unit] `acpSessionOptions` with mode `guarded` returns `profile: "ask"`.
5. [unit] `acpSessionOptions` with mode `full` returns `profile: "full"`.
6. [unit] `acpSessionOptions` returns the `tools` `_acpSessionDeps.chatAcpTools` resolved for the given providers and `cwd`.
7. [unit] `acpSessionOptions` returns `instructions` equal to `buildChatAcpInstructions({ agentLabel, toolInstructions })` for the agent's label and the tools' instructions.
8. [unit] `acpSessionOptions` returns `sessionId` and `approvalTimeoutMs` from its input, and `workdir` equal to the input `cwd`.
9. [unit] `isFreshFallback` is `true` for an `AgentSessionError` with code `AGENT_SESSION_NOT_FOUND`, and for one with code `AGENT_SESSION_BACKEND_MISMATCH`.
10. [unit] `isFreshFallback` is `true` for a `NaxError` with code `TRANSCRIPT_CORRUPT`.
11. [unit] `isFreshFallback` is `true` for `AGENT_SESSION_CAPABILITY_UNSUPPORTED` with `context.capability` `"resume"`, and `false` for the same code with `context.capability` `"model"`.
12. [unit] `isFreshFallback` is `false` for `AGENT_SESSION_AUTH_REQUIRED` and for `AGENT_SESSION_BACKEND_UNAVAILABLE`.
13. [unit] `ACP_FRESH_SESSION_NOTICE("Codex")` returns `"Codex's earlier session could not be resumed; it starts a new one"`.

### US-006

1. [integration] `openChatSession` for a new session with model `"acp:codex/gpt-5.5"` and mode `guarded` calls `createAgentSession` once with a backend from `_acpSessionDeps.acpBackend` and `profile: "ask"`.
2. [integration] That open never calls `_openChatSessionDeps.nativeBackend` and never calls `_openChatSessionDeps.buildCommandShadow`.
3. [integration] That open passes `createAgentSession` the file transcript store created for `<storage dir>/acp-codex`.
4. [integration] That open passes `createAgentSession` `instructions` that contain `"Codex"` and the `nax-workflow` provider's instructions text.
5. [integration] `openChatSession` with model `"acp:codex"` passes `createAgentSession` tools whose names start with `nax-workflow__` or `nax-jobs__` only, for `toolProviders` that also include a `nax-skills` provider.
6. [integration] `openChatSession` resuming a session whose metadata model is `"acp:codex"` and whose `acp-codex` store has a document calls `resumeAgentSession` with the session id and the `acp-codex` store.
7. [integration] Resuming a session whose metadata model is `"acp:claude"`, whose `acp-claude` store has no document, calls `createAgentSession` with the same session id.
8. [integration] A resume whose `resumeAgentSession` rejects with `AGENT_SESSION_NOT_FOUND` calls `retainFailed(sessionId)` on the `acp-codex` store and then `createAgentSession` once.
9. [integration] That fallback returns a handle whose `notice` is `ACP_FRESH_SESSION_NOTICE("Codex")`.
10. [integration] A resume whose `resumeAgentSession` rejects with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and `context.capability` `"resume"` takes the same fallback (retained, then created).
11. [integration] A resume whose `resumeAgentSession` rejects with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and `context.capability` `"model"` rejects with that error and never calls `retainFailed`.
12. [integration] A resume whose `resumeAgentSession` rejects with `AGENT_SESSION_BACKEND_UNAVAILABLE` rejects with that error and never calls `createAgentSession`.
13. [integration] A resume whose `resumeAgentSession` rejects with `AGENT_SESSION_AUTH_REQUIRED` rejects with that error and never calls `retainFailed`.
14. [integration] A handle opened without a fallback has no `notice`.
15. [integration] `openChatSession` with model `"acp:codex"` for a session whose native store holds a document with two messages returns `history.messages` equal to those two messages.
16. [integration] `openChatSession` for a new session with model `"acp:gemini"` rejects with `CHAT_ACP_MODEL_INVALID` and never calls `storage.acquireLock`.
17. [integration] `openChatSession` with a native model `"openai/gpt-6"` still calls `_openChatSessionDeps.nativeBackend` and never calls `_acpSessionDeps.acpBackend`.

### US-007

1. [unit] With `_acpCatalogDeps.launchCandidateKind` returning `"local"` for every agent, `rows()` returns `["acp:claude", "acp:codex", "acp:cursor"]`.
2. [unit] After `opened("acp:codex", { offeredModels: ["gpt-5.5", "gpt-5.4"] })`, `rows()` returns `["acp:claude", "acp:codex", "acp:codex/gpt-5.5", "acp:codex/gpt-5.4", "acp:cursor"]`.
3. [unit] After `opened("acp:codex/gpt-5.5", { offeredModels: ["gpt-5.5"] })` and then `opened("acp:codex", { offeredModels: ["gpt-5.4"] })`, `rows()` lists `acp:codex/gpt-5.4` and not `acp:codex/gpt-5.5` (a non-empty report replaces the agent's rows).
4. [unit] After `opened("acp:codex", { offeredModels: ["gpt-5.5"] })` and then `opened("acp:codex", { offeredModels: "gpt-5.4" })` (not an array), `rows()` still lists `acp:codex/gpt-5.5`.
5. [unit] After `opened("acp:codex", { offeredModels: ["gpt-5.5"], offeredEfforts: ["high"] })` and then `opened("acp:codex", { offeredModels: [], offeredEfforts: [] })`, `rows()` still lists `acp:codex/gpt-5.5` and `effortLevels("acp:codex")` is still `["default", "high"]`.
6. [unit] `opened` with `offeredModels` `["gpt-5.5", 7]` learns only `gpt-5.5`.
7. [unit] `effortLevels("acp:codex")` before any open returns `["default"]`.
8. [unit] After `opened("acp:codex", { offeredEfforts: ["low", "high"] })`, `effortLevels("acp:codex/gpt-5.5[high]")` returns `["default", "low", "high"]`.
9. [unit] With `launchCandidateKind` returning `undefined` for `cursor`, `installed("acp:cursor")` is `false` and `unavailable("acp:cursor")` is `"not installed"`.
10. [unit] With `launchCandidateKind` returning `"npx"` for `claude`, `installed("acp:claude")` is `true`.
11. [unit] `createAcpCatalog({ env })` passes `env` to `launchCandidateKind`, calling it exactly once per agent across repeated `rows()`, `installed` and `unavailable` calls.
12. [unit] After `failed("acp:codex", error)` with an `AgentSessionError` of code `AGENT_SESSION_AUTH_REQUIRED`, `unavailable("acp:codex/gpt-5.5")` is `"not logged in"`.
13. [unit] After `failed("acp:codex", error)` with code `AGENT_SESSION_BACKEND_UNAVAILABLE` and message `"spawn failed\nmore"`, `unavailable("acp:codex")` is `"spawn failed"`.
14. [unit] For a `AGENT_SESSION_BACKEND_UNAVAILABLE` message whose first line is 200 characters, `unavailable` returns its first 120 characters.
15. [unit] After `failed("acp:codex", error)` with code `AGENT_SESSION_MODEL_MISMATCH`, `unavailable("acp:codex")` is `undefined`.
16. [unit] After `failed` with `AGENT_SESSION_AUTH_REQUIRED` and then `opened("acp:codex", {})`, `unavailable("acp:codex")` is `undefined`.
17. [unit] `unavailable("openai/gpt-6")` is `undefined` and `installed("openai/gpt-6")` is `true`.

### US-008

1. [unit] `chatCommand` with `_chatCommandDeps.createAcpCatalog` stubbed calls it once with `{ env: deps.env }`.
2. [unit] That `chatCommand` passes the stub's return value as `acp` to `createChatHost`.
3. [integration] A host created with `models: ["openai/gpt-6"]` and a catalog whose `rows()` returns `["acp:claude"]` has `models` equal to `["openai/gpt-6", "acp:claude"]`.
4. [integration] A host created without `acp` and with `models: ["openai/gpt-6"]` has `models` equal to `["openai/gpt-6"]`.
5. [integration] A host whose catalog's `rows()` changes between two reads of `host.models` returns the new rows on the second read.
6. [integration] `host.effortLevels("acp:codex")` returns the catalog's `effortLevels("acp:codex")`.
7. [integration] `host.effortLevels("acp:codex")` on a host without a catalog returns `["default"]`.
8. [integration] `host.effortLevels("openai/gpt-6")` on a host with a catalog returns what it returns today (the deps' map, else `EFFORT_LEVELS`).
9. [integration] `host.modelNote("acp:cursor")` returns the catalog's `unavailable("acp:cursor")`.
10. [integration] `host.modelNote("acp:cursor")` on a host without a catalog returns `undefined`.

### US-009

1. [integration] `host.start({ mode: "guarded", model: "acp:codex" })` with an `open` stub whose session's `backend.capabilities` is `{ offeredModels: ["gpt-5.5"] }` calls the catalog's `opened("acp:codex", { offeredModels: ["gpt-5.5"] })`.
2. [integration] With a real catalog (`launchCandidateKind` stubbed `"local"`), after that start `host.models` includes `"acp:codex/gpt-5.5"`.
3. [integration] `host.switchTo({ model: "acp:claude" })` whose `open` rejects with `AGENT_SESSION_AUTH_REQUIRED` calls the catalog's `failed("acp:claude", error)`.
4. [integration] That failed switch rejects with the open's error, and afterwards `host.current().model` is the model the host was on before.
5. [integration] `host.switchTo({ model: "acp:cursor" })` on a catalog where `installed("acp:cursor")` is `false` rejects with `NaxError` `CHAT_ACP_AGENT_UNAVAILABLE` whose message contains `"Cursor"` and `"not installed"`.
6. [integration] That refused switch calls neither the current session's `close` nor `open`.
7. [integration] `host.start({ mode: "guarded", model: "acp:cursor" })` on that catalog rejects with `CHAT_ACP_AGENT_UNAVAILABLE` and never calls `open`.
8. [integration] Starting a host on `"acp:codex/gpt-5.5"` never calls `_chatHostDeps.lookupContextWindow`.
9. [integration] After that start `host.current()` has no `contextWindow`.
10. [integration] `host.runCommand("ls", onEvent)` on a session whose model is `"acp:codex"` resolves to `{ isError: true, content: ACP_RUN_COMMAND_UNSUPPORTED }` and never calls the session's `runCommand`.
11. [integration] `host.switchTo({ model: "openai/gpt-6" })` from `"acp:codex"` calls `open` with model `"openai/gpt-6"` and the same session id.
12. [integration] `host.notice()` after a start whose `open` stub returns a handle with `notice: "N"` returns `"N"`.
13. [integration] `host.resume({ id })` whose `open` rejects calls neither the catalog's `failed` nor `opened`, and rejects with the open's error.
14. [unit] `assertAcpInstalled(catalog, "openai/gpt-6")` returns without throwing for a catalog whose `installed` returns `false`.
15. [unit] `assertAcpInstalled(undefined, "acp:cursor")` returns without throwing.
16. [unit] `reportAcpOpens(open, catalog)` for a native model resolves the opener's handle and calls neither `catalog.opened` nor `catalog.failed`.
17. [unit] `reportAcpOpens(open, catalog)` calls `open` with exactly the request and deps it was given.

### US-010

1. [unit] `acpWriteRefusal(jobs, "/repo", event)` for an approval whose `tool` is `"edit"`, with a running `run` job `j1` whose `cwd` is `"/repo"`, returns `"[nax-jobs] edit refused: nax run job j1 is running in this checkout; wait for it to end or cancel it"`.
2. [unit] It returns a refusal for `tool` `"delete"` and for `tool` `"move"` under the same job.
3. [unit] It returns `undefined` for `tool` `"execute"` and for `tool` `"other"` under the same job.
4. [unit] It returns `undefined` for `tool` `"edit"` when the only running job's `cwd` is `"/other"`.
5. [unit] It returns `undefined` for `tool` `"edit"` when the only running job's kind is `bot_review`.
6. [unit] With two running `plan` / `run` jobs in `"/repo"`, the refusal names the one with the latest `startedAt`.
7. [unit] `acpRefusal({ jobs, repoRoot: "/repo", model: () => "openai/gpt-6" })` returns `undefined` for an `edit` approval under a running `run` job in `/repo`.
8. [unit] `acpRefusal` with `jobs` returning `undefined` returns `undefined` for an `edit` approval on an ACP model.
9. [unit] A `ChatAskController` whose `refuse` returns a string, handed an answerable `approval_requested` event, calls `answer(requestId, { decision: "deny" })`, and `pending()` stays empty.
10. [unit] That controller in mode `full` still answers `{ decision: "deny" }` for the refused event.
11. [unit] A controller whose `refuse` returns `undefined` puts the event in `pending()` in mode `guarded`.
12. [unit] A controller without `refuse` behaves as today: in mode `full` an answerable approval is answered `{ decision: "allow" }`.
13. [unit] `refuse` is never called for an event whose `requestId` starts with `"host-"`.
14. [integration] On a host created with resources and a `naxEntry` (as `chat-host-jobs.test.ts` builds one) whose job runner reports a running `run` job in `repoRoot`, a session on `"acp:codex"` whose `send` emits an answerable `approval_requested` with `tool: "edit"` gets `answer` called with `{ decision: "deny" }` during `host.send`.
15. [integration] The same approval on that host with model `"openai/gpt-6"` (native) becomes pending in guarded mode and is not answered.
16. [integration] The same approval on an ACP host with no running job becomes pending in guarded mode.

### US-011

1. [unit] `shortModel("acp:claude")` returns `"Claude Code"`.
2. [unit] `shortModel("acp:codex/gpt-5.5[high]")` returns `"Codex · gpt-5.5[high]"`.
3. [unit] `shortModel("openai/gpt-6")` returns `"gpt-6"` as today.
4. [unit] `shortModel("acp:gemini")` returns without throwing.
5. [unit] `pickerModel` of kind `model` with models `["openai/gpt-6", "acp:codex/gpt-5.5"]` gives the second row the label `"Codex · gpt-5.5"`.
6. [unit] `pickerModel` with `modelNote` returning `"not installed"` for `"acp:cursor"` gives that row the detail `"unavailable: not installed"`.
7. [unit] A row whose `modelNote` returns `undefined` keeps the detail `"effort <level>"`.
8. [unit] `pickerModel` filtering with the query `"codex"` matches the row `"acp:codex/gpt-5.5"`.
9. [integration] The model picker rendered through `useChatPicker` for a host built by `createChatHost` with a catalog whose `installed("acp:cursor")` is `false` draws a row containing `"unavailable: not installed"`.
10. [integration] `useSwitchNotices` after the model changes from `"openai/gpt-6"` to `"acp:codex"` on the same session appends the notices `"model: Codex"` and `"Codex does not see gpt-6's turns"`.
11. [integration] After the model changes from `"acp:codex"` to `"acp:codex/gpt-5.4"` (same agent) it appends `"model: Codex · gpt-5.4"` only.
12. [integration] After the model changes from `"acp:codex"` to `"acp:codex[high]"` it appends `"model: Codex[high]"` only.
13. [integration] After the model changes from `"acp:codex"` to `"openai/gpt-6[high]"` it appends `"model: gpt-6[high]"` and `"gpt-6[high] does not see Codex's turns"`.
14. [integration] After the model changes from `"acp:codex"` to `"acp:claude"` it appends `"model: Claude Code"` and `"Claude Code does not see Codex's turns"`.
15. [integration] After the model changes from `"openai/gpt-6"` to `"openai/gpt-6[high]"` it appends `"model: gpt-6[high]"` only, as today.

### US-012

1. [unit] `runSlashCommand` for `/skills` on a host whose current model is `"acp:codex"` shows `"/skills is not available on Codex: it uses its own skills"`.
2. [unit] `/mcp` on that host shows `"/mcp is not available on Codex: it uses its own MCP servers"`.
3. [unit] `/agents` on that host shows `"/agents is not available on Codex: it uses its own subagents"`.
4. [unit] `/review the diff` on that host, where `review` is a catalog command, returns `{ kind: "send", message: "/review the diff" }`.
5. [unit] `/brainstorming` on that host, where `brainstorming` is a catalog skill, returns `{ kind: "send", message: "/brainstorming" }`.
6. [unit] `/unknownthing x` on that host returns `{ kind: "send", message: "/unknownthing x" }`.
7. [unit] `/help` on that host shows the built-in commands and no catalog command or skill line.
8. [unit] `/model` with no argument on that host still returns `{ kind: "picker", picker: "model" }`.
9. [unit] `/jobs` and `/cost` on that host show the same output as on a native host.
10. [unit] `/skills` on a host whose current model is `"openai/gpt-6"` shows the skills listing as today.
11. [unit] `/unknownthing` on a native host shows `"unknown command /unknownthing"` as today.
12. [unit] `slashMenuItems` for a host whose current model is `"acp:codex"` and whose catalog has one command and one skill returns exactly the built-in items in `COMMANDS` order.
13. [unit] `slashMenuItems` for a host with only a `catalog` (no `current`) returns the built-ins followed by the catalog's command and skill, as today.
14. [unit] `slashMenuItems` for a host whose `current()` throws `CHAT_SESSION_NOT_OPEN` returns the built-ins followed by the catalog's entries.
15. [integration] `ChatApp` rendered for a host with one catalog skill, after its session switches from `"openai/gpt-6"` to `"acp:codex"`, shows a slash menu (typed `/`) that lists no catalog skill.
