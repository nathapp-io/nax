# ACP tool delivery + per-session MCP tool-surface artifact

**Date:** 2026-10-11
**Status:** Design — approved in brainstorming (builder check resolved, see D3/D4 settled points), not yet planned
**Closes:** #2444 (delivery + profile bounding) and #2410 items 1–3, 5 (observability). Item 4 (`hint`) deferred. #2372 untouched in code; adapter research filed there (2026-10-11 comment), delivery stays claude-only per D3.

## Goal

Two defects, one artifact:

1. **ACP sessions are tool-blind.** An op dispatched over ACP gets neither its declared
   coding tools nor its stage's MCP provider tools. `open-context.ts:102` opens every
   ACP session with `tools: []`, so `nax-agent-acp` never starts its loopback tool host
   and `session/new` carries `mcpServers: []` (`client/open.ts:223`) — even though both
   dispatch hops already call `resolveCodingToolSupport` and hold a fully resolved
   provider tool list at that moment. A server configured with
   `stages: ["review"]` reaches native sessions and never reaches an advisor on
   `agent: "claude"`.
2. **The read-only declaration does not bound ACP sessions.** `adviseOp` declares
   `tools: ["Read", "Glob", "Grep"]`, but the ACP profile is derived from the
   permission mode alone (`profile-map.ts:12-16`): under
   `execution.permissionProfile: "unrestricted"` a read-only advisor opens with the
   agent's full built-in tool set, writes and shell included.
3. **MCP adoption is unverifiable.** `resolveProviderTools` knows exactly which provider
   tools survive sanitisation, the lock and `admits`, and which providers it skipped for
   stage mismatch — and persists none of it. A configured, connected, never-called
   server produces zero signal, so "the model ignored the tool" cannot be told apart
   from "the tool was never advertised" (#2410 gaps 1–3).

After this design: an ACP session receives the stage's provider tools over the existing
loopback host, its profile is the narrower of the permission mode and the op's declared
tools, and every session — native or ACP — leaves a per-session record of exactly which
MCP tools it was offered, which were withheld, which providers were skipped and why,
plus (end of run) a per-server adoption summary with a zero-adoption WARN.

## Why the delivery is shaped the way it is (D1)

The loopback path exists and is exercised: `BackendOpenContext.tools` (EmbedderTools)
→ `createToolCalls` → `createToolHost` (HTTP MCP on `127.0.0.1`, bearer-token gated)
→ `session/new` `mcpServers: [{type:"http", name:"nax", ...}]` → the agent sees
`mcp__nax__<tool>`, pre-approved via Claude's `_meta.claudeCode.options.allowedTools`
(`client/pre-approval.ts`). nax's run path simply never populates `tools`.

**Decision D1 — deliver provider tools only; declared tools drive the profile, not the
host.** The op's declared coding tools (`Read`, `Glob`, `Grep`, …) are *not* re-served
as `mcp__nax__*` duplicates:

- The agent already has them natively; duplication adds the per-hop schema tax
  (`advertisedSchemaBytes`) and a twin-call ambiguity for zero new capability.
- Re-serving them bounds nothing: built-ins remain available under `full` profile
  regardless, and actually disabling built-ins would require a per-agent
  built-in-name disallowlist mapping — fragile, and the same territory #2372 is
  working through.
- The declared tools still do real work: they decide the profile (D2), they keep
  their native-path role unchanged, and the narrowed profile is recorded in the
  surface artifact (D4) so the bounding is auditable.

Rejected: literal delivery of declared tools over the loopback (the issue's Expected 1
wording) — the interpretation above preserves the issue's intent ("as native sessions
get them") for the tools the agent genuinely lacks, and achieves Expected 2 through the
only built-in lever the ACP protocol offers (the profile). Recorded as a decision on
#2444.

## Decisions

### D2 — profile = narrower of mode and declaration

`acpProfileFor(mode)` becomes `acpProfileFor(mode, declaredTools?)`:

- `undefined`/empty declaration → today's behaviour (mode alone).
- A declaration containing **no** tool from the write/shell class
  (`Write`, `Edit`, `Delete`, `Bash`, `Exec`, `RunCommand`, git-write; reuse
  `session-tool-support.ts`'s `WRITE_TOOLS` as the seed, extended with the exec
  identities) → `"read"`, whatever the mode resolved to.
- The universal scratchpad trio (`ScratchpadWrite/Read/List`) is **exempt** from the
  classification — it is nax-internal scratch space, not a repo write, and
  `resolveCodingToolSupport` unions it into every declaration.
- Provider (MCP) tools do not participate in the classification: they bypass the
  declaration half by rule (R12) and are stage-scoped, not op-scoped. A read-profile
  session may still call a stage-granted MCP write tool; that boundary is
  stage-level by design and stated in the docs (D7).
- The narrowing consumes the **materialized declaration** — the resolved tool set the
  dispatch path already holds (an omitted op declaration has become
  `DEFAULT_CODING_TOOLS` by then), not a raw may-be-absent field (settled). Rationale:
  native parity. A default-declared op is already read-only on the native path (the
  default carries no write tools and the native policy intersects declaration with
  grants); narrowing its ACP session to `read` removes today's divergence where the
  same op wrote through claude built-ins. There is no "undefined" arm in the run
  path; the escape hatch in `acpProfileFor`'s signature remains for sessions opened
  outside an op declaration.
- `profile-map.ts` stays pure; `open-context.ts` passes the declaration through from
  `OpenSessionOpts` (plumbed by the dispatch hop, which already holds
  `declaredTools`).
- Fail-closed rule unchanged (D2-i): the map never widens a profile to make an open
  succeed. **Known consequence, accepted:** an advisor on codex/opencode/gemini/pi
  under `unrestricted` moves from "works, full tools" to
  `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until #2372 lands. The failure reason is
  recorded in the surface artifact rather than discovered from a stack trace.

### D3 — claude-only delivery; other agents degrade gracefully and recorded

**Scope ruling (2026-10-11): delivery targets claude ACP sessions only in this PR.**
The precise constraint is *our registry's* pre-approval channel, not agent capability:
codex-acp v2.1.1 does accept HTTP `mcpServers` and surfaces identifiable MCP approvals
(`_meta.is_mcp_tool_approval`, `rawInput {server, tool}`), so codex delivery via
layer-2 permission decisions is viable future work — adapter findings filed on #2372
(2026-10-11 comment). Widening delivery means a registry/gate change in
`nax-agent-acp`, unverified codex-core approval semantics, a billed live check, and a
server-name dedup edge (codex silently drops a `session/new` server whose name already
exists in the user's `config.toml`; our host is named `nax`) — its own workstream, not
this fix.

- nax checks the target backend's tool-delivery capability before populating
  `tools`. No capability → today's behaviour (`tools: []`), a log line, and
  `skippedProviders: [{id: "<agent>", reason: "mcp-pre-approval-unsupported"}]`
  in the surface record. Under the claude-only ruling this arm is currently
  unreachable for registered agents (custom agents have no entry and fail closed at
  open) — it exists so the gate's invariant and its audit trail are explicit and
  tested, and so #2372's widening flips one registry entry, not a design.
- The capability source is the registry record nax already imports
  (`@nathapp/nax-agent-acp/client`); if querying it from `src/agents/acp/` violates a
  boundary, the check rides on the open result instead (attempt, catch the capability
  error, retry tool-less once, record the skip). Builder's choice, noted in the plan.
- **Reuse/resume staleness is accepted** (settled): the surface and narrowed profile
  apply at open only; a reused or resumed session keeps its open-time surface. Under
  the claude-only ruling there is no capability-retry path that could leave a degraded
  session, and config does not change mid-run; revisit if #2372 widens delivery.

### D4 — one surface record, both transports

Extend the tool-audit file body (both writers already stamp
`{schemaVersion, ...header, sessionName, calls}`) with an additive, optional
`toolSurface` object:

```jsonc
{
  "toolSurface": {
    "stage": "review",
    "transport": "acp",                      // "native" | "acp"
    "profile": "read",                       // ACP only; resolved after narrowing
    "declaredTools": ["Read", "Glob", "Grep"],
    "advertised": [{ "providerId": "codegraph", "names": ["search_graph", "..."] }],
    "withheld": [{ "providerId": "codegraph", "name": "write_graph", "reason": "not-admitted" }],
    "skippedProviders": [
      { "id": "runonly", "reason": "stage-mismatch", "serverStages": ["run"] },
      { "id": "codex",   "reason": "mcp-pre-approval-unsupported" }
    ],
    "failures": [{ "providerId": "x", "reason": "connect EREFUSED" }]
  }
}
```

- Source of truth: `ResolvedProviderTools` gains `skipped` (stage mismatches, with the
  server's configured stages) and `withheld` (sanitised-but-not-admitted). Both are
  computed inside `resolveProviderTools` where the information already exists;
  `resolveProviderContribution` passes them through.
- **Delivery filter (settled, security-conservative): provider tools bound by an
  `Mcp(...)` deny rule or an ask rule are excluded from ACP delivery** at the hop,
  each recorded as `withheld: {reason: "denied" | "ask-ruled"}`. Claude pre-approval
  means those calls never reach a permission round trip where layer 2 could enforce
  the rule, so delivery time is the only enforcement point on that path; silently
  pre-approving a deny-ruled tool would be a permission ruling lost across the
  transport switch. Native semantics unchanged (deny blocks at call time, ask asks).
- **Provider-scope skips get a surface entry** (settled): when `providerScope` blocks
  the whole MCP layer (`safe` → `"none"`, or `"rules"` admitting nothing for a
  provider), `skippedProviders` records `{id, reason: "provider-scope", scope}` so the
  artifact explains an empty `advertised`. Because nothing is delivered, the D6
  adoption summary counts the server as `sessionsOffered: 0` and no WARN can misfire.
- **Sink contract change (settled): the tool-audit sink writes a session's file when
  it holds calls *or* a `toolSurface`** — today `write()` early-returns on zero calls,
  which would silence exactly the never-called session #2410 is about. Both the
  native sink and the ACP recorder adopt the rule; partial-flush behaviour follows the
  same predicate. This is the one behaviour change to a shared writer in this PR.
- Native path: `createToolAuditSink` receives the surface (from
  `buildCodingToolSupport`/`resolveCodingToolSupport`) and stamps it at flush.
- ACP path: the hop passes the same object alongside `toolAudit`; the ACP audit writer
  stamps it the same way.
- Additive optional field on schemaVersion 1 (no reader breaks; matches the ledger
  field-truth pattern). Builder verifies against the repo's schema-version policy.

### D5 — stage-skip logging at the resolve site

Once per session, at debug level (config-visible), inside/near
`resolveProviderContribution` where the skip decision is made:

```
mcp: <id> not attached (session stage=review, server stages=[run])
```

Not once per tool, not per turn — per session resolve.

### D6 — end-of-run adoption summary + zero-adoption WARN

At run completion (lifecycle completion phase), aggregate the run's tool-audit files:

- Per configured server: `sessionsOffered`, `sessionsCalled`, `totalCalls`.
- `sessionsOffered > 0 && totalCalls == 0` → `[WARN]` line in the run summary:
  `mcp: <id> was offered to N sessions and never called`.
- The same per-server object lands in `status.json` (new additive block, e.g.
  `mcpAdoption`), so `nax-diagnose`-style tooling reads it without scraping ledgers.
- Aggregation reads tool-audit files only (transport-agnostic); no new per-call
  instrumentation.

### D7 — docs (item 5)

`docs/guides/mcp-and-interception.md` (+ `configuration.md` where `stages` is
described): `run` does not cover `review`/`verify`/`rectification`; a server must list
every stage that must see it; stage-granted tools are visible to every op in that
stage, including read-profile ones; the surface record and the adoption summary
explain where "offered but never called" is visible.

### Deferred — item 4 (per-server `hint`)

Behaviour change; the issue itself requires an A/B before defaulting. Out of this PR;
follow-up issue if the A/B is wanted.

## Constraints (house rules this design binds itself to)

- Permission SSOT: the profile still derives from `resolvePermissions`' resolved mode;
  the declaration only narrows. No new permission source appears.
- D2-i: never widen a profile to make an open succeed.
- `src/agents/acp/` cannot import `NaxConfig` (`check:adapter-no-config-import`); the
  declaration travels via `OpenSessionOpts`, the stage via the existing hop.
- nax-agent stays transport-neutral: surface fields land in nax-agent types only where
  the information originates (`ResolvedProviderTools`, audit writers); nothing in
  nax-agent learns about ACP.
- Bun-native APIs, `_deps` for external calls, functions ≤30 lines, no `any` in
  public APIs, `satisfies` over casts (ARCHITECTURE.md).

## Non-goals

- Per-role (op-level) MCP filtering — stage-level is the configured granularity (#2444).
- Codex/opencode/gemini/pi read enforcement or pre-approval (#2372).
- Native-path tool-surface *semantics* — unchanged; only the record is new.
- Scratchpad or `RequestCapability` delivery over the ACP loopback.
- The adoption summary explaining *why* a model ignored a tool — it makes absence
  visible, not motivation.

## Left to the builder (settled during planning, not here)

- `CodingTool → EmbedderTool` adaptation for provider tools on the ACP open path
  (approval `"never"` — they are policy-granted before they are advertised), and where
  it lives (`src/agents/acp/`).
- Plumbing `declaredTools` + the surface object through `OpenSessionOpts` vs the
  hop's existing extras channel (`open-session-extras.ts`).
- Whether the capability probe in D3 reads the registry or catches-and-retries.
- Aggregation point and file-read helpers for D6 (completion phase has existing
  tool-audit dir access).
- Test placement mirroring `test/unit/...` per package; `_deps` mocking for fs.
