# Issue #853 — CompleteOptions Primitivization: Implementation Plan

**Status:** Ready for handover (Sonnet implementation)
**Date:** 2026-05-02
**Parent issue:** [#853](https://github.com/nathapp-io/nax/issues/853)
**Sibling follow-ups:** [#855](https://github.com/nathapp-io/nax/issues/855) (debate concurrency), [#856](https://github.com/nathapp-io/nax/issues/856) (unified retry strategy)

## Final-check corrections (read first)

This plan was audited against current code on 2026-05-02. Corrections applied:

- **A4 removed (originally "CLI adapter complete()"):** there is no CLI adapter directory. `src/agents/` contains only `acp/`, `cost/`, `shared/`, `manager.ts`, `factory.ts`, `registry.ts`, `types.ts`, `utils.ts`, `interaction-handler.ts`. ACP is the sole adapter. Sections renumbered: original A5 → A4 (call-site updates), A6 → A5 (decompose-prompt), A7 → A6 (selector deletion), A8 → A7 (CI gate), A9 → A8 (tests). All `src/agents/{acp,claude}/` references retargeted to `src/agents/acp/`.
- **A5 (decompose-prompt) expanded:** `decompose-prompt.ts` has *two* entry points. The async path (`buildDecomposePromptAsync`, used by CLI `plan-decompose.ts`) also reads `options.config?.precheck...` — must be migrated alongside the sync path. Caller must extract `maxAcCount` at the CLI boundary.
- **B2 corrected:** the `OneShotPromptBuilder` API is `OneShotPromptBuilder.for("auto-approver")` — there is no `buildAutoApprove` method. The op's `build()` lifts the existing `buildPrompt` body verbatim from `auto.ts:203-231`.
- **B2 dep-injection:** `_autoPluginDeps` only injects `agentManager` today. Migration must add `runtime: NaxRuntime | null` and update all wiring sites that set `agentManager`.
- **Audit grep tightened:** original pattern would false-match `configFoo`/`configure`. Corrected pattern uses `\.config(\.|\?|,|\)|$)` + an additional check for the dynamic config import.
- **B4 link syntax fixed:** removed stray backticks inside the markdown link target.

No other line numbers, file paths, or code references in this plan changed during the audit — they were all spot-checked and confirmed accurate.

## Goal

Make agent adapters protocol primitives — drop `CompleteOptions.config`, push model + retry resolution to the manager boundary, migrate live consumers to `callOp`, delete dead parallel code paths.

## Discovery

Of the 7 non-`callOp` callers identified in #853, only **3 are live production paths**:

| # | Site | Status | Action |
|:---|:---|:---|:---|
| 1 | `src/routing/strategies/llm.ts` (single + batch) | LIVE | Migrate to `callOp` (op already exists, not wired) |
| 2 | `src/interaction/plugins/auto.ts` | LIVE | Migrate to `callOp` (new `autoApproveOp`) |
| 3 | `src/verification/rectification-loop.ts` | LIVE — debate fan-out | **Defer to [#855](https://github.com/nathapp-io/nax/issues/855)**, keep `completeAs` |
| 4 | `src/debate/session-helpers.ts` | LIVE — debate plugin contract | **Defer to [#855](https://github.com/nathapp-io/nax/issues/855)**, keep `completeAs` |
| 5 | `src/debate/resolvers.ts` | LIVE — debate resolver impls | **Defer to [#855](https://github.com/nathapp-io/nax/issues/855)**, keep `completeAs` |
| 6 | `src/acceptance/generator.ts` (`generateAcceptanceTests`) | DEAD (only test refs) | Delete |
| 7 | `src/acceptance/fix-generator.ts` (`generateFixStories`) | DEAD (only test refs) | Delete |

## Decisions made (for handover clarity)

1. **Two PRs, not one.** PR-1 is mechanical with zero behavior change; PR-2 has behavior changes (call paths shift, dead code deleted). Splitting enables independent revertability, narrower review surface, and CI safety (PR-1's adapter-no-config-import gate must land before PR-2 can re-introduce config drilling).
2. **BUG-033 retry stays as a local helper in PR-2** (`classifyWithRetry` in `router.ts`). A unified retry strategy is the right long-term answer — see [#856](https://github.com/nathapp-io/nax/issues/856) — but designing it from one site is the same trap as designing `callOpFanOut` from one debate site (#855). The local helper is intentionally easy to delete when #856 lands.
3. **Debate stays on `completeAs`** for now ([#855](https://github.com/nathapp-io/nax/issues/855)). It needs a fan-out primitive (`callOpFanOut`) and a refactored resolver plugin contract before it can migrate. Single-consumer YAGNI applies — wait for a second fan-out use case before designing the helper.

## Step 0 — Read first, in order

1. `docs/adr/ADR-019-adapter-primitives-and-session-ownership.md` §1 (4 primitives) and §3 (permissions resolve at the resource opener)
2. `docs/adr/ADR-020-dispatch-boundary-ssot.md` §D3 (no adapter bypass) and §D4 (verify/recover)
3. `.claude/rules/adapter-wiring.md` — full file (Layer table, Rules 1–5)
4. `src/agents/types.ts` lines 209–271 (`CompleteOptions` — current shape) and 332–360 (`OpenSessionOpts` — the target shape to mirror)
5. `src/operations/call.ts` lines 66–175 (`callOp` complete-kind branch is the model-resolution template)

---

## PR-1: Phase 2a — Primitivize `CompleteOptions`

**Scope:** ~150 LOC, mechanical, zero behavior change. Type-system refactor only.

### A1. Extend `CompleteOptions` ([src/agents/types.ts:209](src/agents/types.ts#L209))

```ts
export interface CompleteOptions {
  // PROMOTE to required (was optional with `?? "approve-reads"` fallback in adapter):
  resolvedPermissions: ResolvedPermissions;
  workdir: string;            // already required de facto; tighten

  // NEW — replaces { model: string, modelTier, config.models }:
  modelDef: ModelDef;
  // NEW — replaces config.agent.acp.promptRetries:
  promptRetries?: number;

  // KEEP unchanged:
  maxTokens?, jsonMode?, timeoutMs?,
  sessionName?, featureName?, storyId?, sessionRole?, pipelineStage?,
  signal?, onPidSpawned?, onPidExited?,

  // REMOVE: config, model (string), modelTier
}
```

**Important nuance:** `resolvedPermissions` is *required on the adapter API* (A1) but *populated by the manager* (A2). Callers of `agentManager.completeAs()` still pass `CompleteOptions` without it; the manager fills it in. Document this with `@internal` markers on the field, mirroring the existing pattern for `onPidSpawned`/`onPidExited` ([types.ts:262](src/agents/types.ts#L262)).

### A2. `AgentManager.completeAs()` ([src/agents/manager.ts:581](src/agents/manager.ts#L581))

Two changes — move both config reads to this single boundary:

```ts
async completeAs(agentName: string, prompt: string, options: CompleteOptions) {
  const stage = options.pipelineStage ?? "complete";
  // BEFORE: resolvePermissions(options.config ?? this._config, stage)
  const resolvedPermissions = resolvePermissions(this._config, stage);
  // NEW:
  const promptRetries = this._config.agent?.acp?.promptRetries;
  const augmented: CompleteOptions = { ...options, resolvedPermissions, promptRetries };
  // …rest unchanged
}
```

Delete the `@design Per plan §3.3 Note` comment at line 583 — the workaround it describes is gone.

### A3. ACP adapter `complete()` ([src/agents/acp/adapter.ts:147-189](src/agents/acp/adapter.ts#L147))

Remove the entire inline `resolveModel` closure (lines 154–172). Replace with primitives:

```ts
async complete(prompt: string, _options: CompleteOptions): Promise<CompleteResult> {
  const timeoutMs = _options.timeoutMs ?? 120_000;
  const permissionMode = _options.resolvedPermissions.mode;     // no fallback
  const { workdir, modelDef, promptRetries } = _options;

  const tryOneAgent = async (agentName: string) => {
    const cmdStr = `acpx --model ${modelDef.model} ${agentName}`;
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    const client = _acpAdapterDeps.createClient(
      cmdStr, workdir, timeoutSeconds,
      _options.onPidSpawned, promptRetries, _options.onPidExited,
    );
    // …rest unchanged
  };
  // …
}
```

Delete the `await import("../../config/schema")` dynamic import — adapter no longer touches `src/config/`.

### A4. Update 5 call sites to pass `modelDef`

Each site already resolves a model — wire the resolved `modelDef` through instead of `model: string` + `config: NaxConfig`:

| File | Line | Today | Target |
|:---|:---|:---|:---|
| [src/operations/call.ts](src/operations/call.ts#L85) | 85 | `{ model: resolved.modelDef.model, config, … }` | `{ modelDef: resolved.modelDef, … }` |
| [src/routing/strategies/llm.ts](src/routing/strategies/llm.ts#L158) | 158 | `{ model: resolvedModel.modelDef.model, config }` | `{ modelDef: resolvedModel.modelDef, workdir }` |
| [src/interaction/plugins/auto.ts](src/interaction/plugins/auto.ts#L186) | 186 | `{ model: resolvedModel, config: naxConfig, … }` | `{ modelDef: …, … }` |
| [src/debate/session-helpers.ts](src/debate/session-helpers.ts#L139) | 139 | passes `options: CompleteOptions` through | callers must already construct primitives |
| [src/verification/rectification-loop.ts](src/verification/rectification-loop.ts#L116) | 116 | `{ model: debater.model, config, … }` | resolve `modelDef` per debater via `resolveConfiguredModel` |

For sites that don't have a `workdir` today, derive from context (story workdir, project root). `resolvedPermissions` is filled in by the manager — callers don't construct it.

### A5. Decompose-prompt — drop config fallback ([src/agents/shared/decompose-prompt.ts:168](src/agents/shared/decompose-prompt.ts#L168))

`decompose-prompt.ts` exports **two** entry points:

| Function | Used by | Has `options.config` fallback? |
|:---|:---|:---|
| `buildDecomposePromptSync` ([line 117](src/agents/shared/decompose-prompt.ts#L117)) | `decomposeOp.build()` ([decompose.ts:32](src/operations/decompose.ts#L32)) | No — already takes `maxAcCount` as input ✓ |
| `buildDecomposePromptAsync` ([line 129](src/agents/shared/decompose-prompt.ts#L129)) | `src/cli/plan-decompose.ts:90` | **Yes** — reads `options.config?.precheck?.storySizeGate?.maxAcCount` |

Both must be updated:

1. Add `maxAcCount?: number | null` to `DecomposeOptions` ([src/agents/shared/types-extended.ts:87](src/agents/shared/types-extended.ts#L87))
2. Update `buildPlanModePrompt` async path ([line 168](src/agents/shared/decompose-prompt.ts#L168)) to use `options.maxAcCount ?? null` (delete the `options.config?.precheck...` chain)
3. Update CLI caller ([src/cli/plan-decompose.ts:90-99](src/cli/plan-decompose.ts#L90)) to extract `maxAcCount` from config at the CLI boundary and pass it explicitly: `maxAcCount: config?.precheck?.storySizeGate?.maxAcCount`
4. Once both paths take `maxAcCount` as input, the `config` field on `DecomposeOptions` may also become removable (audit other reads first)

### A6. Delete the workaround selector ([src/config/selectors.ts:112-115](src/config/selectors.ts#L112), 142)

Delete `completeConfigSelector` and `CompleteConfig` (the TODO comment explicitly says "delete when Phase 2 lands"). Update the import in `src/agents/types.ts:9`.

### A7. Add CI gate

Extend `scripts/check-no-adapter-wrap.sh` (or add `scripts/check-adapter-no-config-import.sh`) to fail if any file under `src/agents/acp/` imports from `../config` or `../../config`. Mirrors the existing adapter-boundary discipline.

### A8. Tests to update

- `test/unit/agents/manager-complete-as.test.ts` (or equivalent) — assert `promptRetries` flows from `this._config` not `options.config`
- `test/unit/agents/acp/adapter-complete.test.ts` — drop `config` from fixtures; pass `modelDef` and `resolvedPermissions`
- Any test using `CompleteOptions` literal — search & replace pattern
- Use `makeMockAgentManager` / `makeAgentAdapter` from `test/helpers/` per `.claude/rules/test-helpers.md`

### PR-1 commit sequence

1. `refactor(agents): require resolvedPermissions on CompleteOptions, drop adapter fallback`
2. `refactor(agents): add modelDef + promptRetries primitives to CompleteOptions`
3. `refactor(agents): pre-resolve promptRetries at AgentManager.completeAs boundary`
4. `refactor(agents): ACP adapter complete() consumes primitives — drop config drilling`
5. `refactor(callers): pass modelDef instead of model+config in 5 callsites`
6. `refactor(decompose): require maxAcCount as input — drop options.config fallback`
7. `chore(types): delete CompleteOptions.config, completeConfigSelector workaround`
8. `chore(ci): add adapter-no-config-import gate`

### PR-1 verification

```bash
bun run lint
bun run typecheck
timeout 60 bun test test/unit/agents/ --timeout=10000
timeout 60 bun test test/unit/operations/ --timeout=10000
timeout 60 bun test test/integration/cli/adapter-boundary.test.ts --timeout=10000
bun run test  # final
```

**Success criterion:** Zero references to `_options.config` or `options.config` (the field, not symbols starting with `config`) inside `src/agents/acp/`.

```bash
# Match `.config` followed by `.`, `?`, `,`, `)`, or end-of-line — excludes `configFoo`/`configure`/etc.
rg "options\??\.config(\.|\?|,|\)|$)" src/agents/acp/
# Expected: no matches

# Also confirm the dynamic config import is gone
rg "import.*config/(schema|defaults|loader)" src/agents/acp/
# Expected: no matches
```

---

## PR-2: Phase 2b — Migrate live consumers, delete dead code

**Scope:** ~400 LOC, behavior changes (call paths shift, dead code deleted). Depends on PR-1.

### B1. Migrate router (single + batch) to ops

`classifyRouteOp` already exists ([src/operations/classify-route.ts](src/operations/classify-route.ts)) but is **not wired in**. Three pieces:

**B1a.** Create `classifyRouteBatchOp` — same pattern as `classifyRouteOp`, takes `UserStory[]`, returns `Map<string, RoutingDecision>`. Use the existing `BATCH_ROUTING_SCHEMA` and `parseBatchResponse` from [llm.ts](src/routing/strategies/llm.ts).

**B1b.** Add local retry helper `classifyWithRetry` in [src/routing/router.ts](src/routing/router.ts) — preserves BUG-033 behavior:

```ts
// src/routing/router.ts — narrow, scoped, ~10 lines
async function classifyWithRetry<T>(
  ctx: CallContext, op: Operation<…>, input: …,
  opts: { retries: number; retryDelayMs: number },
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= opts.retries; i++) {
    try { return await callOp(ctx, op, input); }
    catch (err) { lastErr = err as Error; if (i < opts.retries) await Bun.sleep(opts.retryDelayMs); }
  }
  throw lastErr ?? new Error("classifyWithRetry: unknown failure");
}
```

This is intentionally local and intentionally easy to delete. **[#856](https://github.com/nathapp-io/nax/issues/856) replaces this with a unified `RetryStrategy` interface** — when that lands, this helper becomes a 5-line deletion.

**B1c.** Rewrite [src/routing/router.ts:192-193](src/routing/router.ts#L192) and [307-308](src/routing/router.ts#L307) to call the ops via `classifyWithRetry`. Router currently takes `IAgentManager` directly — will need to thread `runtime` or accept a `CallContext` arg.

**B1d.** Delete `callLlm`, `callLlmOnce`, `routeBatch`, `classifyWithLlm` from [strategies/llm.ts](src/routing/strategies/llm.ts). Keep prompt builders + parser exports (the ops import them).

### B2. Migrate auto interactor to op

Create `autoApproveOp` ([src/operations/auto-approve.ts](src/operations/auto-approve.ts)):
- `kind: "complete"`, `jsonMode: true`, `stage: "run"`
- `config: interactionConfigSelector` (already exists)
- `build`: lift the existing `buildPrompt` body from [auto.ts:203-231](src/interaction/plugins/auto.ts#L203) — uses `OneShotPromptBuilder.for("auto-approver")` (the API today; **there is no `buildAutoApprove` method**)
- `parse`: lift `parseResponse` logic from [auto.ts:233](src/interaction/plugins/auto.ts#L233), wrapped via `parseLLMJson<DecisionResponse>`

**Dep-injection change:** [auto.ts:78-80](src/interaction/plugins/auto.ts#L78) currently injects only `agentManager` and (deprecated) `callLlm`. Migration requires injecting `runtime: NaxRuntime | null` so the plugin can construct a `CallContext` for `callOp`. Update:

```ts
// src/interaction/plugins/auto.ts
export const _autoPluginDeps = {
  agentManager: null as IAgentManager | null,   // KEEP for back-compat
  runtime: null as NaxRuntime | null,            // NEW
  callLlm: null as ((req: InteractionRequest) => Promise<DecisionResponse>) | null,  // KEEP — deprecated escape hatch
};
```

Rewrite [auto.ts:164-198](src/interaction/plugins/auto.ts#L164) (`callLlm` private method) to call `callOp(ctx, autoApproveOp, input)` when `runtime` is injected. Fall back to the existing `agentManager.complete` path when only `agentManager` is injected (back-compat for tests that haven't migrated to `makeTestRuntime`). The deprecated `_autoPluginDeps.callLlm` injection path stays as a documented escape hatch.

**Update wiring at all `_autoPluginDeps.agentManager = …` sites** to also set `runtime` — likely 1–3 sites in `src/runtime/` or `src/interaction/registry.ts`.

### B3. Delete dead acceptance code paths

Both production functions are unreferenced outside tests; their op replacements are already wired:

- Delete `generateAcceptanceTests` from [src/acceptance/generator.ts:155](src/acceptance/generator.ts#L155) — replaced by `acceptanceGenerateOp` (used at [acceptance-setup.ts:328](src/pipeline/stages/acceptance-setup.ts#L328)). Keep `extractTestCode`, `buildAcceptanceRunCommand`, `generateSkeletonTests` (still imported by stages).
- Delete `generateFixStories` from [src/acceptance/fix-generator.ts:212](src/acceptance/fix-generator.ts#L212). Verify with `grep -r "FixStory" src/ --include="*.ts"` after deletion. If `FixStory` type is needed elsewhere, keep the type, delete the function.
- Delete `test/unit/acceptance/generator-adapter.test.ts` (entire file — tests the deleted functions).
- Update `src/acceptance/index.ts` exports accordingly.

### B4. Sharpen `adapter-wiring.md` Rule 3

[.claude/rules/adapter-wiring.md](.claude/rules/adapter-wiring.md) Rule 3 currently lists allowed callers of adapter primitives. Add a new paragraph above the Layer table:

> **Layer 3 (Manager API) is the intentional escape hatch for parallel fan-out and plugin contracts** — not a generic "behavior outside an Operation." The only sanctioned `agentManager.completeAs` consumers are: (a) debate fan-out and resolvers (see [#855](https://github.com/nathapp-io/nax/issues/855) for migration path), (b) the AgentManager's own internal dispatch. New code goes through `callOp`.

### PR-2 commit sequence

9. `refactor(routing): wire classifyRouteOp + new batch op into router; delete callLlm`
10. `refactor(interaction): migrate AutoInteractionPlugin to autoApproveOp`
11. `chore(acceptance): delete dead generateAcceptanceTests + generateFixStories`
12. `docs(rules): sharpen adapter-wiring.md Rule 3 — completeAs is intentional escape hatch`

### PR-2 verification

```bash
bun run lint
bun run typecheck
timeout 60 bun test test/unit/routing/ --timeout=10000
timeout 60 bun test test/unit/interaction/ --timeout=10000
timeout 60 bun test test/unit/acceptance/ --timeout=10000
bun run test  # final
```

**Success criteria:**

- BUG-033 regression test passes ([test/unit/routing/routing-stability.test.ts:103-160](test/unit/routing/routing-stability.test.ts#L103))
- Zero references to `agentManager.complete` or `agentManager.completeAs` outside the sanctioned set: `src/agents/manager.ts`, `src/operations/call.ts`, `src/debate/`, `src/verification/rectification-loop.ts`:

```bash
rg "agentManager\.(complete|completeAs)\b" src/ --type ts \
  | grep -v "src/debate/" \
  | grep -v "src/verification/rectification-loop.ts" \
  | grep -v "src/agents/manager.ts" \
  | grep -v "src/operations/call.ts"
# Expected: no matches
```

- `acceptance/index.ts` exports updated; no broken imports:

```bash
bun run typecheck  # would catch any orphan import
```

---

## Out of scope

- The 3 debate sites (rectification-loop, session-helpers, resolvers) — covered by [#855](https://github.com/nathapp-io/nax/issues/855)
- `agentManager.complete` direct callers — exactly one (`AgentManager.complete` at line 478, delegates to `completeAs`). Public method, leave it.
- `runWithFallback`/`completeWithFallback` retry/backoff logic — already correctly placed at the manager layer (manager.ts:265–286). Don't move.
- Any changes to `OpenSessionOpts` — already correct shape; A1 is making `CompleteOptions` match it.
- Unified retry strategy interface — covered by [#856](https://github.com/nathapp-io/nax/issues/856). PR-2's `classifyWithRetry` helper is intentionally local and replaceable.

---

## Open questions for implementer (ask before starting)

None remaining — all three earlier decisions are baked in:

1. ✅ BUG-033 retry: keep as local `classifyWithRetry` helper in PR-2; full unification deferred to [#856](https://github.com/nathapp-io/nax/issues/856).
2. ✅ Two PRs, not one. PR-1 (steps 1–8) and PR-2 (steps 9–12) ship independently.
3. ✅ Router op signature: `classifyRouteBatchOp` takes `UserStory[]` and returns `Map<string, RoutingDecision>` (one prompt = one cost = one cache-fill).

If anything in the plan is unclear during implementation, surface it before guessing.
