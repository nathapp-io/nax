# MCP client support for the native agent

Design only. Status: **design approved, not yet implemented.** No code changes are to be
made against this spec while the import-cycles refactor is in flight.

Companion spec: `2026-09-13-nax-rtk-command-interception-design.md` (written separately;
the two share no files and may land in either order).

## 1. Goal

Let the native coding agent call tools served by external MCP servers — the motivating
case is `codebase-memory-mcp` (graph search, call-path tracing, code snippets) — so a nax
operation can answer structural code questions without burning turns on `Grep` sweeps.

Two properties are requirements, not nice-to-haves:

- **Config-only onboarding.** Adding a second or third MCP server must be one
  self-contained block in `.nax/config.json`. No TypeScript edit, no touching a shared
  op-to-server map, no risk of breaking server A by adding server B.
- **Native only.** ACP is out of scope (§7).

## 2. Current state

There is **no** MCP support in nax today. An exhaustive grep over `src/`, `bin/` and
`package.json` for `mcp|modelcontextprotocol` finds exactly two hits, neither of them a
client:

- `src/context/engine/agent-profiles.ts:52-55` — `toolSchemaDialect: "anthropic" |
  "openai" | "mcp" | "none"`, a *descriptive* field about how an external agent expects
  schemas.
- `src/cli/config-descriptions.ts:203` — prose only.

There is no `@modelcontextprotocol/sdk` dependency, no JSON-RPC client, no `mcp` config
block. This is greenfield.

What already exists, and what this design leans on:

| Seam | Location | Note |
|---|---|---|
| `CodingTool` interface | `src/tools/registry.ts:63-80` | `name`, `description`, `inputSchema`, `scope`, `run()` |
| Reserved built-in names | `src/tools/registry.ts:74-87` | 11 names; may never be re-registered |
| Per-session tool injection | `src/tools/runtime.ts:90`, consulted at `:104-105` | `extraTools` is looked up **before** the global registry |
| Advertisement | `src/tools/runtime.ts:174-184` | `advertised(declared)` = declared ∩ granted, then lookup |
| Per-hop resolve | `src/agents/coding-tool-support.ts:167-252` | already `async`; builds policy, extraTools, audit sink |
| Permission SSOT | `src/config/permissions.ts:160-191` | `resolvePermissions(config, stage)` |
| Grant expressions | `src/config/permissions.ts:144-154` | `Read`, `Write(src/**)`, `Git(diff,log)` |
| Policy check | `src/tools/policy.ts:288` (`grantedTools`), `:291+` (`check`) | ungranted tool ⇒ denial |
| Run lifecycle | `src/runtime/index.ts:282` (`createRuntime`), `:424-447` (`close`) | `close()` already idempotent |
| PID registry | `src/runtime/index.ts:318` | existing kill path for child processes |
| Tool ledger | `src/tools/tool-audit.ts` | `ToolCallRecord` JSONL sink |
| Dispatch routing | `src/agents/native/session/turn-loop.ts:452` | `codingToolNames.has(call.name) ? "coding-tool" : "context-tool"` |

`registerCodingTool` (`registry.ts:91-127`) is documented as an in-process extension
point and **has no caller outside tests**. It is not used by this design; `extraTools` is
the better fit because MCP tool sets are per-run and workdir-scoped, not process-global.

## 3. Rulings

Decisions taken during design. Each closes an alternative that should not be reopened
without new evidence.

**R1 — nax is an MCP *client* only.** Exposing nax's own capabilities as an MCP server is
a separate, unrelated feature.

**R2 — Attachment is configured on the server, not declared on the operation.** Op tool
declarations live in code (`src/operations/implement.ts:46` and siblings). Putting server
names there would force a TypeScript edit per new server, violating the config-only
requirement. Instead each server declares the stages it attaches to.

Note the granularity shift this implies: built-in tools are declared per **operation**,
whereas MCP attachment is per **stage**, and a stage may run several operations. Every
native operation under an attached stage therefore sees that server's tools. This is
deliberate — `resolvePermissions` is keyed by stage, so stage is the granularity the
permission SSOT already speaks, and inventing a parallel per-operation config key would
give two answers to "may this call run". Operation-level narrowing, if it is ever needed,
belongs in a scoped profile rather than in the `mcp` block.

**R3 — MCP tools bypass the declaration half of advertisement.** Consequence of R2. This
is implemented by *appending* resolved MCP tool names to the declared array at resolve
time — `advertised()` itself is unchanged, and `CodingToolName` gains no new variant.
An earlier draft added a `{ mcp: string }` tagged variant to the union; R2 makes it
unnecessary.

**R4 — `stages` is the attachment SSOT in every permission profile; a scoped profile may
only narrow.** `execution.permissions[stage]` is consulted **only** under the `scoped`
profile (`permissions.ts:203-227`), while the default profile is `unrestricted`. An
attachment mechanism that lived only in `execution.permissions` would therefore do
nothing for most users.

**R5 — MCP is never wildcard-granted.** `unrestricted` enumerates its built-ins
explicitly (`permissions.ts:163-180`) rather than granting all registered tools, so MCP is
already excluded there *by construction*. This ruling records that property as an
invariant to preserve and test, not a new rule to add. `safe` denies all MCP.

**R6 — Tool sets are pinned by a lockfile.** `Mcp(server)` otherwise grants whatever the
server advertises today; a server upgrade silently widens the grant. codebase-memory-mcp
ships `delete_project`, `index_repository` and `manage_adr`, so this is a real capability
risk, not a theoretical one.

**R7 — The connection pool is keyed by `(serverId, workdir)`.** nax runs stories in
parallel worktrees. A server such as codebase-memory-mcp is inherently cwd-scoped — it
indexes a repository — so one run-scoped connection pointed at the main checkout would
answer every worktree's queries against the wrong tree. That is a silent-wrong-answer
failure, not a crash. Cost: one subprocess per active worktree per server. Accepted.

**R8 — Failure degrades, it does not abort.** A server that will not connect has its
tools dropped and the run continues.

**R9 — The advertised tool set is immutable within a hop.** `tools/list_changed` is
ignored in v1. Mutating the list mid-turn produces transcripts whose tool results
reference tools no longer advertised.

**R10 — stdio transport only in v1.** Streamable HTTP is deferred (§7), but the client
sits behind a transport interface so it can be added without touching the adapter,
grant, or lifecycle layers.

## 4. Design

### US-001 — `mcp` config block

New `src/config/schemas-mcp.ts` exporting `McpConfigSchema`, `.strict()` so a typo'd key
fails loudly rather than being silently stripped. Mounted in `NaxConfigSchema`
(`src/config/schemas.ts`) alongside `install:` and `quality:`, using the derived-default
idiom already used for `context:` (`schemas.ts:304`) rather than a hand-written literal
default, which drifts.

```json
{
  "mcp": {
    "servers": {
      "codebase-memory": {
        "command": "codebase-memory-mcp",
        "args": [],
        "env": {},
        "stages": ["run", "verify", "review"],
        "allowedTools": ["search_graph", "trace_path", "get_code_snippet"],
        "timeoutMs": 60000,
        "enabled": true
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `command`, `args`, `env` | how to spawn the stdio server |
| `stages` | pipeline stages this server attaches to; `["*"]` = all native stages |
| `allowedTools` | optional narrowing; omitted ⇒ every locked tool is grantable |
| `timeoutMs` | per-call timeout, default `60000` (US-006) |
| `enabled` | kill switch without deleting the block |

`stages` entries are validated against `PipelineStage | "*"` — `PipelineStage`
(`src/config/permissions.ts:18-27`) being `plan | run | setup | verify | review |
rectification | regression | acceptance | complete`, plus the literal `"*"` meaning every
stage. There is **no `implement` stage** — implementation work runs under `run`. An
unknown stage name is a schema error, not a silently-ignored entry; a server attached to
a stage that never executes is not an error.

`enabled: false` short-circuits before everything: the server is not connected, not
locked, and contributes no grants. It does not need a lock entry to be disabled, and
disabling a server never invalidates the lockfile.

Server ids are constrained to `[a-z0-9][a-z0-9_-]*` so the `mcp__<server>__<tool>`
namespace stays unambiguously splittable.

`AgentManagerConfig` is selector-derived
(`src/config/selectors.ts:170` — `ReturnType<typeof agentManagerConfigSelector.select>`),
so `agentManagerConfigSelector` must be widened to carry the `mcp` block through to
`resolvePermissions`. The alternative is the local-widening workaround already used for
`quality`/`install` (see the `RULING F2` comment at
`src/agents/coding-tool-support.ts:185-199`); widening the selector is preferred here
because the permission layer — not just the hop — needs the block.

Also required, per the config checklist the repo already enforces: a runtime interface in
`runtime-types-mcp.ts` re-exported through `runtime-types.ts`, `schema.ts` and
`config/index.ts`; and field documentation in `src/cli/config-descriptions.ts`, which
`test/unit/cli/config-descriptions.test.ts` asserts stays in sync with the schema.

**Acceptance:** a config declaring two servers with disjoint `stages` parses; an unknown
key inside a server block fails with `CONFIG_SCHEMA_INVALID`; an invalid server id is
rejected; adding a second server requires no change to any file under `src/operations/`.

### US-002 — Connection pool, keyed by `(serverId, workdir)`

New `src/mcp/pool.ts`. Constructed in `createRuntime` (`src/runtime/index.ts:282`, which
is synchronous — so construction must be synchronous and connection must not be) and torn
down in `close()` (`:424-447`).

- **Lazy connect.** A server connects on first advertisement for a given workdir, not at
  startup; a run does not know its stage set upfront, and eager connect would pay
  subprocess cost for servers no executed stage reaches. Connect carries its own timeout.
- **Memoized per key.** Concurrent first-use for the same `(serverId, workdir)` awaits one
  in-flight connect, never two.
- **Requests may be serialized per connection.** The turn loop dispatches tool calls in a
  sequential `for` loop (`src/agents/native/session/turn-loop.ts:404`), awaiting each
  before the next, so a single hop never has two calls in flight against one server. A
  simple request/response client is sufficient; concurrent request-id correlation would
  be machinery no code path exercises. (Distinct worktrees get distinct connections per
  R7, so cross-story parallelism does not contradict this.)
- **Teardown** follows the `argv-exec` precedent (`src/utils/argv-exec.ts:57-93`):
  `detached: true` so `killProcessGroup` reaches grandchildren, bounded graceful close,
  then SIGKILL. Children register in `pidRegistry` (`src/runtime/index.ts:318`) so nax's
  existing kill paths reach them. `close()` stays idempotent.

**Acceptance:** two workdirs against one server id produce two subprocesses; `close()`
twice is a no-op the second time; every spawned pid appears in the registry; no orphan
survives `close()`.

### US-003 — Discovery, adaptation, and the lockfile

On connect: `tools/list` once, cached on the pool entry. Per hop,
`resolveCodingToolSupport` (`src/agents/coding-tool-support.ts:167`) reads the cache —
no connection work on the hot path — and adapts each descriptor to a `CodingTool`:

```
name:        `mcp__${serverId}__${toolName}`
description: server-supplied, sanitized (US-005)
inputSchema: server-supplied, validated (US-005)
scope:       { pathFields: [] }          // no path fields; gated at tool-name level
run:         (input) => pool.call(serverId, workdir, toolName, input)
```

**Which `workdir`?** The hop's **permitted root** (`ctx.root`, the policy root for that
call), *not* the `workdir` passed to `createRuntime`. This is the whole point of R7 and
the easiest place to lose it: an implementer reaching for the runtime's `workdir` —
which is right there on the object the pool hangs off — silently reintroduces exactly
the stale-index bug R7 exists to prevent, and it will pass every test that does not use
two worktrees.

A name colliding with `RESERVED_TOOL_NAMES` (`registry.ts:74-87`) is refused at
adaptation time. To be honest about what this buys: the `mcp__` prefix already makes
collision with `Read`/`Write`/`Delete` structurally impossible, so the check is
defence-in-depth against a future change to the prefix scheme, not a live guard. Tool
names containing `__` are fine and need no escaping — the namespaced name is never parsed
back apart, which is why `ToolCallRecord` carries an explicit `server` field (US-007).

**Lockfile — `.nax/mcp-lock.json`.** Records, per server, each discovered tool name and a
hash of its input schema. Only tools present in the lock are grantable. A tool that
appears later is advertised as denied until the lock is refreshed by an explicit command
(`nax mcp lock`). Drift is then visible and deliberate, the same posture as `bun.lock`.

**Acceptance:** a tool absent from the lock is not grantable and its denial names the
refresh command; a tool whose schema hash changed is likewise withheld; a server whose
tool set is unchanged produces a byte-identical lock on re-run.

### US-004 — Attachment and grants

Two knobs, with a strict direction of travel:

1. `mcp.servers.<id>.stages` — the attachment SSOT, honoured in **every** profile.
2. `Mcp(server)` / `Mcp(server:tool)` in a `scoped` profile — may only **narrow** an
   existing attachment, never widen it.

Wiring:

- `resolvePermissions(config, stage)` (`permissions.ts:160-191`) gains MCP grants derived
  from `mcp.servers.*.stages` ∩ lock ∩ `allowedTools`, for `unrestricted` and `scoped`.
  `safe` yields none (R5).

- **Grants must be emitted already expanded, one `ToolGrant` per namespaced tool name.**
  This is the single easiest thing to get wrong in this design. `compileToolPolicy` keys
  grants by exact tool name — `compiled.get(tool)` in `check`, and `grantedTools()`
  returns `[...compiled.keys()]` (`src/tools/policy.ts:288-295`). Meanwhile `advertised()`
  tests `granted.has(name)` where `name` is the full `mcp__<server>__<tool>`. So a grant
  left in its parsed shape `{ tool: "Mcp", patterns: ["codebase-memory"] }` compiles to
  the key `"Mcp"`, which matches no advertised name, and **every MCP call is denied**.

  `resolvePermissions` therefore emits:

  ```
  { tool: "mcp__codebase-memory__search_graph", patterns: ["*"] }
  { tool: "mcp__codebase-memory__trace_path",   patterns: ["*"] }
  ```

  `Mcp(...)` is **surface syntax only** — a way for a human to write a narrowing rule in a
  scoped profile. It never survives into a compiled grant.

- `parseToolExpression` (`permissions.ts:144-154`) parses `Mcp(a,b)` into
  `{ tool: "Mcp", patterns: ["a","b"] }` without modification. `resolveScopedPermissions`
  then applies the narrowing and expands the result into the per-tool grants above.
- `resolveCodingToolSupport` appends the resolved MCP tool names to the declared array
  before calling `advertised()`. **`advertised()` is unchanged** (R3).
- `turn-loop.ts:452` needs no change: once the names are in `codingToolNames` they route
  as `"coding-tool"` and dispatch through `runtime.callTool` unmodified.
- `policy.check` needs no new branch. With `scope` carrying no `argvField`, no
  `verbField` and empty `pathFields`, the grant lookup is the whole gate — which is the
  intended semantics for a tool with no path or verb surface.

**Acceptance:** a server attached to `run` is advertised there and absent from a
stage it does not list; under `safe` no MCP tool is advertised anywhere; under
`unrestricted` a configured-but-unattached server is not advertised; a scoped profile
narrowing to `Mcp(codebase-memory:search_graph)` advertises exactly one tool; a scoped
profile naming a server with no `stages` entry widens nothing.

The regression test that matters most: **`grantedTools()` contains the full namespaced
names, and no entry equal to `"Mcp"`.** A grant that survives in its parsed shape denies
every call at runtime while every unit test of the parser still passes.

### US-005 — Untrusted input from servers

Tool descriptions and schemas arrive from a subprocess and go straight into the model's
tool list, which makes descriptions a prompt-injection surface and schemas an unbounded
context cost — codebase-memory-mcp alone advertises 17 tools.

The adapter therefore: caps description length and total schema bytes per server; rejects
a schema that is not a JSON object; strips control characters from descriptions and
names; and truncates rather than drops, so an over-long description degrades instead of
removing the tool.

**Acceptance:** an oversized description is truncated and the tool still works; a
non-object schema causes that single tool to be skipped, not the whole server to fail; a
description carrying control characters is sanitized.

### US-006 — Failure, restart, timeout

- **Connect failure** → warn, tools not advertised, run continues (R8).
- **Death mid-run** → in-flight calls return `{ isError: true }` carrying "server
  unavailable", *as data, not a thrown error*, consistent with ADR-029 §5's
  denial-as-data posture. The advertised set is **not** mutated mid-hop (R9); removal
  takes effect at the next hop.
- **Restart** is bounded, reusing the existing shape rather than inventing one:
  `agent.native.transportRetry` (`maxAttempts: 3`, `baseDelayMs: 2000`,
  `src/config/schemas-infra.ts:330-339`), mirrored per server.
- **Per-call timeout** is `timeoutMs`, per server, **default `60000`**. The default is a
  deliberate compromise, not a measured value: nax's existing bounds are
  `GIT_TIMEOUT_MS` 10 s (`src/utils/git.ts:13`) and `EXEC_TIMEOUT_MS` 300 s
  (`src/tools/run-command-exec.ts:43`), and MCP calls span both extremes —
  `search_graph` is milliseconds, `index_repository` is minutes. 60 s is long enough for
  any interactive query and short enough that a wedged server does not consume a hop.
  A server with genuinely long operations raises its own `timeoutMs`; the per-server
  field exists precisely so the global default does not have to satisfy both cases.

**Acceptance:** a server whose command does not exist degrades without failing the run; a
server killed mid-hop yields an error tool-result rather than an exception, and the tool
list for that hop is unchanged; a call exceeding `timeoutMs` returns an error result and
does not leak the subprocess.

### US-007 — Audit and telemetry

MCP calls dispatch through `runtime.callTool` unchanged and so inherit `ToolCallRecord`
(`src/tools/tool-audit.ts`) for free. Three additions:

1. **`server?: string` on `ToolCallRecord`.** The name prefix is parseable, but telemetry
   that string-splits tool names to group by server breaks silently when a naming
   convention shifts.
2. **Pre-truncation result bytes.** `resultBytes` is currently measured *after* the
   `maxBytes` slice (`runtime.ts:244`, cap `DEFAULT_TOOL_MAX_BYTES = 40_000` at `:28`),
   so elision is invisible — a 2 MB graph result and a 40 KB one both ledger as 40 000.
   Recording both makes "how much did we discard" answerable. This matters more for MCP
   than for built-ins because graph queries return unbounded payloads by nature.
3. **Advertised-schema bytes per hop.** 17 tool schemas enter the prompt on every hop
   whether or not a single tool is called — a fixed per-hop tax that appears in no ledger
   today. Recording it turns "is MCP worth its context cost" into a measured question.
   The same instrument is what nax#1991's context-burn report needs, so it is built once
   and shared.

**Server lifecycle events** (connect ok/fail, restart, disconnect) go to the logger and a
small per-run rollup in the run artifacts — *not* into `ToolCallRecord`, whose semantics
are strictly per-call. A run must be able to answer "was codebase-memory actually
attached?" without log spelunking.

**Denials** carry a redirect (`src/tools/denial-redirect.ts`): a tool withheld by lock
drift says so and names the refresh command, rather than reading as a generic "not
permitted" and burning turns.

**No cost-ledger entry.** MCP servers are local subprocesses with no rate card; their
cost is entirely indirect — schema bytes in the prompt, result bytes in the transcript —
and both are covered above.

**Acceptance:** a successful MCP call ledgers with `server` set and both byte counts; a
degraded server appears in the run rollup; a lock-drift denial names the refresh command.

## 5. Sequence

US-001 (config) → US-002 (pool) → US-003 (discovery + lock) → US-004 (grants) are a
chain; each depends on its predecessor. US-005 (sanitization) and US-007 (audit) can land
alongside US-003 and US-004 respectively. US-006 (failure) depends on US-002 only.

US-004 is the first point at which a tool actually reaches a model, so it is the first
end-to-end verifiable slice.

## 6. Verification

The end-to-end anchor is a fake stdio MCP server checked into `test/fixtures/` that
advertises a known tool set and can be told to die on demand. Everything above is then
testable without a network or a real server, including R7's two-workdir case and US-006's
mid-hop death.

The one thing fixtures cannot prove is the context-cost claim. Before declaring the
feature worthwhile, run the US-007 schema-bytes metric against a real
`codebase-memory-mcp` attachment and compare turn counts and token spend on a story with
and without it. **`#1990`'s 48 % needs measuring, not assuming** applies here too: the
premise that graph tools beat `Grep` sweeps is plausible and unmeasured.

## 7. Out of scope

- **ACP.** Coding tools never reach the ACP adapter — there are no `codingTools`
  references in the ACP files — so ACP is excluded by construction rather than by a
  special case. No guard is needed; a test records the property.
- **nax as an MCP server** (R1).
- **Streamable HTTP / remote servers** (R10). The transport interface accommodates it;
  nothing else here presumes stdio beyond the pool's spawn path.
- **`tools/list_changed` handling** (R9).
- **MCP prompts and resources.** Tools only. `ListMcpResourcesTool`-style surfaces are a
  separate feature.
- **OAuth / authenticated servers.** Follows HTTP transport, not before it.
