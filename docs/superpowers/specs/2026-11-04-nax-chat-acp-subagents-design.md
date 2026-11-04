# nax: ACP subagents, a headless agent command, and sending a flow to koda

Status: DRAFT 2026-11-04. Brainstormed with the user 2026-11-04. Companion design in koda:
`docs/superpowers/specs/2026-11-04-fleet-flow-design.md` (koda owns the always-on flow; this document covers
the nax pieces it depends on).

## Intent

The user wants one brainstorm to turn into ready PRs with as little of their attention as possible. They stay
hands-on for the brainstorm, and they want to be asked only when something is genuinely ambiguous. Two things
stand in the way today:

1. **A second model cannot review inside one chat.** `nax chat` can use an ACP agent (Claude Code, Codex,
   Cursor) as its brain, but a chat **subagent** always opens a native nax session. Reviewing a spec on a
   different model, for example Codex reviewing a spec Claude wrote, means switching the whole chat's brain
   with `/model`, by hand.
2. **Nothing runs an agent headlessly.** koda's runner can launch `nax plan`, `nax run`, `nax bot review` and
   `nax bot fix`, but it cannot run "the spec reviewer on this spec" as a job. The koda flow needs exactly that,
   for its spec review and PRD review steps.

A third, thin piece connects the two halves: a way for `nax chat` to hand a settled spec set to koda as a
flow, so the work carries on after the chat closes.

## Goals

- **G1. ACP subagents.** An agent file's `model:` (or the alias it names) may be an `acp:` model, for example
  `acp:codex/<model>`. A chat subagent then runs as a nested ACP session on that agent instead of a native one.
- **G2. Roles through profiles.** `agent.modelAliases` accepts `acp:` values, so a profile can say what a role
  means: `{"agent": {"modelAliases": {"reviewer": "acp:codex/<model>"}}}`. An agent file names `model: reviewer`
  and never changes when the user switches reviewer models.
- **G3. A read-only reviewer that is configured, not hard-coded.** An ACP subagent whose agent file grants no
  write tools opens on a read-only ACP permission profile. An agent that cannot enforce read-only refuses to
  start, rather than silently running with write access.
- **G4. `nax agents run`.** A headless command runs one agent definition on one task and prints its final text
  (and, with `--json`, a structured result). It uses the same code path as a chat subagent, native or ACP.
  koda's runner uses it for the flow's review steps.
- **G5. Send a flow to koda.** A `nax chat` tool proposes "send this spec set to koda as a flow" on one card.
  Approving it pushes the spec branch and creates a **pending** flow in koda. Nothing billed starts from this
  card. koda always asks for its own approval: per the user (2026-11-04), pre-approval is only the koda
  thread's tickbox, so a flow sent from nax has no pre-approval path.

## Non-goals

- Changing native subagents, or the chat chain (`nax-jobs__chain`). The chain stays the tool for a single
  feature watched in one sitting.
- Translating an agent file's `tools:` list into ACP tool restrictions beyond read-only versus not. An ACP agent
  keeps its own tools (as the chat brain already does); `tools:` only decides the permission profile.
- Running the flow in nax. The flow's state, its approvals, waiting for merges and escalation all live in koda.
- A declarative flow schema inside nax. The flow record is koda's; nax only sends the fields koda's API takes.
- A project-wide auto-approve setting (deferred by the user 2026-11-04).

## Anti-goals

- Any path where a billed step starts without the user's explicit yes. The send-to-koda card is not that yes;
  koda's approval, or the user's per-thread pre-approval, is.
- A read-only reviewer that can actually write because its agent lacks read-only enforcement. Fail closed.
- A headless command that exits 0 on failure, as `nax run` and `nax plan` do today. `nax agents run` exits
  non-zero when the turn does not complete, so a runner can gate on it.

## Current state (verified on `main` `14742b8a9`)

- `runSubagent` (`packages/nax/src/chat/subagent-session.ts`) builds every subagent session with
  `nativeBackend(...)`, a memory-only transcript store, and nax rules in the instructions.
- `createSubagentRuns.runNested` (`packages/nax/src/chat/subagent-runs.ts`) resolves the model with
  `resolveSubagentModel` (`subagent-model.ts`: inherit, alias, tier, `provider/model`, fallback) and the tool
  list with `mapSubagentTools` (`subagent-tools.ts`). Asks from the nested session go through `routeAsk`.
- The chat ACP brain builds its backend with `acpBackend({ agent, model, effort, allowUnsandboxed, inheritEnv })`
  in `acpSessionOptions` (`packages/nax/src/chat/acp/acp-session-options.ts`). It passes profile `ask` (guarded)
  or `full`. `parseChatAcpModel` (`acp/acp-model.ts`) parses `acp:<agent>[/<model>][[<effort>]]` for agents
  `claude`, `codex` and `cursor`.
- `@nathapp/nax-agent-acp/client` already knows read-only profiles `none`, `read` and `review`
  (`capabilities.ts` `isReadOnlyProfile`). A read-only profile on an agent with no read-only enforcement is
  rejected with `profile "<p>" needs read-only enforcement; this agent has none`. The registry
  (`registry.ts`) holds a `readOnly` entry per agent that supports it.
- `agent.modelAliases` (`packages/nax/src/config/schemas-model-alias.ts`) only accepts `provider/model[effort]`.
  An `acp:` value fails validation today.
- Agent files (`packages/nax/src/resources/parse-agent.ts`) carry `name`, `description`, `model`, `tools`.
- There is no headless command that runs an agent or skill. `nax agents` lists agents only.

## Design

### 1. ACP subagents (G1, G2)

- `resolveSubagentModel` keeps its order. An alias or a `model:` value that starts with `acp:` passes through
  unchanged (source `alias` or `model`).
- `ModelAliasesSchema` accepts either the existing `provider/model[effort]` shape or a string that
  `parseChatAcpModel` accepts. The error message names both shapes.
- `runSubagent` branches on the resolved model. For a native model nothing changes. For an `acp:` model it
  builds the session the way `acpSessionOptions` does: `acpBackend({ agent, model, effort, allowUnsandboxed:
  true, inheritEnv: true })`, the chat's delivered providers (`nax-workflow`, `nax-jobs`, `nax-memory`) filtered
  further by the agent's `tools:` when it declares them, and subagent instructions in place of the brain's.
  The profile comes from section 2.
- The nested ACP session is memory-only and closed after its one turn, like a native subagent. It never
  resumes and never writes an ACP transcript under the chat sessions dir.
- The subagent's cost and activity reach the parent the way a native subagent's do, through `routeActivity`.
  When the ACP agent reports no cost, the subagent's cost is recorded as unknown, not 0.
- A subagent cannot start a subagent (unchanged), and an ACP subagent gets no `nax-jobs` launch tools: billed
  launches stay with the chat brain. (My call: the chain's rules assume the brain is the only launcher.)

### 2. Read-only by configuration (G3)

- **Write tools** are `Write`, `Edit`, `MultiEdit`, `Delete` and `GitCommit`. `Bash` is not a write tool for
  this rule: under a read-only profile, the agent's own read-only enforcement governs what its shell may do, so
  a reviewer that declares `Bash` for `git diff` stays read-only. (My call.)
- The profile for an ACP subagent is derived from its agent file:
  - `tools:` declared with no write tool: the read-only profile `review`. (My call: `review` over `read`, since
    this is a reviewer; the builder may pick `read` if the registry's `review` entry differs in a way that
    matters.)
  - `tools:` declared with a write tool: the chat's own profile, `ask` in guarded mode and `full` in full mode.
  - no `tools:` line: in chat, the chat's own profile (Claude Code semantics: inherit everything). In
    `nax agents run`, which runs unattended, `review`. An unattended run gets write access only when the agent
    file declares a write tool. (My call: fail closed where no human can answer an ask.)
- An optional config override, `agent.acpSubagents.profile: "review" | "read" | "ask" | "full"`, settable in a
  profile, replaces the derived value for every ACP subagent. This follows the user's standing preference that
  ACP read-only rules be exposed as config rather than a tight harness.
- **What counts as enforced.** A read-only profile is allowed only on an agent whose registry entry enforces
  read-only through the agent's own permission mode. Today that is `claude` and `codex`. `cursor`'s read-only
  relies on nax's rule translation alone (nax#2372), so a read-only ACP subagent on `cursor` does not start until
  that is settled. (My call: the anti-goal below is about unattended reviewers, where "probably read-only" is not
  enough.) The builder confirms the claude and codex entries before relying on them.
- When the agent cannot enforce a read-only profile, the subagent does not start. Its tool result is the
  backend's error, prefixed `[chat] subagent <name> could not start read-only:`.
- Headless denial is total: in `nax agents run` every ask is denied, including one the agent's own config would
  pre-approve through nax's pre-approval channel. The read-only profile, not ask handling, is the guarantee.

### 3. `nax agents run` (G4)

```
nax agents run <agent> --task <text> | --task-file <path>
              [-d <dir>] [--profile <names>] [--model <id>] [--json] [--timeout <seconds>]
```

- Resolves `<agent>` through the same resource catalog as chat (short or `plugin:name`), resolves its model
  through `resolveSubagentModel` (with `--model` taking the place of the agent file's `model:`), and runs it
  through `runSubagent`, ACP or native, in mode `guarded` with no human attached: an ask the session raises is
  denied, and the result says which ask was denied.
- Skills: `--task` may begin with `/<skill> <args>`; the command expands it with
  `buildSkillInvocationMessage` exactly as the chat slash command does, so `nax agents run spec-reviewer
  --task "/spec-review .nax/features/x/spec.md"` runs the spec-review skill inside the reviewer agent.
- Output: plain mode prints the final text. `--json` prints one object:
  `{ "agent", "model", "status": "completed" | "failed" | "cancelled" | "timeout", "output", "deniedAsks": [...],
  "costUsd"?: number }`.
- Exit code: 0 only for `completed`; 1 for `failed`, `cancelled` or `timeout`; 2 for a usage or config error.
- Billing: this is a billed LLM call. In koda it runs as a fleet job under the flow's approval and budget. On
  the user's machine it is a command the user types; it is never launched by the chat brain except through a
  card (see Non-goals: no new chat launch tool for it in this design).
- The command does not interpret the output. A caller that needs a verdict (koda) asks for one in the task text
  and parses it itself.
- **Roles on another machine.** `nax agents run` resolves aliases only from the profiles it is given. It needs no
  inline alias map: koda's runner already writes a per-job profile (`koda-job-<id>`) and passes it with
  `--profile`, so koda puts the flow's role aliases (`agent.modelAliases.reviewer`, `.supervisor`) into that
  profile. (Answered by the koda runner's existing per-job profile.)

### 4. Send a flow to koda (G5)

This part depends on koda's flow API (companion design, section "nax entry"). It is built after that API
exists.

- A new chat tool, `nax-flow__send`, offered only when nax has a koda connection: `koda.url` in config, and a
  koda agent key stored with `nax auth login koda` (a new credential kind in the existing `nax auth` store,
  never in config text). The key is a koda agent key that a koda admin issues, as for any koda agent. (My call.)
- **Repo mapping.** nax sends the repo's git remote URL; koda resolves it to its fleet repo and rejects the call
  if no fleet repo matches. nax never needs koda's repo id. (My call.)
- Input: the features in order, each `{ feature, specPath, dependsOn?: string[] }`; the role aliases to use
  (`reviewer`, `supervisor`); and a cost cap.
- The tool shows one card: the branch it will push, each feature and its spec path, the order and
  dependencies, the role models, the cost cap, and the line
  `koda will ask you to approve this flow before anything billed starts`.
- On allow it commits nothing new. It requires a clean spec branch, pushes it, and calls koda's create-flow
  endpoint with the remote URL, branch and head sha. The result is the flow's koda URL and its state, which is
  always `PENDING`.
- A spec review done in the chat is not sent as a claim. koda runs its own spec review (koda design). (My call:
  a billed step is never skipped on an unverified claim.)
- The tool is offered to the chat brain, ACP or native. It is never offered to subagents.

### Failure handling

| Condition | Behaviour |
|---|---|
| `acp:` alias with an unknown agent | config validation error naming the allowed agents |
| read-only profile on an agent with no read-only enforcement | subagent does not start; error result naming the agent |
| ACP agent binary missing or fails to start | subagent error result; the parent turn continues |
| ACP session reports no cost | cost recorded as unknown |
| `nax agents run` agent not found | exit 2, `agent <name> not found; see nax agents` |
| `nax agents run` turn fails, is cancelled or times out | exit 1, status in `--json` |
| an ask raised during `nax agents run` | denied; listed in `deniedAsks`; the turn continues |
| `nax-flow__send` with a dirty spec branch | error, nothing pushed |
| `nax-flow__send` with no stored koda key | the tool is not offered |
| koda finds no fleet repo for the remote URL | error naming the URL; the branch stays pushed; nothing is created |
| koda unreachable or rejects the flow | error with koda's message; the branch stays pushed; nothing is created |

## Left to the builder

- How the ACP subagent's instructions are composed (reuse `buildSubagentInstructions`, or a variant like
  `buildChatAcpInstructions`), as long as the agent body and the task reach the agent.
- Whether `nax agents run` lives under `src/cli/agents.ts` or its own file, within the file-size limits.
- The exact koda endpoint shape for section 4, which the koda design fixes.
- Splitting this into features. A sensible split: (a) sections 1 and 2, (b) section 3, (c) section 4 after the
  koda API lands.
