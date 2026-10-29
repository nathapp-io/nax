# nax chat on ACP agents (Claude Code, Codex, Cursor) — design

Status: draft, awaiting user approval. Main roadmap: nax as a full coding agent
(TUI + koda chat). Follows slice 2 (workflow dispatch) and chat-run-asks (#2738).

## 1. Intent

Let `nax chat` run on an external coding agent over ACP — Claude Code, Codex or
Cursor — as the chat's main "model", instead of only the native nax-agent session.

Why (user, 2026-10-29): use the subscriptions already paid for (Claude, Codex,
Cursor) and each agent's own skills, from inside the nax chat TUI, while keeping
nax's workflow tools (plan / run / bot review / bot fix) and the job list.

The user's broader pain (roadmap, 10-24): stitching by hand between agents for
different jobs. This slice lets the brainstorm/spec agent of choice and the nax
workflows live in one chat.

## 2. Goals

- G1. The chat model picker lists ACP agents next to native models. Picking one
  makes that agent the brain of the conversation.
- G2. All three ship together: Claude Code, Codex, Cursor.
- G3. Each agent loads its own full setup, like running it directly: its skills,
  plugins, hooks, CLAUDE.md / AGENTS.md, MCP servers and its own allow rules.
- G4. Each agent uses the login already on the machine (subscription), not an API
  key nax asks for.
- G5. The nax workflow tools (the `nax-workflow`, `nax-jobs` tool surface the
  native chat has today) reach all three agents, and run asks keep arriving as
  chat cards (chat-run-asks, #2738).
- G6. Switching brain mid-conversation carries the history over, in every
  direction: native -> ACP, ACP -> native, ACP -> another ACP agent — the same
  experience as switching native models today.
- G7. nax keeps the screen: transcript, tool cards, approval cards and status line
  look the same whichever brain drives.

## 3. Non-goals

- The koda side (workflow tools on the ACP server koda connects to). It is a
  SEPARATE feature (user ruling 10-29), outlined in §9, designed and built after
  this one.
- Gemini, OpenCode, pi as chat brains. The registry has them; they are not in this
  slice. A builder may leave them listable-but-hidden or simply not list them.
- Re-implementing the agent's own features on the nax side (its skills, subagents,
  compaction, background shell). nax's versions step aside (§5.4).
- Changing how `nax run` uses ACP agents. Run sessions keep their current
  profiles and settings handling (read-only profiles still load no settings,
  #2366).

## 4. Anti-goals

- An ACP chat that silently loses nax's workflow tools, or where a run ask is
  denied because nobody could see it (the slice 2 §4.6 gap chat-run-asks closed).
- Double features: two background-shell systems, two skill loaders, two subagent
  systems competing in one session.
- History that disappears on a brain switch.
- nax asking for API keys the user does not need because they have a logged-in
  subscription.

## 5. Design

### 5.1 What exists (verified 2026-10-29, main `cf987b22f`)

- `acpBackend()` (`packages/nax-agent-acp/src/client/backend.ts`) implements the
  same `SessionBackend` contract as the native backend. `nax run` already drives
  claude / codex / cursor / gemini / opencode / pi through it
  (`packages/nax/src/agents/acp/session.ts`).
- Embedder tools reach an ACP agent through a per-session loopback MCP tool host
  (`client/tool-host.ts`, `client/tool-calls.ts`), server name `nax`.
- Only Claude can receive embedder tools today: `client/open.ts:266` throws
  "the agent has no way to pre-approve embedder tools" for any agent without a
  `preApproval` channel, and `client/capabilities.ts:88` refuses tools unless
  `mcpHttp && preApproval`. Codex and Cursor have `preApproval: undefined`
  (`client/registry.ts`).
- Permission requests by profile (`client/permissions.ts`): `full` allows; `ask`
  routes to the caller through the ask port (`asks.requestApproval` + `answer()`)
  — which in chat is the existing AskCard path.
- `nax chat` is hard-wired to `nativeBackend` (`packages/nax/src/chat/open-chat-session.ts:176`).
  Chat's profile is always `full`; its user-facing modes (guarded / full) are
  native options (`chat/chat-mode.ts`: askRules, denyRules, bashApproval, ...).
- Chat's nax tools are native `ToolProvider`s (`cli/chat.ts:204`: skills,
  workflow, MCP pool; plus jobs/chain/agents providers). The ACP backend takes
  `EmbedderTool[]` (`nax-agent/src/session/agent-session-types.ts:68`), not
  providers. ToolProviders are native-only today.
- Brain switch today: `ChatHost.switchSession` (`chat/chat-host.ts:460`) closes
  the session and reopens on the same session id and transcript store; the native
  backend carries history across models (`carryHistoryAcrossModels`).
- Model choices: `chat/chat-models.ts` (native tiers + catalog). Effort levels:
  `chat/chat-effort.ts`.

### 5.2 Picking an ACP agent (G1, G2)

- The picker gains an "Agents" group: Claude Code, Codex, Cursor. Each shows the
  models that agent offers after its session opens (ACP session config options;
  `resolveModelValue` in `client/capabilities.ts` already resolves offered ids).
  Effort shows only when the agent offers it.
- A chat model string names the backend, e.g. `acp:claude` / `acp:claude/<model>`.
  Exact syntax is the builder's (my call: an `acp:` prefix that cannot collide
  with a `<provider>/<model>` catalog string).
- An agent whose binary is missing or not logged in shows as unavailable with the
  reason, rather than failing on pick.

### 5.3 Own setup and login (G3, G4) — user ruling

- Each agent loads its full own configuration, as if run directly. For Claude this
  means NOT passing `settingSources: []` (only the run read-only profiles set it,
  `registry.ts:139`; chat never uses them, so this already holds); for Codex
  and Cursor no isolated config dir / policy file (no `CURSOR_CONFIG_DIR`
  override). The agent's own allow rules and hooks act without a nax card — the
  user accepted this trade-off explicitly.
- Login: the agent's existing local login is used. nax does not require
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CURSOR_API_KEY`; if one is set, the
  agent's own precedence applies. Today `client/env.ts` passes only PATH, HOME,
  USER, SHELL, TMPDIR, LANG, TERM, LC_* and each entry's `authEnv`. My call: a chat
  ACP session inherits the user's full environment (`inheritEnv`), because running
  the agent directly inherits it too and its config-dir variables (CODEX_HOME,
  CLAUDE_CONFIG_DIR, ...) must reach it. Secrets stay in the redaction set for
  display. `nax run` keeps the allowlist.

### 5.4 Chat modes and approvals

- guarded -> ACP profile `ask`: every permission request the agent makes (what its
  own allow list does not already cover) becomes a nax approval card.
- full -> ACP profile `full`: nax allows.
- The mode toggle and model / effort switches keep working. On an ACP brain a
  switch that stays on the same agent reopens through the agent's own resume
  (`client/resume.ts`, session/resume or session/load) when the agent supports it,
  else a fresh session plus replay (§5.6). My call.
- No embedder sandbox for a chat ACP session (`ctx.sandbox` not passed): the user
  ruled "like running it directly", so the agent's own sandbox settings apply and a
  nax sandbox can never make the agent unavailable. My call, from the ruling.
- Native-only features step aside on an ACP brain and are hidden or show
  "not available on <agent>": background Bash + ctrl+b, nax subagents, nax skill
  loader / skill invocation, nax MCP pool, nax compaction, command shadow, the
  native bashApproval posture. The agent's own equivalents take over.

### 5.5 nax workflow tools on every agent (G5)

Two gaps to close:

1. **Providers -> embedder tools.** The workflow / jobs / chain tool surface must be
   offered to an ACP session as `EmbedderTool`s (or the ACP backend learns to take
   providers). Builder chooses; my call: adapt at the nax side (a small adapter
   from the chat's workflow-tool providers to embedder tools) so nax-agent-acp
   keeps its current contract. Only the workflow surface is required: `nax-workflow`
   and `nax-jobs` (`chat/jobs/jobs-provider.ts` plus the chain tools,
   `chat/jobs/chain-tools.ts`). `nax-tasks` is the background-shell provider
   (`chat/background/tasks-provider.ts`), native-only like `nax-skills`,
   `nax-agents` and the MCP pool (§5.4). The adapter keeps each tool's existing
   approval behaviour (plan / run approval unchanged); where a provider decides
   approval inside the tool, the embedder tool keeps doing so, otherwise it maps to
   `approval: "always"`. The chat-run-asks hooks (#2738) stay on the chat host and
   are reached the same way whichever brain launched the job.
2. **Codex and Cursor tool approval.** Without a pre-approval channel the agent will
   ask permission for each `nax` MCP tool call (or nax refuses to open). Design:
   allow nax's own tool-host tools for agents without pre-approval by answering
   their permission request automatically when it is provably for the session's
   own `nax` tool host — those tools already apply nax's own approval rules
   (plan / run still need the user's approval inside the tool). Lift the
   `open.ts:266` / `capabilities.ts:88` refusal for the chat case accordingly.
   - Constraint: a request's title is agent-controlled display data (S4-4 D4-c),
     so identification must not trust the title alone. The builder must find a
     trustworthy signal per agent (e.g. the tool call's MCP server/tool fields in
     the ACP tool_call update, correlated with the tool host actually receiving
     the call). If no trustworthy signal exists for an agent, fall back to showing
     the card (never auto-allow an unidentified request).
   - Under chat `full` (ACP profile `full`) every permission request is already
     allowed (`permissions.ts`), so this matters only under guarded (`ask`).
   - Live probe DONE 2026-10-29 (user-approved; throwaway client offering one
     loopback HTTP MCP server named `nax` with one tool, `readOnlyHint: true` as
     `tool-calls.ts` sets it; agents in their default modes with the user's own
     setup):
     - **Codex** (`@agentclientprotocol/codex-acp` ~2.1.1, codex 0.159.3, default
       mode `agent` = auto review): sent NO permission request for the MCP call. It
       called the host directly, then reported `tool_call` with structured
       `rawInput: { server: "nax", tool, arguments }` and
       `_meta.is_mcp_tool_call: true`. Nothing to approve, so no cards; the
       only change needed is lifting the `open.ts:266` / `capabilities.ts:88`
       refusal. The spec must still define the behaviour if Codex DOES ask
       (another mode, a future version): treat it like Cursor below.
     - **Cursor** (`cursor-agent acp`): sent a `tool_call_update` with structured
       `rawInput: { providerIdentifier: "nax", toolName: "nax_ping", args }`, then
       `session/request_permission` for the SAME `toolCallId` (title
       `"nax-nax_ping: nax_ping"`, options allow-once / allow-always /
       reject-once), and only after the answer called the host. So the host call
       cannot be used for correlation (it comes after the answer).
     - Trustworthy signal (design): auto-allow a permission request only when the
       same `toolCallId` was earlier reported with structured MCP fields (Codex
       `rawInput.server/tool`, Cursor `rawInput.providerIdentifier/toolName`) naming
       the session's tool host server and one of its tool names. Never the title.
       These fields are set by the adapter's MCP routing, not by model text. To stop
       a user's own MCP server colliding with (or impersonating) the name, the chat
       tool host server name is unique per session (e.g. `nax-<8 hex>`); the
       pre-approval rule for Claude follows the same name. Anything unmatched gets
       a card (user ruling 6).
     - Both agents loaded the user's own setup through ACP (Codex listed the user's
       skills as `$<skill>` commands; Cursor listed user commands), confirming §5.3
       works without extra plumbing. Offered config: Codex `mode`,
       `collaboration_mode`, `model`, `reasoning_effort`, `fast-mode`; Cursor
       `mode`, `model` (effort is encoded inside Cursor's model ids).
- Run asks from runs the ACP brain launched route to chat cards exactly as with the
  native brain (#2738). In the chain flow where the chat agent answers asks itself
  (slice 2 §4.7), the ACP brain receives the same notice text; if that cannot be
  delivered to an ACP agent mid-turn, asks go to the user (builder decides,
  document the behaviour).

### 5.6 History across brain switches (G6) — user ruling: carry it over

- nax keeps one conversation record per chat session regardless of brain. Turns
  taken on an ACP brain (user text, agent text, tool calls as summaries) are
  written to nax's transcript, so a switch back to native carries them. The ACP
  backend stores only cost baseline and ACP metadata today (`backend.ts` ~330-358),
  so nobody owns ACP message history yet. My call: the chat host records the turns
  from the session's event stream into the shared transcript, in the native
  message format the native backend already replays; nax-agent-acp's contract is
  unchanged.
- Switching INTO an ACP agent: the agent starts a fresh ACP session; nax hands it
  the conversation so far as context on its first turn (user / assistant text,
  earlier tool calls condensed to one-line summaries). My call: bounded size, with
  oldest turns dropped first and a note saying so; the builder picks the bound.
- Resume (`nax chat` reopen of a past session): reopens on the brain it last used.
  My call: prefer the agent's own resume (`client/resume.ts`, session/resume or
  session/load) when the stored ACP record is still valid; else open fresh and
  replay as above.

### 5.7 Display (G7)

- ACP turn events already map to nax-agent events (text, thinking, tool_call /
  tool_result, usage — `client/turn.ts`, `client/tool-events.ts`). Chat renders
  them with the existing tool cards. Status line shows the agent and its model.
- Picker: the three agents are listed statically; nax never starts an agent just to
  list models. Its offered models fill in after the first open and are cached per
  agent for the chat process. "Unavailable" = binary not found on launch
  resolution (`client/launchable.ts`) or the open failing with an auth error, shown
  on the row. My call.
- Cost: subscription turns may report no cost; show tokens if reported, no cost
  figure otherwise. Not a blocker.

## 6. Decided by the user (2026-10-29)

1. An ACP agent is a main model choice in the chat picker.
2. Claude Code, Codex and Cursor ship together.
3. Each agent loads its own full setup, like running it directly (own allow rules
   and hooks act without nax cards).
4. History carries over on a switch, like native model switches.
5. The koda ACP server side is a separate feature.
6. Codex / Cursor ship even if no trustworthy own-tool signal exists: guarded mode
   then shows a card per nax tool call (full mode is unaffected). Live probe
   approved (user, 10-29).

## 7. Calls I made (open to user change)

- `acp:` model-string prefix; picker "Agents" group.
- guarded -> ACP `ask`, full -> ACP `full`.
- Native-only chat features hidden on an ACP brain rather than bridged.
- Adapt workflow providers to embedder tools on the nax side.
- Auto-allow only provably-own `nax` tool-host calls for Codex/Cursor; else card.
- Bounded history replay into a fresh ACP session; agent-native resume first (also
  for same-agent mode / model switches).
- The chat host records ACP turns into the shared transcript (nax side).
- Chat ACP sessions inherit the full environment; no nax embedder sandbox.
- Static agent rows in the picker; models fill in after first open.
- Gemini / OpenCode / pi not offered in this slice.

## 8. Left to the builder

- Exact model-string syntax, picker layout, unavailable-agent detection.
- The adapter shape (providers -> embedder tools) and where it lives.
- The exact matching code for the own-tool signal (§5.5, probe results).
- Replay bound and condensation format; transcript schema for ACP turns.
- Feature split into specs (each own spec / PRD / PR, as with slices 1-2). Suggested:
  F1 tool gap (Codex/Cursor embedder tools + provider adapter, nax-agent-acp +
  nax); F2 chat ACP brain (picker, backend switch, modes, own setup, step-aside);
  F3 history carry + resume. The builder may merge or reorder.

## 9. Next feature (separate): workflow tools for koda

Outline only, to be brainstormed after this slice. The ACP server koda talks to
is the `nax-agent` binary (`packages/nax-agent-acp/src/server/`), a plain native
agent that does not load `@nathapp/nax`; the workflow tools live in the nax chat
host (job list, ask cards). Open questions: nax serving ACP itself (a `nax acp`
entry that reuses the chat host) vs moving the workflow tools into a package the
server can load; how run asks travel to koda (ACP permission / elicitation
requests); approval rules for koda-launched runs. F1's tool-gap work is reusable
there.

## 10. Glossary

- ACP: Agent Client Protocol; nax talks to Claude Code / Codex / Cursor through
  their ACP adapters (`claude-agent-acp`, `codex-acp`, `cursor-agent acp`).
- Brain: the session backend answering chat turns (a native model or an ACP agent).
- Embedder tools: tools nax hands an ACP agent over its loopback MCP tool host.
- Pre-approval: Claude's `allowedTools` channel that lets nax tools run without the
  agent asking permission; Codex and Cursor have none.
