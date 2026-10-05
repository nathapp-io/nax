# @nathapp/nax-agent-acp

ACP (Agent Client Protocol) backend for `@nathapp/nax-agent` sessions. It lets the
nax-agent session API (`createAgentSession`, `send()`, `answer()`, `cancel()`, `close()`)
drive external coding agents such as Claude Code over ACP.

**Status: pre-release.** The package is being built in stages (S4-1 to S4-6) and is not
published yet. `./client` gains `acpBackend()` in S4-2; `./server` is reserved for a
later ACP server.

nax-agent-acp and `@nathapp/nax-agent` share one version and are released together.
