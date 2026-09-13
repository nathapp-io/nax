# Provider tools: dynamically-named tools for the native agent

Design only. Status: **design approved, not yet implemented.** No code changes are to be
made against this spec while the import-cycles refactor is in flight.

**Prerequisite for two other specs**, both of which need dynamically-named tools and
would otherwise build the same plumbing twice:

- `2026-09-13-nax-mcp-client-design.md` — tools discovered from external MCP servers
- `2026-09-13-nax-rtk-command-interception-design.md` — a recall tool contributed by a
  command interceptor

This spec exists because those two features share a mechanism but **not** a trust model,
and conflating the two would damage both (§3 R2).

## 1. Problem

Every tool the native agent can call is named by a closed type. `CodingToolName`
(`src/tools/types.ts:19-31`) is a fixed union of 11 built-ins; operation declarations are
`CodingToolName[]` (`src/operations/types.ts:12`); `AgentRunOptions.declaredTools` is
`readonly CodingToolName[]` (`src/agents/types.ts:170`); and `RESERVED_TOOL_NAMES`
(`src/tools/registry.ts:74-87`) forbids re-registering any of them.

That is a good design for a fixed tool set and an obstacle for a dynamic one. Two
in-flight features need tools whose names are not knowable at compile time:

- an MCP server's tool list, discovered at connect
- a tool contributed by whichever command interceptor is configured

Neither can be expressed today. This spec adds the one mechanism both need, and nothing
else.

## 2. Current state

`registerCodingTool` (`src/tools/registry.ts:91-127`) is documented as an in-process
extension point and **has no caller outside tests**. It is a process-global `Map`, which
is the wrong lifetime for tools that are per-run and sometimes per-workdir. This design
does not use it.

The seam that does fit already exists:

| Seam | Location | Note |
|---|---|---|
| `extraTools` | `src/tools/runtime.ts:90`, consulted `:104-105` | session-local tool list, looked up **before** the global registry |
| `advertised(declared)` | `src/tools/runtime.ts:174-184` | `granted.has(name)` then `lookup(name)` |
| `grantedTools()` / `check` | `src/tools/policy.ts:288`, `:291+` | grants keyed by **exact tool name** |
| `resolvePermissions` | `src/config/permissions.ts:160-191` | permission SSOT, keyed by `PipelineStage` |
| `resolveCodingToolSupport` | `src/agents/coding-tool-support.ts:167-252` | per-hop, already `async`, already builds `extraTools` |
| `ToolCallRecord` | `src/tools/tool-audit.ts` | per-call ledger |
| Dispatch routing | `src/agents/native/session/turn-loop.ts:449` | `codingToolNames.has(call.name)` decides coding-tool vs context-tool |

The comment at `runtime.ts:104-105` states the intent directly: the global registry cannot
hold session-local tools like `RunCommand`, whose declared commands are per-project, so
`extraTools` is consulted first. Provider tools are the same shape of problem.

## 3. Rulings

**R1 — `extraTools`, not the global registry.** Provider tools are per-run and may be
per-workdir. A process-global `Map` is the wrong lifetime and would leak between runs in
the same process.

**R2 — Two provider kinds, split by schema trust.** This is the ruling the whole spec
exists for.

| Kind | Schema authored by | Obligations |
|---|---|---|
| `static` | nax, in nax's repo, reviewed in nax's PRs | none beyond a normal built-in |
| `discovered` | an external process, at runtime | sanitization, size caps, and pinning |

A `discovered` tool's name, description and JSON schema go straight into the model's tool
list, which makes the description a prompt-injection surface and the schema an unbounded
context cost. A `static` tool's schema is exactly as trustworthy as `Read`'s.

Without this split one of two bad things happens: a nax-authored tool inherits lockfile
ceremony and sanitization it has no need of, or those protections get weakened until they
accommodate a trusted provider. Putting the obligations on the **kind** rather than on
every provider avoids both.

**R3 — Grants must be expanded to concrete names before compilation.** `compileToolPolicy`
keys grants by exact tool name — `compiled.get(tool)` in `check`, and `grantedTools()`
returns `[...compiled.keys()]`. A grant left in a parsed form such as
`{ tool: "Mcp", patterns: ["codebase-memory"] }` compiles to the key `"Mcp"`, which
matches no advertised name, and **every call to that provider's tools is denied**.

The failure mode is what makes this a ruling rather than an implementation note: every
unit test of the expression parser passes, and the break appears only at runtime. Grant
expression syntax is **surface syntax for humans**; it never survives into a compiled
grant.

**R4 — Declaration is bypassed; `advertised()` is unchanged.** Operation declarations live
in code, so requiring a code edit to use a configured provider would defeat the
config-only requirement both consuming specs carry. Provider tool names are appended to
the declared array at resolve time. `advertised()` itself is not modified.

**R5 — Provider tools are never wildcard-granted.** `unrestricted` enumerates its
built-ins explicitly (`permissions.ts:164-178`) rather than granting every registered
tool, so provider tools are excluded there by construction. This records that property as
an invariant to preserve and test. `safe` grants none.

**R6 — Attachment is per `PipelineStage`, configured on the provider.** Stage is the
granularity `resolvePermissions` already speaks. A parallel per-operation key would give
two answers to "may this call run".

**R7 — This spec adds no tools.** It is mechanism only. The MCP spec and the rtk spec
supply the providers.

## 4. Design

### US-001 — The `ToolProvider` interface

```
type ProviderKind = "static" | "discovered"

interface ToolProvider {
  readonly id: string              // [a-z0-9][a-z0-9_-]*
  readonly kind: ProviderKind
  readonly stages: readonly (PipelineStage | "*")[]
  tools(workdir: string): Promise<readonly ProviderTool[]>
}

interface ProviderTool {
  readonly localName: string       // unqualified, as the provider knows it
  readonly description: string
  readonly inputSchema: JSONSchema
  run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>
}
```

`tools(workdir)` takes the workdir because a provider may legitimately expose different
tools per working root, and because the consuming MCP spec keys its connections by
`(serverId, workdir)`. A `static` provider ignores the argument.

**Acceptance:** a provider with an invalid id is rejected at registration; a provider
declaring an unknown stage is rejected; `tools()` is never called for a stage the provider
does not attach to.

### US-002 — Naming and the reserved-name guard

Namespaced name: **`<providerId>__<localName>`**, with the provider id charset
(`[a-z0-9][a-z0-9_-]*`) keeping the boundary unambiguous.

The namespaced name is **never parsed back apart**. Local names containing `__` are
therefore fine and need no escaping, and the ledger carries the provider id as an explicit
field (US-005) rather than expecting a consumer to string-split.

A namespaced name colliding with `RESERVED_TOOL_NAMES` is refused at adaptation time. To
be honest about what this buys: a provider id cannot collide with `Read` or `Write`
because those contain no `__`, so the guard is defence-in-depth against a future change to
the naming scheme, not a live protection.

**Acceptance:** two providers exposing the same local name produce distinct namespaced
names; a local name containing `__` round-trips through dispatch; a synthetic name
colliding with a reserved name is refused.

### US-003 — Grant expansion

`resolvePermissions(config, stage)` emits one `ToolGrant` per namespaced tool name, fully
expanded (R3):

```
{ tool: "codebase-memory__search_graph", patterns: ["*"] }
{ tool: "rtk__recall",                   patterns: ["*"] }
```

Any grant-expression sugar a consuming spec defines — `Mcp(server)`, `Mcp(server:tool)` —
is parsed by `parseToolExpression` (`permissions.ts:144-154`), narrowed by
`resolveScopedPermissions`, and **expanded here** before reaching `compileToolPolicy`.

`policy.check` needs no new branch: a provider tool declares
`scope: { pathFields: [] }` — no `argvField`, no `verbField` — so the grant lookup is the
whole gate, which is the correct semantics for a tool with no path or verb surface.

**The regression test that matters:** `grantedTools()` contains namespaced names and **no
entry equal to a grant-expression keyword** such as `"Mcp"`. A grant that survives in
parsed shape denies every call at runtime while every parser test stays green.

**Acceptance:** a granted provider tool is callable; an ungranted one is denied with the
standard not-permitted reason; `grantedTools()` contains no expression keyword; under
`safe` no provider tool is granted; under `unrestricted` a provider not attached to the
stage contributes no grants.

### US-004 — Advertisement

`resolveCodingToolSupport` (`src/agents/coding-tool-support.ts:167`), per hop:

1. select providers whose `stages` include this stage
2. call `tools(workdir)` — **`workdir` is the hop's permitted root (`ctx.root`)**, not the
   runtime's `workdir`
3. adapt each to a `CodingTool` with the namespaced name and `scope: { pathFields: [] }`
4. pass them as `extraTools`
5. append their names to the declared array, then call `advertised()` unchanged (R4)

Step 2's parenthetical is load-bearing. `createRuntime(config, workdir)` has a workdir
sitting on the object a provider will likely hang off, and reaching for it silently binds
every worktree's calls to the main checkout. It passes every test that does not use two
worktrees.

`turn-loop.ts:449` needs no change: once the names are in `codingToolNames` they route as
`"coding-tool"` and dispatch through `runtime.callTool` unmodified.

**Acceptance:** a provider attached to `run` is advertised there and absent elsewhere;
adaptation uses the hop root, proven by a two-worktree test asserting each hop's provider
received its own root; with no providers configured, the advertised list is byte-identical
to today.

### US-005 — Untrusted schemas, for `discovered` providers only

Applied to `kind: "discovered"` and **not** to `static` (R2):

- cap description length and total schema bytes per provider
- reject a schema that is not a JSON object — skip that tool, not the whole provider
- strip control characters from names and descriptions
- truncate rather than drop, so an over-long description degrades instead of removing a
  working tool

**Acceptance:** a `discovered` provider's oversized description is truncated and the tool
still works; a non-object schema skips one tool only; a `static` provider's schema passes
through untouched, proven by a test asserting no sanitization is applied to it.

### US-006 — Audit

`ToolCallRecord` (`src/tools/tool-audit.ts`) gains **`provider?: string`**. Provider tools
dispatch through `runtime.callTool` unchanged and otherwise inherit the existing ledger.

Also recorded, because both consuming specs need it and neither should build it alone:
**advertised-schema bytes per hop**. Provider tool schemas enter the prompt on every hop
whether or not a tool is called — a fixed per-hop tax that appears in no ledger today.
This is the instrument nax#1991's context-burn report needs.

**Acceptance:** a provider tool call ledgers with `provider` set; a hop advertising
provider tools records its schema-byte total; a hop with no providers records zero.

## 5. Sequence

US-001 → US-002 → US-003 → US-004 is a chain. US-005 depends on US-001's `kind`. US-006
can land alongside US-004.

US-004 is the first end-to-end verifiable slice — the first point at which a
provider-supplied tool reaches a model.

## 6. Verification

Everything here is testable with a `static` fake provider: no MCP server, no rtk, no
network. The two cases worth calling out because they are easy to omit:

- **two worktrees**, asserting each hop's provider call received its own root (US-004)
- **`grantedTools()` contains no expression keyword** (US-003)

Both failures are invisible to unit tests of the component in isolation and only appear in
integration.

## 7. Out of scope

- **Any concrete provider.** Mechanism only (R7).
- **Connection lifecycle, pooling, restart, timeouts.** A `discovered` provider backed by
  a subprocess owns its own lifecycle; the MCP spec defines that.
- **Pinning / lockfiles.** Drift is a property of *discovery*, so `.nax/mcp-lock.json`
  belongs to the MCP spec. A `static` provider has nothing to drift.
- **Provider tools for ACP.** Coding tools never reach the ACP adapter — there are no
  `codingTools` references in `src/agents/acp/` — so this is excluded by construction.
- **Downloadable or third-party in-process plugins.** Providers are constructed by nax
  from config; this is not a plugin-loading path.
