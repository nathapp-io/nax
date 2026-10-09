# @nathapp/nax-agent

nax's native coding agent as a package: the session contract, the native session adapter and its turn loop over `@nathapp/nax-ai`, the tool set, permission resolution, the OS sandbox, command-safety and cost accounting.

> **Pre-1.0.** Until `1.0` the API of `.` may change in any minor release. Pin an exact version.

## Install

```bash
npm install @nathapp/nax-agent
```

Requires **Node.js >= 22.19.0**. The package is ESM only and ships no Bun code: it runs on Node, and on Bun, with the default runtime.

## Entry points

- **`@nathapp/nax-agent`** is the supported entry. Every export is named, and none starts with `_`. Its exact names are pinned in [`api/nax-agent.api.txt`](api/nax-agent.api.txt), which CI compares with the built declarations.
- **`@nathapp/nax-agent/internal`** is **nax-only and outside semver.** nax bundles this package and reaches below the public entry for shared helpers, `NaxError`, deep modules and the `_*Deps` test seams. Names, shapes and behaviour there can change in any release, patch included, and a change there is not a breaking change. Do not import it from another project.
- **`@nathapp/nax-agent/mcp`** — the shared MCP connection layer; see below.

## Process-wide slots

The host installs these once, near startup. They are module-level, so they apply to everything in the process.

| Slot | Install | When unset |
|:-----|:--------|:-----------|
| Logger | `setAgentLogger(logger)` (`null` clears) | Logging is silent: `getLogger()` is a no-op logger and `getSafeLogger()` is `null`. |
| Credentials | `configureCredentials({ configDir, readAuthConfig })` | The first credential read throws `NaxError` with code `CREDENTIALS_NOT_CONFIGURED`. There is no default config directory. |
| Runtime | `setAgentRuntime(runtime)` (`null` clears) | `getAgentRuntime()` returns `nodeRuntime`, built on `node:child_process` and `node:fs`. |

`AgentRuntime` is the process and glob contract (`spawn`, `glob`, `globSync`). The Node default is complete; install your own only to change how the agent spawns processes or expands globs.

## Ports the host supplies

Three pieces of host knowledge are passed in as data or functions, because the package cannot know them. Their behaviour when you omit them differs, so check each one.

- **`runDeclaredCommand`** runs a command your project declared (a test or lint command), never one the model wrote. If you do not supply it, the `RunCommand` tool answers `exit 1` with "no declared-command runner is configured for this session" and starts no process. It fails closed.
- **`ProtectedPathsPolicy`** names the paths you own and want kept away from the agent: git pathspecs the Git tool excludes from its default view, gitignore patterns `GitCommit` refuses to stage, the project state directory, the credential directory and the trust-store file the sandbox protects. If you do not supply it, the Git tool excludes nothing from its default view, and `GitCommit` fails closed: it refuses every path and stages nothing until the policy supplies a non-empty `gitIgnorePatterns` (an empty list refuses the same way). Supply it whenever the agent works in a directory that holds files you own. Building a sandboxed session requires it.
- **`commandInterceptor`** may rewrite a command before it runs (for example to prefix a wrapper binary). Rewrites are validated: an argv rewrite may only prefix the original argv with the provider's own binary, and a shell rewrite goes through the same narrowing. If you do not supply one, commands run unchanged. An interceptor that throws, or returns a rewrite that fails validation, is treated as a decline, and the original command runs.

## Repository instructions

Native sessions load repository-local instructions from the session workdir. In each directory, `AGENTS.override.md` takes precedence over `AGENTS.md`, with `CLAUDE.md` as a fallback. The native adapter's `OpenSessionOpts.instructionDirectories` adds package scopes relative to that workdir; a monorepo session can supply `["apps/api", "packages/client"]` to load each root-to-package chain. `OpenSessionOpts.instructionFileName` selects another Markdown basename, such as `TEAM.md`. A custom name loads only that filename in each directory, with no override or legacy fallback. Names must be nonhidden Markdown basenames without path separators, colon or control characters. More specific directory instructions override ancestor instructions within their scope. Other packages are discovered when authorized file tools enter them.

Local Markdown `@path.md` imports are deduplicated and bounded. Discovery stays inside the active checkout and respects protected paths and denied paths. Each session retains its own instructions outside compactable message history; transcripts record source paths, scopes and hashes. Resume reloads the applicable files from disk using the filename supplied again in the session options. ACP sessions use their CLI's instruction discovery.

## Conversational sessions

`createAgentSession` gives an embedder (for example a long-running Node service) a multi-turn chat with a person in the loop. Events stream, tools come from the embedder, history lives in a store the embedder supplies, and a turn can be cancelled or answered with an approval.

```ts
import { createAgentSession, createFileTranscriptStore, type EmbedderTool, nativeBackend } from "@nathapp/nax-agent";

const lookupOrder: EmbedderTool = {
  name: "lookup_order",
  description: "Look up an order by id.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  approval: "always", // ask the person before every run
  async run(input, { signal }) {
    return { content: JSON.stringify(await orders.get(input, { signal })) };
  },
};

const session = await createAgentSession({
  backend: nativeBackend({ model: "anthropic/claude-sonnet-5-5" }),
  profile: "ask",
  workdir: "/abs/project",
  tools: [lookupOrder],
  transcriptStore: createFileTranscriptStore("/abs/state/sessions"),
});

for await (const event of session.send("Where is order 42?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "approval_requested") showApproval(event); // later: session.answer(event.requestId, { decision: "allow" })
  if (event.type === "turn_end") console.log(event.status, event.costUsd);
}
await session.close();
```

Profiles set what a session may do:

| Profile | Side effects |
|:--------|:-------------|
| `none` | no side effects; |
| `read` | read-only; |
| `ask` | every Write, Edit, Delete, GitCommit and Bash is put to `answer()`; |
| `full` | no prompts; `bashApproval` and the sandbox floor apply. |

`createAgentSession` takes a `SessionBackend`. `nativeBackend(opts)` takes `instructionFileName` (default `AGENTS.md`), `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval` and `allowUnsandboxed`. The ACP backend ships in `@nathapp/nax-agent-acp`.

`usage.costSource` is `computed` (native), `reported` or `unpriced`; never sum `unpriced` rows as cost.

- **One turn at a time.** `send()` claims the session's turn slot at once. A second `send()` while a turn runs throws `AGENT_SESSION_BUSY`. The returned iterable is single-use, and the turn starts on its first `next()`. Breaking out of the loop cancels the turn.
- **Events.** `turn_start`, `text_delta`, `thinking_delta`, `stream_reset`, `tool_call`, `tool_result`, `approval_requested`, `approval_resolved`, `question`, `usage`, `compaction` and `turn_end`. Sessions do not compact, so `compaction` is not emitted and a conversation that outgrows the model's context window ends `errored`. Each carries `sessionId`, `turnId`, `at` and your `metadata`. `turn_end` is always last, and a failed turn arrives as `turn_end`, never as a throw.
- **Deltas are provisional.** `stream_reset` means the deltas of that round so far are void: the provider call was retried after a transient fault (up to 3 attempts; a rate-limit retry waits the provider's `retryAfter` silently, and `cancel()` ends the wait). `turn_end.output` and the stored transcript are authoritative. While your consumer lags, adjacent deltas are merged; control events are never merged or dropped.
- **Approvals and questions.** Answer them with `session.answer(requestId, { decision: "allow" | "deny" })` or `{ text }`. An unanswered one is denied after `approvalTimeoutMs` (default 600000, range 30000..3600000). `answer` returns `"accepted"`, `"expired"`, `"cancelled"` or `"unknown"`.
- **Credentials.** A session's `credentials` (`memory` or `exec`) and `catalogOverrides` give it its own client. Without them it uses the process-wide `configureCredentials` slot.
- **History and restarts.** The store holds one document per session, saved at the end of every turn. `close()` keeps it. After a restart, `resumeAgentSession(sessionId, options)` reopens it with the same options you created it with; pass `instructions` and `tools` again, since they are not stored. If the process died mid-turn, `session.lastTurn` is `{ turnId, status: "interrupted" }`, and that turn's message is not in history. A resume with a different model throws `AGENT_SESSION_MODEL_MISMATCH`; a different reasoning effort (`[high]`) is the same model. Resuming with a different backend kind throws `AGENT_SESSION_BACKEND_MISMATCH`; a stored document with no `backend` field is native. Do not open one session id twice at once: the store has no lock.
- **Errors.** Every error is an `AgentSessionError` with a code `AGENT_SESSION_*`: `INVALID_OPTIONS`, `EXISTS`, `BUSY`, `CLOSED`, `INVALID_ANSWER`, `NOT_FOUND`, `SCHEMA_UNSUPPORTED`, `MODEL_MISMATCH`, `SANDBOX_UNAVAILABLE`, `TOOL_NAME_RESERVED`, `BACKEND_UNAVAILABLE`, `AUTH_REQUIRED`, `CAPABILITY_UNSUPPORTED` or `BACKEND_MISMATCH`. A stored document that cannot be read is a `NaxError` with `TRANSCRIPT_CORRUPT`.

## MCP connections (`@nathapp/nax-agent/mcp`)

A small MCP client for embedders that bridge MCP servers into their own tools.
The root entry never loads it.

```ts
import { connectMcp } from "@nathapp/nax-agent/mcp";

const connection = await connectMcp(
  { kind: "stdio", command: "my-mcp-server", args: [], env: { API_KEY: "..." }, cwd: "/repo" },
  { signal, timeoutMs: 30_000, clientInfo: { name: "my-app", version: "1.0.0" } },
);
connection.tools;                                   // listed once, every page
await connection.call("search", { q: "x" }, { signal, timeoutMs: 600_000, maxBytes: 1_048_576 });
await connection.close();                           // waits for the process; SIGKILL after 3 s
```

- Transports: `stdio` and streamable `http` (with `headers`). SSE is not supported.
- `env` is laid over the default environment, so `PATH` is kept. Server stderr is
  never inherited; its last 512 bytes are attached to a connect failure.
- A server-side tool error is a result with `isError: true`; protocol errors,
  timeouts, aborts and closed connections throw `McpCallError`.
- `onClose` reports a stdio server that exits on its own; HTTP has no such signal.
- The facade (`createAgentSession`) has no `mcpServers` option: wrap MCP tools as
  `EmbedderTool`s yourself.

## Status and roadmap

`0.x` may reshape `.` with a minor bump. `@nathapp/nax-agent-acp` provides an ACP backend for the same API (0.3.0). See [`CHANGELOG.md`](CHANGELOG.md).

Maintainers: see the [release procedure](https://github.com/nathapp-io/nax/blob/main/packages/nax-agent/RELEASING.md)
for the manual 0.1.0 publish and OTP step, trusted-publisher setup and subsequent tagged releases.

## License

MIT
