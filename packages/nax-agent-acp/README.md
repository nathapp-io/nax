# @nathapp/nax-agent-acp

ACP (Agent Client Protocol) backend for `@nathapp/nax-agent` sessions. It lets the
nax-agent session API (`createAgentSession`, `send()`, `answer()`, `cancel()`, `close()`)
drive external coding agents such as Claude Code over ACP.

**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves sessions under all four profiles, with
thinking, tool and usage events, questions from the agent, and embedder tools on
Claude. Resume (S4-6) is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until
its stage lands. `./server` is reserved for a later ACP server.

```ts
import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

const session = await createAgentSession({
  backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
  profile: "full",
  workdir: "/path/to/repo",
  transcriptStore: createMemoryTranscriptStore(),
});
for await (const event of session.send("Summarise this repository")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
await session.close();
```

What to know:
- **The agent runs unsandboxed on the host.** That is why `allowUnsandboxed: true` is required.
- **Environment.** The agent gets an allowlist: `PATH`, `HOME`, `USER`, `SHELL`,
  `TMPDIR`, `LANG`, `LC_*`, `TERM`, the agent's auth variables, and `env`.
  `inheritEnv: true` hands it your whole environment instead, credentials included.
- **Instructions** are prepended to the first prompt only; ACP has no system prompt.
- **Stop reasons.** A turn that stops for anything but `end_turn` ends `errored` with
  an `ACP_STOP_*` code (`ACP_STOP_CODES`).
- **Usage.** Each turn ends with one `usage` event: the tokens the agent reports for
  the turn, and the cost it reports (`costSource: "reported"`). An agent that reports
  no cost gives `costUsd: 0` with `costSource: "unpriced"`. Never sum `unpriced`
  rows as a cost. See "Events and usage on ACP".
- **A crashed or killed agent leaves the session disconnected.** Later turns end
  `AGENT_SESSION_CLOSED`. A cancel the agent ignores for `cancelGraceMs` kills it.
- **A crash between `session/new` and the first save** loses the agent's session
  id. The next `createAgentSession` with the same id starts fresh.

## Profiles on ACP

ACP enforces a profile in two layers: the agent's own mode, and this client's
answer to each permission request the agent sends.

| Profile | Agent mode (Claude) | Permission requests |
|---|---|---|
| `none` | `plan` | rejected, recorded as `decidedBy: "profile"` |
| `read` | `plan` | rejected, recorded as `decidedBy: "profile"` |
| `ask` | `default` | `approval_requested`; you decide with `answer()` |
| `full` | `default` | allowed, recorded as `decidedBy: "profile"` |

- **Only Claude supports `none` and `read`.** Other agents have no read-only mode,
  so those profiles fail with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` before any prompt.
- **The guarantees are narrower than the native backend's.** Only actions the agent
  routes through a permission request are decided here.
  - Under `none` and `read`, Claude may still run tools it does not ask about, such
    as reads and search. `none` means no permitted side effects, not no reads.
  - Under `ask`, actions Claude's `default` mode allows without asking (reads and
    other non-mutating tools) are not shown to you.
- **Only one-time options are chosen.** "Always allow" is never chosen, because it
  would outlive the session. An agent that offers no allow-once option is denied.
- **Expiry and failure deny.** An unanswered approval expires to a deny after
  `approvalTimeoutMs`. A cancelled turn or a dead agent process answers `cancelled`.
- **What you see is display data.** The request's title, command and paths come from
  the agent. They are redacted and capped, and they never decide anything.
- **Some requests are denied without being shown under `ask`.** This happens when a
  secret cannot be masked safely next to shell syntax, or the agent's text is too large
  to check. Some legitimate commands are caught too, for example `FOO_TOKEN=x; cmd`.
- **A cancelled turn starts nothing new.** A permission request that arrives after
  `cancel()`, while the agent is still stopping, is answered `cancelled` under every
  profile, `full` included.
- **The agent process is unsandboxed** under every profile.

nax-agent-acp and `@nathapp/nax-agent` share one version and are released together.

## Embedder tools on ACP

Tools you pass as `createAgentSession({ tools })` reach the agent through a small
MCP server this client runs for the session.

- **Claude only.** The agent needs HTTP MCP support and a way to pre-approve the
  tools. Other agents fail with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`
  (`capability: "tools"`) after `initialize`.
- **Loopback only.** The server listens on `127.0.0.1` on a random port. Every
  request needs the session's bearer token; requests with another `Host`, any
  `Origin`, or a body over 1 MiB are refused, so browser pages cannot reach it. It
  stops when the session closes.
- **The token is not a secret from your own processes.** Claude's adapter hands
  the server's headers to the Claude CLI on its command line, so any process
  running as your user (including the agent's own shell) can read the token from
  the process table. Treat your tools' `approval` as their real gate.
- **Where the token is redacted.** Errors, the agent's stderr, approval displays,
  tool summaries, tool events, and the agent's own text and thinking. It is never
  stored in the transcript.
- **The name `nax` is reserved.** If your Claude user or project settings define an
  MCP server named `nax`, it can collide with this one. Rename yours.
- **Pre-approved at the agent.** Claude is told to allow exactly `mcp__nax__<tool>`
  for each of your tools, so it never asks permission for them. Your tool's own
  `approval` is the only gate: `"always"` asks you through `approval_requested` and
  `answer()` under every profile; `"never"` runs under every profile.
- **Not yet verified on `none` and `read`.** Those profiles put Claude in plan mode.
  Whether Claude honours the pre-approval while in plan mode is checked in the
  live acceptance smoke before release.
- **Calls run inside a turn.** A call outside a running turn gets an error and the
  tool does not run. When the turn is cancelled, times out, ends or loses the agent
  process, the call's signal aborts and the agent is told the call was abandoned.
  At most 8 calls run at once.
- **Tool input is not validated** against your `inputSchema`, as on the native
  backend. Check it in `run`.
- **A permission request that names one of your tools is not trusted as such.** The
  agent's tool title is display data. If an agent asks permission for an MCP tool
  anyway, it is decided by profile like any other request.

## Events and usage on ACP

A turn on ACP emits the same event types as on the native backend, with these
differences.

- **Text and thinking** arrive as `text_delta` and `thinking_delta`, always with
  `round: 0`. `stream_reset` and `compaction` never occur.
- **Your secrets are scrubbed from the agent's text.** The values of `env` keys
  named like `KEY`, `TOKEN`, `SECRET` or `PASSWORD` (8 characters or more) and the
  tool host's token show as `[REDACTED]` in `text_delta`, `thinking_delta` and
  `turn_end.output`, also when a value arrives split across two chunks. To catch
  that, up to one such value's length of text is held back until the next chunk;
  without such values nothing is held. Other secrets are not pattern-redacted in
  text, as on the native backend.
- **Tool calls.** `tool_call` is sent when the agent uses the call: it asks
  permission for it, reports progress, or finishes. It is not sent when the call is
  first mentioned, because Claude fills in a call's input after mentioning it.
  `name` is the agent's tool name (with Claude: `Read`, `Bash`, `mcp__nax__<tool>`).
  Every `tool_call` is followed by exactly one `tool_result`. A call still running
  when the turn ends gets `isError: true` and `"Not answered: the turn ended."`. A
  call the agent mentions but never uses produces no events.
- **Inputs and previews** are capped and redacted best-effort, as on the native
  backend. A file edit shows as `edit <path> (+added -removed)` lines.
- **Usage.** One `usage` event per turn, after the turn's last delta and tool
  result, also when the turn stops for a reason other than `end_turn`.
  - Tokens are the agent's numbers for the turn. Output tokens include thinking
    tokens. Cache fields appear only when the agent reports them.
  - Cost: the agent reports a running total for the session, and each turn's cost
    is the difference. Spend between turns, or in a turn that ends without the
    agent's final answer (cancel, crash), is counted in the next turn that reports
    a cost.
  - A turn that ends `errored` has zero `usage` in `turn_end`; read its `usage`
    event instead.

## Questions from the agent

Under `ask` and `full` this client tells the agent it can show forms. Claude uses
forms for its AskUserQuestion tool and for some model-fallback prompts. Under `none`
and `read` forms are not offered, and one that arrives anyway is declined.

- **Each form field is one `question` event.** Answer it with
  `answer(requestId, { text })`.
  - Choices are numbered. Reply with a number or the choice's text, in any case.
  - A multi-select takes a comma-separated list.
  - Claude's "Other" box: a reply that is not one of the choices becomes your own
    answer.
  - An empty reply skips an optional field.
- **Declined forms.** Forms with number, boolean or other field types, more than 16
  fields or more than 32 choices, and requests to open a URL are declined. You see
  an informational `question` that starts with `declined:`; `answer()` on it
  returns `"cancelled"`. A reply that matches no choice (when there is no "Other"
  box) and an empty reply to a required field also decline the form, with a note.
- **No answer cancels.** An unanswered question after `approvalTimeoutMs`, a
  cancelled turn, the turn ending or the agent process dying cancels the whole form,
  and later fields are not asked. `answer()` on that question returns `"cancelled"`.
- **Question text comes from the agent.** Control characters are stripped, your
  secrets scrubbed, and it is capped at 4 KiB.
