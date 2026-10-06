# @nathapp/nax-agent-acp

ACP (Agent Client Protocol) backend for `@nathapp/nax-agent` sessions. It lets the
nax-agent session API (`createAgentSession`, `send()`, `answer()`, `cancel()`, `close()`)
drive external coding agents such as Claude Code over ACP.

**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves text-only `full` sessions. Profiles
`none`/`read`/`ask` (S4-3), embedder tools (S4-4), tool and usage events (S4-5) and
resume (S4-6) are refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until their
stage lands. `./server` is reserved for a later ACP server.

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
- **Usage** is reported as zeros with `costSource: "unpriced"`. Never sum
  `unpriced` rows as a cost.
- **A crashed or killed agent leaves the session disconnected.** Later turns end
  `AGENT_SESSION_CLOSED`. A cancel the agent ignores for `cancelGraceMs` kills it.
- **A crash between `session/new` and the first save** loses the agent's session
  id. The next `createAgentSession` with the same id starts fresh.

nax-agent-acp and `@nathapp/nax-agent` share one version and are released together.
