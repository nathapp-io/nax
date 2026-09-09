# Fallback Swap Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nax's agent-fallback ladder actually change the model it dispatches to, and make a swap survive past the operation that made it.

**Architecture:** Four independent defects on one path, fixed in dependency order. #1965 makes a same-agent hop dispatch its own model instead of the caller's pin. #1966 gives a literal-id fallback target its own cooldown identity so it stops colliding with the bare-agent key. #1967 makes the rectification ops inherit `story.routing` like the implementer does. #1964 records the target a story actually swapped to on a run-scoped store and reuses it for that story's later operations.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** GitHub issues [#1964](https://github.com/nathapp-io/nax/issues/1964), [#1965](https://github.com/nathapp-io/nax/issues/1965), [#1966](https://github.com/nathapp-io/nax/issues/1966), [#1967](https://github.com/nathapp-io/nax/issues/1967). Diagnosed from run `run-2026-09-09T13-58-46-234Z` (feature `prompt-affordance-ssot`, nax `0.82.0-canary.7`).

## Global Constraints

- **Base ref is `origin/main` at `21dacecfa`** (v0.82.0-canary.7). It contains PR #1962, which every task here builds on. Do NOT branch from `feat/prompt-affordance-ssot` — that branch is at canary.5 and predates #1962.
- **Bun-native APIs only.** No Node.js equivalents.
- **TypeScript strict — no `any`** without explicit justification.
- **`src/agents/manager.ts` is at 595 lines against a hard 600-line limit** (`scripts/check-file-sizes.ts`, `SRC_LIMIT = 600`). It is NOT in `scripts/baselines/file-sizes-baseline.json`, so there is no grandfathered exemption — 5 lines of headroom, total. Task 2 must extract rather than grow it.
- **`CallContext` must not gain result-side fields.** `.nax/rules/adapter-wiring.md` Rule 6: "never extend `CallContext` as a back-channel". Run-scoped per-story results travel on `NaxRuntime` maps — `agentFallbacks` and `lastAdapterFailure` are the existing precedents, and Task 4 follows them.
- **`resolvePermissions(config, stage)` is the only source of permission decisions.** No task here touches permissions; do not introduce a hardcoded mode.
- **`resolveModel(entry)` infers the provider from the model NAME**, not from a `provider/model` split (`src/config/schema-types.ts:243`): anything not starting `claude`/`gpt`/`o1`/`o3`/`gemini` gets `provider: "unknown"`. So a native id resolves to `unknown/openrouter/z-ai/glm-5.3-flash[high]`. That is still a **stable, unique identity**, which is all Task 2 needs — and because `resolveModelForAgent` resolves a tier's map entry through the *same* `resolveModel`, a tier and a literal pin naming the byte-identical string produce the identical identity and collide correctly. They only collide if the strings match exactly, **effort suffix included** (`[high]`). Do not "normalise" the suffix away.
- **`op.model?.(input, ctx)` does not compile** — `OperationModel` is a union whose literal member is not callable (TS2349). Tests must call the resolver through `opModelResolver(op)` from `test/helpers/op-model.ts`, which exists for exactly this.
- **Conventional commits**, one logical concern per commit. No attribution footer (disabled globally).
- **Every log call carries `storyId`** (project convention).
- Run `bun run lint`, `bun run typecheck`, and the targeted test file after each task. Run `bun run test:coverage` once at the end — it is a separate CI step with a per-file floor and a passing suite can still fail it.

---

### Task 0: Isolated workspace and clean baseline

**Files:**
- Create: `docs/superpowers/plans/2026-09-09-fallback-swap-correctness.md` (this plan, copied into the worktree)

- [ ] **Step 1: Create the worktree**

Use the `EnterWorktree` tool with `name: "fallback-swap-correctness"`. Its default `worktree.baseRef` is `fresh`, which branches from `origin/<default-branch>` — that is `origin/main`, which is the base this plan requires.

Do NOT use `git worktree add` directly: the native tool owns placement, branch creation, and exit-time cleanup, and bypassing it leaves state the harness cannot see.

- [ ] **Step 2: Verify the base contains #1962**

```bash
git merge-base --is-ancestor 8c4c19319 HEAD && echo "OK: base has #1962" || echo "WRONG BASE"
```

Expected: `OK: base has #1962`. If it prints `WRONG BASE`, stop — every task below assumes the #1962 identity plumbing exists.

- [ ] **Step 3: Install dependencies**

```bash
bun install
```

- [ ] **Step 4: Record the clean baseline**

```bash
bun run lint && bun run typecheck && bun run test 2>&1 | tail -20
```

Expected: all three green. Record the test count. If anything fails on a clean `origin/main`, stop and report — a dirty baseline makes every later failure ambiguous.

- [ ] **Step 5: Copy this plan into the worktree and commit**

```bash
mkdir -p docs/superpowers/plans
cp /private/tmp/claude-501/-Users-williamkhoo-workspace-subrina-coder-projects-nax-repos-nax/6fdf56f2-0ab4-4705-9c16-115d06114bbc/scratchpad/2026-09-09-fallback-swap-correctness.md docs/superpowers/plans/
git add docs/superpowers/plans/2026-09-09-fallback-swap-correctness.md
git commit -m "docs: plan for fallback swap correctness (#1964, #1965, #1966, #1967)"
```

---

### Task 1: A swap hop dispatches its own model, not the caller's pin (#1965)

The foundation. While a same-agent hop re-dispatches the caller's pinned model, Task 4's stickiness would faithfully stick to a target that never changed, and Task 2's identity work would be unobservable end to end.

**Files:**
- Modify: `src/operations/build-hop-callback.ts` (the `pinnedModelDef` computation, ~line 349, and a new helper beside `hopTier`/`hopModelId` at ~line 118-141)
- Test: `test/unit/operations/build-hop-callback-model-pin.test.ts` (exists — add to it)

**Interfaces:**
- Consumes: `HopKind` from `src/agents/manager-types.ts`. Every variant already carries optional `tier?: string` and `model?: string`:
  ```ts
  export type HopKind =
    | { kind: "primary"; tier?: string; model?: string }
    | { kind: "stale-retry"; attempt: number; tier?: string; model?: string }
    | { kind: "timeout-retry"; attempt: number; tier?: string; model?: string }
    | { kind: "swap"; failure: AdapterFailure; tier?: string; model?: string };
  ```
- Produces: `hopChoseItsOwnModel(hopKind: HopKind): boolean`, exported for the test.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/operations/build-hop-callback-model-pin.test.ts`. That file already has everything needed: a `harness(pinnedModelAgent?)` factory returning `{ ctx, options, opened }`, where `opened` collects `opts.modelDef.model` from the mocked `openSession`. Use it — do NOT write a new harness or an inline mock (`scripts/check-inline-test-mocks.ts` enforces this, and `.nax/rules/test-helpers.md` catalogues the shared helpers).

First extend the file's existing `MODELS` const with a two-tier native agent. Adding a key leaves the existing `claude`/`codex` expectations untouched:

```ts
const MODELS = {
  claude: { balanced: { provider: "anthropic", model: "haiku" } },
  codex: { balanced: { provider: "openai", model: "gpt-5.6-luna" } },
  native: {
    balanced: { provider: "minimax", model: "MiniMax-M3" },
    powerful: { provider: "opencode-go", model: "deepseek-v4-flash" },
  },
};
```

Then add the failure fixture and the three tests. `AdapterFailure` is `{ category, outcome, retriable, message }`:

```ts
const RATE_LIMIT_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "rate limited",
};

describe("buildHopCallback — a swap hop outranks the caller's pin (nax#1965)", () => {
  test("a same-agent swap dispatches the hop's tier, not the pinned model", async () => {
    const { ctx, options, opened } = harness("native");

    await buildHopCallback(ctx, SESSION_ID, options)(
      "native",
      makeContextBundle(),
      { kind: "swap", failure: RATE_LIMIT_FAILURE, tier: "powerful" },
      options,
    );

    expect(opened[0]).toBe("deepseek-v4-flash");
  });

  test("a same-agent swap dispatches a literal model pin", async () => {
    const { ctx, options, opened } = harness("native");

    await buildHopCallback(ctx, SESSION_ID, options)(
      "native",
      makeContextBundle(),
      { kind: "swap", failure: RATE_LIMIT_FAILURE, model: "openrouter/z-ai/glm-5.3-flash" },
      options,
    );

    expect(opened[0]).toBe("openrouter/z-ai/glm-5.3-flash");
  });

  test("a primary hop that named no model of its own still honours the pin", async () => {
    const { ctx, options, opened } = harness("native");

    await buildHopCallback(ctx, SESSION_ID, options)("native", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("haiku");
  });
});
```

The third test looks odd — `native` dispatching `haiku` — but that is the harness's fixture (`options.modelDef` is the anthropic pin) and it is exactly the behaviour that must not regress: a hop with no tier and no model of its own keeps the caller's pin.

Add `AdapterFailure` to the file's type imports (`import type { AdapterFailure } from "@/context/engine";`).

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/unit/operations/build-hop-callback-model-pin.test.ts --timeout=30000
```

Expected: the first two tests FAIL, both reporting `minimax/MiniMax-M3` where a different model was expected. The third PASSES already (it pins the behaviour that must not regress).

If the first two pass, stop — the defect is not reproduced and the fix below would be unverified.

- [ ] **Step 3: Add the helper**

In `src/operations/build-hop-callback.ts`, beside the existing `hopTier` and `hopModelId` exports:

```ts
/**
 * Did this hop select a model of its own?
 *
 * The caller's pinned `modelDef` exists to stop a pin leaking ACROSS agents
 * (nax#1722 — `acpx --model haiku ... codex` is rejected outright). That rationale
 * does not reach a swap: a swap has already chosen its target, so letting the pin
 * win re-dispatches the model that just failed. On the native transport, where one
 * agent fronts several providers through `models.native.<tier>`, that made the
 * entire same-agent ladder inert (nax#1965).
 */
export function hopChoseItsOwnModel(hopKind: HopKind): boolean {
  return hopKind.tier !== undefined || hopKind.model !== undefined;
}
```

- [ ] **Step 4: Apply it at the pin site**

Replace the `pinnedModelDef` computation (currently at ~line 349):

```ts
    // The caller's pinned model is usable only on the agent it was resolved for; any
    // other agent re-resolves from its own tier map (nax#1722 — see pinnedModelAgent).
    // A hop that named its own tier or model outranks the pin entirely (nax#1965).
    const pinnedModelDef =
      hopChoseItsOwnModel(hopKind) || (pinnedModelAgent !== undefined && pinnedModelAgent !== agentName)
        ? undefined
        : resolvedRunOptions.modelDef;
```

The `modelDef` resolution below it is unchanged — with `pinnedModelDef` now `undefined`, the existing `hopPin ? resolveModel(hopPin) : resolveModelForAgent(..., hopTier(hopKind, effectiveTier), ...)` arm already does the right thing.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/operations/build-hop-callback-model-pin.test.ts test/unit/operations/build-hop-callback-tier.test.ts test/unit/operations/build-hop-callback-stale-retry.test.ts --timeout=30000
```

Expected: all PASS. The stale-retry file matters here — a `stale-retry` hop carries `tier`, so it now also bypasses the pin. That is correct (it should re-resolve the tier it was retrying at), but confirm the file's expectations still hold rather than assuming.

- [ ] **Step 6: Run the fallback suite and the gates**

```bash
bun test test/unit/agents/ test/unit/operations/ --timeout=60000
bun run lint && bun run typecheck
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/operations/build-hop-callback.ts test/unit/operations/build-hop-callback-model-pin.test.ts
git commit -m "fix(agents): a swap hop dispatches its own model, not the caller's pin

A same-agent fallback hop was selected correctly by #1962 but dispatched with
resolvedRunOptions.modelDef, because pinnedModelAgent === agentName short-circuited
the hop's own tier/pin resolution. Every {agent: <same>, tier|model} rung was a
no-op that still cost a hop from maxHopsPerStory.

Closes #1965"
```

---

### Task 2: A literal-id fallback target gets its own cooldown identity (#1966)

**Files:**
- Modify: `src/agents/fallback-model-identity.ts` (extend `resolveFallbackModelId`; add the exclusion-predicate factory)
- Modify: `src/agents/swap-decision.ts` (widen the `isExcluded` predicate)
- Modify: `src/agents/manager.ts` (thread the pin — **net line budget: +5 max**)
- Modify: `src/agents/manager-run-fallback.ts` (pass the failing hop's model, and give the primary hop a real identity)
- Test: `test/unit/agents/fallback-tier-targets.test.ts` (exists — add to it)
- Test: `test/unit/agents/cooldown-store.test.ts` (exists — add the primary-identity case)

**Interfaces:**
- Consumes: `hopChoseItsOwnModel` is not needed here. `FallbackTarget` from `swap-decision.ts` is `{ agent: string; tier?: string; model?: string }` where `tier` and `model` are mutually exclusive.
- Produces:
  - `resolveFallbackModelId(models, agent, tier, defaultAgent, modelPin?): string | undefined` — gains a fifth parameter.
  - `makeExclusionPredicate(deps): (agent: string, tier?: string, model?: string) => boolean` — extracted so `manager.ts` stays under its line ceiling.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/agents/fallback-tier-targets.test.ts`. Note its existing `nextCandidate` describe block builds a manager with a local factory that does **not** inject models:

```ts
function manager(map: Record<string, unknown[]>) {
  const config = NaxConfigSchema.parse({ agent: { default: "claude", fallback: { enabled: true, map } } });
  return new AgentManager(config);
}
```

These tests need model resolution, so add a sibling factory that passes the third constructor argument (`AgentManager(config, registry?, opts?)`, where `opts.models` is the DI seam #1962 added):

```ts
const NATIVE_MODELS = {
  native: {
    balanced: "minimax/MiniMax-M3",
    powerful: "opencode-go/deepseek-v4-flash",
    glm: "openrouter/z-ai/glm-5.3-flash[high]",
  },
};

function managerWithModels(map: Record<string, unknown[]>) {
  const config = NaxConfigSchema.parse({
    agent: { default: "native", fallback: { enabled: true, map, maxHopsPerStory: 3 } },
    models: NATIVE_MODELS,
  });
  return new AgentManager(config, undefined, { models: NATIVE_MODELS });
}

const RL: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "rate limited",
};

describe("literal-pin fallback targets (nax#1966)", () => {
  test("a literal-pin rung survives the primary agent's cooldown", () => {
    const m = managerWithModels({
      native: [
        { agent: "native", model: "powerful" },
        { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
        "claude",
      ],
    });

    // The primary hop failed at its dispatched tier, as runWithFallback now records it.
    m.markUnavailable("native", RL, "balanced");
    // Then rung 1 failed too.
    m.markUnavailable("native", RL, "powerful");

    expect(m.nextCandidate("native", 2, "native", "powerful")).toEqual({
      agent: "native",
      model: "openrouter/z-ai/glm-5.3-flash[high]",
    });
  });

  test("a literal pin and the tier naming the same model share one identity", () => {
    // The strings must match byte for byte, effort suffix included — that is what makes
    // both spellings resolve through resolveModel to the same ModelDef.
    const m = managerWithModels({ native: [{ agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" }, "claude"] });

    m.markUnavailable("native", RL, "glm");

    expect(m.nextCandidate("native", 1, "native", "glm")).toEqual({ agent: "claude" });
  });
});
```

Add to `test/unit/agents/cooldown-store.test.ts` (match that file's own failure fixture and clock style):

```ts
test("a model-scoped cooldown recorded with no tier does not blanket the agent", () => {
  const store = new CooldownStore(() => 1000);
  // Pre-fix, runWithFallback recorded the primary hop with no tier at all, so the bare
  // agent key doubled as "the whole agent is down" for every tier-less lookup (nax#1966).
  store.mark("native", RL, undefined, "minimax/MiniMax-M3");

  expect(store.isCooling("native", undefined, "minimax/MiniMax-M3")).toBe(true);
  expect(store.isCooling("native", undefined, "openrouter/z-ai/glm-5.3-flash[high]")).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/agents/fallback-tier-targets.test.ts test/unit/agents/cooldown-store.test.ts --timeout=30000
```

Expected: the three new tests FAIL. The first returns `{ agent: "claude" }` (the literal rung was skipped). The second returns the literal rung (the tier's death was invisible to it). The third reports `true` for the unrelated model.

- [ ] **Step 3: Give a literal pin a resolvable identity**

In `src/agents/fallback-model-identity.ts`, extend `resolveFallbackModelId`:

```ts
export function resolveFallbackModelId(
  models: ModelsConfig | undefined,
  agent: string,
  tier: string | undefined,
  defaultAgent: string,
  modelPin?: string,
): string | undefined {
  // A literal pin resolves without the tier map — this is the same call dispatch
  // makes (`hopModelId` -> `resolveModel` in build-hop-callback.ts), so selection
  // identity and dispatch identity finally name the same endpoint. Without it a
  // pin was judged identity-less and collapsed onto the bare agent key, colliding
  // with the tier-less primary hop (nax#1966).
  if (modelPin !== undefined) {
    const def = resolveModel(modelPin);
    return `${def.provider}/${def.model}`;
  }
  if (!tier || !models) return undefined;
  try {
    const def = resolveModelForAgent(models, agent, tier, defaultAgent);
    return `${def.provider}/${def.model}`;
  } catch {
    return undefined;
  }
}
```

Add `resolveModel` to the existing `@/config` import at the top of the file.

- [ ] **Step 4: Add the exclusion-predicate factory in the same file**

`manager.ts` has 5 lines of headroom, so the predicate moves out rather than growing there:

```ts
/**
 * The dependencies `makeExclusionPredicate` closes over.
 *
 * `models` is a THUNK, not a value. `AgentManager._isExcluded` is a class field, and
 * JS runs every field initializer before the constructor body — so a field capturing
 * `this._models` eagerly captures `undefined`, because `this._models = opts?.models`
 * has not run yet. The existing arrow-function field survives this only because it
 * reads through `this` lazily on every call. Keep every dependency here lazy.
 */
export interface ExclusionDeps {
  readonly models: () => ModelsConfig | undefined;
  readonly defaultAgent: () => string;
  readonly isPruned: (agent: string) => boolean;
  readonly isCooling: (agent: string, tier?: string, modelId?: string) => boolean;
}

/**
 * Is this candidate excluded from selection?
 *
 * Keyed on the candidate's resolved MODEL where one can be resolved — a tier name,
 * or a literal pin — so two spellings of one endpoint cannot disagree about whether
 * it is alive. Lives here rather than on AgentManager because that file is at its
 * 600-line ceiling.
 */
export function makeExclusionPredicate(deps: ExclusionDeps) {
  return (agent: string, tier?: string, model?: string): boolean =>
    deps.isPruned(agent) ||
    deps.isCooling(agent, tier, resolveFallbackModelId(deps.models(), agent, tier, deps.defaultAgent(), model));
}
```

- [ ] **Step 5: Widen the candidate filter**

In `src/agents/swap-decision.ts`, change `availableCandidates`' predicate type and the filter call:

```ts
export function availableCandidates(
  map: FallbackMap | undefined,
  agent: string,
  isExcluded: (candidate: string, tier?: string, model?: string) => boolean,
  resolve: (target: FallbackTarget) => FallbackTarget = (target) => target,
): FallbackTarget[] {
  return (map?.[agent] ?? [])
    .map(normaliseFallbackTarget)
    .map(resolve)
    .filter((candidate) => !isExcluded(candidate.agent, candidate.tier, candidate.model));
}
```

Extend the existing doc comment on this function: the paragraph explaining that `isExcluded` receives the tier should now also say it receives the literal pin, and that a predicate ignoring the extra arguments keeps its original behaviour (TS contravariance).

- [ ] **Step 6: Thread the pin through the manager**

In `src/agents/manager.ts`, replace the four members. Keep the reformatting tight — this must land within +5 lines:

```ts
  isUnavailable(agent: string, tier?: string, model?: string): boolean {
    return this._cooldowns.isCooling(agent, tier, resolveFallbackModelId(this._models, agent, tier, this.getDefault(), model));
  }

  markUnavailable(agent: string, reason: AdapterFailure, tier?: string, model?: string): void {
    this._cooldowns.mark(agent, reason, tier, resolveFallbackModelId(this._models, agent, tier, this.getDefault(), model));
    this._emitter.emit("onAgentUnavailable", { agent, tier, failure: reason });
  }
```

```ts
  private readonly _isExcluded = makeExclusionPredicate({
    models: () => this._models,
    defaultAgent: () => this.getDefault(),
    isPruned: (a) => this._prunedFallback.has(a),
    isCooling: (a, t, m) => this._cooldowns.isCooling(a, t, m),
  });
```

```ts
  nextCandidate(current: string, _hops: number, exclude?: string, excludeTier?: string, excludeModel?: string): FallbackTarget | null {
    const failedId = resolveFallbackModelId(this._models, exclude ?? current, excludeTier, this.getDefault(), excludeModel);
    const excluded = (c: string, t?: string, m?: string): boolean =>
      (c === exclude && sameEndpoint(this._models, c, t, m, this.getDefault(), failedId)) || this._isExcluded(c, t, m);
    return availableCandidates(this._config.agent?.fallback?.map, current, excluded, this._resolveTarget)[0] ?? null;
  }
```

Add `sameEndpoint` to `fallback-model-identity.ts` (keeping manager.ts small):

```ts
/**
 * Does this candidate resolve to the endpoint that just failed?
 *
 * The hop-local exclusion used to compare `(agent, tier)` names, which cannot see
 * that a literal pin and a tier key name one model. Comparing resolved identities
 * makes the two spellings collide as they must; when neither side resolves, it
 * falls back to bare-agent equality, which is the pre-#1962 behaviour.
 */
export function sameEndpoint(
  models: ModelsConfig | undefined,
  agent: string,
  tier: string | undefined,
  model: string | undefined,
  defaultAgent: string,
  failedId: string | undefined,
): boolean {
  // Both unresolvable compares `undefined === undefined` and yields true — which is the
  // pre-#1962 bare-agent behaviour, and the right default when there is no identity to
  // tell two same-named targets apart.
  return resolveFallbackModelId(models, agent, tier, defaultAgent, model) === failedId;
}
```

Update the `nextCandidate` signature in `src/agents/manager-types.ts:182` and the `RunFallbackInput.nextCandidate` type in `src/agents/manager-run-fallback.ts:33` to match.

- [ ] **Step 7: Give the primary hop a real identity, and pass the failing hop's pin**

In `src/agents/manager-run-fallback.ts`, at the swap branch:

```ts
      const failure = result.adapterFailure ?? unknownFailure();
      // The primary hop carries no tier of its own, so record it at the tier the
      // caller actually dispatched. Without this its cooldown lands on the bare
      // agent key, which `CooldownStore._live` returns for any tier-less lookup
      // regardless of scope — which is what excluded every literal-pin rung (nax#1966).
      const failedTier = currentHopKind.tier ?? request.runOptions.modelTier;
      input.markUnavailable(currentAgent, failure, failedTier, currentHopKind.model);
      const next = input.nextCandidate(primaryAgent, hopsSoFar, currentAgent, failedTier, currentHopKind.model);
```

Apply the same `markUnavailable` / `nextCandidate` argument change in `AgentManager.completeWithFallback` (`src/agents/manager.ts:341-342`), which threads its own `currentTier` local and has no model pin to pass — pass `undefined` there explicitly rather than omitting the argument, so the call sites read alike.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
bun test test/unit/agents/fallback-tier-targets.test.ts test/unit/agents/cooldown-store.test.ts test/unit/agents/cooldown-integration.test.ts --timeout=30000
```

Expected: all PASS.

- [ ] **Step 9: Verify the line ceiling and the gates**

```bash
bun run check:file-sizes 2>&1 | tail -5
wc -l src/agents/manager.ts
bun run lint && bun run typecheck
bun test test/unit/agents/ --timeout=60000
```

Expected: `src/agents/manager.ts` at 600 or below and `check:file-sizes` green. If it is over, move more of `nextCandidate`'s body into `fallback-model-identity.ts` — do NOT add the file to `scripts/baselines/file-sizes-baseline.json`.

- [ ] **Step 10: Commit**

```bash
git add src/agents/ test/unit/agents/
git commit -m "fix(agents): key fallback exclusion on the resolved endpoint, including literal pins

A {agent, model: '<provider/model>'} rung resolved to no identity, collapsed onto
the bare agent key, and collided with the tier-less primary hop's cooldown — so
the literal spelling of a target was excluded where the tier spelling survived.
resolveFallbackModelId now resolves a pin, the candidate filter forwards it, and
the primary hop records at its dispatched tier instead of the bare agent name.

Closes #1966"
```

---

### Task 3: Rectification ops inherit `story.routing` (#1967)

Independent of Tasks 1, 2 and 4 — it can be done in any order, and is the one defect that bites with no provider outage involved.

**Files:**
- Create: `src/operations/story-routing-model.ts`
- Modify: `src/operations/implement.ts` (replace the inline resolver with the shared one)
- Modify: `src/operations/autofix-implementer.ts`, `src/operations/autofix-test-writer.ts`, `src/operations/full-suite-rectify-op.ts`, `src/operations/rectify.ts` (add `model:`)
- Test: `test/unit/operations/story-routing-model.test.ts` (new)
- Test: `test/unit/operations/autofix-implementer.test.ts` (exists — add the inheritance case)

**Interfaces:**
- Produces: `storyRoutingModel(story: UserStory): ConfiguredModel | undefined`. All four rectification op inputs already carry `story: UserStory` (verified in `AutofixImplementerInput`, `AutofixTestWriterInput`, `FullSuiteRectifyInput`, `RectifyInput`), so the resolver is `(input) => storyRoutingModel(input.story)` in every case.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/story-routing-model.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { storyRoutingModel } from "../../../src/operations/story-routing-model";
import { makeStory } from "../../helpers/make-story";

describe("storyRoutingModel", () => {
  test("returns the story's current tier", () => {
    const story = makeStory({ routing: { modelTier: "powerful", testStrategy: "tdd-simple", reasoning: "" } });
    expect(storyRoutingModel(story)).toBe("powerful");
  });

  test("prefers a profile's literal pin over the tier", () => {
    const story = makeStory({
      routing: {
        agent: "native",
        profileModelPin: "openai-codex/gpt-5.6-terra",
        modelTier: "balanced",
        testStrategy: "tdd-simple",
        reasoning: "",
      },
    });
    expect(storyRoutingModel(story)).toEqual({ agent: "native", model: "openai-codex/gpt-5.6-terra" });
  });

  test("returns undefined for a story with no routing", () => {
    expect(storyRoutingModel(makeStory({}))).toBeUndefined();
  });

  test("ignores a pin with no agent to dispatch it on", () => {
    const story = makeStory({
      routing: { profileModelPin: "openai-codex/gpt-5.6-terra", modelTier: "fast", testStrategy: "tdd-simple", reasoning: "" },
    });
    expect(storyRoutingModel(story)).toBe("fast");
  });
});
```

`makeStory` is exported from `@test/helpers` (used by `build-hop-callback-model-pin.test.ts` among others) — import it from there rather than re-implementing one; `.nax/rules/test-helpers.md` forbids inline re-implementations.

Add to `test/unit/operations/autofix-implementer.test.ts`. **`op.model?.(input, ctx)` does not compile** — `OperationModel` is a union whose literal-model member is not callable, so tsc rejects it with TS2349. `test/helpers/op-model.ts` exists for exactly this and narrows on `typeof === "function"` without a cast:

```ts
import { makeBuildCtx, makeStory, opModelResolver } from "@test/helpers";

test("the rectifier runs at the story's escalated tier, not a hardcoded balanced", () => {
  const story = makeStory({ routing: { modelTier: "powerful", testStrategy: "tdd-simple", reasoning: "" } });

  expect(opModelResolver(implementerRectifyOp)({ failedChecks: [], story }, makeBuildCtx())).toBe("powerful");
});

test("the rectifier honours a profile's literal pin", () => {
  const story = makeStory({
    routing: { agent: "native", profileModelPin: "openai-codex/gpt-5.6-terra", modelTier: "balanced", testStrategy: "tdd-simple", reasoning: "" },
  });

  expect(opModelResolver(implementerRectifyOp)({ failedChecks: [], story }, makeBuildCtx())).toEqual({
    agent: "native",
    model: "openai-codex/gpt-5.6-terra",
  });
});
```

Confirm `opModelResolver` and `makeBuildCtx` are re-exported from `@test/helpers`; if `opModelResolver` is not, import it from `@test/helpers/op-model` directly.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/operations/story-routing-model.test.ts test/unit/operations/autofix-implementer.test.ts --timeout=30000
```

Expected: the new file FAILS to resolve the import (`story-routing-model` does not exist), and the autofix test FAILS because `implementerRectifyOp.model` is `undefined`.

- [ ] **Step 3: Create the shared resolver**

`src/operations/story-routing-model.ts`:

```ts
/**
 * The model an op should run a story at.
 *
 * Shared by the implementer and every rectification op. The rectification ops
 * declared no `model` at all, so `callOp` substituted the literal `"balanced"` and
 * they inherited the story's AGENT but neither its escalated tier nor its profile
 * pin — on an escalated attempt the implementer ran at `powerful` while the
 * rectifier silently dropped to `balanced` (nax#1967).
 *
 * `RectificationConfigSchema` deliberately has no model field: rectification
 * tracks the implementer rather than being configured against it.
 */

import type { ConfiguredModel } from "../config";
import type { UserStory } from "../prd";

export function storyRoutingModel(story: UserStory): ConfiguredModel | undefined {
  const routing = story.routing;
  // A literal profile pin selects its own agent's exact model; otherwise escalation
  // mutates modelTier in the PRD before re-dispatch. Ad-hoc callers without routing
  // return undefined, so callOp uses its default tier.
  if (routing?.profileModelPin !== undefined && routing.agent !== undefined) {
    return { agent: routing.agent, model: routing.profileModelPin };
  }
  return routing?.modelTier;
}
```

- [ ] **Step 4: Point the five ops at it**

In `src/operations/implement.ts`, replace the inline `model:` body with `model: (input) => storyRoutingModel(input.story),` and keep the existing explanatory comment above it.

In each of `autofix-implementer.ts`, `autofix-test-writer.ts`, `full-suite-rectify-op.ts`, `rectify.ts`, add beside the existing `config:` line:

```ts
  // Inherit the story's rung so an escalation or a profile pin reaches the fix
  // cycle too — without this the op fell through to callOp's literal "balanced".
  model: (input) => storyRoutingModel(input.story),
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/operations/story-routing-model.test.ts test/unit/operations/autofix-implementer.test.ts test/unit/operations/autofix-test-writer.test.ts test/unit/operations/implementer.test.ts --timeout=30000
```

Expected: all PASS.

- [ ] **Step 6: Run the wider suite and the gates**

```bash
bun test test/unit/operations/ test/unit/execution/ --timeout=120000
bun run lint && bun run typecheck
```

Expected: green. Pay attention to `test/unit/execution/escalation/` — it is the suite that would catch a story now rectifying at a different tier than before.

- [ ] **Step 7: Commit**

```bash
git add src/operations/ test/unit/operations/
git commit -m "fix(operations): rectification ops inherit the story's routing

The four rectification ops declared no model resolver, so callOp substituted the
literal 'balanced'. They inherited the story's agent but dropped its escalated
tier and its profile model pin — an escalated story implemented at powerful and
rectified at balanced, silently. Extracts the implementer's resolver so the two
cannot drift again.

Closes #1967"
```

---

### Task 4: A story sticks to the target it swapped to (#1964)

Depends on Task 1 — without it, the recorded target may be one that never changed the dispatched model.

**Files:**
- Modify: `src/agents/manager-types.ts` (`AgentRunOutcome.finalTarget`)
- Modify: `src/agents/manager-run-fallback.ts` (track and return the final target)
- Modify: `src/agents/manager.ts` (return `finalTarget` from `completeWithFallback` — **watch the line budget again**)
- Modify: `src/runtime/index.ts` (the run-scoped store)
- Modify: `src/operations/call-resolvers.ts` (record and read helpers)
- Modify: `src/operations/call.ts` (prefer the sticky target)
- Test: `test/unit/operations/call-fallback-recording.test.ts` (exists — add the recording case)
- Test: `test/unit/operations/call-sticky-target.test.ts` (new — the cross-op case)

**Interfaces:**
- Consumes: `FallbackTarget` (`{ agent: string; tier?: string; model?: string }`) from `swap-decision.ts`; `storyFixKey(storyId, tier?, agent?)` from `src/findings/story-fix-history.ts` as the keying precedent.
- Produces:
  - `AgentRunOutcome.finalTarget?: FallbackTarget`
  - `NaxRuntime.storyAgentTargets: Map<string, FallbackTarget>`
  - `recordStoryAgentTarget(ctx: CallContext, target: FallbackTarget | undefined, swapped: boolean): void`
  - `stickyAgentTarget(ctx: CallContext, tier: string | undefined): FallbackTarget | undefined`

**Design decisions, made explicit:**

1. **Record only when a swap actually happened** (`fallbacks.length > 0`). Recording the primary target on every success would pin a story to its attempt-1 choice for no benefit.
2. **Key on `(storyId, tier, agent)`, not `storyId` alone**, reusing `storyFixKey`. This is the existing precedent for per-story escalation-aware state (`storyScopedFixBudget`, #1530: "a cross-agent ladder can escalate to a rung that reuses a tier name, and a tier-only key hands that rung the previous agent's exhausted budget"). It also means a tier escalation gets a fresh agent choice with no explicit invalidation — a more capable rung should not inherit the previous rung's fallback.
3. **The store lives on `NaxRuntime`, not `CallContext`.** `.nax/rules/adapter-wiring.md` Rule 6 forbids `CallContext` fields that carry result-side data; `agentFallbacks` and `lastAdapterFailure` are the two existing precedents for exactly this shape.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/call-sticky-target.test.ts`, modelled on `test/unit/operations/call-fallback-recording.test.ts` — read that file first and copy its scaffolding verbatim: the `afterEach` that closes `createdRuntimes`, the `hop()` fixture, the `makeOp(name)` factory, and its `pickSelector` config slice. It solves exactly the same problem (asserting what `callOp` records on the run-scoped store) and its helpers are `makeMockAgentManager`, `makeMockRuntime` and `assertDefined` from `@test/helpers`.

The one new piece is a manager that reports a swap. `callOp` passes its chosen agent as `runWithFallback`'s second argument (`primaryAgentOverride`), so recording that argument is what proves the sticky target took effect:

```ts
/** Reports a swap away from `deadAgent`; dispatches straight through on any other agent. */
function managerSwapping(deadAgent: string, liveAgent: string, dispatched: string[]) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req, primaryAgentOverride) => {
      const agent = primaryAgentOverride ?? deadAgent;
      dispatched.push(agent);
      const swapped = agent === deadAgent;
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop(swapped ? liveAgent : agent, undefined, { kind: "primary" }, req.runOptions);
      return {
        result: hopResult.result,
        fallbacks: swapped ? [hop({ priorAgent: deadAgent, newAgent: liveAgent })] : [],
        finalTarget: { agent: swapped ? liveAgent : agent },
      };
    },
    runAsSessionFn: async () => ({
      output: "done",
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

test("a later op of the same story dispatches on the agent the earlier op swapped to", async () => {
  const dispatched: string[] = [];
  const ctx = makeCtx({ agentManager: managerSwapping("native", "claude", dispatched), storyId: "US-001", agentName: "native" });

  await callOp(ctx, makeOp("op-one"), "work");
  await callOp(ctx, makeOp("op-two"), "work");

  expect(dispatched).toEqual(["native", "claude"]);
});

test("a different story is unaffected by another story's swap", async () => {
  const dispatched: string[] = [];
  const agentManager = managerSwapping("native", "claude", dispatched);

  await callOp(makeCtx({ agentManager, storyId: "US-001", agentName: "native" }), makeOp("op-one"), "work");
  await callOp(makeCtx({ agentManager, storyId: "US-002", agentName: "native" }), makeOp("op-two"), "work");

  expect(dispatched).toEqual(["native", "native"]);
});

test("an escalated tier gets a fresh agent choice", async () => {
  const dispatched: string[] = [];
  const agentManager = managerSwapping("native", "claude", dispatched);

  await callOp(makeCtx({ agentManager, storyId: "US-001", agentName: "native", tier: "balanced" }), makeOp("op-one"), "work");
  // Escalation bumped the story to powerful; the balanced rung's swap must not carry over.
  await callOp(makeCtx({ agentManager, storyId: "US-001", agentName: "native", tier: "powerful" }), makeOp("op-two"), "work");

  expect(dispatched).toEqual(["native", "native"]);
});
```

`makeCtx` here is a thin local wrapper over the sibling file's `CallContext` construction that reuses ONE `makeMockRuntime()` across the calls in a test (the sticky store is run-scoped, so a fresh runtime per call would make every test pass vacuously). Push that runtime onto `createdRuntimes` so the `afterEach` closes it. The second and third tests must share the runtime too — that is precisely what they are isolating.

The `tier` in `makeCtx` reaches `resolved.modelTier`; drive it through the op's `model` resolver (a literal tier string on `makeOp`) rather than inventing a new `CallContext` field.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/unit/operations/call-sticky-target.test.ts --timeout=30000
```

Expected: the first test FAILS with `["native", "claude", "native"]` — op 2 went back to the primary. The second and third tests should PASS already (they assert the isolation that must not regress); if they fail, the harness is wrong, not the source.

- [ ] **Step 3: Return the final target from the fallback loop**

In `src/agents/manager-types.ts`, beside `finalAgent`:

```ts
  /**
   * The resolved target the final hop ran on — agent AND the tier or literal model
   * it was dispatched at. `finalAgent` alone cannot express a same-agent swap, where
   * the name is unchanged and the model is the whole point (nax#1964).
   */
  finalTarget?: import("./swap-decision").FallbackTarget;
```

In `src/agents/manager-run-fallback.ts`, track it alongside `currentAgent`. `resolveStartAgent` already returns a `FallbackTarget`, so no reshaping is needed — and spreading avoids the `"tier" in start` idiom, which is misleading here because `tier` is an optional property, not a discriminant:

```ts
  let currentTarget: FallbackTarget = { ...start };
```

Set it on each swap, next to the existing `currentAgent = next.agent;`:

```ts
      currentTarget = next;
```

Then add `finalTarget: currentTarget` to each `return { result, fallbacks, ... }` site. There are **five** — verify with:

```bash
grep -c 'finalAgent: currentAgent' src/agents/manager-run-fallback.ts   # expect 5
```

Every one must carry it, including the failure exits: a story that exhausted its ladder still swapped, and the next op should start where this one ended rather than back at the dead primary.

- [ ] **Step 4: Add the run-scoped store**

In `src/runtime/index.ts`, beside `agentFallbacks` (~line 178):

```ts
  /**
   * The dispatch target each story swapped to, keyed by `storyFixKey(storyId, tier, agent)`.
   *
   * A swap used to die with the operation that made it: every op re-derived its agent
   * from `ctx.agentName`, so a story that failed over re-probed the dead primary on its
   * next op — and once the per-story hop budget was spent it could no longer swap away
   * (nax#1964). Written by callOp only when a swap actually occurred; read by callOp
   * before it resolves a dispatch target. Keyed on the full escalation rung for the same
   * reason `storyFixHistory` is (#1530): a new rung deserves a fresh choice.
   */
  readonly storyAgentTargets: Map<string, FallbackTarget>;
```

and construct it beside `const agentFallbacks = new Map...` (~line 359), and add it to the returned object (~line 393).

- [ ] **Step 5: Add the record and read helpers**

In `src/operations/call-resolvers.ts`, beside `recordAgentFallbacks`:

```ts
/**
 * Record the target a story swapped to, so its later ops start there.
 *
 * Only a real swap is recorded: pinning a story to its primary would add nothing and
 * would freeze a choice nothing had to make.
 */
export function recordStoryAgentTarget(
  ctx: CallContext,
  target: FallbackTarget | undefined,
  swapped: boolean,
  tier: string | undefined,
): void {
  if (!swapped || !target || !ctx.storyId) return;
  ctx.runtime.storyAgentTargets.set(storyFixKey(ctx.storyId, tier, ctx.agentName), target);
}

/** The target this story already swapped to at this rung, if any. */
export function stickyAgentTarget(ctx: CallContext, tier: string | undefined): FallbackTarget | undefined {
  if (!ctx.storyId) return undefined;
  return ctx.runtime.storyAgentTargets.get(storyFixKey(ctx.storyId, tier, ctx.agentName));
}
```

- [ ] **Step 6: Prefer the sticky target in callOp**

In `src/operations/call.ts`, after `const effectiveTier = resolved.modelTier ?? "balanced";`:

```ts
  // A swap this story already made outranks the op's own resolution: re-deriving the
  // agent from ctx.agentName is what sent every later op back to a dead primary (nax#1964).
  const sticky = stickyAgentTarget(ctx, resolved.modelTier);
  const dispatchAgent = sticky?.agent ?? resolved.agent;
```

Replace the existing `const dispatchAgent = resolved.agent;` with the above, and where `runOptions.modelDef` / `hopCtx.pinnedModelAgent` are assembled, resolve the sticky target's own model when it has one:

```ts
  const dispatchModelDef = sticky
    ? sticky.model !== undefined
      ? resolveModel(sticky.model)
      : resolveModelForAgent(effectiveModels, sticky.agent, sticky.tier ?? effectiveTier, defaultAgent)
    : resolved.modelDef;
```

then use `dispatchModelDef` in place of `resolved.modelDef` in `runOptions` and in the `completeOptions` branch.

At the recording site, next to the existing `recordAgentFallbacks(ctx, outcome.fallbacks);`:

```ts
  recordStoryAgentTarget(ctx, outcome.finalTarget, outcome.fallbacks.length > 0, resolved.modelTier);
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
bun test test/unit/operations/call-sticky-target.test.ts test/unit/operations/call-fallback-recording.test.ts test/unit/operations/call.test.ts --timeout=60000
```

Expected: all PASS.

- [ ] **Step 8: Run the full suite and the gates**

```bash
bun run lint && bun run typecheck
bun run test 2>&1 | tail -20
bun run check:file-sizes 2>&1 | tail -5
```

Expected: green, with the same test count as the Task 0 baseline plus the tests added here. `src/operations/call.ts` was 591 lines at baseline — check it is still at or under 600 and extract into `call-resolvers.ts` if not.

- [ ] **Step 9: Commit**

```bash
git add src/agents/ src/runtime/ src/operations/ test/unit/operations/
git commit -m "feat(agents): a story sticks to the agent and model it swapped to

runWithFallback returned finalAgent and nothing read it, so every op re-derived
its agent from ctx.agentName and a story that failed over re-probed the dead
primary on its next op — fatal once the per-story hop budget was spent, because
decideSwap then returned hop-cap-reached before considering any candidate.

Records the resolved target (agent AND tier/model, since a same-agent swap changes
only the model) on a run-scoped store keyed by the full escalation rung, following
storyFixHistory. CallContext is untouched per adapter-wiring.md Rule 6.

Closes #1964"
```

---

### Task 5: Coverage gate and integration check

- [ ] **Step 1: Run the coverage gate**

```bash
bun run test:coverage 2>&1 | tail -30
```

This is a separate CI step with a per-file floor and is NOT part of the nax pipeline — a passing suite can still fail it. If a file regressed, add the missing case rather than re-baselining. Never run `--update-baseline` locally: it bakes in local numbers and drops files CI still needs grandfathered.

- [ ] **Step 2: Check for import cycles**

```bash
bun run check:import-cycles 2>&1 | tail -10
```

Task 2 adds a `manager.ts` -> `fallback-model-identity.ts` edge and Task 4 adds `call-resolvers.ts` -> `findings/story-fix-history.ts`. `src/agents/manager.ts` already appears in `scripts/baselines/import-cycles-baseline.json`, so confirm nothing new was introduced.

- [ ] **Step 3: Verify the end-to-end behaviour the issues describe**

Construct a single test asserting the composite: a story whose primary agent rate-limits swaps to a different provider on the same agent, and its next operation dispatches there without spending a hop. Put it in `test/unit/agents/manager-swap-loop.test.ts`, which already owns the multi-hop scenarios.

This is the assertion that all four fixes were needed for — Task 1 makes the swap change the model, Task 2 lets the literal rung be chosen, Task 4 carries it to the next op.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fallback-swap-correctness
gh pr create --title "fix(agents): make the fallback ladder change the model and survive the op boundary" --body "$(cat <<'EOF'
Fixes four defects on the agent-fallback path, all diagnosed from run
`run-2026-09-09T13-58-46-234Z` (feature `prompt-affordance-ssot`, 0.82.0-canary.7),
where a provider quota exhaustion put a story into a 6-minute loop that re-validated
unchanged code three times.

- Closes #1965 — a same-agent swap hop dispatched the caller's pinned model, so every
  same-agent rung was inert while still costing a hop.
- Closes #1966 — a literal-id rung resolved to no identity, collided with the tier-less
  primary hop on the bare agent key, and was never selected.
- Closes #1967 — the four rectification ops inherited the story's agent but not its
  escalated tier or profile pin.
- Closes #1964 — a swap died with the op that made it; later ops re-probed the dead
  primary with an exhausted hop budget.

Left for a follow-up: #1968 (a rectification pass with zero successful dispatches
reports "completed" and the cycle re-validates unchanged code).
EOF
)"
```

---

## Self-Review

**Spec coverage.** #1965 → Task 1. #1966 → Task 2. #1967 → Task 3. #1964 → Task 4. #1968 is explicitly out of scope and named as such in the PR body.

**Ordering.** Task 1 gates Task 4 (a recorded target must be one that actually changed the dispatch). Task 2 is independent of Task 1 but shares `manager.ts`, so do them in order to avoid a line-budget conflict. Task 3 is fully independent.

**Type consistency.** `FallbackTarget` is `{ agent: string; tier?: string; model?: string }` throughout — Tasks 2 and 4 both use that shape, and `AgentRunOutcome.finalTarget` reuses it rather than introducing a parallel type. `resolveFallbackModelId`'s new fifth parameter is optional, so every existing call site compiles unchanged.

**Verification pass (2026-09-09).** Every API, helper, and script named above was checked against `origin/main@21dacecfa`. Seven errors were found and corrected in place:

1. Task 1's test used an invented `makeHopCtx`/`onDispatch` seam. The real file has a `harness(pinnedModelAgent?)` returning `{ ctx, options, opened }` — rewritten to use it.
2. Task 3's test used `op.model?.(input, ctx)`, which does not compile (TS2349 — `OperationModel` is a union whose literal member is not callable). `test/helpers/op-model.ts` exists for this; the test now uses `opModelResolver`.
3. Task 2's tests used a nonexistent `makeManager`/`rateLimitFailure`. The real file constructs `new AgentManager(config)` from a local factory that does **not** inject models — a models-injecting sibling factory is now specified, along with the real `AdapterFailure` shape `{ category, outcome, retriable, message }`.
4. `sameEndpoint` was written with a ternary that collapsed to its own else-branch. Simplified, with the `undefined === undefined` case documented rather than accidental.
5. `resolveModel` infers the provider from the model name and does not split `provider/model`, so native ids resolve to `provider: "unknown"`. The identity is still stable and unique and the two spellings still collide — but only for byte-identical strings, so the Task 2 fixtures now carry the `[high]` effort suffix on both sides. Recorded in Global Constraints.
6. `finalAgent: currentAgent` appears **five** times in `manager-run-fallback.ts`, not six. Corrected, with a `grep -c` check.
7. Task 4's `currentTarget` initialiser used `"tier" in start`, which reads as a discriminant check on a plain optional property. Replaced with a spread.

**Known risk.** Task 2's `sameEndpoint` changes hop-local exclusion from name comparison to identity comparison. A config whose fallback map names two agents that resolve to the same model will now see the second excluded where it previously was not. That is the intended behaviour (#1962's stated goal), but it is a behaviour change beyond the reported bug — call it out in review, and check `test/unit/agents/manager-swap-loop.test.ts` for a case that depended on the old leniency.
