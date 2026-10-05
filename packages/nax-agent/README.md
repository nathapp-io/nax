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

## Conversational sessions

`createAgentSession` gives an embedder (for example a long-running Node service) a multi-turn chat with a person in the loop. Events stream, tools come from the embedder, history lives in a store the embedder supplies, and a turn can be cancelled or answered with an approval.

```ts
import { createAgentSession, createFileTranscriptStore, type EmbedderTool } from "@nathapp/nax-agent";

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
  backend: "native",
  sessionId: "ticket-1234",
  model: "anthropic/claude-sonnet-5-5",
  profile: "none", // "none" | "read" | "full"
  instructions: "You are a support assistant.",
  tools: [lookupOrder],
  transcriptStore: createFileTranscriptStore("/var/lib/my-app/sessions"),
  credentials: { kind: "memory", credentials: { anthropic: { kind: "api-key", key: process.env.ANTHROPIC_API_KEY! } } },
});

for await (const event of session.send("Where is order 42?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "approval_requested") showApproval(event); // later: session.answer(event.requestId, { decision: "allow" })
  if (event.type === "turn_end") console.log(event.status, event.costUsd);
}
await session.close();
```

- **One turn at a time.** `send()` claims the session's turn slot at once. A second `send()` while a turn runs throws `AGENT_SESSION_BUSY`. The returned iterable is single-use, and the turn starts on its first `next()`. Breaking out of the loop cancels the turn.
- **Events.** `turn_start`, `text_delta`, `thinking_delta`, `stream_reset`, `tool_call`, `tool_result`, `approval_requested`, `approval_resolved`, `question`, `usage`, `compaction` and `turn_end`. In 0.2.0 sessions do not compact, so `compaction` is not emitted and a conversation that outgrows the model's context window ends `errored`. Each carries `sessionId`, `turnId`, `at` and your `metadata`. `turn_end` is always last, and a failed turn arrives as `turn_end`, never as a throw.
- **Deltas are provisional.** `stream_reset` means the deltas of that round so far are void: the provider call was retried after a transient fault (up to 3 attempts; a rate-limit retry waits the provider's `retryAfter` silently, and `cancel()` ends the wait). `turn_end.output` and the stored transcript are authoritative. While your consumer lags, adjacent deltas are merged; control events are never merged or dropped.
- **Approvals and questions.** Answer them with `session.answer(requestId, { decision: "allow" | "deny" })` or `{ text }`. An unanswered one is denied after `approvalTimeoutMs` (default 600000, range 30000..3600000). `answer` returns `"accepted"`, `"expired"`, `"cancelled"` or `"unknown"`.
- **Profiles.** `none` gives your tools, a private scratchpad and `ask_human`. `read` adds Read, Glob, Grep and read-only Git over `workdir`. `full` adds writes and Bash, under the OS sandbox and `bashApproval` (default `"gated"`: every command is put to the person).
- **Credentials.** A session's `credentials` (`memory` or `exec`) and `catalogOverrides` give it its own client. Without them it uses the process-wide `configureCredentials` slot.
- **History and restarts.** The store holds one document per session, saved at the end of every turn. `close()` keeps it. After a restart, `resumeAgentSession(sessionId, options)` reopens it with the same options you created it with; pass `instructions` and `tools` again, since they are not stored. If the process died mid-turn, `session.lastTurn` is `{ turnId, status: "interrupted" }`, and that turn's message is not in history. A resume with a different model throws `AGENT_SESSION_MODEL_MISMATCH`; a different reasoning effort (`[high]`) is the same model. Do not open one session id twice at once: the store has no lock.
- **Errors.** Every error is an `AgentSessionError` with a code `AGENT_SESSION_*`: `INVALID_OPTIONS`, `EXISTS`, `BUSY`, `CLOSED`, `INVALID_ANSWER`, `NOT_FOUND`, `SCHEMA_UNSUPPORTED`, `MODEL_MISMATCH`, `SANDBOX_UNAVAILABLE` or `TOOL_NAME_RESERVED`. A stored document that cannot be read is a `NaxError` with `TRANSCRIPT_CORRUPT`.

## Status and roadmap

`0.x` may reshape `.` with a minor bump. An ACP backend for the same session API is planned. See [`CHANGELOG.md`](CHANGELOG.md).

Maintainers: see the [release procedure](https://github.com/nathapp-io/nax/blob/main/packages/nax-agent/RELEASING.md)
for the manual 0.1.0 publish and OTP step, trusted-publisher setup and subsequent tagged releases.

## License

MIT
