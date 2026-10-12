# ACP tool delivery + MCP tool-surface artifact — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver stage-granted MCP provider tools to claude ACP sessions over the existing loopback host, narrow the ACP profile by the op's declared tools, and record every session's MCP tool surface (per-session artifact + end-of-run adoption summary).

**Architecture:** `resolveCodingToolSupport` already resolves provider tools per hop on both transports; this plan extends `ResolvedProviderTools` with skip/withhold evidence, stamps a `toolSurface` record into both tool-audit writers, and teaches nax's ACP adapter to hand policy-allowed provider tools (adapted to `EmbedderTool`) to `openContext` for agents whose registry entry declares a pre-approval channel. Declared tools narrow the profile via `acpProfileFor`; an end-of-run aggregator reads tool-audit files into `status.json` with a zero-adoption WARN.

**Tech Stack:** Bun 1.4 + TypeScript strict (ESM), bun:test, zod config, Biome.

**Spec:** `docs/superpowers/specs/2026-10-11-acp-mcp-tool-surface-design.md` (decisions D1–D7; the plan argues from it).

## Global Constraints

- Permission SSOT: profile still derives from `resolvePermissions`' resolved mode; the declaration only narrows. Never hardcode `approve-all`/`approve-reads` (consumer sites take `// nax-permission-mode-allow: <reason>`).
- D2-i: never widen a profile to make an open succeed.
- `packages/nax/src/agents/acp/` cannot import `NaxConfig` (`check:adapter-no-config-import`).
- nax-agent: import with `#src/`, Node-compatible only (`check:no-bun-apis`), any export added to `.` requires `bun run api:update`; `_*Deps` seams for external calls; functions ≤30 lines; no `any` in public APIs.
- New/changed `src/` files stay under 400 lines.
- ACP delivery is claude-only (D3): gated on `registryEntry(agent)?.preApproval !== undefined`; all other agents keep today's tool-less open with the skip recorded.
- Conventional commits, one concern per commit.

## Review Focus

1. **A session that calls zero tools but was offered MCP tools must still produce a tool-audit file** (surface present ⇒ write despite empty `calls`) — pinned in Task 2.
2. **A provider tool bound by an `Mcp(...)` deny or ask rule must never reach the ACP loopback** (pre-approval would bypass layer 2 forever) — pinned in Task 5.
3. **An op that omits `tools` (materialized default: Read/Glob/Grep/scratchpad) must narrow its ACP session to `read` under `approve-all`**, matching native parity — pinned in Task 8.
4. **A non-claude agent name with provider tools available must not fail the open** — tools dropped, `skippedProviders` gains `mcp-pre-approval-unsupported`, session opens tool-less — pinned in Task 9.
5. **Provider tool `isError` results must cross the EmbedderTool boundary as errors**, not silent successes — pinned in Task 9.

---

### Task 1: `ResolvedProviderTools` evidence — `skipped` + `withheld` (nax-agent)

**Files:**
- Modify: `packages/nax-agent/src/tools/provider-advertise.ts:15-71`
- Test: `packages/nax-agent/test/unit/tools/provider-advertise.test.ts`

**Interfaces:**
- Produces: `ResolvedProviderTools` gains
  `readonly skipped: readonly { providerId: string; reason: "stage-mismatch"; stages: readonly string[] }[]`
  and `readonly withheld: readonly { providerId: string; localName: string; reason: "not-admitted" }[]`.
  `resolveProviderTools` populates both: a provider failing `providerAttachesTo` appends to `skipped` (with its configured `stages`); a sanitized tool rejected by `options.admits` appends to `withheld`. Both default `[]` in the empty return (used by `resolveProviderContribution`'s scope-off arm — keep it updated).
- Produces (D5): each `skipped` entry logs once, at debug: `getSafeLogger()?.debug("mcp", `[provider] ${providerId} not attached`, { stage, stages })` — `getSafeLogger` from `#src/infra/index`.

- [ ] **Step 1: Write failing tests** in `provider-advertise.test.ts` — new cases: (a) provider with `stages: ["run"]` queried at stage `"review"` lands in `skipped` with `stages: ["run"]` and contributes no tools; (b) `admits` rejecting one of two sanitized tools puts it in `withheld` (`reason: "not-admitted"`) while the other is advertised; (c) empty providers return `skipped: []`, `withheld: []`.
- [ ] **Step 2: Run** `bun test ./test/unit/tools/provider-advertise.test.ts --timeout=60000` — Expected: FAIL (fields missing).
- [ ] **Step 3: Implement** the interface additions and population logic; keep the function ≤30 lines by extracting the per-provider loop body if needed.
- [ ] **Step 4: Run** the file's tests — Expected: PASS. Also run `packages/nax` consumer tests later compile: `bun run typecheck` in `packages/nax-agent`.
- [ ] **Step 5: Commit** `feat(nax-agent): record stage skips and withheld provider tools in resolveProviderTools`

### Task 2: `ToolSurfaceDraft`/`ToolSurfaceRecord` types + sink stamps surface and writes on zero calls (nax-agent)

**Files:**
- Modify: `packages/nax-agent/src/tools/tool-audit.ts` (types near `ToolAuditHeader` :231-236; `createToolAuditSink` :256-319; write predicate at :268)
- Test: `packages/nax-agent/test/unit/tools/tool-audit.test.ts`

**Interfaces:**
- Produces (exported from `.`):
```ts
export interface ToolSurfaceDraft {
  readonly stage: string;
  readonly declaredTools: readonly string[];
  readonly advertised: readonly { providerId: string; names: readonly string[] }[];
  readonly withheld: readonly { providerId: string; name?: string; reason: string }[];
  readonly skippedProviders: readonly { id: string; reason: string; stages?: readonly string[] }[];
  readonly failures: readonly { providerId: string; reason: string }[];
}
export interface ToolSurfaceRecord extends ToolSurfaceDraft {
  readonly transport: "native" | "acp";
  readonly profile?: "full" | "read";
}
```
- Produces: `createToolAuditSink` opts gain `toolSurface?: ToolSurfaceRecord`; the file body gains `"toolSurface"` when present; the write predicate becomes `if (calls.length === 0 && opts.toolSurface === undefined) return;` (flushPartial/`record`-after-partial logic keyed off the same predicate).
- Consumes (later tasks): nax passes `toolSurface` through the sink opts on both paths.

- [ ] **Step 1: Write failing tests** in `tool-audit.test.ts`: (a) sink created with a `toolSurface` and zero recorded calls → flush writes a file whose body carries `toolSurface` and `calls: []`; (b) sink with calls + surface → both present; (c) existing "empty flush writes nothing" test still passes unchanged (no surface, zero calls).
- [ ] **Step 2: Run** `bun test ./test/unit/tools/tool-audit.test.ts --timeout=60000` — Expected: (a),(b) FAIL, (c) PASS.
- [ ] **Step 3: Implement** the types (this file, above `ToolAuditHeader`), the opts field, the body stamp, and the predicate. Export the new types from `src/index.ts`.
- [ ] **Step 4: Run** the tests — Expected: PASS. Run `bun run check:api` — Expected: FAIL (surface change).
- [ ] **Step 5: Run** `bun run api:update`, then `bun run check:api` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(nax-agent): stamp per-session MCP tool surface into the tool-audit ledger`

### Task 3: `OpenSessionOpts` carries delivery fields (nax-agent)

**Files:**
- Modify: `packages/nax-agent/src/session/session-types.ts:92-260` — alongside `toolAudit` (:145-154) add: `readonly providerTools?: readonly CodingTool[]`, `readonly declaredTools?: readonly string[]`, `readonly toolSurface?: import("#src/tools/tool-audit").ToolSurfaceDraft` (doc: "ACP delivery (D3): provider tools already policy-filtered; declared tools narrow the ACP profile; the transport-less surface draft the adapter finalizes").
- Test: `packages/nax-agent/test/unit/session/` — extend whichever existing opts-validation test covers `OpenSessionOpts` (search `OpenSessionOpts` under `test/unit/session/`); if validation is structural (no schema), typecheck + the Task 9 consumer tests cover it.

**Interfaces:**
- Produces: `OpenSessionOpts.providerTools` / `.declaredTools` (Task 5 adds `toolSurface` on `OpenSessionRequest`) — the fields nax's ACP adapter and hops set and read.

- [ ] **Step 1: Add the two optional fields** with doc comments matching the file's style.
- [ ] **Step 2: Run** `bun run typecheck` in `packages/nax-agent` — Expected: PASS. `bun run check:api` — Expected: FAIL.
- [ ] **Step 3: Run** `bun run api:update` && `bun run check:api` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(nax-agent): open-session options for ACP provider-tool delivery`

### Task 4: `buildToolSurfaceRecord` + ACP delivery filter (nax)

**Files:**
- Create: `packages/nax/src/agents/tool-surface.ts`
- Modify: `packages/nax/src/agents/coding-tool-support-resolve.ts` (`resolveCodingToolSupport` :460-543, `resolveProviderContribution` :297-330, `unionDeclaredTools` :342-352)
- Modify: `packages/nax-agent/src/coding-tools/coding-tool-support.ts:41-45` (`CodingToolSupport` gains `readonly toolSurface?: ToolSurfaceRecord` and `readonly acpDelivery?: { readonly tools: readonly CodingTool[]; readonly declaredTools: readonly string[] }`)
- Test: `packages/nax/test/unit/agents/tool-surface.test.ts` (new), `packages/nax/test/unit/agents/coding-tool-support-resolve.test.ts` (extend)

**Interfaces:**
- Produces: `buildToolSurfaceDraft(input: { stage: string; declaredTools: readonly string[]; providerResult: ResolvedProviderTools }): ToolSurfaceDraft` — pure; `advertised` from `providerResult.entries` (only entries with non-empty `names`, mapped to the draft's `name` field naming), `withheld` (from `providerResult.withheld`, `localName` → `name`), `skippedProviders` (from `skipped`, `stages` → `stages`), `failures` passed through; `extraSkipped?: readonly { id: string; reason: string }[]` appended when given.
- Produces: `finishToolSurface(draft: ToolSurfaceDraft, transport: "native" | "acp", profile?: "full" | "read"): ToolSurfaceRecord` — one-line spread.
- Produces: `filterAcpDelivery(providerResult: ResolvedProviderTools, rules: { deniedMcp: readonly string[]; askedMcp: readonly string[] }): { tools: readonly CodingTool[]; withheldExtra: readonly { providerId: string; name: string; reason: "denied" | "ask-ruled" }[] }` — pure; drops tools whose `providerIdByTool`/name matches `mcpRuleAdmits(deniedMcp|askedMcp, …)`; use `partitionMcpRules`/`mcpRuleAdmits` from `@nathapp/nax-agent` (`provider-grants.ts:43-66`).
- Consumes: `resolveProviderContribution` must expose its `providerResult` + the partitioned `denied`/`asked` MCP patterns to `resolveCodingToolSupport`'s build step (it already has them in scope — restructure the return or pass through).

- [ ] **Step 1: Write failing tests** for the pure functions in `tool-surface.test.ts`: scope `"none"` ⇒ `advertised: []` + `skippedProviders` contains `{ id: "*", reason: "provider-scope:none" }` (reason string embeds the scope value: `provider-scope:none` / `provider-scope:rules`); entries/withheld/failures passthrough with `localName` → `name`; `finishToolSurface` stamps `transport`/`profile`; delivery filter keeps rule-free tools, drops a `Mcp(server)`-denied tool with `reason: "denied"` and a `Mcp(server:tool)`-asked tool with `reason: "ask-ruled"`.
- [ ] **Step 2: Run** `bun test test/unit/agents/tool-surface.test.ts --timeout=60000` (from `packages/nax`) — Expected: FAIL.
- [ ] **Step 3: Implement** the three functions (`buildToolSurfaceDraft` ≤30 lines by composing small helpers).
- [ ] **Step 4: Extend `resolveCodingToolSupport`**: pass `toolSurface: finishToolSurface(buildToolSurfaceDraft({ stage, declaredTools: declaredWithProviders, providerResult }), "native")` into `buildCodingToolSupport` (new passthrough opt; stamp via the sink — Task 2's opt) and set `acpDelivery: { tools: filterAcpDelivery(...).tools, declaredTools: declaredWithProviders, surface: buildToolSurfaceDraft({...}) }` only when provider tools exist. Extend `coding-tool-support.test.ts` sibling tests: native surface present in the flushed audit file (`transport: "native"`, `advertised` names); a provider tool under a deny rule is absent from `acpDelivery.tools`.
- [ ] **Step 5: Run** `bun test test/unit/agents/coding-tool-support-resolve.test.ts --timeout=60000` — Expected: PASS (new cases green, old cases untouched).
- [ ] **Step 6: Commit** `feat(nax): build the MCP tool-surface record and the policy-filtered ACP delivery set`

### Task 5: Hop wiring — codingSupport reaches the open call (nax)

**Files:**
- Modify: `packages/nax/src/operations/build-hop-callback.ts:171-190` (pass `tooling.codingSupport` into `prepareHopSession`)
- Modify: `packages/nax/src/operations/build-hop-callback-hop.ts:364-438` (`prepareHopSession` gains the codingSupport param; `openSessionRequest` :397-419 gains `...(acpDelivery !== undefined ? { providerTools: acpDelivery.tools, declaredTools: acpDelivery.declaredTools, toolSurface: acpDelivery.surface } : {})`)
- Modify: `packages/nax/src/session/types.ts:146` (`OpenSessionRequest` gains `providerTools?`, `declaredTools?`, `toolSurface?: ToolSurfaceDraft`)
- Modify: `packages/nax/src/session/open-session-extras.ts:40` (forward `providerTools`, `declaredTools`, `toolSurface` the way `toolAudit` is forwarded)
- Test: `packages/nax/test/unit/operations/build-hop-callback-hop.test.ts` (extend), `packages/nax/test/unit/session/` open-session-extras test (extend, create if absent)

**Interfaces:**
- Consumes: Task 4's `codingSupport.acpDelivery` (`tools`, `declaredTools`, `surface` — a transport-less `ToolSurfaceDraft`).
- Produces: `OpenSessionRequest.toolSurface` (draft) + `providerTools`/`declaredTools`; the ACP adapter finalizes the draft (Task 7); native sessions ignore all three fields (native adapter never reads them; its stamped surface comes from codingSupport's sink).

- [ ] **Step 1: Write failing test** in `build-hop-callback-hop.test.ts`: with a fake `SessionManager` capturing `openSession` opts and a codingSupport whose `acpDelivery` is set, the open request carries `providerTools`, `declaredTools`, and a transport-less `toolSurface` draft; without `acpDelivery` the fields are absent.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the parameter threading (≤30-line functions; extract request assembly if `prepareHopSession` grows).
- [ ] **Step 4: Run** hop + session test files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(nax): thread the ACP provider-tool delivery into the op-dispatch open path`

### Task 6: Profile narrowing (nax)

**Files:**
- Modify: `packages/nax/src/agents/acp/profile-map.ts`
- Modify: `packages/nax/src/agents/acp/open-context.ts:100` (`acpProfileFor(opts.resolvedPermissions.mode, opts.declaredTools)`)
- Test: `packages/nax/test/unit/agents/acp/profile-map.test.ts` (extend), `packages/nax/test/unit/agents/acp/open-context.test.ts` (extend)

**Interfaces:**
- Produces: `acpProfileFor(mode: ResolvedPermissions["mode"], declaredTools?: readonly string[]): AcpProfile` — `undefined`/empty ⇒ mode alone; else if `declaredTools` contains any of `ACP_WRITE_CLASS_TOOLS = ["Write", "Edit", "Delete", "Bash", "Exec", "RunCommand", "GitCommit"]` ⇒ mode's profile, else `"read"`. (`Scratchpad*` names are not in the set — membership already exempts them; say so in a comment.) Export `ACP_WRITE_CLASS_TOOLS`.

- [ ] **Step 1: Write failing tests**: `[Read, Glob, Grep]` under `approve-all` ⇒ `"read"`; default-materialized set (Read/Glob/Grep/ScratchpadWrite/ScratchpadRead/ScratchpadList) under `approve-all` ⇒ `"read"`; `[Read, Write]` under `approve-all` ⇒ `"full"`; `undefined` ⇒ mode alone (existing three tests keep passing).
- [ ] **Step 2: Run** `bun test test/unit/agents/acp/profile-map.test.ts --timeout=60000` — Expected: new FAIL, old PASS.
- [ ] **Step 3: Implement**; update `open-context.ts` call site.
- [ ] **Step 4: Run** profile-map + open-context tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(nax): narrow the ACP profile by the op's declared tools (D2)`

### Task 7: Embedder adaptation + capability gate + surface finalization (nax)

**Files:**
- Create: `packages/nax/src/agents/acp/provider-embedder.ts`
- Modify: `packages/nax-agent-acp/src/client/index.ts` (export `registryEntry` + `type AgentRegistryEntry` alongside the existing `AcpAgentName` re-export at :15)
- Modify: `packages/nax/src/agents/acp/open-context.ts` (`OpenContextInput` gains `agent: AcpAgentName`; `tools` populated; surface finalized — see Interfaces)
- Modify: `packages/nax/src/agents/acp/session.ts:156-169, 238-278` (`openBackend` passes `agent`; `createSession` finalizes the surface before `createAuditRecorder`)
- Modify: `packages/nax/src/agents/acp/tool-audit.ts:44-103` (`createAuditRecorder(sessionName, target, surface?: ToolSurfaceRecord)` → passes `toolSurface` into its `createToolAuditSink`)
- Test: `packages/nax/test/unit/agents/acp/provider-embedder.test.ts` (new), `open-context.test.ts` + `session.test.ts` + `tool-audit.test.ts` (extend)

**Interfaces:**
- Produces: `toEmbedderTools(tools: readonly CodingTool[], workdir: string): EmbedderTool[]` — name/description/inputSchema 1:1, `approval: "never"`, `run` builds a minimal `ToolRunContext` (`{ root: workdir, resolvedPaths: new Map(), maxBytes: ACP_MCP_RESULT_MAX_BYTES, maxFileBytes: ACP_MCP_RESULT_MAX_BYTES, signal: ctx.signal }`, constant `ACP_MCP_RESULT_MAX_BYTES = 1_048_576` with a comment: per-call result cap for MCP results served over the loopback host) and maps `ToolResult` → `{ content, isError }`; rejects/throws surface as `isError: true` (Review Focus 5).
- Produces: `finalizeAcpSurface(agent: AcpAgentName, opts: Pick<OpenSessionOpts, "providerTools" | "toolSurface">, profile: AcpProfile): { tools: readonly EmbedderTool[]; surface: ToolSurfaceRecord | undefined }` — capability `registryEntry(agent)?.preApproval !== undefined` (`registryEntry` imported from `@nathapp/nax-agent-acp/client`): supported ⇒ tools adapted from `opts.providerTools`, surface `finishToolSurface(opts.toolSurface, "acp", profile)` when a draft exists; unsupported ⇒ `tools: []`, surface gains `skippedProviders: [...(draft?.skippedProviders ?? []), { id: agent, reason: "mcp-pre-approval-unsupported" }]` and `advertised: []` (Review Focus 4). No draft ⇒ `{ tools: [], surface: undefined }`.
- Consumes: `openContext` keeps reading `opts.providerTools`/`opts.declaredTools`; `session.ts` calls `finalizeAcpSurface` once and feeds both `openContext` (via a new `OpenContextInput` field) and `createAuditRecorder`.

- [ ] **Step 1: Write failing tests**: `provider-embedder.test.ts` — name/schema passthrough, `approval: "never"`, `run` happy path returns `{ content }`, throwing tool run ⇒ `{ isError: true }`; `open-context.test.ts` — claude + `providerTools` ⇒ `context.tools.length > 0` and surface `transport: "acp"`, `profile` narrowed per Task 6; codex + `providerTools` ⇒ `context.tools` empty and surface `advertised: []` with the skip entry; no `providerTools` ⇒ `tools: []`, surface undefined; `tool-audit.test.ts` (acp) — recorder with a surface and zero events writes a file carrying `toolSurface`.
- [ ] **Step 2: Run** the four test files — Expected: new cases FAIL.
- [ ] **Step 3: Implement** the client-entry export, then `provider-embedder.ts`, then the `open-context.ts`/`session.ts`/`tool-audit.ts` wiring (each function ≤30 lines). From `packages/nax-agent-acp`: `bun run check:api` → FAIL ⇒ `bun run api:update` → PASS.
- [ ] **Step 4: Run** `bun test test/unit/agents/acp/ --timeout=60000` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(nax): deliver MCP provider tools to claude ACP sessions over the loopback host (D1, D3)`

### Task 8: Adoption summary + WARN + status.json block (nax)

**Files:**
- Create: `packages/nax/src/mcp/adoption.ts`
- Modify: `packages/nax/src/execution/lifecycle/run-completion-phases.ts` (new phase between `logRunCompletion` :183 and `writeFinalStatus` :197; logger conventions per that file)
- Modify: `packages/nax/src/execution/lifecycle/run-completion.ts` (:58-100 options, :125-219 phases + `RunCompletionResult` gains `mcpAdoption?: McpAdoptionSummary`)
- Modify: `packages/nax/src/execution/status-writer.ts:310-337` (`writeFeatureStatus` overrides gain `mcpAdoption?: McpAdoptionSummary`; block written verbatim into the feature `status.json`)
- Modify: `packages/nax/src/operations/runner-completion.ts:403, :528` (forward `result.mcpAdoption` into both `writeFeatureStatus` calls)
- Test: `packages/nax/test/unit/mcp/adoption.test.ts` (new), status-writer test (extend)

**Interfaces:**
- Produces: `type McpAdoptionSummary = Readonly<Record<string, { sessionsOffered: number; sessionsCalled: number; totalCalls: number }>>`
- Produces: `summarizeMcpAdoption(args: { serverIds: readonly string[]; auditDir: string; fs?: AdoptionFs }): Promise<McpAdoptionSummary>` — reads `*.json` files in `auditDir` through an injectable fs seam (readdir + readfile; Bun-native); a session is *offered* to server S when its `toolSurface.advertised` contains S with non-empty `names`; a session *called* S when any `calls` row has `provider === S` (fallback: `tool` starts with `` `${S}__` ``); servers configured but absent from every file count `{0, 0, 0}`.
- Consumes: `config.mcp?.servers` keys + `toolAuditDir({ root: options.workdir, outputDir: options.outputDir }, feature)` (paths module :154-158) at the phase call site.

- [ ] **Step 1: Write failing tests** in `adoption.test.ts`: two files (one offered+called, one offered-never-called) + a configured-but-never-offered server ⇒ summary `{ s1: {1,1,n}, s2: {1,0,0}, s3: {0,0,0} }`; empty/missing dir ⇒ all-zero for configured ids.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `adoption.ts` (fs seam `_deps`-style, functions ≤30 lines).
- [ ] **Step 4: Write failing phase test**: run-completion with a seeded audit dir logs a `[WARN]` line `mcp: <id> was offered to N sessions and never called` (capture via the phase's logger arg, mirroring existing run-completion-phases tests) and returns `mcpAdoption`; then implement the phase (WARN only when `sessionsOffered > 0 && totalCalls === 0`).
- [ ] **Step 5: Extend the status-writer test**: `writeFeatureStatus(..., { mcpAdoption })` puts the block into the written JSON; implement + forward at both runner-completion call sites.
- [ ] **Step 6: Run** `bun test test/unit/mcp/adoption.test.ts test/unit/execution/ --timeout=60000` — Expected: PASS.
- [ ] **Step 7: Commit** `feat(nax): per-server MCP adoption summary with zero-adoption WARN in status.json (D6)`

### Task 9: Docs (D7)

**Files:**
- Modify: `docs/guides/mcp-and-interception.md`, `docs/guides/configuration.md` (wherever `stages` is documented)

- [ ] **Step 1:** Add: `run` does not cover `review`/`verify`/`rectification` — list every stage that must see a server; stage-granted tools are visible to every op in that stage including read-profile ones; ACP delivery is claude-only (other agents log and record a skip); the per-session `toolSurface` ledger block and the feature `status.json` `mcpAdoption` block; the zero-adoption WARN meaning.
- [ ] **Step 2: Commit** `docs(mcp): stages coverage, tool-surface ledger, adoption summary`

### Task 10: Full verification

- [ ] **Step 1:** From `packages/nax-agent`: `bun run typecheck && bun run lint && bun run test` — Expected: PASS. `bun run check:api` — PASS (snapshots updated in Tasks 2–3).
- [ ] **Step 2:** From `packages/nax`: `bun run typecheck && bun run lint && bun run test` — Expected: PASS.
- [ ] **Step 3:** From repo root: `bun run check:all` — Expected: PASS (includes `check:package-boundaries`, `check:adapter-no-config-import`, `check:permission-mode-ssot`).
- [ ] **Step 4:** `bun run typecheck` (root) — Expected: PASS. Fix anything found; amend-free follow-up commits.
- [ ] **Step 5:** Final commit if any fixes: `fix: review fixes for acp tool surface bundle`
