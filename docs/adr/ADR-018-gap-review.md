# ADR-018 Gap Review

**Date:** 2026-04-24
**Reviewer:** Claude (self-review)
**Target:** [ADR-018 Runtime Layering](./ADR-018-runtime-layering-with-session-runners.md)
**Purpose:** Capture pre-implementation gaps for 1-by-1 discussion before opening the PR.

---

## Status Matrix

| # | Gap | Severity | Status |
|:--|:---|:---|:---|
| 1 | `ThreeSessionRunner` vs. sequential `callOp`s — architectural ambiguity | Blocking | Resolved → Option A |
| 2 | `composeSections()` dependency in Wave 1 — migration ordering | Blocking | Resolved → Option A |
| 3 | Broken reference `ctx.runtime.config` in §5.2 (no such field) | Blocking | Resolved → Option A |
| 4 | Root `NaxConfig` vs per-package `PackageView.config` — which does `op.config` select? | Blocking | Resolved → Option E (no scope) |
| 5 | `AgentManager.runAs()` uses `this._costTracker` / `this._promptAuditor` — wiring unspecified | Blocking | Resolved → Option G (middleware) |
| 6 | One-shot debate mode is session-less — odd fit under "SessionRunner" | Non-blocking | Resolved → DebateRunner cohesive |
| 7 | Existing test / `_deps` compatibility during migration — unstated | Non-blocking | Resolved → Option A + B |
| 8 | No deprecation window for `.plan()` / `.decompose()` removal | Non-blocking | Resolved → Option B |

Convention for resolution: when a gap is decided, append a `### Resolution` block and flip `Status` → `Resolved → <decision>`.

---

## Gap 1 — `ThreeSessionRunner` vs. sequential `callOp`s

**Severity:** Blocking — affects ADR shape and Wave-3 work estimate
**Location in ADR:** [§5.3](./ADR-018-runtime-layering-with-session-runners.md#L616), [§5.5](./ADR-018-runtime-layering-with-session-runners.md#L670)

### Problem

The ADR says `callOp(tddOp)` routes to `ThreeSessionRunner` via `op.session.topology: "three"`. The runner sketch then calls three sub-ops internally. Three things are never specified:

1. Is there a composite "tdd" op? If so, what do its `build()` / `parse()` produce when the real work is three distinct ops with flowing state?
2. How does `ThreeSessionRunner` get references to `writeTest`, `implement`, `verify`? Hardcoded imports (tight coupling)? A `subOps` field on the op (composite shape not defined in the `RunOperation` interface)?
3. The sketch does `const input = ctx.op.input as TddInput` — but `op.input` isn't a field on `RunOperation`. `input` arrives as `callOp`'s second argument, not embedded in the op.

### Why it matters

Without resolution, the Wave-3 TDD migration has no concrete target. The type-checker will reject the `ctx.op.input` cast; callers can't know what to pass to `callOp(tddOp, ???)`.

### Options

**A. Drop `ThreeSessionRunner`.** Each sub-op (`writeTest`, `implement`, `verify`) is a `RunOperation<..., ..., ...>` with `topology: "single"`. Each goes through `SingleSessionRunner` → `runInSession` independently. The TDD orchestrator at [src/tdd/orchestrator.ts](../../src/tdd/orchestrator.ts) sequences three `callOp()` calls:

```typescript
const tests = await callOp(ctx, writeTest, input);
const impl  = await callOp(ctx, implement, { ...input, tests });
const vrf   = await callOp(ctx, verify,    { ...input, tests, impl });
```

Bookkeeping (state transitions, bindHandle, token propagation, #589/#590) is already uniform — every sub-op goes through `SingleSessionRunner`, which goes through `runInSession`. Claim "closes #589/#590 by construction" still holds.

**B. Keep `ThreeSessionRunner`; specify the composite shape.** Introduce a dedicated composite op type:

```typescript
export interface CompositeRunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "composite-run";
  readonly topology: "three" | "debate";
  readonly subOps: readonly RunOperation<unknown, unknown, unknown>[];
  // build() produces a seed; topology runner maps input → sub-op inputs
}
```

Adds a third op kind. Runners dispatch on `op.topology` with full access to declared sub-ops. `callOp()` grows a branch for `kind: "composite-run"`.

### Recommendation

**Option A.** Matches #596's underlying DRY goal (share the `runInSession` wrapper) without inventing a composite-op kind. "Three sequential sessions with flowing state" is stage-orchestrator concern, not a topology abstraction. `DebateSessionRunner` stays (see Gap 6) because debate has genuine topology shape (N-parallel, mode dispatch) that can't be expressed as "sequence K callOps."

Claim "closes #589/#590 by construction" stays accurate under Option A: every session opened via any callOp routes through `SingleSessionRunner.run()` → `SessionManager.runInSession()`.

### Resolution — Gap 1

**Decision:** Drop `ThreeSessionRunner`. TDD orchestrator sequences three Operations through `callOp` → `SingleSessionRunner`.
**Chosen option:** A — matches the actual shape of the codebase (ThreeSessionRunner is already a 50-line shim; `runThreeSessionTdd` is the real sequencer and stays). Between-session logic (greenfield detect, full-suite gate, verdict read, rollback) cannot be expressed as a composite-op sequence, so the composite abstraction (Option B) earns no duplication savings.

**ADR edit required:**
- §5 `ISessionRunner` family — remove `ThreeSessionRunner`; `ISessionRunner` contracts to `SingleSessionRunner` only.
- §5.2 `SingleSessionRunnerContext` — add `noFallback?: boolean` field so TDD ops can opt out of cross-agent fallback at the type level (prevents silent regression if a future refactor threads `agentManager` through).
- §4 / Wave 3 — specify TDD migration creates `writeTestOp` / `implementOp` / `verifyOp` (each `kind: "run"`, `topology: "single"`) in `src/tdd/ops/`, with a shared `runTddSessionOp(role, input, ctx)` helper in `src/tdd/session-op.ts` extracted from today's `runTddSession`. Orchestrator `runThreeSessionTdd` keeps recursion guard / dry-run / retry-skip / greenfield-detect / full-suite gate / verdict read / post-verify fallback / rollback / aggregation — only its three `runTddSession(...)` call sites change to `callOp(ctx, op, input)`.
- §4 Operation interface — clarify that `execute` for `kind: "run"` ops is the natural home for session post-work (autoCommit, isolation verification, changed-file diff, PID cleanup); `parse` stays reserved for pure text → domain mappings used by `kind: "complete"` ops.
- Rejected-alternatives list — add `CompositeRunOperation` with pointer to the between-session logic (`runFullSuiteGate`, `readVerdict`, `rollbackToRef`) that can't be expressed as a sub-op sequence.

**Wave impact:** Wave 3 TDD-migration sub-plan made concrete (estimated ~2 days, in line with original budget): 3 ops + 1 shared helper + orchestrator rewire + `ThreeSessionRunner` deletion + test rewrites. Test-fixture migration cost absorbed by `makeTestRuntime()` from Gap 7 (Wave 1).

---

## Gap 2 — `composeSections()` lands in Wave 3, but Wave 1's `callOp()` already calls it

**Severity:** Blocking — Wave 1 proof-of-concept can't work as written
**Location in ADR:** [§4.3 `callOp()`](./ADR-018-runtime-layering-with-session-runners.md#L477), [Wave 3 migration plan](./ADR-018-runtime-layering-with-session-runners.md#L1007)

### Problem

Wave 1 ships `callOp()`. The body invokes:

```typescript
const sections = composeSections(op.build(input, buildCtx));
const prompt   = join(sections);
```

`composeSections` / `join` / `SLOT_ORDER` land in Wave 3. The Wave-1 `classifyRoute` proof-of-concept has no `composeSections` to call.

### Why it matters

Wave 1 claims the operation shape is proven end-to-end. It isn't, if `callOp` can't actually build a prompt.

### Options

**A. Move `composeSections` + `SLOT_ORDER` + `ComposeInput` into Wave 1.** They're ~100 lines of total functions; no behavior risk. Builder migrations (slot-method exposure, rectifier 720→200) can still land in Wave 3.

**B. Wave 1's `callOp` uses a legacy string-building path.** Ops declare `build: (input, ctx) => string`. Wave 3 amends the op interface when `composeSections` ships. Type signature changes mid-migration — every Wave-1-migrated op needs a second edit in Wave 3.

**C. Wave 1's `classifyRoute` bypasses the `build` step.** Hand-writes prompt inline. Doesn't prove the `Operation` shape.

### Recommendation

**Option A.** `composeSections` is a small total function. Shipping it in Wave 1 makes the Wave-1 exit criterion ("one operation end-to-end through `callOp`") actually testable. Wave 3 retains the heavier work: slot method migration per builder, the rectifier collapse, the CI lint rule.

Wave 1 deliverables grow by: `src/prompts/compose.ts` (~100 lines), `SectionSlot` + `SLOT_ORDER` added to `src/prompts/core/types.ts` (~20 lines). Net small.

### Resolution — Gap 2

**Decision:** Ship `composeSections` + `SectionSlot` + `SLOT_ORDER` + `ComposeInput` in Wave 1. Coexists with `SectionAccumulator` during the transition; builder migrations (slot methods, rectifier collapse) stay in Wave 3.
**Chosen option:** A — composeSections is a pure, total function with no builder entanglement; Wave 1's `callOp` actually needs it to prove the Operation shape end-to-end. The heavy builder work is orthogonal and stays in Wave 3.

**ADR edit required:**
- §4.3 `callOp()` — reference `composeSections` + `join` from `src/prompts/compose.ts` as shipping-in-Wave-1, not Wave 3.
- Wave 1 deliverables — add: `src/prompts/compose.ts` (~80 lines), `SectionSlot` enum + minimal `SLOT_ORDER` (~30 lines), `ComposeInput` type (~15 lines), ~6-8 unit tests.
- Wave 1 design notes:
  - `SLOT_ORDER` stays **minimal in Wave 1** — only slots used by Wave-1 ops (`constitution`, `instructions`, `input`, `candidates`, `json-schema`). Grows per wave as builders migrate. Builders not yet migrated keep using `SectionAccumulator` unchanged.
  - Dynamic labelled inputs (OneShotPromptBuilder.inputData pattern) use a **single `input` slot holding an array of `{label, body}`** instead of template-literal slot names. Avoids polluting the `SectionSlot` union.
  - `composeSections.join()` reuses `SECTION_SEP` from [src/prompts/core/wrappers.ts](../../src/prompts/core/wrappers.ts) and the empty-content filter logic from `SectionAccumulator.join()`. Single source of truth for separator + empty-section policy.
  - Coexistence pattern for Wave 2 transitional period: legacy-builder-backed ops wrap the builder's string output in a single-slot `ComposeInput` (`{ slots: { role_task: body } }`). Wave 3 collapses this when builders expose slot methods.
- Wave 3 — scope narrowed to: slot-method exposure per builder, rectifier collapse (720→200), CI lint rule. `composeSections` itself already shipped.
- §7 `composeSections` — fold in as Wave 1 deliverable; remove any references that treat it as Wave 3.

**Wave impact:** Wave 1 grows by ~1 day (6-7 hrs, absorbed by existing Wave 1 budget). Wave 3 shrinks by the same ~1 day. Net zero; sequencing now matches dependencies. Optional: add `autoApprove` op alongside `classifyRoute` in Wave 1 (~2 hrs) to exercise conditional-slot coverage — not strictly required.

---

## Gap 3 — Broken reference `ctx.runtime.config` (field doesn't exist)

**Severity:** Blocking — code sketch won't compile
**Location in ADR:** [§5.2 `SingleSessionRunner`](./ADR-018-runtime-layering-with-session-runners.md#L585), line ~605

### Problem

The `SingleSessionRunner.run()` sketch has:

```typescript
const result = await ctx.runtime.sessionManager.runInSession(
  sessionId,
  async (options) => ctx.runtime.agentManager.runWithFallback(ctx.agentName, {
    runOptions: {
      // ...
      config: ctx.runtime.config,     // ← field does not exist on NaxRuntime
      // ...
    },
  }),
  // ...
);
```

`NaxRuntime` §2 defines `configLoader: ConfigLoader` only. `.config` was removed in favor of `configLoader.current()`. The elsewhere-correct §4.3 `callOp()` uses `ctx.runtime.configLoader.current()`.

### Why it matters

Pure inconsistency. Blocks the type-checker on first compile.

### Options

**A. One-word fix.** `config: ctx.runtime.configLoader.current()`.

### Recommendation

**Option A.** No debate; the sketch is just stale. Apply during ADR edit pass.

### Resolution — Gap 3

**Decision:** One-word fix.
**Chosen option:** A — `ctx.runtime.config` does not exist; `configLoader.current()` is the canonical accessor per §2.1.

**ADR edit required:** §5.2 `SingleSessionRunner` sketch — replace `config: ctx.runtime.config` with `config: ctx.runtime.configLoader.current()`.

**Wave impact:** None. Pure doc-consistency fix applied during the ADR edit pass.

---

## Gap 4 — Root `NaxConfig` vs per-package `PackageView.config`: which does `op.config` select?

**Severity:** Blocking — affects every per-package op in Wave 3
**Location in ADR:** [§4.3 `callOp()`](./ADR-018-runtime-layering-with-session-runners.md#L477), [§9.3 `PackageRegistry`](./ADR-018-runtime-layering-with-session-runners.md#L861)

### Problem

Two candidate "config" sources coexist after this ADR:

- **Root config** — `runtime.configLoader.current()`, loaded from global + project `.nax/config.json`.
- **PackageView.config** — per §9.3, root merged with `.nax/mono/<pkg>/config.json` overrides.

`callOp()` currently does `runtime.configLoader.select(op.config)` — always root. So a package-scoped op reading `ctx.config.review.maxAttempts` gets the root value, even if the package defines an override. The per-package override machinery (described in `.claude/rules/monorepo-awareness.md` §A and referenced by ADR-009) never reaches the op.

ADR-015 anticipated this with a forward-reference ("after ADR-016 introduces `PackageView`, slicing is applied to `ctx.package.config`") but ADR-018 drops the forward-reference and never makes the decision.

### Why it matters

Every op migrated in Wave 3 that reads review/rectification/acceptance/tdd config through its selector gets the wrong value in polyglot monorepos. Finding out after migration means rewriting ~10 ops.

### Options

**A. Selectors always apply against root.** Per-package config is accessed via `ctx.packageView.config.*` explicitly, out-of-band of the selector. Clear separation; ops that want package-merged review config write custom projection. Downside: defeats the whole per-package override story for the common case.

**B. `callOp()` slices against `packageView.config` when the op is package-scoped.** Mirrors ADR-015's forward-reference. Natural default — callers get "the config that applies to this package in this op's context." Requires reintroducing a `scope: "package" | "repo"` field on ops (or inferring from `packageDir` presence).

**C. `ConfigLoader.select(selector, base?)` overload.** Caller chooses which base to slice against. Flexible; more complex API.

**D. Two parallel selectors per subsystem.** `reviewRootSelector` and `reviewPackageSelector`. Doubles the registry; cumbersome.

### Recommendation

**Option B.** It matches what callers expect ("the config that applies here"); it's the path ADR-015 anticipated; it requires one field (`scope`) or one inference rule. Reintroducing `scope: "package" | "repo"` on `RunOperation` / `CompleteOperation` costs one line per op but keeps slicing deterministic.

If we want to avoid the extra field: infer package vs repo from whether `ctx.packageDir === runtime.workdir` (repo-scoped) vs. a sub-path (package-scoped). Brittle under monorepos where the root itself is a package; I'd take the explicit field instead.

**Consequence if taken:** `CompleteOperation` / `RunOperation` gain `readonly scope: "package" | "repo"` (or `"cross-package"` if we want to anticipate cross-package; ADR-017 rejected that for YAGNI). `callOp()` branches: repo-scoped → slice root; package-scoped → slice `packageView.config`.

### Resolution — Gap 4

**Decision:** No `scope` field. All ops read through `ctx.packageView.select(op.config)`. `PackageView.config` is always a safe read because per-package config is a one-way merge — package overrides win for whitelisted sections, root values pass through for non-whitelisted sections.
**Chosen option:** E (new option surfaced during discussion — supersedes the original Options A-D). Selector-owned scope (revised Option C) was considered and was already strictly better than the originally-recommended Option B. Option E goes further: if `packageView.config` is always the correct base for every op, the `scope` field solves a problem that doesn't exist.

**Key insight:** `mergePackageConfig` (see [src/config/merge.ts](../../src/config/merge.ts)) is a one-way merge — whitelisted sections (agent, models, routing, execution, review, acceptance, quality, context, project) get package overrides when present, root values when not. Root-only sections (autoMode, generate, tdd, decompose, plan, constitution, interaction) can never be overridden by packages. So for any field in any section, `packageView.config[section].field` is the correct semantic value. Repo-scoped ops like `planOp` / `decomposeOp` read from `packageView.config.plan` and get the root value by construction (plan is root-only). There is no case where reading `configLoader.current()` in an op is correct and reading `packageView.config` is wrong.

**ADR edit required:**
- §2 `NaxRuntime` — `configLoader` stays but is used by **run-level setup code only** (createRuntime, iteration-runner bookkeeping, PackageRegistry backing store). Ops never touch it directly.
- §2.1 `ConfigLoader.select<C>(selector)` — kept for run-level setup. Ops use `ctx.packageView.select(op.config)`.
- §4 `ConfigSelector<C>` — interface stays as `{ readonly name: string; select(base: NaxConfig): C }`. No `scope` field. `select()` is a pure `(NaxConfig) => C`.
- §4 Operation types — no `scope` field on `RunOperation` / `CompleteOperation`.
- §4.3 `callOp()` — one dispatch path: `const sliced = ctx.packageView.select(op.config); const sections = composeSections(op.build(input, { config: sliced, ... })); ...`. No scope branching.
- §4.2.4 (contract rules) — drop any rule about selector-to-base mapping. Single rule now: **all ops read config through `ctx.packageView.select(selector)`.**
- §9.3 `PackageRegistry.resolve(packageDir)` — accepts `undefined` / missing workdir. Returns a root-equivalent `PackageView` (backed by `configLoader.current()`) when no story workdir exists. Never throws; never returns null.
- `OpContext` — `packageView: PackageView` is **always present** (not optional). Single-package runs, pre-story ops, and no-workdir runs all receive a root-equivalent view.
- Rejected-alternatives list — add Options A-D **and** the selector-owned-scope flavor of Option C, with a pointer to this resolution explaining why no scope field is needed.

**Wave impact:**
- Wave 2 infrastructure: `PackageRegistry` + `PackageView` + `PackageView.select<C>()` — unchanged from the Option B estimate (~1.5 days).
- Wave 3 per-op cost: lower than Option B because no scope declaration per op (~15 min/op saved × ~10 ops = ~2-3 hrs total savings).
- **New Wave-3 migration task**: grep audit of current `rootConfig.*` reads in `src/`. Expected <10 hits based on the [pipeline/types.ts:69-72](../../src/pipeline/types.ts#L69-L72) documented list. For each, classify as:
  - *Defensive legacy* — safe to migrate; behaviour changes only when a package actually overrides that field (which was arguably always the right behaviour).
  - *Semantically root-required* — audit; if confirmed correct, document and keep `configLoader.current()` access in that specific op as an explicit escape hatch.
- Estimate for the grep + classification pass: ~45 min. If any hits turn out to be semantically root-required, add ~30 min each.

**Secondary benefit (correctness fix):** the current `ctx.rootConfig.models` / `ctx.rootConfig.agent.default` reads that bypass legitimate per-package overrides get fixed for free during Wave-3 migration. Polyglot repos that today silently ignore per-package model maps or per-package default-agent overrides will start respecting them.

---

## Gap 5 — `AgentManager.runAs()` uses `this._costTracker` / `this._promptAuditor` — wiring unspecified

**Severity:** Blocking — affects Wave-2 construction order
**Location in ADR:** [§3 `runAs()` envelope](./ADR-018-runtime-layering-with-session-runners.md#L225)

### Problem

The §3 envelope sketch calls `this._costTracker.record(...)` and `this._promptAuditor.record(...)` as if both are internal manager fields. They are not — they live on `NaxRuntime`. The ADR never specifies how `AgentManager` obtains references to them.

### Why it matters

Wave 2's core deliverable is "move permissions/cost/audit/errors into `runAs()`." Without a wiring decision, the implementation has no entry point.

### Options

**A. `createAgentManager` grows deps parameters.** `createAgentManager(config, { costTracker, promptAuditor, signal, logger })` — runtime factory passes them at construction. Clean; matches the `_deps` convention already used across the codebase. `AgentManager` holds private refs; no runtime backref.

**B. `AgentManager` takes a `runtime` backref.** Lazy access via `this._runtime.costTracker`. Creates circular reference (runtime owns manager, manager points to runtime). Works, but harder to test in isolation — `AgentManager` now can't be constructed without a runtime mock.

**C. `AgentManager` owns its own counter; `CostTracker` subscribes.** Moves the source of truth back into the manager. Partially regresses the orphan-consolidation win (what does orphan consolidation even mean if managers have their own counters?).

### Recommendation

**Option A.** Matches the existing `_deps` DI pattern in the codebase. Keeps `AgentManager` testable without a runtime. Wave 2 migration:

1. Add `CostTracker` + `PromptAuditor` + `Logger` + `AbortSignal` as optional deps on `createAgentManager`.
2. Runtime construction (`createRuntime` in Wave 1) passes them.
3. Orphan call sites that still construct their own managers (none after Wave 1) would need the deps too — but none exist.

Add ADR text pinning this; add a line to §3 code sketch showing the construction: `const mgr = createAgentManager(config, { costTracker, promptAuditor, signal, logger });`.

### Resolution — Gap 5

**Decision:** Adopt observer middleware inside `AgentManager.runAs()`. Sinks (`ICostAggregator`, `IPromptAuditor`) live on `NaxRuntime`. `createAgentManager` takes a single `middleware` deps slot. Cost + audit are not manager fields.
**Chosen option:** G — surfaced during discussion; supersedes the originally-recommended Option A (grow manager deps with cost+audit) and the interim Option F (pass-through + shared adapter helper). Middleware design is ported from [ADR-014 §2.8](./ADR-014-runscope-and-middleware.md#L472-L513) — the pattern was not rejected on its merits; it was bundled with `RunScope` composite and fell with it. ADR-018's flat `NaxRuntime` + pre-existing `runAs()` envelope are the right slot to re-admit the middleware chain.

**Why not Option A (grow manager deps with `costTracker` + `promptAuditor`):** couples observability to agent lifecycle; manager inflates with unrelated concerns; every new observability concern (budget enforcement, rate tracking, token-aware throttle) requires a new manager field + constructor parameter. Fragments the extension story.

**Why not Option F (pass-through + shared adapter helper):** audit uniformity relies on "every adapter author remembers to call `maybeAuditPrompt()`" — code-review discipline, not structural correctness. In a polyglot adapter future (CLI + ACP + future transports), the first forgotten call is a silent audit miss. Observability extensions (budget, rate) scatter as fragmented `manager.events` subscribers, not a single pattern.

**Why Option G wins:**
- **Structural audit uniformity** — impossible to bypass. New adapter inherits the chain automatically; nothing to remember.
- **Session-internal calls covered by construction** — ADR-013 Phase 5 locked down direct adapter calls; everything flows through `IAgentManager`. `SessionManager.runInSession(id, manager, req)` therefore passes through the same middleware chain. No SessionManager rewire needed (contrast ADR-014, which required the `scope.getAgent` callback to reach session-internal calls).
- **One extension pattern for future observability** — budget enforcement, rate tracking, token-aware throttle each become "add a middleware," not "thread a new dep through every call site."
- **Manager stays semantically narrow** — lifecycle + fallback policy only. Observability delegated.
- **Preserves ADR-014's three Phase 1 invariants** (observer-only, frozen chain, pre-chain permissions) — none was the reason ADR-014 was rejected.

**ADR edit required:**

- **§2 `NaxRuntime`** — add `readonly costAggregator: ICostAggregator` and `readonly promptAuditor: IPromptAuditor`. Both drained/flushed by `runtime.close()`.
- **§3 `runAs()` envelope** — remove `this._costTracker.record(...)` / `this._promptAuditor.record(...)` calls from the sketch. Replace with middleware chain execution around the terminal `runWithFallback`:
  ```typescript
  async runAs(name, request) {
    const resolved = resolvePermissions(config, request.runOptions.pipelineStage);
    const opts = { ...request.runOptions, permissions: resolved };
    return this._middleware.execute(
      { agentName: name, options: opts, signal: request.signal, ... },
      async () => runWithFallback({ ...request, runOptions: opts }),
    );
  }
  ```
- **New §3.1 Agent middleware** — port [ADR-014 §2.8](./ADR-014-runscope-and-middleware.md#L472-L513) verbatim (minus RunScope-specific wording):
  - `AgentMiddleware` interface (`run?` / `complete?` observers + `next` continuation)
  - `MiddlewareContext` type (prompt, options, agentName, stage, storyId, packageDir, signal — `runtime` replaces `scope`)
  - Phase 1 chain: `audit`, `cost`, `cancellation`, `logging`
  - Three invariants: **observer-only (no transformers in Phase 1)**, **frozen at runtime construction**, **permissions pre-chain (not a middleware concern)**
  - On error: every middleware resilient; `audit` emits error entry, `cost` emits `CostErrorEvent`, `cancellation` translates; no middleware swallows the throw
- **New §9.x `CostAggregator`** — port [ADR-014 §3](./ADR-014-runscope-and-middleware.md#L516-L562) verbatim (`ICostAggregator` + `CostEvent` + `CostErrorEvent`). Runtime-owned. Per-agent/stage/story snapshots. Drained on `runtime.close()` into `StoryMetrics`.
- **New §9.x `PromptAuditor`** — port [ADR-014 §4](./ADR-014-runscope-and-middleware.md#L566-L590) (`IPromptAuditor` + `PromptAuditEntry` + `PromptAuditErrorEntry`). Writes to `.nax/audit/<runId>.jsonl`. Runtime-owned. Flushed on `runtime.close()`.
- **§3 `createAgentManager` signature** — grows single optional slot: `createAgentManager(config, opts?: { middleware?: readonly AgentMiddleware[] })`. Default empty chain (for tests). `createRuntime` composes the production chain and passes it.
- **Rejected-alternatives list** — add Option A (manager grows cost+audit fields — couples observability to lifecycle; fragmented extension story) and Option F (pass-through + shared adapter helper — audit uniformity by discipline, not structure). Pointer to this resolution for why Option G wins.

**Wave impact:**

- **Wave 2 grows ~2 days** (from ~2 days to ~4 days) to cover middleware infrastructure (~1 day), sinks (~0.5 day), and per-middleware implementations (~1 day for audit + cost + cancellation + logging).
- Extract `writePromptAudit` call from [src/agents/acp/adapter.ts:651-666](../../src/agents/acp/adapter.ts#L651-L666) during Wave 2; the adapter stops doing audit inline (middleware does it).
- No Wave-3 op changes required. Middleware fires inside `runAs()` regardless of which op called it.

**Constraints to carry forward:**
- **Middleware is observer-only in Phase 1.** No transformer middleware. Re-open only when a concrete transformer case emerges with justification.
- **Chain frozen at runtime construction.** Registered once in `createRuntime`; immutable for runtime lifetime. No per-call / per-op middleware overrides.
- **Permissions pre-chain, not middleware.** `resolvePermissions()` fires before the chain executes; middleware reads `options.permissions` for audit but does not compute it. Matches ADR-014's explicit rejection of permissions-as-middleware.

---

## Gap 6 — One-shot debate mode is session-less, odd under "SessionRunner"

**Severity:** Non-blocking — naming / framing
**Location in ADR:** [§5.4 `DebateSessionRunner`](./ADR-018-runtime-layering-with-session-runners.md#L639)

### Problem

`DebateSessionRunner.runOneShot` is documented as "N × `complete()`, no sessions." A runner class named `*SessionRunner` that has a mode with no sessions is a naming smell.

### Options

**A. Rename `DebateSessionRunner` → `DebateRunner`.** Drops the "Session" since the runner coordinates modes, not all of which use sessions.

**B. Route one-shot debate through parallel `callOp(debatePropose, ...)` with `kind: "complete"`.** The "runner" disappears for one-shot mode; the debate orchestrator calls N complete-kind callOps in parallel. Stateful and hybrid modes retain `DebateSessionRunner`.

**C. Accept the naming inconsistency.** Noted, moved on.

### Recommendation

**Option A** (rename). One line edit. Conveys what the runner actually does (coordinates debate topology, some modes use sessions, some don't). Option B is also valid but requires more structural work.

### Resolution — Gap 6

**Decision:** `DebateRunner` stays as one cohesive class. It **does not** implement `ISessionRunner`. It is a debate-domain orchestrator that uses `callOp` uniformly across all modes — oneshot calls N complete-kind callOps in parallel; stateful/hybrid call N run-kind callOps (which route through `SingleSessionRunner` → `SessionManager.runInSession`).
**Chosen option:** New resolution surfaced during discussion — supersedes both Option A (rename only) and Option B (split orchestrator from runner). Key insight: the "Runner" suffix is a class-naming convention, not an interface commitment. `DebateRunner` does not need to conform to `ISessionRunner` just because the suffix matches. Forcing that conformance was the original cause of the smell.

**Why not Option A (rename `DebateSessionRunner` → `DebateRunner` while keeping `implements ISessionRunner`):** fixes the vocabulary but not the design. A class named `DebateRunner` that claims to be an `ISessionRunner` for oneshot mode (which is session-less) still lies about its conformance. The interface invariant established in Gap 1's resolution ("`ISessionRunner` is the shared call site for `runInSession`") weakens.

**Why not Option B (split one-shot mode out into `DebateOrchestrator`):** fragments one domain feature across two classes (orchestrator + runner). Callers who think "run a debate" now have to know which class handles which mode. Loses cohesion. The split was solving a problem that only existed because we incorrectly assumed `DebateRunner` needed to implement `ISessionRunner`.

**Why this resolution wins:**

- **Debate cohesion preserved.** One `DebateRunner` class, one entry point (`DebateRunner.run(ctx, input)`), internal mode dispatch. Users think "run a debate"; they get one API.
- **`ISessionRunner` invariant preserved.** Only `SingleSessionRunner` implements it. Gap 1's narrowing holds; no weakening to admit session-less impls.
- **Interface-conformance claim honest.** `DebateRunner` does not claim to be an `ISessionRunner` because it isn't always one. Class name describes domain role; no interface contract to violate.
- **All modes use `callOp` uniformly.** Oneshot = N parallel complete-kind callOps; stateful/hybrid = N parallel run-kind callOps. Middleware chain (Gap 5 resolution → Option G) fires for every persona call across every mode automatically. No special-case observability.

**ADR edit required:**

- **§5 `ISessionRunner` family** — remains "`SingleSessionRunner` only" (per Gap 1 resolution). `DebateRunner` is explicitly **not** listed under `ISessionRunner` implementations.
- **§5.4 `DebateSessionRunner`** — rename to `DebateRunner`. Remove `implements ISessionRunner`. Document as a debate-domain orchestrator that uses `callOp` internally.
- Add new subsection or sidebar note: **"`*Runner` suffix conventions"** — the suffix describes domain role (runs debates, runs stories, runs verifications). It does not imply `ISessionRunner` conformance. Only classes that genuinely share the `runInSession` call site implement the interface.
- **Wave-3 debate migration** — `DebateRunner.run(ctx, input)` dispatches on `input.mode`; each branch is `Promise.all(personas.map(p => callOp(ctx, opFor(mode), { persona: p, ... })))`. `debateProposeOp` = `kind: "complete"` (oneshot); `debateSessionOp` = `kind: "run", topology: "single"` (stateful/hybrid).
- **Rejected-alternatives** — add both Option A (rename only; leaves design smell of session-less mode inside a class claiming `ISessionRunner` conformance) and Option B (orchestrator/runner split; fragments cohesion for an interface the class shouldn't conform to in the first place).

**Wave impact:** ~5 lines of change during Wave 3 — remove `implements ISessionRunner` from the class declaration, adjust internal dispatch to use `callOp` uniformly. Lower than either Option A (1-line rename + interface implementation kept) or Option B (~30-line class split). Net simplification.

**Constraint to carry forward:** Class-naming `*Runner` suffix is free to use for any domain orchestrator. Interface conformance to `ISessionRunner` is reserved for classes that genuinely share the `runInSession` primitive — today that is `SingleSessionRunner` only.

---

## Gap 7 — Existing test / `_deps` compatibility during migration — unstated

**Severity:** Non-blocking — affects wave time estimates
**Location in ADR:** Wave-3 migration plan

### Problem

Wave 3 migrates TDD, debate, acceptance, review. Each has extensive `_deps` test factories:

- [src/acceptance/generator.ts](../../src/acceptance/generator.ts) — `_generatorDeps.createManager`
- [src/acceptance/refinement.ts](../../src/acceptance/refinement.ts) — `_refinementDeps.createManager`
- [src/debate/session-helpers.ts](../../src/debate/session-helpers.ts) — `_debateSessionDeps`
- [src/verification/rectification-loop.ts](../../src/verification/rectification-loop.ts) — `_rectificationDeps`

The ADR says "other sites swap `createManager` dep for `runtime`" (§2 migration table). It doesn't say whether existing test fixtures that inject `_deps.createManager` keep working, or need rewriting to inject `_deps.runtime` with a mocked runtime.

### Why it matters

Wave 3 estimate ("1–2 days per wave") assumes mechanical migration. If every test in `test/unit/acceptance/**`, `test/unit/debate/**`, `test/unit/verification/**` needs rewriting to use a `makeTestRuntime()` fixture, Wave 3 doubles in effort.

### Options

**A. Ship a `makeTestRuntime()` fixture in Wave 1.** Matches ADR-014's `makeTestScope()` approach. Tests migrate mechanically (one import change + one factory swap).

**B. Keep `_deps.createManager` as a legacy alias during Wave 3.** Deprecation warning. Tests migrate opportunistically. Delete after Wave 3.

**C. Rewrite tests inline per op migration.** Slow but explicit.

### Recommendation

**Option A + B.** Ship `makeTestRuntime()` in Wave 1 so new op tests have a fixture. Keep `_deps.createManager` as a legacy wrapper (internally calls `createRuntime` and extracts `runtime.agentManager`) during Wave 3 to avoid a big-bang test rewrite. Delete in a Wave 3 cleanup pass or as a post-Wave-3 chore.

Add a line to Wave 1 deliverables: "Publish `test/helpers/runtime.ts` with `makeTestRuntime(opts)` fixture."

### Resolution — Gap 7

**Decision:** Ship `makeTestRuntime()` fixture in Wave 1. Keep `_deps.createManager` as a legacy wrapper during Wave 3 (internally calls `createRuntime()` and extracts `runtime.agentManager`). Delete the legacy alias in a Wave-3 cleanup pass or as a post-Wave-3 chore.
**Chosen option:** A + B combined — matches the dual need: new op tests need a fixture from day one (Option A), and the existing ~4 `_deps.createManager` factory sites (acceptance/generator, acceptance/refinement, debate/session-helpers, verification/rectification-loop) need a grace period to avoid a big-bang test rewrite alongside Wave-3 op migration (Option B).

**ADR edit required:**
- Wave 1 deliverables — add: publish `test/helpers/runtime.ts` with `makeTestRuntime(opts)` fixture. Opts permit overriding individual runtime services (agentManager, sessionManager, configLoader, middleware, costAggregator, promptAuditor) so tests can inject mocks without constructing the full runtime.
- Wave 3 migration note — existing `_deps.createManager` factories stay as legacy wrappers during the wave. Each wrapper's body becomes: `(opts) => { const runtime = createTestRuntime(opts); return runtime.agentManager; }`. Call sites migrate opportunistically; delete the aliases in the Wave-3 cleanup pass once all tests target the new fixture.
- Gap 5 interaction — `makeTestRuntime()` must support an empty middleware chain by default for tests (observable behaviour is equivalent to today's pre-middleware adapter path).

**Wave impact:** Wave 1 gains ~4 hours for the fixture + doc. Wave 3 estimate stays at "1–2 days per wave" because the legacy alias absorbs the test-migration cost during the wave itself.

---

## Gap 8 — No deprecation window for `.plan()` / `.decompose()` removal

**Severity:** Non-blocking — likely fine given internal-only use
**Location in ADR:** [Wave 3](./ADR-018-runtime-layering-with-session-runners.md#L1007)

### Problem

Wave 3 deletes `AgentAdapter.plan()` and `.decompose()`. Any code implementing the adapter interface (internal or external) breaks at compile time. ADR-017 mentioned a "one-release window"; this ADR doesn't.

### Why it matters

If adapters are strictly internal today (ACP + any in-tree alternatives), the removal is fine. If plugins can contribute agents (plugin type `agent` per §H), a plugin implementing the old 4-method interface breaks on first upgrade.

### Options

**A. Delete directly in Wave 3.** Adapters are internal; plugin `agent` type is not widely used yet. Document in release notes.

**B. One-release deprecation window.** Wave 3 makes `.plan()` / `.decompose()` throw `NaxError ADAPTER_METHOD_DEPRECATED`. Next release deletes. Plugin authors get one cycle to migrate.

**C. Keep them as default implementations that delegate to the operations.** `AgentAdapter.plan = () => { throw new Error("use scope.invoke(plan, ...)"); }`. Compile succeeds; runtime throws with guidance.

### Recommendation

**Option B.** Low-cost, aligns with ADR-017's stated policy, covers any external `agent`-plugin author. Adds one line to the Wave-3 exit criteria: "`.plan()` / `.decompose()` throw `NaxError ADAPTER_METHOD_DEPRECATED` with a migration pointer; deletion lands in the next release."

### Resolution — Gap 8

**Decision:** One-release deprecation window. Wave 3 makes `AgentAdapter.plan()` / `.decompose()` throw `NaxError ADAPTER_METHOD_DEPRECATED` with a migration pointer. Deletion lands in the release following Wave 3.
**Chosen option:** B — low-cost, aligns with ADR-017's stated policy, covers external plugin authors who implemented the old 4-method interface. Option A (delete directly) is faster but leaves first-upgrade plugins with a non-actionable compile error; Option C (default implementations that throw at runtime) is strictly inferior to Option B since the compile-time surface shrinks identically in both.

**ADR edit required:**
- Wave 3 exit criteria — add: "`AgentAdapter.plan()` / `.decompose()` throw `NaxError ADAPTER_METHOD_DEPRECATED` with a migration pointer to the replacement operations (`planOp` / `decomposeOp`). Deletion lands in the next release."
- Error message template — include: (a) which adapter/method was called, (b) the replacement operation name (`scope.invoke(planOp, ...)` / equivalent via `callOp`), (c) a link to the Wave-3 migration notes in the ADR.
- Release-notes note — post-Wave-3 release deletes the deprecated methods; plugin authors get one release cycle to migrate.

**Wave impact:** Wave 3 adds ~30 minutes for the deprecation stubs + error message. Post-Wave-3 release adds ~5 minutes to delete the stubs.

---

## Discussion Template

For each gap, expected resolution format:

```
### Resolution — Gap N

**Decision:** <one line>
**Chosen option:** <letter + brief why>
**ADR edit required:** <yes/no + location>
**Wave impact:** <which wave(s) change>
```

When all eight are resolved, do a single ADR edit pass + amend commit to `docs/adr-018-runtime-layering`, then open the PR.
