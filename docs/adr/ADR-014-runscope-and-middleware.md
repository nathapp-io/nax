# ADR-014: RunScope, Agent Middleware, and Orphan Consolidation

**Status:** Reject
**Date:** 2026-04-23
**Author:** William Khoo, Claude
**Extends:** ADR-013 (SessionManager → AgentManager Hierarchy); ADR-012 (AgentManager Ownership); ADR-011 (SessionManager Ownership)
**Superseded-by / Followed-by:** ADR-015 (Operation Contract), ADR-016 (Prompt Composition & PackageView)
**Related:** #523 (fallback state divergence across orphan AgentManagers — unblocked by this ADR)

---

## Context

ADR-011, ADR-012, and ADR-013 established the canonical hierarchy: `SessionManager.runInSession()` orchestrates `IAgentManager.run()` / `IAgentManager.complete()`, and adapter methods are manager-internal. That work fixed retry/fallback correctness on the main execution path.

Two architectural problems remain and are in scope for this ADR:

### Problem 1 — Orphan `AgentManager` instances (#523)

`createAgentManager(config)` is called from **eight** locations — **seven orphans plus the canonical Runner instance**:

| Site | Scope |
|:---|:---|
| [src/routing/router.ts:271](../../src/routing/router.ts#L271) | Pre-execution LLM classification |
| [src/cli/plan.ts:61](../../src/cli/plan.ts#L61) | `nax plan` standalone CLI |
| [src/debate/session-helpers.ts:83](../../src/debate/session-helpers.ts#L83) | Debate proposer pool |
| [src/review/semantic.ts:35](../../src/review/semantic.ts#L35) | Semantic review debate fallback |
| [src/verification/rectification-loop.ts:129](../../src/verification/rectification-loop.ts#L129) | Nested retry agent |
| [src/acceptance/refinement.ts:25](../../src/acceptance/refinement.ts#L25) | Pre-execution AC refinement |
| [src/acceptance/generator.ts:75](../../src/acceptance/generator.ts#L75) | Pre-execution test generation |
| [src/execution/runner.ts:117](../../src/execution/runner.ts#L117) | Canonical owned instance |

Each orphan has its own fallback state, availability marks, and token counters. A 401 on routing does not inform the execution-phase manager. Costs accumulated in rectification do not roll up into `StoryMetrics`. #523 is blocked on this and has only a partial workaround inside the ACP adapter.

### Problem 2 — Cross-cutting concerns are hand-wired per call site

Cost aggregation, prompt audit, cancellation propagation, permission resolution, and logging are hand-wired at every agent call site. Each new call site copies the ceremony. Each drift (forgotten audit, missing cost tag, absent `storyId` on a log line) is a silent bug. There is no interception point.

### Out of scope (deferred to follow-up ADRs)

- **Operation contract + removal of `.plan()` / `.decompose()` from the adapter** → ADR-015.
- **IPromptBuilder sections, prompt middleware, and PackageView enforcement** → ADR-016.
- **Monorepo-awareness violations (#533–#536)** → closed as part of ADR-016 (PackageView).

This narrow ADR delivers the foundation — `RunScope` + agent middleware + orphan consolidation — which unblocks #523 and makes cost/audit uniform. The operation and prompt layers land on top of this foundation in the follow-ups.

---

## Decision

We introduce two structural pieces:

1. **RunScope** — composite lifecycle owner for one run / plan / ephemeral unit. Wraps `SessionManager` + `AgentManager` with scope-level services (cost, audit, permissions, logger).
2. **Agent middleware chain** — interceptor around every `IAgent` returned by the scope. Hoists permissions, audit, cost, cancellation, and logging out of individual call sites.

Both preserve every ADR-011/012/013 invariant (adapter methods manager-internal, single `runInSession()`, `ISessionRunner` for topology) and add the layer above.

---

### 1. RunScope

The composite owner for one logical execution unit. Exactly one `RunScope` per `nax run`, per `nax plan`, per standalone CLI invocation that touches agents.

```typescript
// src/runtime/scope.ts
export interface RunScope {
  readonly id: RunScopeId;
  readonly kind: "run" | "plan" | "ephemeral";
  readonly repoRoot: string;

  // Frozen at construction — configuration and cancellation
  readonly config: NaxConfig;
  readonly signal: AbortSignal;

  // Managers (ADR-011, ADR-012, ADR-013) — unchanged interfaces
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;

  // Scope-level services (drained by middleware)
  readonly services: {
    readonly costAggregator: ICostAggregator;
    readonly promptAuditor: IPromptAuditor;
    readonly permissionResolver: IPermissionResolver;
    readonly logger: Logger;
  };

  // Obtain a middleware-wrapped agent. The only way outside src/runtime/ to get an IAgent.
  getAgent(agentName: string): IAgent;

  // Lifecycle — idempotent, cascades to sessions → services.drain() → agentManager.dispose()
  close(): Promise<void>;
}
```

**Ownership contract:**

- `RunScope` **owns** the lifecycle of `agentManager`, `sessionManager`, and the services. Constructed once, disposed once.
- `config` is frozen at scope construction. Configuration changes require a new scope — there is no hot reload.
- `signal` is produced by a scope-internal `AbortController` created in the factory. `close()` aborts it, which cascades to in-flight agent calls via the `cancellation` middleware.
- `RunScope.close()` cascades: signal aborts → sessions close → services flush → agent manager disposes. Idempotent.
- **No `child()` method.** Per-call isolation (debate proposers, rectification loops) is achieved via per-call `signal` / `logger` overrides, not scope forking. See Rejected Alternatives §C.

**SessionManager wiring — middleware must reach session-internal calls:**

Today's `SessionManager` holds agent references captured at session-open time. For the middleware chain to wrap every LLM call including those made inside a running session, `SessionManager` construction changes:

- The factory constructs `SessionManager` with a `getAgent: (name) => IAgent` callback supplied by the scope.
- That callback is `scope.getAgent` — every agent obtained by a session is middleware-wrapped.
- Sessions never capture a raw `AgentAdapter` or unwrapped `IAgent`. The existing agent-registry parameter on `SessionManager` is replaced by the callback.

Without this change, Phase 2's "every LLM call goes through middleware" invariant is false for in-session calls. The change is a one-line constructor signature shift but must land alongside the scope introduction.

**Construction — single factory, not ad-hoc:**

```typescript
// src/runtime/scope-factory.ts
export interface IRunScopeFactory {
  forRun(config: NaxConfig, workdir: string, opts?: ForRunOptions): Promise<RunScope>;
  forPlan(config: NaxConfig, workdir: string, opts?: ForPlanOptions): Promise<RunScope>;
  forEphemeral(config: NaxConfig, workdir: string, label: string): Promise<RunScope>;
}

export interface ForRunOptions {
  readonly hooks?: HookRegistry;          // loaded hooks; scope exposes them to the Runner
  readonly parentSignal?: AbortSignal;    // e.g. CLI SIGINT — linked into scope.signal
}
```

Every `createAgentManager(config)` call outside this factory becomes a compile error. The symbol is removed from the public barrel (`src/agents/index.ts`) and relocated to `src/runtime/internal/` where only the factory may call it.

**Hooks and scope:** `hooks` is threaded into the scope as-is for the Runner to fire at pipeline phase boundaries. Scope-aware hook authoring (hooks that read cost snapshots or emit audit entries) is deferred to ADR-017. In this ADR, hooks continue to receive their existing loose refs; the factory parameter exists only to carry the registry from CLI into the Runner without re-loading.

---

### 2. Permission resolution and agent middleware

Permissions flow through **three** layers today: a stage-driven **resolver** produces canonical policy; a per-transport **transport translator** renders canonical into the transport's wire format; the **adapter** applies the wire format. `scope.invoke()` owns the resolver call; the adapter owns its transport translator (which lives inside the adapter's folder). The middleware chain is purely observational — permission resolution happens pre-chain.

An **agent-level translator layer** is intentionally **not** introduced in Phase 2. Today the only transport is ACP, and acpx passes tool-allowlist entries through to each hosted agent unchanged — per-agent tool-name translation (e.g. `"Read"` → `"read_file"` for a hypothetical non-Claude agent) is not something nax needs to own. If a future agent genuinely requires vocabulary adjustment nax must apply, the agent translator slots **between** canonical and transport as Layer 2′ with zero call-site churn: transport translators would then consume the agent-native policy instead of canonical directly.

#### 2.1 Three-layer model

```
Config + stage (declarative — op.requires.permissions)
       │
       ▼ Layer 1 — RESOLVER (adapter-agnostic, agent-agnostic, transport-agnostic)
       │   src/config/permissions.ts :: resolvePermissions()
       │
ResolvedPermissions (canonical — StandardTool vocabulary)
       │
       ▼ Layer 2 — TRANSPORT TRANSLATOR (transport-specific)
       │   src/agents/acp/permissions.ts :: toAcpWire()
       │   wrapped as `acpTranslator: IPermissionTranslator<AcpWirePolicy>`
       │   registered in scope.services.translatorRegistry keyed by "acp"
       │   adapter resolves via registry (middleman) — does not import directly
       │
AcpWirePolicy (ACP wire format — { permissionMode, allowedToolsArg })
       │
       ▼ Layer 3 — ADAPTER APPLICATION (transport I/O)
       │   src/agents/acp/adapter.ts
       │
createSession({ permissionMode, … }) + acpxArgs.push("--allowed-tools", …)
```

Responsibilities:

| Layer | Knows about | Does not know about |
|:---|:---|:---|
| Resolver | Config schema, pipeline stages | Transports, wire formats, agents |
| Transport translator | Canonical policy, this transport's wire format | Pipeline stages, config schema |
| Adapter | Wire format of its transport, session/process plumbing | Policy semantics, wire-token decisions |

**Why no agent translator today:** ACP is the only transport, and acpx is agent-agnostic at the permission level — it forwards `permissionMode` and `--allowed-tools` entries without rewriting them. Every agent that runs under acpx consumes the same tokens. An agent translator would be a pass-through today, shipping ceremony for no benefit. When/if a future agent requires nax-side vocabulary adjustment, Layer 2′ slots in cleanly; transport translators re-target from consuming canonical to consuming agent-native. YAGNI applied to the "we might need it" speculation.

**Future Layer 2′ (agent translator) — for reference, not Phase 2:**

```
                                 (future, only when a real agent demands it)
ResolvedPermissions ─► Layer 2′ AGENT TRANSLATOR ─► AgentPermissionPolicy ─► Layer 2 TRANSPORT TRANSLATOR ─► Wire
                       src/runtime/permissions/
                       translators/<agent>.ts
                       resolved via IPermissionTranslatorRegistry
```

At that point, `AgentPermissionPolicy` would mirror canonical's shape (profile, allowedTools with agent-native tool names, warnings for agent-capability downgrades). The transport translator's input type changes from `ResolvedPermissions` to `AgentPermissionPolicy`; the transport signature is otherwise stable.

#### 2.2 Canonical `ResolvedPermissions`

`src/config/permissions.ts` is amended. The existing type is replaced to remove adapter-specific fields.

```typescript
// src/config/permissions.ts
export interface ResolvedPermissions {
  readonly profile: PermissionProfile;
  /** Scoped-profile patterns; undefined when profile ≠ "scoped". */
  readonly allowedTools?: readonly ToolAllowPattern[];
}

/**
 * Permission profile — single source of truth for auto-approve behavior.
 *
 *   "unrestricted" — blanket auto-approve; no user prompts for any action.
 *   "auto"         — agent decides via its own policy/judgment (newer Claude Code
 *                    ships a built-in auto-approve mode narrower than "unrestricted"
 *                    but broader than "safe"). Transport translator emits the
 *                    agent's native auto token.
 *   "safe"         — auto-approve read-only operations; prompt on writes / shell / network.
 *                    This is the default.
 *   "none"         — prompt for every action.
 *   "scoped"       — per-tool allowlist from `allowedTools`; actions matching the
 *                    allowlist are auto-approved, everything else prompts.
 *
 * Permissiveness ordering (for static profiles): unrestricted > auto > safe > none.
 * "scoped" is orthogonal — permissiveness depends on the allowlist.
 */
export type PermissionProfile =
  | "unrestricted"
  | "auto"
  | "safe"
  | "none"
  | "scoped";

export interface ToolAllowPattern {
  readonly tool: StandardTool;
  readonly paths?: readonly string[];     // globs for Read/Write/Edit
  readonly commands?: readonly string[];  // globs for Bash
}

export type StandardTool =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Network"
  | "Notebook";
```

**Dropped from the current type:**

- `mode: "approve-all" | "approve-reads" | "default"` — ACP-specific vocabulary; moves inside the ACP adapter's folder (§2.5).
- `skipPermissions: boolean` — dead (was the removed CLI adapter's `--dangerously-skip-permissions` flag).

**Unchanged:** `resolvePermissions(config, stage): ResolvedPermissions` remains the single entry point. Phase 2 implementation of `resolveScopedPermissions()` populates `allowedTools`; until then it returns `undefined` and #374 delivers the stage-by-stage body.

#### 2.3 `scope.invoke()` pre-chain resolution

Resolution happens once, before the middleware chain fires, at the top of `scope.invoke()`:

```typescript
// src/runtime/scope.ts — scope.invoke() internal flow
async invoke<I, O, C>(op, input, opts) {
  // ... validate, resolve agent name, slice config ...

  // Canonical policy — agent-agnostic, transport-agnostic.
  const canonical = resolvePermissions(packageView.config, op.requires.permissions);

  // Thread into agent-call options. Adapter consumes it via its transport translator;
  // middleware observes it for audit/logging.
  const agentCallOptions = {
    ...baseOptions,
    permissions: canonical,
  };

  // ... build OperationContext, invoke middleware-wrapped agent with agentCallOptions ...
}
```

Neither the adapter nor any middleware calls `resolvePermissions()` at runtime. Single resolution per agent call. The adapter's transport translator (§2.5) consumes `canonical` and produces wire format.

#### 2.4 `AgentRunOptions.permissions` and `.scope` shape

```typescript
// src/agents/types.ts — AgentRunOptions amended
export interface AgentRunOptions {
  // ... existing fields ...

  readonly permissions: ResolvedPermissions;  // canonical; adapter calls its transport translator on this
  readonly scope: RunScope;                   // scope reference — gives adapter access to services.translatorRegistry

  // REMOVED:
  // dangerouslySkipPermissions?: boolean;   (dead — CLI adapter removed)
  // pipelineStage?: PipelineStage;          (no longer needed — pre-resolution handles it)
}
```

`CompleteOptions` gets both `permissions` and `scope` fields on the same terms. `config` stays on both (still needed by audit/cost middleware, but **not** for permission derivation anywhere).

The options carry the canonical `ResolvedPermissions` directly. When Layer 2′ (agent translator) is added later, this widens to a union or nested shape — the change is local to `scope.invoke()` and the transport translator signature.

**Why thread `scope` through options** rather than have the adapter reach for a global: adapter calls happen inside middleware-wrapped paths; the wrapping middleware is the only thing that knows the active scope for this call. Threading via options keeps the adapter a pure function of its inputs — no singletons, no async-local storage — which matches the observer-only middleware invariant (§2.8) and keeps tests isolated (each `makeTestScope()` instance is self-contained).

#### 2.5 ACP transport translator

The ACP wire format lives **inside the ACP adapter folder**. No module outside `src/agents/acp/` treats ACP wire types as first-class — they surface only at the generic parameter of the registry's `get<AcpWirePolicy>()` call at the adapter boundary (§2.7). A pure function `toAcpWire()` bridges canonical `ResolvedPermissions` to the ACP wire tokens that `createSession()` and acpx expect.

```typescript
// src/agents/acp/permissions.ts (NEW — inside the adapter's folder)
import type { ResolvedPermissions, ToolAllowPattern } from "../../config/permissions";

// ACP wire tokens — exclusively scoped to this module
export type AcpPermissionMode =
  | "approve-all"
  | "approve-auto"
  | "approve-reads"
  | "default";

export interface AcpWirePolicy {
  readonly permissionMode: AcpPermissionMode;
  readonly allowedToolsArg?: readonly string[];   // pre-formatted strings for acpx --allowed-tools
  /**
   * Reserved for #374 (scoped tool allowlists) and for future transport-capability validation.
   * Phase 2 leaves this undefined — `toAcpWire()` does not emit warnings today because every
   * canonical profile maps cleanly to an ACP mode. Populated when validation in #374 encounters
   * an allowlist pattern the wire cannot express.
   */
  readonly warnings?: readonly string[];
}

export function toAcpWire(resolved: ResolvedPermissions): AcpWirePolicy {
  // Map canonical profile → ACP permissionMode.
  // "scoped" uses "approve-reads" as the ceiling; the allowlist (below) carries the
  // per-tool grants that acpx forwards to the underlying agent.
  const permissionMode: AcpPermissionMode =
    resolved.profile === "unrestricted" ? "approve-all"   :
    resolved.profile === "auto"         ? "approve-auto"  :
    resolved.profile === "safe"         ? "approve-reads" :
    resolved.profile === "scoped"       ? "approve-reads" :
                                          "default"; // "none"

  const allowedToolsArg = resolved.allowedTools?.map(formatAsAcpAllowlistEntry);

  return { permissionMode, allowedToolsArg };
}

function formatAsAcpAllowlistEntry(p: ToolAllowPattern): string {
  // acpx passes the allowlist string through to the underlying agent, which enforces it.
  // Tool names are in StandardTool vocabulary; acpx handles agent-specific name mapping today.
  // Format: "Tool" or "Tool(glob1,glob2,...)"
  if (p.paths && p.paths.length > 0)       return `${p.tool}(${p.paths.join(",")})`;
  if (p.commands && p.commands.length > 0) return `${p.tool}(${p.commands.join(",")})`;
  return p.tool;
}
```

**What this buys us:**

- ACP wire vocabulary (`approve-all`, `approve-reads`, etc.) never appears outside `src/agents/acp/`.
- A future direct-API transport would live in `src/agents/<transport>/permissions.ts` with its own `toXxxWire()` function. Canonical stays stable.
- `toAcpWire()` is a pure function — unit-testable without spawning a process. All ACP mode decisions live in one ~25-line function.
- When Layer 2′ (agent translator) is added later, `toAcpWire()` re-targets from `ResolvedPermissions` to `AgentPermissionPolicy` — a one-line signature change inside this file.

#### 2.6 Translator registry — middleman pattern

The adapter does **not** import `toAcpWire` directly. Instead a `IPermissionTranslator` interface wraps the wire function, the registry holds it, and the adapter resolves through the registry. The registry is a scope-level service.

**Why a registry when only one transport exists today:**

- **Test injection.** Tests can supply a fake translator without stubbing the adapter or monkey-patching `toAcpWire`.
- **Plugin extension seam.** Plugin API v2 (future ADR) can register additional translators or override the default without touching the ACP adapter's code.
- **Extension for future transports.** Direct-API Claude, HTTP bridges, or any other transport add a new registry entry; the adapter wiring pattern stays identical.
- **Keeps the adapter ignorant of *how* the translation is resolved.** Adapter calls `registry.get("acp")`; what that returns is the registry's concern.

One entry today. Not speculative per-agent stubs — a deliberate middleman so the shape is stable when the second entry arrives.

```typescript
// src/runtime/permissions/translator.ts
export interface IPermissionTranslator<W = unknown> {
  readonly transport: string;                          // "acp" today; future: "claude-api" | ...
  translate(resolved: ResolvedPermissions): W;         // W is the transport's wire type
}

export interface IPermissionTranslatorRegistry {
  /** Returns the translator for a transport; throws NaxError PERMISSION_TRANSLATOR_MISSING on miss. */
  get<W = unknown>(transport: string): IPermissionTranslator<W>;
  /** Returns the translator or null — for composite chaining. */
  tryGet<W = unknown>(transport: string): IPermissionTranslator<W> | null;
}

// src/runtime/permissions/registries/static.ts — Phase 2 default
export class StaticTranslatorRegistry implements IPermissionTranslatorRegistry {
  constructor(private readonly map: ReadonlyMap<string, IPermissionTranslator<unknown>>) {}
  tryGet<W>(transport: string) {
    // Runtime cast — the generic parameter is asserted by the caller. See "Generic type erasure"
    // commentary in §2.7: the registry stores IPermissionTranslator<unknown>; the caller at the
    // adapter boundary specifies the concrete wire type (e.g. AcpWirePolicy) in the type argument.
    return (this.map.get(transport) ?? null) as IPermissionTranslator<W> | null;
  }
  get<W>(transport: string) {
    const t = this.tryGet<W>(transport);
    if (t) return t;
    throw new NaxError(
      `No permission translator registered for transport "${transport}"`,
      "PERMISSION_TRANSLATOR_MISSING",
      { transport },
    );
  }
}
```

**Each transport contributes its translator** inside its own folder:

```typescript
// src/agents/acp/permissions.ts — appended to existing file
import type { IPermissionTranslator } from "../../runtime/permissions/translator";

export const acpTranslator: IPermissionTranslator<AcpWirePolicy> = {
  transport: "acp",
  translate: toAcpWire,     // the pure function defined above
};
```

**Scope construction registers the Phase 2 set:**

```typescript
// src/runtime/scope-factory.ts — inside forRun()
import { acpTranslator } from "../agents/acp/permissions";

const translatorRegistry: IPermissionTranslatorRegistry = new StaticTranslatorRegistry(
  new Map<string, IPermissionTranslator<unknown>>([
    ["acp", acpTranslator],
  ])
);

const scope: RunScope = {
  // ...
  services: {
    costAggregator,
    promptAuditor,
    permissionResolver: resolvePermissions,
    translatorRegistry,                     // NEW
    logger,
  },
  // ...
};
```

**Future variants** (deferred to plugin API v2 ADR, same pattern):

- `AgentDescriptorTranslatorRegistry` — reads translators from `AgentDescriptor` entries when plugins contribute agents with custom transports.
- `CompositeTranslatorRegistry` — chains multiple registries (plugins first, then built-ins).

All three implementations satisfy the same `IPermissionTranslatorRegistry` interface. Adapter code is unaware which registry type backs it.

#### 2.7 ACP adapter application

The adapter resolves the translator from the registry and applies its output. Zero permission-semantics logic, zero direct translator imports.

```typescript
// src/agents/acp/adapter.ts — inside run()
// No import of toAcpWire. Registry is the only seam.

const translator = options.scope.services.translatorRegistry.get<AcpWirePolicy>("acp");
const wire = translator.translate(options.permissions);

const session = await client.createSession({
  agentName: options.agentName,
  permissionMode: wire.permissionMode,
  sessionName,
});
if (wire.allowedToolsArg) {
  acpxArgs.push("--allowed-tools", wire.allowedToolsArg.join(","));
}
if (wire.warnings) {
  for (const w of wire.warnings) {
    getSafeLogger()?.warn("acp-adapter", w, { agentName: options.agentName });
  }
}
```

Existing ACP adapter sites that call `resolvePermissions()` — [adapter.ts:593](../../src/agents/acp/adapter.ts#L593), [adapter.ts:847](../../src/agents/acp/adapter.ts#L847), [adapter.ts:1036](../../src/agents/acp/adapter.ts#L1036) — all delete. They become the ~8 lines above.

#### 2.8 Agent middleware chain — observers only

After pre-chain resolution, the middleware chain is pure observation. No middleware reads or derives permissions; `options.permissions` is present for audit/logging inspection only.

```typescript
// src/runtime/agent-middleware.ts
export interface AgentMiddleware {
  readonly name: string;
  run?(ctx: MiddlewareContext, next: () => Promise<AgentResult>): Promise<AgentResult>;
  complete?(ctx: MiddlewareContext, next: () => Promise<CompleteResult>): Promise<CompleteResult>;
}

export interface MiddlewareContext {
  readonly prompt: string;
  readonly options: AgentRunOptions | CompleteOptions;  // includes .permissions (canonical) and .scope
  readonly agentName: string;
  readonly scope: RunScope;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly signal: AbortSignal;
}
```

**Canonical middleware (Phase 1):**

| Middleware | Concern | Semantics |
|:---|:---|:---|
| `audit` | Capture prompt + response via `IPromptAuditor`; record `options.permissions.profile` | Observer — emits `PromptAuditEntry` on success, `PromptAuditErrorEntry` on error |
| `cost` | Emit `CostEvent` to `ICostAggregator`, tagged with `{ agentName, stage, storyId, packageDir }` | Observer — `CostEvent` on success, `CostErrorEvent` on error |
| `cancellation` | Thread `signal` into adapter call; translate `AbortError` to `NaxError CANCELLED` | Pass-through with error translation; does not observe prompt/response |
| `logging` | Structured JSONL per `project-conventions.md`, `storyId` first, includes canonical `profile` | Observer |

Note: no `permissions` entry — permission resolution is pre-chain (§2.3), not a middleware concern.

**Middleware invariants:**

- **Middleware are observers, not transformers** (Phase 1 constraint). No middleware mutates the prompt, response, or options for the next middleware in the chain. Order-independence is preserved.
- **On error:** every middleware is resilient to the call throwing. `audit` emits an error entry, `cost` emits a `CostErrorEvent`, `cancellation` translates the error. No middleware may swallow the thrown error.
- **Frozen at scope construction.** The chain is registered once in `IRunScopeFactory.forRun()` and immutable for the scope lifetime. No per-call reordering, no per-op opt-out.
- **Future extension:** if a later middleware needs to transform (e.g. inject system prompt, rewrite options), the invariant tightens to a declared order at that point, with the concrete case as justification. The `permissions` case is handled pre-chain and does not justify loosening this invariant.

---

### 3. CostAggregator

Single sink for cost events across the run. Drained by the `cost` middleware. Replaces the per-`AgentManager` internal counter, which today is lost for orphan instances.

```typescript
// src/runtime/cost-aggregator.ts
export interface ICostAggregator {
  record(event: CostEvent): void;
  recordError(event: CostErrorEvent): void;
  snapshot(): CostSnapshot;
  byAgent(): Record<string, CostSnapshot>;
  byStage(): Record<string, CostSnapshot>;
  byStory(): Record<string, CostSnapshot>;
  drain(): Promise<void>;  // flushes to StoryMetrics on scope close
}

export interface CostEvent {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly agentName: string;
  readonly model: string;                                // resolved model string (successful calls always have this)
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface CostErrorEvent {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly agentName: string;
  readonly model?: string;                               // may be unresolved (e.g. auth failure before dispatch)
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly durationMs: number;
}

// Rule: successful calls emit CostEvent (model required). Failed calls emit only CostErrorEvent.
// The cost middleware never emits both for the same call.
```

Nested calls (rectification, debate proposers, pre-execution refinement) all flow through the same aggregator via the shared scope. `StoryMetrics` reads aggregate totals on `scope.close()`.

**Per-operation and per-package breakdowns** are added in ADR-015 when `Operation.name` becomes available as a tag, and in ADR-016 when `PackageView` formalizes `packageDir`. Phase 1 tags with `{ stage, storyId }` only.

---

### 4. IPromptAuditor

Scope-level service. Captures every prompt via agent middleware, so session-less calls (routing, decompose, refinement) are audited too.

**Explicitly rejected:** putting prompt audit on `SessionManager`. That would bypass session-less paths — exactly the class of bug this ADR removes.

```typescript
// src/runtime/prompt-auditor.ts
export interface IPromptAuditor {
  record(entry: PromptAuditEntry): void;
  recordError(entry: PromptAuditErrorEntry): void;
  flush(): Promise<void>;  // writes to .nax/audit/<runId>.jsonl
}

export interface PromptAuditEntry {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly agentName: string;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPreview: string;   // first 500 chars
  readonly responseHash: string;
  readonly responsePreview: string;
  readonly tokens: { input: number; output: number };
  readonly durationMs: number;
  readonly sessionId?: string;
}

export interface PromptAuditErrorEntry {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly agentName: string;
  readonly model?: string;                       // may be unresolved when the error happens pre-dispatch
  readonly promptHash?: string;                  // absent if failure happened before prompt was captured
  readonly promptPreview?: string;
  readonly errorCode: string;                    // matches CostErrorEvent.errorCode for correlation
  readonly errorMessage: string;                 // single-line summary
  readonly durationMs: number;
  readonly sessionId?: string;
}
```

---

### 5. Test fixture — `makeTestScope()`

The canonical test fixture. Every test that needs a `RunScope` constructs one via this helper rather than assembling a bespoke mock. Published from `test/helpers/scope.ts`.

```typescript
// test/helpers/scope.ts
export interface MakeTestScopeOptions {
  readonly config?: Partial<NaxConfig>;                           // merged into DEFAULT_CONFIG
  readonly agents?: Record<string, IAgent>;                       // stubbed agents by name, default: empty
  readonly middleware?: readonly AgentMiddleware[];               // default: no middleware (raw agents)
  readonly services?: Partial<RunScope["services"]>;              // override any service with a stub
  readonly workdir?: string;                                      // default: temp dir via test/helpers/temp.ts
}

export function makeTestScope(opts?: MakeTestScopeOptions): RunScope;
```

**Construction rules:**

- If `agents` is provided, `scope.getAgent(name)` returns the stubbed `IAgent` wrapped by the supplied `middleware` (default: no middleware → raw stub).
- If no middleware is supplied, tests observe raw call behavior — useful for assertion tests on stub agents.
- If services are not overridden, default in-memory implementations are used (`InMemoryCostAggregator`, `InMemoryPromptAuditor`, etc.) which expose `snapshot()` for assertion.
- `close()` is a no-op unless the test explicitly asserts lifecycle behavior.

**Migration from today's fixtures:**

- `_deps.createManager` mock fields (debate, rectification) delete. Tests supply stub agents via `makeTestScope({ agents: { claude: stubAgent } })`.
- `agentGetFn` injection in pipeline-stage tests delete. `ctx.scope = makeTestScope({ agents: {...} })` replaces.
- Cost/audit assertion tests read `scope.services.costAggregator.snapshot()` instead of inspecting private manager fields.

The fixture is part of Phase 1 deliverables so migrated tests have a landing pad from day one.

---

## Architecture After ADR-014

```
RunScope (per run / plan / ephemeral)
  ├─ agentManager: IAgentManager                 // ADR-012, ADR-013 — unchanged interface
  ├─ sessionManager: ISessionManager             // ADR-011, ADR-013 — unchanged interface
  ├─ services:
  │    ├─ costAggregator                         // NEW
  │    ├─ promptAuditor                          // NEW
  │    ├─ permissionResolver: resolvePermissions
  │    ├─ translatorRegistry                     // NEW — IPermissionTranslatorRegistry
  │    └─ logger
  ├─ getAgent(name) → IAgent                     // middleware-wrapped
  ├─ invoke<I,O,C>(op, input, opts) → O          // pre-chain resolves permissions, §2.3
  └─ close() → Promise<void>

Permission flow (pre-chain, §2.1–§2.7)
  scope.invoke() → resolvePermissions() → options.permissions (canonical)
                                            │
                                            ▼ adapter reads via registry
  options.scope.services.translatorRegistry.get<AcpWirePolicy>("acp")
                                            │
                                            ▼ translate
  toAcpWire(canonical) → AcpWirePolicy → createSession + acpx args

Agent middleware chain (observers only, order-independent, no permissions entry)
  audit / cost / cancellation / logging → rawAgent

IAgent (ADR-013, unchanged)
  ├─ run(prompt, opts): Promise<AgentResult>
  └─ complete(prompt, opts): Promise<CompleteResult>
     — .plan() and .decompose() remain until ADR-015
```

Stages still call `ctx.agentManager.runAs(...)` / `ctx.agentManager.completeAs(...)` as today. The only observable change per call site is that `ctx.agentManager` (threaded via `PipelineContext`) now comes from `scope.agentManager` and every call is middleware-wrapped. No stage logic changes.

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **#523 unblocks** | `createAgentManager` removed from public barrel. One `AgentManager` per run. Fallback state survives across routing → execution → rectification → debate. |
| **Orphan-free by construction** | 8 orphan sites collapse to scope-owned access. `IAgent` can only be obtained via `scope.getAgent()` → guaranteed middleware-wrapped. |
| **Uniform cost attribution** | Every LLM call emits a `CostEvent` tagged with `{ stage, storyId }`. `StoryMetrics` sees nested calls (rectification, debate proposers) that today vanish into orphan counters. |
| **Uniform prompt audit** | Every LLM call — including session-less routing, decompose, refinement — is audited. Single JSONL per run at `.nax/audit/<runId>.jsonl`. |
| **Cross-cutting concerns hoisted** | Permissions, cost, audit, cancellation, logging removed from call sites. Future additions (rate limiting, budget enforcement) slot in as middleware without touching stages. |
| **Testing simplifies** | Scope fixture (`makeTestScope(opts)`) covers 90% of agent-using tests. Per-call mocks (adapter, manager, cost tracker) consolidate into one scope mock. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| `PipelineContext` gains a `scope` field | Threaded from runner alongside existing fields. Stages opt-in: Phase 1 migrates one stage as proof; remaining stages migrate during Phase 2. |
| Existing tests construct bare managers | `makeTestScope()` fixture matches the shape of today's test construction; mechanical migration. |
| Scope-lifetime discipline required | `RunScope.close()` is idempotent and cascades. Every scope construction must be followed by a `try/finally` close at the CLI/runner boundary. |
| Plugin API change (`IReporter`, `IContextProvider`, etc.) | Out of scope — plugins continue to receive individual refs in Phase 1. A versioned plugin API with `PluginContext` derived from `RunScope` is deferred to a follow-up ADR. |

---

## Migration Plan

Three phases, each independently shippable. Each phase preserves all ADR-011/012/013 invariants.

### Phase 1 — RunScope shell + services + test fixture

- Introduce `src/runtime/scope.ts` and `src/runtime/scope-factory.ts`.
- `IRunScopeFactory.forRun()` wraps existing `AgentManager` + `SessionManager` + instantiates `CostAggregator`, `PromptAuditor`.
- Update `SessionManager` constructor to take the `getAgent` callback (§1 SessionManager wiring note).
- Runner constructs scope at the top of `runSetupPhase()`, closes it in `runCompletionPhase()`.
- Thread `scope: RunScope` through `PipelineContext` alongside existing fields.
- Publish `test/helpers/scope.ts` with `makeTestScope()` (§5).
- **No middleware yet.** `scope.getAgent()` returns bare adapter-wrapped agent.
- **Exit criteria:**
  1. The `implement` stage obtains its agent via `ctx.scope.agentManager` (not the threaded `agentManager` field) and the call succeeds end-to-end against today's integration tests.
  2. At least three existing tests migrate to `makeTestScope()` as proof-of-fit for the fixture.
  3. Runner constructs and closes scope cleanly; `close()` idempotency verified by test.
- **Risk:** Low. Purely additive. The one behavior change (SessionManager's `getAgent` callback) is constructor-level and invisible to call sites.

### Phase 2 — Permission resolution, middleware chain, orphan consolidation

**Permission resolution (§2.1–§2.7):**

- Amend `src/config/permissions.ts` — canonical `ResolvedPermissions` as `{ profile, allowedTools? }`. `PermissionProfile` widens to `"unrestricted" | "auto" | "safe" | "none" | "scoped"`. Drops legacy `mode` and `skipPermissions`.
- Add `AgentRunOptions.permissions: ResolvedPermissions` and `AgentRunOptions.scope: RunScope`; same on `CompleteOptions`.
- Implement `scope.invoke()` pre-chain resolution — calls `resolvePermissions()` once, stuffs `options.permissions`.
- Add `src/agents/acp/permissions.ts` — `AcpPermissionMode`, `AcpWirePolicy`, `toAcpWire()`, `acpTranslator`. ACP wire vocabulary scoped to this module.
- Add `src/runtime/permissions/translator.ts` (interfaces) and `src/runtime/permissions/registries/static.ts` (`StaticTranslatorRegistry`).
- Wire `scope.services.translatorRegistry` in `IRunScopeFactory.forRun()` with single entry `"acp" → acpTranslator`.
- Shrink ACP adapter permission handling to registry-resolved translator call. Delete `resolvePermissions()` calls at [adapter.ts:593](../../src/agents/acp/adapter.ts#L593), [adapter.ts:847](../../src/agents/acp/adapter.ts#L847), [adapter.ts:1036](../../src/agents/acp/adapter.ts#L1036).

**Middleware chain (§2.8):**

- Implement `AgentMiddleware` interface and canonical middleware (audit, cost, cancellation, logging) as independent observers. **No `permissions` middleware** — it was pre-chain work above.
- `scope.getAgent()` returns middleware-wrapped agent.

**Orphan consolidation:**

- Migrate orphan call sites in order of lowest blast radius:
  1. `routing/router.ts` — use `scope.getAgent(defaultAgent).complete()`
  2. `acceptance/refinement.ts`, `acceptance/generator.ts`
  3. `verification/rectification-loop.ts`
  4. `debate/session-helpers.ts` (drops the orphan `createAgentManager` import; the runner topology is left to ADR-015)
  5. `review/semantic.ts`
  6. `cli/plan.ts` — uses `forPlan()` factory
- **Delete `createAgentManager` from public barrel.** Move to `src/runtime/internal/`.

**Exit criteria:**

- Zero `createAgentManager` imports outside `src/runtime/`. #523 verifiable: a 401 on routing activates the same fallback chain as execution.
- Zero `resolvePermissions()` calls inside `src/agents/acp/adapter.ts`.
- No ACP wire-token literals (`"approve-all"`, etc.) outside `src/agents/acp/`.

**Risk:** Medium. Mechanical migrations touch many files; each site's behavior change is small and individually reviewable.

### Phase 3 — Drain aggregator and auditor into metrics/disk

- `StoryMetrics` reads from `scope.services.costAggregator.snapshot()` on story completion.
- `scope.close()` flushes `PromptAuditor` to `.nax/audit/<runId>.jsonl`.
- Remove the per-`AgentManager` internal cost counter (now redundant).
- **Exit criteria:** Cost totals in `StoryMetrics` match orphan-free ground truth. Every run produces an audit JSONL covering all agent calls.
- **Risk:** Low. Additive plus one dedup.

**Rollback plan:** Phase 1 and Phase 2 are gated behind the phase boundary — scope exists alongside legacy paths until Phase 2 removes the orphans. Each phase reverts independently.

---

## Rejected Alternatives

### A. Make SessionManager fully own AgentManager

**Rejected.** SessionManager and AgentManager have different lifecycle scopes, and ~30% of agent calls are legitimately session-less (routing, pre-execution decompose, AC refinement). Forcing those through synthetic sessions is ceremony that produces exactly the kind of ad-hoc workarounds this ADR removes. The peer relationship (both owned by `RunScope`) is the correct model.

### B. Put prompt audit on SessionManager

**Rejected.** Would bypass session-less paths. Audit is cross-cutting; it belongs as middleware on the scope-owned `IAgent`, where no call can escape it. SessionManager stays focused on session lifecycle only.

### C. Nested `RunScope` via `child()`

**Rejected as speculative.** The initial draft proposed `scope.child(label)` for debate proposers and rectification loops. On inspection, both need per-call isolation (own logger sub-scope, own `AbortSignal`), not scope-level isolation — they already share everything else (`agentManager`, `sessionManager`, services). Per-call `signal` and `logger` overrides cover the real need without introducing scope-lifecycle questions (who owns what, what does child close dispose). If a future case genuinely needs scope-level isolation (sandboxed sub-run with own cost budget), `child()` can be added then with a concrete motivation documented.

### D. Middleware as transformers from day one

**Rejected.** Transformers (middleware that can rewrite prompt/response for the next middleware) introduce load-bearing ordering semantics. Phase 1 ships observers only — all middleware read `MiddlewareContext` and emit side effects without affecting the chain. If a future middleware needs to transform, the invariant tightens to a declared order at that point, with the concrete case as justification.

### E. Permissions as middleware

**Rejected.** Early drafts listed `permissions` as a middleware entry. The middleware interface (observer-only, `readonly ctx`, args-less `next()`) cannot actually rewrite agent-call options — so a `permissions` middleware would either have to mutate (breaking the observer invariant) or do nothing useful. Resolution happens **pre-chain** inside `scope.invoke()` (§2.3), stuffs `options.permissions` with canonical policy, and the observer chain runs unchanged. The `permissions` entry disappears from the middleware table (§2.8).

### F. Adapter-side `resolvePermissions()` calls (current code path)

**Rejected.** Today's ACP adapter calls `resolvePermissions()` three times inside `run()`/`complete()`/`plan()` — duplicative with caller-side resolution. Single resolution in `scope.invoke()` puts canonical on options so middleware + audit can observe policy decisions without re-resolving, and adapters become pure consumers of pre-resolved state.

### G. Adapter imports `toAcpWire` directly (no registry)

**Rejected.** Loses the test-injection seam and forces each future transport to replicate its own ad-hoc wiring. The `IPermissionTranslatorRegistry` middleman (§2.6) is minor ceremony now (one entry) and pays off the moment a second transport or a plugin override appears.

### H. Per-agent translator layer in Phase 2

**Rejected as speculative.** Early drafts proposed per-agent translators (`translateToClaude`, `translateToGemini`, etc.) under ACP. Today acpx passes allowlist entries through unchanged — an agent translator would be a pass-through for every entry. Layer 2′ (§2.1 future reference) slots in cleanly when a real agent demands vocabulary adjustment; shipping the layer now would add ceremony without benefit.

### I. ACP wire tokens in shared runtime types

**Rejected.** Early drafts exported `AcpPermissionMode` from `src/runtime/permissions/`. Wire tokens are transport-specific and belong inside the transport's folder. `AcpPermissionMode`, `AcpWirePolicy`, and `toAcpWire()` all live inside `src/agents/acp/`. The registry stores `IPermissionTranslator<unknown>`; the adapter asserts the concrete wire type via the generic parameter at the call site.

---

## Open Questions

1. **Plugin API versioning.** `IReporter`, `IContextProvider`, `IReviewPlugin` currently take loose refs. A narrow `PluginContext` view derived from `RunScope` is the eventual shape; exact form deferred until the operation/prompt follow-ups land.

2. **Middleware order when transformers are introduced.** Phase 1 is observer-only and order-free. When the first transformer is justified, the ADR that introduces it must also specify the canonical order and the rationale for each neighbor pairing.

3. **Session resume across scope restarts.** Scope lifecycle is per-invocation; session descriptors persist on disk. Resume semantics (crashed run's scope is gone, its sessions can be reattached) need a clear contract — likely "scope opens, discovers resumable descriptors via `SessionManager`, offers reattach." Deferred to an ADR-008 follow-up.

---

## References

- ADR-008 — Session lifecycle
- ADR-011 — SessionManager ownership
- ADR-012 — AgentManager ownership
- ADR-013 — SessionManager → AgentManager hierarchy
- ADR-015 — Operation Contract (follow-up — adds `Operation<I, O, C>`, removes `.plan/.decompose` from adapter, introduces `ISessionRunner` implementations incl. `DebateSessionRunner`)
- ADR-016 — Prompt Composition & PackageView (follow-up — immutable `IPromptBuilder` sections, prompt middleware, monorepo-awareness enforcement)
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `docs/architecture/agent-adapters.md` — adapter protocol (unchanged by this ADR)
