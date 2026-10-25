# nax interactive coding agent, slice 1: the TUI session

Status: DESIGN. Brainstorm held 2026-10-24 (morning), resumed and closed the
same day. Builder check run 2026-10-24; its findings are folded in and
recorded in section 9. **Not yet approved by the user, not yet planned.**
When approved, the next step is a plan via the superpowers:writing-plans
skill, written to `docs/superpowers/plans/`.

## 0. How to read this document

This document is meant to stand alone. A fresh session with no memory of
the brainstorm should be able to plan from it. It carries:

- the intent and the user's own words (sections 1, 2);
- what already exists in the repo, verified against `main` on 2026-10-24
  (section 3), which the builder re-verifies and never rebuilds;
- the design (section 4), with every decision tagged **user** (said by the
  user, do not re-litigate), **Claude** (a default proposed in the brainstorm
  or settled after the builder check; the user may change it), or
  **builder** (open);
- what has to change in `@nathapp/nax-agent` (section 5), since the builder
  check showed the TUI cannot be built on the package as it stands;
- a decision log (section 8), the builder-check record (section 9), a
  glossary (section 10), and pointers to related documents (section 11).

Process rules that bind anyone working this document (standing user rulings):

- Nothing gets built, scaffolded or installed until the user approves this
  document. Reading and exploring are fine.
- `nax plan` and `nax run` are billed. Never launch either, including
  re-runs, without explicit approval at the launch moment.
- Before any push: the full `bun run check:all` from the repo root. Never
  bare `bun test`, never `bun run nax`.
- Branch directly off `main` when the checkout is free; do not create a
  worktree while a nax run or a subagent is active in this checkout.
- Releases are lockstep across nax-ai, nax-agent, nax-agent-acp and nax, and
  maintainer-initiated. Never bump one package alone; never release
  unprompted.

## 1. Intent

nax becomes an interactive coding agent in the terminal, the way `claude` and
`codex` are, built on the native agent that already exists as
`@nathapp/nax-agent`. This is slice 1 of the main nax roadmap (user ruling
2026-10-24): a full-power coding agent with a terminal TUI and koda chat whose
main session later dispatches the nax workflows (`nax plan`, `nax run`,
`nax bot review`, `nax bot fix`).

The driver is fragmentation. Today the user brainstorms and writes specs in
Claude Code, plans and runs in nax, fixes PRs with `nax bot fix`, and watches
from koda. Each hop loses context: Claude Code knows nothing about
`.nax/rules`, the feature spec, the PRD or the last run's findings. The user
named this as the anti-goal: "different agent doing different thing, maybe
use claude code for brainstorm and creating plan, or dispatch the nax run".
Success is one `nax` session that covers the whole loop. Slice 1 covers the
front of the loop well enough that the user stops opening Claude Code for it.

**Acceptance (user):** brainstorm and spec-review the slice 2 design (workflow
dispatch) inside the nax TUI itself, using the superpowers brainstorming skill
and the nax-spec-kit spec-review skill, loaded by this slice's skill loader.

## 2. Goals, non-goals, anti-goals

Goals
- `nax` with no subcommand (and `nax chat`) opens a chat session in the
  current repo over a native nax-agent session, with streamed tool calls,
  approvals, session save and resume.
- A two-position permission mode (full, guarded), set at launch and
  switchable mid-session, that reuses the existing session profile and Bash
  approval mode axes.
- Claude Code skills, MCP servers and subagents load from the same places
  Claude Code reads them, so the user's existing skills work on day one.
- The session knows the repo's `.nax/rules` the way `nax run` does.
- Sessions are stored so koda (the ACP server) can list and resume them.

Non-goals (slice 2 and later)
- Dispatching `nax plan`, `nax run`, `nax bot review`, `nax bot fix` as tools
  from the session. The approval rule for billed runs carries over unchanged
  when that arrives.
- Claude Code hooks. Parsed, reported, not executed.
- A koda-side front door. koda already talks to the same agent over ACP; this
  slice only has to keep sessions in the store koda reads.
- Publishing anything new to npm. The nax-agent changes in section 5 ride the
  normal lockstep release.
- Autonomy rules for what the agent may decide between workflow handoffs.
  That question only exists once slice 2 exists.

Anti-goals (a shipping slice 1 that still has these is a failure)
- The user still needs Claude Code for brainstorm, spec-writing or spec-review.
- A permission mode that is silently weaker than what it says, for example a
  session that keeps running unsandboxed after one Docker command needed it,
  or a guarded session that runs every command unwrapped because the sandbox
  was missing.
- A second skill or plugin format that only nax understands.

## 3. What exists (verified 2026-10-24 on `main`, corrected after the builder check)

`@nathapp/nax-agent` (`packages/nax-agent/src/`)
- Session contract: `createAgentSession(options)` returns an `AgentSession`
  with `id`, `backend`, `lastTurn`, `send(message)` (async iterable of
  `SessionEvent`s), `answer(askId, ...)`, `cancel()`, `close()`
  (`session/agent-session-types.ts`). There is **no** setter for profile or
  Bash approval; both are fixed at creation.
- `AgentSessionProfile = "none" | "read" | "review" | "ask" | "full"`
  (`session/agent-session-types.ts:17`). `ask` is the profile whose ask tier
  reaches a human; `ask` requires `bashApproval: "gated"`
  (`session/native-backend-options.ts`). The config-level name
  `unrestricted` is a different thing and is not used here.
- Bash approval modes `raw | gated | escalate` (ADR-030,
  `config/bash-approval.ts`, `tools/policy-bash.ts`). `escalate` turns a
  grant miss or lexer refusal into an ask; it does **not** run anything
  outside the sandbox, and the model has no tool to request that.
- Asks: the session builds its own AskLink internally
  (`session/session-ask-link.ts`); asks surface to the host as session
  events and the host answers with `session.answer()`. `nax run` bridges
  those events to Telegram through `packages/nax/src/interaction/dispatch-ask.ts`.
  `AskDecidedBy` is a closed union (`cache | model | human | timeout |
  unavailable | unshowable ...`, `permissions/ask-chain.ts:19`).
- Sandbox: `@anthropic-ai/sandbox-runtime` backend, chosen once per session
  (`session/session-tool-support.ts` `resolveSessionLauncher`). When the
  probe says unavailable: `raw` Bash is refused; `gated` and `escalate`
  commands run **unwrapped** with one warning
  (`sandbox/registry.ts:55`); a profile that needs the sandbox throws
  `AGENT_SESSION_SANDBOX_UNAVAILABLE` at creation unless `gated` plus
  `allowUnsandboxed: true` (session-wide, profiles `ask | full | review`
  only). There is no per-command unsandboxed path.
- Approvals store, command-safety lexer, protected-path refusals for
  `.nax`-owned files and the Claude settings files
  (`sandbox/claude-settings.ts`), file and memory `TranscriptStore`
  (`native/session/transcript-store.ts`) with `loadResumable`.
- Embedder tools (`EmbedderTool`, `approval: "never" | "always"`) let a host
  add in-process tools to a session. `mcpServers` in session options is
  **rejected** as "reserved for a later release"
  (`session/agent-session-options.ts:79`).
- `@nathapp/nax-agent/mcp`: the MCP connection layer (client side), usable
  by a host to connect servers and wrap their tools as embedder tools.

`@nathapp/nax-agent-acp` (`packages/nax-agent-acp/src/`)
- ACP client (what `nax run` uses) and the ACP server bin (what koda chat
  uses). Server session storage (`server/storage.ts`) keeps
  `<id>.session.json` metadata plus a lock beside the S3 transcript, default
  directory `<config-dir>/.agent-server/sessions`. A plain file
  `TranscriptStore` alone is **not** visible to koda.
- `packages/nax` imports only `@nathapp/nax-agent-acp/client`;
  `check:package-boundaries` enforces it.

`@nathapp/nax` (`packages/nax/src/`)
- `tui/`: an ink 6 TUI for `nax run` (App, StatusBar, LiveActivityPanel,
  overlays, `useKeyboard`); ink-testing-library is a dev dependency.
- `interaction/`: the human interaction chain (Telegram first) that
  `nax run` bridges asks to.
- `plugins/`: nax's own plugin system (`~/.nax/plugins/`, `.nax/plugins/`,
  extension points optimizer / router / reviewer / contextProvider ...).
  Unrelated to Claude Code plugins; unchanged by this slice.
- Rules delivery (rules index plus on-demand bodies) used by workflow mode;
  `nax context` fragments; the cost ledger and `nax cost`.

Nothing in the repo reads a `SKILL.md`, a Claude Code `agents/*.md`, a
`.mcp.json`, or a Claude Code plugin manifest today.

## 4. The design

### 4.1 Entry and shell

- `nax` with no subcommand, and `nax chat`, open the interactive session in
  the current working directory. Existing subcommands are untouched. (user:
  TUI like Claude Code / Codex; Claude: the command names.)
- Flags: `--resume [id]` (latest session for this repo when no id),
  `--mode <full|guarded>`, `--model <id>`, `--profile <name>` (the existing
  nax profile mechanism). (user: a launch flag for mode; builder: spellings.)
- The shell is an ink app in `packages/nax/src/tui/chat/` beside the run
  TUI, sharing StatusBar, overlays and `useKeyboard` where they fit.
  (Claude: ink, because it is already there; builder: component split.)
- Layout: transcript (streamed assistant text; tool calls collapsed to one
  line each, expandable), a multi-line input box, and a status line showing
  model, permission mode, session id, session spend, and sandbox state
  (on / off / unavailable).
- Slash commands: `/help`, `/mode`, `/model`, `/resume`, `/sessions`,
  `/clear`, `/cost`, `/skills`, `/mcp`, `/agents`, `/plugins`, `/feature`,
  `/quit`, plus one per loaded skill (4.4). Ctrl-C once interrupts the turn,
  twice quits.
- Keyboard: one key cycles the permission mode mid-session (user: like
  Claude Code's shift-tab; builder: the key). The status line shows the
  change immediately and it applies from the next tool call.

### 4.2 Session and storage

- One native nax-agent session per TUI session. Storage uses the ACP
  server's session storage (transcript plus `<id>.session.json` plus lock,
  in the ACP server's sessions directory), so koda lists and resumes the
  same sessions and the lock prevents two front doors driving one session
  at once. (user: terminal and koda share nothing except the session store
  on the same machine. Claude: therefore the TUI writes the ACP metadata,
  not a bare transcript. Builder: where the storage module lives so both
  `nax` and the ACP server can import it without breaking
  `check:package-boundaries`; moving it into `@nathapp/nax-agent` is the
  obvious option.)
- Resume uses `loadResumable`; an interrupted turn is shown and the user
  decides whether to continue it. A session locked by another process is
  listed but not resumable, with the holder shown.
- The system prompt is an interactive variant: repo summary (`nax context`
  fragments), the `.nax/rules` index with on-demand bodies (the workflow
  mode delivery), the loaded skills index (names and descriptions only),
  the mode description, and the subagent and MCP tool lists. It is not the
  story-execution prompt.
- Streaming uses the existing `AgentStreamEvent` set. Thinking shows
  collapsed; usage updates the status line.
- Every turn writes to the cost ledger under a `chat` kind with the session
  id, so `nax cost` and the telemetry skill see it. `/cost` shows session
  spend. No budget enforcement beyond what config already applies.

### 4.3 Permission modes and approvals

One user-facing mode sets two existing axes:

| Mode | `AgentSessionProfile` | `bashApproval` | Human asked |
|---|---|---|---|
| **full** | `full` | `raw` | never |
| **guarded** (default) | `ask` | `gated` | only where the guard already asks |

(user: full never asks; guarded = existing guard decides; Claude: the name
"guarded" and guarded as default; Claude: the exact profile pairs, chosen
because `ask` is the only profile whose ask tier reaches a human and it
requires `gated`.)

**How the TUI answers asks.** Asks arrive as session events; the TUI renders
them inline (command or tool, reason; allow once / allow for this session /
deny) and replies with `session.answer()`. No AskLink is injected. "Allow
for this session" is remembered by the TUI's own per-session allowlist, keyed
the same way the approvals store keys patterns, so the TUI auto-answers a
repeat without showing it. When the TUI is not focused, the existing
interaction chain (Telegram) is offered the same ask as a fallback, through
the same bridge `nax run` uses. (Claude, after the builder check.)

**Full never asks.** Every ask event is auto-answered allow by the TUI and
recorded in the approvals audit with a new `decidedBy` value `"mode"`
(section 5). If the sandbox is unavailable, full mode runs unsandboxed: the
session is created with `allowUnsandboxed`, and the TUI prints one notice at
session start and on each toggle into full that the sandbox is off. (user:
full runs even when the sandbox is unreachable; Claude: one notice, not per
command.) Note `allowUnsandboxed` today requires `gated`; full uses `raw`, so
this is one of the section 5 changes.

**Guarded and the sandbox.** At session start the sandbox probe runs. If
unavailable, guarded does **not** accept today's behaviour (gated commands
run unwrapped with one warning). Instead the session is created with a new
option, `askWhenUnsandboxed` (section 5), so every shell command that would
have run sandboxed is an ask, and the status line shows "sandbox
unavailable". Nothing is silently weakened. (user: nothing silently weaker;
Claude: the mechanism.)

**Unreachable, per command.** "Unreachable" means a command that needs
something the sandbox cuts off: the network, the Docker socket, a local
database port, a device (user). It is handled per command, never by turning
the sandbox off for the session (user). Mechanism (Claude, section 5): a new
`unsandboxed: true` argument on Bash and RunCommand that the model may set
with a stated reason, allowed only when the session was created with
`allowUnsandboxedCommands`. It is always an ask, so:
- full: auto-answered allow, logged with `decidedBy: "mode"`;
- guarded: the prompt shows the command, the model's reason and the
  sandbox denial text; allow once / allow for this session (pattern) / deny.
Every other command keeps running sandboxed. An escalated command that fails
unsandboxed is an ordinary failed command to the model; no retry loop (Claude,
accepted by the user).

**Mode switch mid-session.** Profile and Bash approval are fixed at creation,
so a switch closes the current session and reopens one on the same transcript
with the new profile and mode, between turns. The transcript records the
switch so a resume shows which mode each turn ran under. Switching during a
turn takes effect after that turn ends. (Claude, after the builder check;
the user asked for the toggle, the mechanism is the cheapest one that needs
no mutable policy in nax-agent. Builder may propose a mutable policy instead
if reopen proves awkward.)

**Always refused**: writes to `.nax`-owned protected paths and the Claude
settings files, in every mode, as for `nax run`.

**MCP tools and subagents under the mode.** MCP tools and the `Agent` tool
are embedder tools, which only know `approval: never | always`. The nax
package wraps them: in full mode every wrapped tool is `never`; in guarded
mode read-only MCP tools (per the server's tool annotations, default
read-only when unannotated is **false**) are `never` and everything else is
`always`, with the TUI's per-session allowlist absorbing repeats. A nested
subagent session is created with the parent's mode or narrower and its asks
are forwarded to the parent TUI as asks. (Claude.)

### 4.4 Resource catalog (re-architected 2026-10-25; supersedes the first draft)

User ruling 2026-10-25: one catalog over the seams nax already has, instead of
chat-only embedder tools kept apart from nax's plugin system. Three layers, the
same shape as pi's ResourceLoader:

- **Sources.** `claude-project` (`<repo>/.claude/{skills,commands,agents}`,
  `<repo>/.mcp.json`, `.claude/settings.json` hooks), `claude-user`
  (`$CLAUDE_CONFIG_DIR` or `~/.claude`), `claude-plugin` (the `enabledPlugins` of
  the user then project `settings.json`, resolved through
  `~/.claude/plugins/installed_plugins.json` v2 `installPath`; `plugin.json`
  optional), and `nax-plugin` (a new data-only `NaxPlugin` extension
  `resources: { skills?, commands?, agents? }`). pi's Agent Skills directories
  are NOT read (user).
- **Catalog** (`packages/nax/src/resources/`): `ResourcePackage[]` merged with
  precedence project > user > plugin; a shadowed name stays reachable as
  `<plugin>:<name>`; every problem is a diagnostic, never fatal. It parses every
  kind (skills, commands, agents, MCP entries, hooks) and F4 delivers skills and
  commands only.
- **Delivery through existing seams.** Skills are a `static` `ToolProvider`
  `skills` (tool `skills__load`, index as provider instructions), the same
  mechanism `nax run` uses for MCP and forge tools. The chat session takes it
  through a new `nativeBackend({ toolProviders })`. `nax run` attaches it only
  when `resources.skillsInRun` is true (default off, user). Commands and skills
  are slash commands; a command's `` !`cmd` `` lines run through the session's
  Bash tool under the mode's approvals (user) via a new `AgentSession.runCommand`.
  nax plugin `loopHandlers` join the chat session (role `tui`).
- **Trust.** `nax chat` calls the existing trust gate before loading anything,
  all-or-nothing like Claude Code (user); the catalog has no trust filter.

Spec: `.nax/features/resource-catalog-and-skills/spec.md` (F4).

### 4.5 MCP servers and subagents (F5, under the 4.4 catalog)

- **MCP**: `.mcp.json` and plugin MCP entries from the catalog merge into the
  existing `McpConfig` and reach sessions through the existing MCP pool, lock and
  trust check as `discovered` providers. No second MCP client.
- **Subagents**: catalog `agents/*.md` become an `Agent` tool provider; nested
  session in the same process, mode equal or narrower, tools intersected with the
  parent's, own model via `agent.modelAliases` (`inherit` = parent's). Depth 1.
- **Hooks**: parsed and listed in `/plugins` as not executed (deferred, user).

### 4.6 Context the session carries

- `.nax/rules` index plus on-demand bodies, exactly the workflow-mode
  delivery; package-scoped rules apply by the paths touched.
- `nax context` fragments as the repo summary.
- `/feature <name>` loads that feature's spec and PRD into the turn. No
  feature is loaded by default. (Claude: in slice 1, because it directly
  serves the acceptance test and is cheap.)

## 5. Changes required in `@nathapp/nax-agent`

The builder check established that the TUI cannot be built on the package as
it stands. These are the additions; each is public API, each needs the
`api/nax-agent.api.txt` update, and all ride one lockstep release. They also
serve koda, which will want the same behaviours in chat.

| # | Change | Why |
|---|---|---|
| A1 | `allowUnsandboxed` permitted with `bashApproval: "raw"` for profiles `full` and `review`; `resolveSessionLauncher` drops the launcher for any unavailable sandbox when it is set; `session.backend.sandbox` exposes the `SandboxState` | full mode runs unsandboxed when the sandbox is unavailable, and the host can show the state |
| A2 | DROPPED (spec-writing grounding 2026-10-24): under `gated` a session already asks for every Bash command (`askRulesFor` adds `Bash(*)`, the session ask chain has no cache), so a guarded session with no sandbox already asks per command. The host reads `backend.sandbox` to label the prompt. | |
| A3 | New session option `allowUnsandboxedCommands: boolean`; `unsandboxed: true` + `unsandboxedReason` arguments on Bash and on RunCommand's `argv` branch; `LaunchRequest.unwrapped` runs that one call unwrapped; policy verdict unchanged; under `gated` the existing ask carries `unsandboxed: true`; under `raw` it runs and the ledger's `SandboxRecord.reason` is `"requested"` | per-command escalation out of the sandbox |
| A4 | DROPPED: `raw` never asks, so full mode needs no approval-audit row; the tool-call ledger records the unwrapped run. `AskDecidedBy` is unchanged. | |
| A5 | Session storage (ACP `storage.ts`: metadata, lock, listing) moves to a shared, importable location | TUI and koda share one store without a boundary violation |

Not required: a mutable mode API (reopen-on-same-transcript suffices), an
injectable AskLink (events + `answer()` suffice), session-level `mcpServers`
(host-side wrapping suffices), a user-role injection API (tool result
suffices).

Caveat found while grounding F1: no session profile declares `RunCommand` or
`Exec` (`declaredToolsFor` offers Scratchpad, Read, Glob, Grep, Git, Write,
Edit, Delete, Bash, GitCommit). The RunCommand `unsandboxed` argument in F1 is
therefore reachable today only by `nax run` stories. Declaring RunCommand for
the interactive session is an open item for F3 (see section 7).

**This section is the one open decision for the user** (section 9, Q1). If
the user does not want nax-agent to change in slice 1, A1 to A3 cannot be
met, and the full and guarded behaviours in 4.3 have to be re-designed to
what the package allows today.

### 5.1 Feature split for the nax workflow (user ruling 2026-10-24)

Slice 1 is five nax features, each its own spec at
`.nax/features/<name>/spec.md`, its own PRD and PR, in dependency order:

| # | Feature | Packages | Content | Depends on |
|---|---|---|---|---|
| F1 | `agent-session-modes` | nax-agent | A1 (`raw` + `allowUnsandboxed`, `backend.sandbox`) and A3 (`LaunchRequest.unwrapped`, `allowUnsandboxedCommands`, Bash + RunCommand `argv` `unsandboxed`); 8 stories (floor, launcher, Bash tool, approval metadata, routing refuse/deny, routing convert/raw, session-level, RunCommand); spec at `.nax/features/agent-session-modes/spec.md`, lint clean, two spec-review passes folded in, PRD planned 2026-10-24 (cross-agent profile), phase 9 PASS; awaiting `nax run` approval | none |

F1 rulings made during spec-review (Claude, following the user's "per command,
human-approved except full" rule): an `unsandboxed: true` call whose policy
verdict is allow is converted to an ask with rule `Unsandboxed(<tool>)` in every
Bash approval mode except `raw`, so `escalate` and ask-less `Exec` grants still
reach the human; with `allowUnsandboxedCommands` off the runtime refuses the call
before policy and before any ask. Sessions have no durable tool-audit sink
today (`buildSessionToolSupport` passes no `auditDir`), so the `raw` unsandboxed
run is observable to the host only through the launcher; plumbing an audit
directory into sessions is left to F3 if the TUI wants a ledger.
| F2 | `shared-session-storage` | nax-agent, nax-agent-acp | A5: ACP session storage (metadata, lock, listing) moved to an importable shared location; ACP server consumes it | none |
| F3 | `nax-chat-shell` | nax | `nax` / `nax chat`, ink shell, modes and toggle (reopen), asks via events, resume, status line, cost ledger `chat`, rules + context prompt, `/feature` | F1, F2 |
| F4 | `resource-catalog-and-skills` | nax-agent, nax | 4.4: `toolProviders` + `runCommand` seams, resource catalog (Claude Code + nax plugin `resources`), `skills` provider (chat; `nax run` opt-in), slash commands with `!` lines, trust gate in chat, `/skills`, `/plugins` | F3 |
| F5 | `mcp-and-subagents` | nax-agent, nax | 4.5: catalog MCP entries through the existing MCP pool as `discovered` providers, `Agent` provider with nested sessions, `agent.modelAliases` | F4 |

Spec status: F1 #2691, F2 #2692, F3 #2695 merged; F4 spec drafted 2026-10-25; F5 queued.

## 6. Constraints

- Node compatibility of nax-agent is untouched; the TUI lives in the Bun CLI.
- `check:package-boundaries` stays green; A5 is done by moving code, not by
  widening the allowed import list, unless the builder shows that is worse.
- Standing rulings apply (section 0).
- Reuse before building: the ink TUI pieces, the interaction bridge, the
  approvals store, the transcript and ACP session storage, the MCP layer, the
  rules delivery. Section 3 is what the builder verifies first and never
  rebuilds.

## 7. Left to the builder

- Exact flag and key names, component split, how much of the run TUI is
  shared versus copied.
- The on-disk discovery paths for the current Claude Code plugin layout.
- Where A5's storage module lands and how the ACP server imports it.
- Where the interactive system prompt lives and how it is tested.
- Test strategy: ink-testing-library for the shell; nax-agent unit tests for
  A1 to A4; a fixture `.claude/` tree with one skill, one subagent, one
  `.mcp.json` and one plugin; a scripted session exercising each mode, the
  mode switch, and the unsandboxed ask.
- Order of work. Sensible: (1) nax-agent A1 to A5; (2) shell plus guarded
  mode plus skills, which passes a dry version of the acceptance test; (3)
  MCP and subagents; (4) full mode and the unsandboxed command path; (5) the
  acceptance test itself.

## 8. Decision log

| Decision | By | When |
|---|---|---|
| nax becomes a full coding agent (TUI + koda chat) dispatching the workflows; this is the main roadmap | user | 2026-10-24 |
| Slice 1 = TUI session with skills, plugins, MCP, subagents; slice 2 = workflow dispatch | user (ordering proposed by Claude, accepted) | 2026-10-24 |
| Two front doors (terminal, koda), independent, sharing only the session store on the same machine | user | 2026-10-24 (earlier brainstorm) |
| full = never ask; otherwise the existing guard decides | user | 2026-10-24 |
| full runs unsandboxed when the sandbox is unavailable | user | 2026-10-24 |
| "Unreachable" includes network, Docker, DB; handled per command; sandbox never off for the session | user | 2026-10-24 |
| Mode toggle mid-session like shift-tab, plus a launch flag | user | 2026-10-24 |
| Plugin loader honours skills, MCP servers, subagents (own model); hooks deferred | user | 2026-10-24 |
| Acceptance = brainstorm + spec-review the slice 2 design inside the nax TUI | user | 2026-10-24 |
| Mode names full / guarded; default guarded | Claude | 2026-10-24 |
| Profile pairs full→`full`+`raw`, guarded→`ask`+`gated` | Claude (after builder check) | 2026-10-24 |
| Asks answered via events + `answer()`; no AskLink injection | Claude (after builder check) | 2026-10-24 |
| Mode switch = reopen session on the same transcript | Claude (after builder check) | 2026-10-24 |
| Per-command escalation = `unsandboxed` argument routed to the ask tier (A3) | Claude (after builder check) | 2026-10-24 |
| TUI writes ACP session metadata so koda can list/resume | Claude (follows the user's shared-store ruling) | 2026-10-24 |
| Skill body delivered as the tool result | Claude (after builder check) | 2026-10-24 |
| MCP and Agent tools wrapped host-side with mode-derived approval | Claude (after builder check) | 2026-10-24 |
| Claude alias → nax-ai model via `agent.modelAliases`; subagent depth 1; `/feature` in slice 1 | Claude | 2026-10-24 |
| nax-agent API may change in slice 1 (section 5) | user | 2026-10-24 |
| Design approved; proceed to spec-writing | user | 2026-10-24 |
| Resource catalog over existing seams (ToolProvider, MCP pool, trust, plugin loopHandlers) replaces 4.4/4.5 "kept apart"; supersedes "Skill body delivered as the tool result" wording (now `skills__load`) and "MCP and Agent tools wrapped host-side" | user (architecture proposed by Claude) | 2026-10-25 |
| pi Agent Skills dirs not read; skills in `nax run` default off, configurable (`resources.skillsInRun`) | user | 2026-10-25 |
| `nax chat` uses the all-or-nothing trust gate like Claude Code | user (Claude recommended) | 2026-10-25 |
| F4 one feature; catalog parses all kinds, delivers skills + commands; command `!` lines run via Bash with approval; `resources` config block | user | 2026-10-25 |

## 9. Builder check (2026-10-24)

A fresh reviewer read the first draft against the code. Contradictions it
found, all confirmed and corrected in section 3: profile names; `escalate`
does not leave the sandbox and there is no per-command unsandboxed path;
no injectable AskLink; no mutable mode; `AskDecidedBy` closed; sandbox
unavailable means gated runs unwrapped, not "asks first"; `mcpServers`
rejected; ACP storage is metadata plus lock, not a bare transcript.

Its questions, sorted:

- **Theirs (user):** Q1. May slice 1 change `@nathapp/nax-agent` (section 5)?
  Yes gives one nax-agent sub-slice then the TUI. No means re-designing full,
  guarded and escalation to today's package. Recommendation: yes; the
  package is this repo's, releases are lockstep anyway, and koda needs the
  same behaviours.
- **Settled by Claude:** mode switch mechanism (reopen); escalation
  mechanism (A3); profile pairs; `decidedBy` (A4); MCP and subagent
  approvals (host-side wrap); koda resume (yes, via A5); skill injection
  (tool result).
- **Builder:** `chat` ledger kind, plugin layout paths, `/plugins` in the
  slash list (added).

User answer to Q1 (2026-10-24): **yes**, nax-agent may change in slice 1.
Design APPROVED by the user 2026-10-24; next step = spec-writing
(nax-spec-kit) for the nax workflow.

## 10. Glossary

- **nax-agent, native session**: `@nathapp/nax-agent`'s in-process coding
  agent (turn loop, tools, permissions, sandbox), as opposed to driving an
  external agent over ACP.
- **ACP**: Agent Client Protocol. `nax-agent-acp/client` lets nax drive
  external agents; `nax-agent-acp/server` exposes the native agent to koda.
- **koda**: the user's fleet platform (NestJS). Its agent chat embeds the
  native agent over the ACP server. The planned second front door.
- **Profile** (`AgentSessionProfile`): which tools a session may use and
  whether its ask tier reaches a human (`none | read | review | ask | full`).
- **Bash approval mode** (ADR-030): how a shell command string is judged:
  `raw` (run as is), `gated` (lexer + approvals store decide), `escalate`
  (misses become asks).
- **Ask tier / ask event**: a tool call the policy will not decide alone; it
  surfaces as a session event and the host answers it.
- **Approvals store**: persisted allow/deny patterns consulted by `gated`.
- **Sandbox**: `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS,
  bubblewrap on Linux) wrapping agent-authored commands; blocks network and
  most filesystem writes outside the repo.
- **Unreachable** (this doc): a command that needs something the sandbox
  cuts off: network, Docker socket, local DB port, device.
- **Embedder tool**: an in-process tool a host adds to a session.
- **Rules / rules index**: `.nax/rules/*.md`, delivered to agents as an
  index plus on-demand bodies in workflow mode.
- **Skill**: a Claude Code `SKILL.md` instruction package, optionally inside
  a Claude Code plugin. Unrelated to nax's own plugin system.
- **Workflow mode / slice 2**: nax's step-graph execution of `plan`, `run`,
  `bot review`, `bot fix`; dispatching these from the TUI session is slice 2.

## 11. Related documents

In this repo (`docs/`):
- `adr/ADR-030-bash-approval-modes.md`: the `raw | gated | escalate` axis
  that 4.3 and A1 to A3 build on.
- `adr/ADR-029-phase-c-native-coding-agent-scope.md`: scope of the native
  coding agent.
- `superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`:
  the session API (`createAgentSession`, events, `answer()`, transcript
  store) this slice drives.
- `superpowers/specs/2026-10-08-s5-acp-server-design.md`: the ACP server and
  its session storage (§5.1) that A5 shares.
- `superpowers/specs/2026-10-12-a5-workflow-mode-design.md`: workflow mode;
  its §13 "LLM controller session" (option B) is the origin of this roadmap
  and the subject of slice 2.
- `superpowers/specs/2026-09-02-native-coding-tools-phase-c1-design.md`: the
  coding tool set.

Outside this repo (`projects/nax/`, the user's workspace, not in git here):
- `nax-agent-master-plan.md`: S0 to S6 of the nax-agent carve-out, all
  complete by 2026-10-17; §5a lists the deferred items.
- `nax-native-coding-agent-master-plan.md`: decisions D1 to D14 of the native
  agent (threat model, sandbox, approval gate).
- `nax-step-graph-and-bot-master-plan.md`: the step graph that slice 2 will
  dispatch.
- `nax-autonomy-master-plan.md`: goal 5, the autonomy arc this roadmap
  continues.
