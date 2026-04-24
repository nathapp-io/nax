# Review: ADR-014 / ADR-015 / ADR-016 split

**Reviewer:** Claude (revised pass)
**Date:** 2026-04-23
**Subjects:**
- `docs/adr/ADR-014-runscope-and-middleware.md`
- `docs/adr/ADR-015-operation-contract.md`
- `docs/adr/ADR-016-prompt-composition-and-packageview.md`

---

## TL;DR

The split is a **strict improvement** over the monolithic ADR it replaces. Dependency chain (014 → 015 → 016) is clean, forward-references are honest, and several additions (`src/control/` directory, `CostErrorEvent`, functional prompt transformers, rejection of `child()` scope) are genuinely better than my original draft.

**But the split should not ship as-is.** There are three architectural decisions still hiding as prose, plus eight smaller gaps. Without resolving them in the ADR text, migration Phase 1 will hit them mid-implementation and force rework.

Severity legend:
- **Blocker** — design decision not yet made; cannot implement from the current text.
- **Gap** — decision made but plumbing incomplete; mechanical fix.
- **Minor** — wording / framing; cosmetic.

---

## Blockers — must resolve before implementation

### B1 — Agent middleware interface can't do what `permissions` claims

**Where:** ADR-014 §2.

**What the docs say:**

```typescript
run?(ctx: MiddlewareContext, next: () => Promise<AgentResult>): Promise<AgentResult>;
```

- `ctx` is `readonly`.
- `next()` takes no arguments.

Canonical middleware table row:
> `permissions` | Resolve permission mode from stage + config, **apply to options** | Observer — reads stage, **enriches options**; does not mutate prompt

**The problem:** there is no mechanism in the interface by which the `permissions` middleware can actually "apply to options" or "enrich options". The options cannot be mutated (readonly ctx), cannot be transformed and forwarded (args-less next), and aren't re-read from any side channel.

**Three resolutions, each with consequences:**

| # | Resolution | Consequence |
|:---|:---|:---|
| A | `next` accepts an `options` parameter; middleware transforms and passes forward | Middleware **are** transformers; "observer-only" invariant (order-independence) is false |
| B | `permissions` isn't middleware — it's a pre-step before the chain that mutates `ctx.options` via a mutable field | Honest observer invariant; introduces a pre-chain layer |
| C | Middleware writes resolved permissions to a scope service; adapter consults it by other means | New service; weakens "middleware is the interception layer" story |

**Why this is a blocker:** the "observer-only" invariant in ADR-014 §2 is load-bearing — it's what justifies order-independence and frozen chain. If resolution (A) is picked, that invariant is false and Phase 2 ordering must be specified. If (B) or (C), the architecture diagram changes.

**Recommended direction:** lean toward (A) — `next(options?)` signature — because real middleware (audit, cost) will eventually need to observe the *final* options the adapter sees, not the caller's unresolved options. Declare canonical order at that point.

**Fix location:** ADR-014 §2 interface definition + invariant bullet.

---

### B2 — `OperationContext` should be a discriminated union

**Where:** ADR-015 §1; ADR-016 §2.2.

**What the docs say:**

```typescript
// ADR-015 §1
readonly packageDir: string;  // "required for package-scoped ops"

// ADR-016 §2.2 (amended)
readonly packageDir: string;  // REQUIRED — no fallback
readonly package: PackageView;
readonly packages?: readonly PackageView[];  // cross-package ops
```

**The problem:** three invalid states are representable:

1. `repo`-scoped op accesses `ctx.package` — compiles, wrong at runtime.
2. `cross-package` op accesses `ctx.package` (singular) — compiles, wrong.
3. `package`-scoped op accesses `ctx.packages` (plural) — compiles, wrong.

**Concrete example from the ADR:** `decompose` in ADR-015 §4.2 declares `scope: "repo"` but its `execute()` reads `ctx.packageDir`:

```typescript
async execute(ctx, input) {
  const prompt = await ctx.scope.promptComposer.compose(decomposeBuilder, input, {
    stage: "decompose",
    packageDir: ctx.packageDir,   // ← what packageDir does a repo-scoped op get?
  });
}
```

**Why this is a blocker:** the ADRs lean on type-level enforcement elsewhere ("lint-detectable", "CI errors", "structurally impossible"). Leaving `OperationContext` unenforced here contradicts the thesis.

**Recommended shape:**

```typescript
type OperationContext<C> =
  | { scope: "package";       packageDir: string; package: PackageView;         ... }
  | { scope: "cross-package"; packages: readonly PackageView[];                  ... }
  | { scope: "repo";          repoRoot: string;                                  ... };
```

With that shape, `decompose` cannot accidentally reach `ctx.package` — it has to decide explicitly.

**Fix location:** ADR-015 §1 `OperationContext` definition; ADR-016 §2.2 amendment.

---

### B3 — Session creation ownership changed silently from ADR-013

**Where:** ADR-015 §1.2 step 5; ADR-015 §2.

**What ADR-013 established:**
- `SingleSessionRunner` implements `ISessionRunner` → `sessionManager.runInSession()` × 1
- `ThreeSessionRunner` → `sessionManager.runInSession()` × 3
- `runInSession(sessionId, agentManager, request)` — caller supplies `sessionId`

**What ADR-015 says:**

> Step 5 of `scope.invoke()`: If `op.requires.session`, **create/reuse session** via `scope.sessionManager`; otherwise `ctx.session = undefined`.

**The problem:** two unresolved questions emerge:

1. **Where does `sessionId` come from inside `scope.invoke()`?** ADR-013's `runInSession` requires one. ADR-015 doesn't say whether `scope.invoke()` mints it, reads it from `InvokeOptions`, or something else.
2. **"Create or reuse" — which?** The word choice is ambiguous and the answer matters:
   - **Rectification loop** (ADR-015 §3.1) calls `scope.invoke(rectify, ...)` N times. N sessions or 1 reused?
   - **TDD** (`ThreeSessionRunner`) calls `scope.invoke()` three times with three different ops. Three sessions (ADR-013's intent) or something else?

**Why this is a blocker:** descriptor persistence, crash recovery, and resume semantics all depend on sessionId. Implementation cannot proceed without this decision.

**Secondary implication:** ADR-015 makes `ISessionRunner` thinner than ADR-013 — session creation moves from runner to `scope.invoke()`. That architectural shift is real but unstated.

**Recommended direction:**
- `scope.invoke()` mints sessionId as `${runId}-${op.name}-${counter}` (default) OR reads from a new `InvokeOptions.sessionRole?: string` override for disambiguation.
- Each `scope.invoke()` call with `requires.session: true` creates a new session by default. Reuse (e.g. debate continuation) is opt-in via `InvokeOptions.sessionId?`.
- `ISessionRunner` becomes a sequencer, not a session creator. ADR-015 §2 should say so explicitly.

**Fix location:** ADR-015 §1.2 (step 5), ADR-015 §2 (ISessionRunner role), ADR-015 §1 (`InvokeOptions` type).

---

## Gaps — mechanical, but need specifying

### G1 — `rectify` doesn't thread `previousAttempts` into `PromptBuildContext`

**Where:** ADR-015 §3.1; ADR-016 §1.5.

**Mismatch:**
- `RectifyInput.previousAttempts: RectifyAttempt[]` (ADR-015)
- `PromptBuildContext.previousAttempts?: readonly PromptSection[]` (ADR-016)

**Missing piece:** conversion from `RectifyAttempt` → `PromptSection`, and the call site in `rectify.execute()` that threads it.

**Fix:**

```typescript
// ADR-015 §3.1 — update sample
const prompt = await ctx.scope.promptComposer.compose(rectifierBuilder, input, {
  stage: ctx.stage,
  storyId: ctx.storyId,
  packageDir: ctx.packageDir,
  previousAttempts: input.previousAttempts.map(renderAttemptAsSection),
});
```

Name `renderAttemptAsSection` (or equivalent) explicitly; reference from ADR-016 §1.5.

---

### G2 — Permissions resolution — single owner

**Where:** ADR-014 §2 canonical middleware table; ADR-015 §1.2 step 4.

**Downstream of B1.** Once B1 picks a resolution, remove the duplicate description. If (A) is chosen: ADR-015 step 4 describes the permissions middleware's work; the step is kept but reframed as "threads `op.requires.permissions` into `MiddlewareContext.stage`; the `permissions` middleware resolves and transforms options." If (B) or (C): step 4 stays as the owner; middleware bullet is rewritten.

---

### G3 — `rectify` loop uses direct `scope.invoke()`, not `SingleSessionRunner`

**Where:** ADR-015 §2.1 (rule) vs §3.1 (implementation).

**Mismatch:**
- §2.1: "`SingleSessionRunner` (and its siblings) wraps operations with `requires.session: true`."
- §3.1: `runRectificationLoop` calls `scope.invoke(rectify, ...)` directly — no `SingleSessionRunner` wrapping.

**Either** the rule needs an exception for control-flow layers, **or** the loop should wrap rectify in `SingleSessionRunner`. Pick one.

**Recommended direction:** exception — control-flow layers invoke ops directly because they're outside `src/operations/`. Runners exist for stage/plugin callers who want a standardized "op + session topology" bundle.

---

### G4 — Two paths to a wrapped agent

**Where:** ADR-014 §Architecture.

**What exists:**
- `scope.agentManager.runAs(name, ...)` — middleware-wrapped (per the Architecture note)
- `scope.getAgent(name).run(prompt, ...)` — middleware-wrapped (per §1)

**Missing:** rationale for two surfaces. Is `scope.agentManager.runAs` a legacy/compat shim that disappears after ADR-015 migrations? Is `getAgent()` for new code only? Is one preferred over the other?

**Recommended:** add a one-paragraph "migration path" note in ADR-014 saying `scope.agentManager.runAs` is the bridge for unmigrated stages; new code and operations use `scope.getAgent()` or `scope.invoke()`.

---

### G5 — `budget-truncate` owner-rule exception not explicit

**Where:** ADR-016 §1.3.

**Ownership rule** (§1.3): each `SectionId` has exactly one owner; duplicate emission → `PROMPT_SECTION_CONFLICT`.

**Canonical middleware row:** `budget-truncate` "may modify any section's content" (no id).

**Missing:** the content-modification exception isn't named in the ownership rule itself. Add a bullet: "Finalize-phase middleware may modify section content without changing ownership; at most one finalize-phase content modifier is permitted per chain."

---

### G6 — `PromptBuildContext.previousAttempts` visible to builders

**Where:** ADR-016 §1.2, §1.5.

**Issue:** `PromptBuildContext` exposes `previousAttempts` to **both** builders and middleware. Builders are expected not to render it (middleware owns `previous-attempts` section). But nothing type-prevents a builder from emitting a `previous-attempts` section, which would `PROMPT_SECTION_CONFLICT` at runtime.

**Options:**
1. Split: `BuilderBuildContext` vs `MiddlewareBuildContext`, builders get the narrower view.
2. Keep single type; document that `previousAttempts` is middleware-only input. Accept runtime-only enforcement.

**Recommended:** option (2) for simplicity — the runtime error is actionable and split types add a category without a concrete cost justification today.

---

### G7 — Routing file touched twice across ADR-014 P2 and ADR-015 P2

**Where:** ADR-014 Phase 2 step 1; ADR-015 Phase 2 step 1.

**What happens:**
- ADR-014 P2: `router.ts` converts to `scope.getAgent(defaultAgent).complete(...)`.
- ADR-015 P2: `router.ts` converts again to `scope.invoke(classifyRoute, input, opts)`.

**Options:**
1. Skip router in ADR-014 P2; let ADR-015 P2 do the whole migration in one step. Cost: orphan `createAgentManager` in routing survives until ADR-015 lands.
2. Keep both migrations; accept double-touch. Benefit: #523 closes fully at end of ADR-014 regardless of ADR-015 timing.

**Recommended:** option (2). #523 is high-value and ADR-015 could slip; better to close it in ADR-014 and accept the second touch.

---

### G8 — `plan` operation's `config.planner` may not exist in current schema

**Where:** ADR-015 §4.1.

```typescript
config: (c) => ({ debate: c.debate, planner: c.planner }),
```

Needs actual schema inspection. If `planner` is a placeholder, rename to an actual config key (e.g. `c.plan` if that exists) or note it as a future field to add.

---

## Minor — wording / framing

### M1 — Observer vs transformer framing

Downstream of B1. After B1 is resolved, add a one-sentence callout in ADR-016 §1.3 distinguishing prompt middleware (functional transformers, by design) from agent middleware (whatever B1 settles on).

### M2 — `IAgentManager` interface `runAs`/`completeAs` naming vs ADR-013

ADR-013's listed interface shows `run(request)` / `complete(prompt, options)`. ADR-014 and ADR-015 reference `runAs(name, ...)` / `completeAs(name, prompt, ...)`. Likely ADR-013's listing was abbreviated and the real API has the `*As` variants. Verify against `src/agents/manager.ts`; if mismatch is real, update ADR-013's listing.

### M3 — `RunOptions.mode`

ADR-015 §4.1 uses `{ mode: "plan" }` on `agent.run()`. Either `RunOptions.mode` pre-exists (confirm in `src/agents/types.ts`) or needs one-line mention that it's added. Pre-exists is likely; just verify.

---

## What's right and should survive

| Thing | Why it matters |
|:---|:---|
| Split dependency chain 014 → 015 → 016 | Each lands independently; Phase 1 of each is shippable without the next ADR |
| Forward-reference discipline | Interim notes (e.g. rectify uses legacy builder until ADR-016 Phase 1) prevent blocked-on-future-ADR churn |
| `src/control/` as a first-class directory with lint rule | Operation-vs-loop boundary becomes structural, not aspirational |
| `CostErrorEvent` + `PromptAuditErrorEntry` as separate types | Avoids "model is required but sometimes absent" type problem |
| Functional transformers (readonly in/out) for prompt middleware | Matches project immutability style; deterministic composition |
| Rejected `child()` scope | Per-call `signal`/`logger`/`agentName` overrides cover debate + rectification without lifecycle questions |
| `makeTestScope()` in Phase 1 | Tests have a landing pad from day one |
| Section ownership model | Duplicate emission is an actionable runtime error, not a silent overwrite |
| Rejected Anthropic `cache_control` as motivation | Honest acknowledgement that cache hit rate is low in practice; sections justified by progressive composition instead |
| `ConfigSelector` keyof-array sugar | 95% case stops being a lambda |

---

## Revised recommendation

**Don't start Phase 1 of ADR-014 until B1 is resolved.** Without a decision on middleware interface semantics, Phase 2 will rebuild the chain once implementation reveals the gap.

**Don't start Phase 1 of ADR-015 until B2 and B3 are resolved.** The `OperationContext` shape and session-creation ownership are both on the critical path for operation migrations.

**Sequence:**

1. Resolve B1, B2, B3 in the ADR text. One-PR-per-blocker or batch — either works.
2. Apply G1–G8 as a single cleanup PR on the ADRs.
3. M1–M3 fold into step 2.
4. Start Phase 1 of ADR-014.

**Original three findings:** still valid. Now understood as downstream of the three blockers rather than independent issues. Don't fix G1–G3 in isolation — fix after blocker resolution so the framing is right.

---

## Discussion order for walking through

When walking these one-by-one, I'd suggest the following order (not doc order — decision-value order):

1. **B1** — makes or breaks the middleware model. Highest leverage.
2. **B3** — session lifecycle decision that ripples through rectification, TDD, debate, resume.
3. **B2** — type-safety fix; small decision, big correctness win.
4. **G1–G8** — mechanical once blockers settle.
5. **M1–M3** — cosmetic.
