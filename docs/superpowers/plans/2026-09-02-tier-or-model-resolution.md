# Plan C — Tier-or-Model Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `{ agent, model }` mean "a tier when the string names a tier for that agent, a literal model otherwise" everywhere it appears, derive tier ordering from `tierOrder` instead of the hardcoded `TIER_RANK`, and let `complexityRouting` place stories on cross-agent rungs.

**Architecture:** Three derivations replace hardcoded builtin-name lists: tier *identity* from membership in `models[agent]` (fallback-inclusive), tier *ordering* from rung index in `autoMode.escalation.tierOrder`, and initial *placement* from rung-qualified `complexityRouting`. Plus two existing behaviours pinned as contracts (off-ladder = no escalation; pin-swap tier precedence) and validation that every ladder rung resolves in its own agent's map.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, Zod config schemas, Biome.

**Spec:** `docs/superpowers/specs/2026-09-02-plan-c-tier-or-model-resolution-design.md` — read it first; tasks cite its sections.

## Global Constraints

- **No new builtin tier names.** `fast`/`balanced`/`powerful` stay defaults-only; the open keyspace does the rest (spec §1).
- **Never touch:** `pinnedModelAgent` semantics (`src/operations/build-hop-callback.ts:304-306`), `MODEL_SHORTHAND_TIERS` contents/precedence, `escalateTier`/budget mechanics, the absent-`modelTier`-on-pin design (nax#1739) (spec §9).
- **The `attempts === 0` early return in `checkPreIterationEscalation` (`src/execution/escalation/tier-escalation.ts:145-155`) must survive verbatim** — its `@design` comment explains why (#1575).
- **Byte-compatibility bar:** a config using only builtin tiers, no custom tiers, no object-form `complexityRouting` routes every story identically to before (spec §11).
- Project gates: 400-line file limit (file-size gate refuses ANY growth of an already-over-limit file — `src/config/runtime-types.ts` is 578 lines, so Task 4 edits it **net-zero**); functions ≤30 lines; conventional commits; `bun test <file> --timeout=30000` for targeted runs; `bun run test` + `bun run typecheck` + `bun run lint` before each commit; `bun run test:coverage` after tasks that add test files.
- Barrel imports (`@/config`, `@/logger`); `.nax/rules/` conventions apply. In `src/config/schema-types.ts` use the existing inline-`require` idiom for cross-module deps (see its `NaxError` require) to avoid import cycles.
- All tasks run on branch `feat/tier-or-model-resolution` (already created). No worktrees — user preference.

---

### Task 1: Shared tier-membership resolver + object-form fix (spec §3)

**Files:**
- Modify: `src/config/schema-types.ts` (object form of `resolveConfiguredModel`, ~lines 91-119; new exports near `isBuiltinModelTier`)
- Modify: `src/config/index.ts`, `src/config/schema.ts`, `src/config/types.ts` (re-export `resolveTierMembership`, `isUnrecognizedLiteralModel` — mirror how `resolveModelForAgent` is re-exported at `schema.ts:84`, `types.ts:81`, `index.ts:69`)
- Modify: `src/cli/plan-runtime.ts:33-43` (unknown-literal guard)
- Test: `test/unit/config/schema-types.test.ts`, `test/unit/cli/plan-runtime.test.ts`

**Interfaces:**
- Consumes: existing `ModelsConfig`, `resolveModelForAgent`, `resolveModel`, `MODEL_SHORTHAND_TIERS` (all in `schema-types.ts`).
- Produces (later tasks rely on these exact shapes):
  ```ts
  export interface TierMembership {
    isTier: boolean;
    /** Tier exists only on the default agent's map, not the target agent's. */
    viaDefaultAgentFallback: boolean;
  }
  export function resolveTierMembership(
    models: ModelsConfig, agent: string, name: string, defaultAgent: string,
  ): TierMembership;
  /** True when resolveModel would guess provider "unknown" AND the id has no "/". */
  export function isUnrecognizedLiteralModel(model: string): boolean;
  ```

- [ ] **Step 1: Write the failing tests** — append to `test/unit/config/schema-types.test.ts` (match the file's existing import style):

```ts
describe("resolveTierMembership (spec §3)", () => {
  const models = {
    claude: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-5", powerful: "claude-opus-5" },
    native: { cheap: "opencode-go/deepseek-v4-flash", turbo: { provider: "opencode-go", model: "deepseek-v4-turbo" } },
  };

  test("own-map custom tier is a tier", () => {
    expect(resolveTierMembership(models, "native", "cheap", "claude")).toEqual({
      isTier: true, viaDefaultAgentFallback: false,
    });
  });

  test("defaultAgent-fallback tier is a tier, flagged", () => {
    expect(resolveTierMembership(models, "native", "balanced", "claude")).toEqual({
      isTier: true, viaDefaultAgentFallback: true,
    });
  });

  test("unknown name is not a tier", () => {
    expect(resolveTierMembership(models, "native", "gpt-5", "claude").isTier).toBe(false);
  });

  test("custom tier resolves through the object form with modelTier set", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "native", model: "turbo" }, "claude");
    expect(r).toEqual({
      agent: "native",
      modelDef: { provider: "opencode-go", model: "deepseek-v4-turbo" },
      modelTier: "turbo",
    });
  });

  test("object and string spellings agree on a custom tier", () => {
    const obj = resolveConfiguredModel(models, "native", { agent: "native", model: "cheap" }, "claude");
    const str = resolveConfiguredModel(models, "native", "cheap", "claude");
    expect(obj).toEqual(str);
  });

  test("fallback-tier membership keeps the target agent", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "native", model: "balanced" }, "claude");
    expect(r.agent).toBe("native");
    expect(r.modelTier).toBe("balanced");
    expect(r.modelDef.model).toBe("claude-sonnet-5");
  });

  test("provider-qualified literal stays a pin (modelTier absent)", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "native", model: "opencode-go/qwen-4" }, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.model).toBe("opencode-go/qwen-4");
  });

  test("known-prefix literal stays a pin", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "claude", model: "claude-opus-5-1" }, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.provider).toBe("anthropic");
  });

  test("isUnrecognizedLiteralModel", () => {
    expect(isUnrecognizedLiteralModel("turbo")).toBe(true);
    expect(isUnrecognizedLiteralModel("opencode-go/qwen-4")).toBe(false);
    expect(isUnrecognizedLiteralModel("claude-opus-5")).toBe(false);
    expect(isUnrecognizedLiteralModel("gpt-5")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/unit/config/schema-types.test.ts --timeout=30000`
Expected: FAIL — `resolveTierMembership is not defined` (and the custom-tier object-form test fails with `modelTier: undefined`).

- [ ] **Step 3: Implement in `src/config/schema-types.ts`**

Add above `resolveConfiguredModel`:

```ts
export interface TierMembership {
  isTier: boolean;
  /** Tier exists only on the default agent's map, not the target agent's. */
  viaDefaultAgentFallback: boolean;
}

/** Is `name` a tier for `agent`? Fallback-inclusive: mirrors resolveModelForAgent's two-step lookup. */
export function resolveTierMembership(
  models: ModelsConfig,
  agent: string,
  name: string,
  defaultAgent: string,
): TierMembership {
  if (models[agent]?.[name] !== undefined) return { isTier: true, viaDefaultAgentFallback: false };
  if (models[defaultAgent]?.[name] !== undefined) return { isTier: true, viaDefaultAgentFallback: true };
  return { isTier: false, viaDefaultAgentFallback: false };
}

/** A literal id resolveModel cannot attribute to a provider and that is not provider-qualified. */
export function isUnrecognizedLiteralModel(model: string): boolean {
  return !model.includes("/") && resolveModel(model).provider === "unknown";
}
```

Replace the object-form body of `resolveConfiguredModel` **after** the alias block (keep the alias block untouched; delete the `isBuiltinModelTier(selection.model)` branch):

```ts
  const membership = resolveTierMembership(models, selection.agent, selection.model, defaultAgent);
  if (membership.isTier) {
    return {
      agent: selection.agent,
      modelDef: resolveModelForAgent(models, selection.agent, selection.model, defaultAgent),
      modelTier: selection.model,
    };
  }

  if (isUnrecognizedLiteralModel(selection.model)) {
    // Loud, not fatal: an acp agent may advertise ids no static heuristic recognizes
    // (spec §2 step 4) — so this cannot throw, but it must not stay silent either.
    const { getSafeLogger } = require("../logger") as { getSafeLogger: typeof import("../logger").getSafeLogger };
    getSafeLogger()?.warn("config", "Configured model is neither a tier nor a recognizable model id — dispatching as a literal", {
      agent: selection.agent,
      model: selection.model,
      availableTiers: Object.keys(models[selection.agent] ?? models[defaultAgent] ?? {}),
    });
  }
  return { agent: selection.agent, modelDef: resolveModel(selection.model) };
```

(The inline `require` follows the file's existing `NaxError` idiom for cycle avoidance. If `src/logger` provably does not import `src/config` — check with `grep -rn "from \"@/config\"\|from \"../config\"" src/logger/` — a normal top import is fine instead.)

Re-export both new symbols from `src/config/schema.ts`, `src/config/types.ts`, `src/config/index.ts` next to `resolveModelForAgent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config/schema-types.test.ts --timeout=30000`
Expected: PASS, including all pre-existing tests in the file (the deleted builtin-tier branch is covered by membership: `validate.ts:38` forces the default agent to define all three builtin tiers, so builtin lookups hit membership).

- [ ] **Step 5: Write the failing plan-runtime tests** — append to `test/unit/cli/plan-runtime.test.ts`:

```ts
describe("resolvePlanModelSelection unknown-literal guard (spec §3)", () => {
  test("garbage object-form plan.model self-rescues to default balanced", () => {
    const config = makeConfig({ plan: { model: { agent: "claude", model: "turbo" } } }); // use the file's existing config factory
    const r = resolvePlanModelSelection(config, "claude");
    expect(r.modelTier).toBe("balanced");
  });

  test("legitimate provider-qualified pin passes through untouched", () => {
    const config = makeConfig({ plan: { model: { agent: "claude", model: "opencode-go/qwen-4" } } });
    const r = resolvePlanModelSelection(config, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.model).toBe("opencode-go/qwen-4");
  });
});
```

(Adapt `makeConfig` to whatever helper the file already uses to build a `NaxConfig`; do not hand-roll a new one — see `.nax/rules/test-helpers.md`.)

- [ ] **Step 6: Verify they fail, then implement the guard in `resolvePlanModelSelection`**

Inside the existing `try`, replace `return resolveConfiguredModel(...)` with:

```ts
    const resolved = resolveConfiguredModel(config.models ?? DEFAULT_CONFIG.models, preferredAgent, selection, defaultAgent);
    if (resolved.modelTier === undefined && isUnrecognizedLiteralModel(resolved.modelDef.model)) {
      getLogger()?.warn("plan", "plan.model is neither a tier nor a recognizable model id — using default balanced model", {
        agent: resolved.agent,
        model: resolved.modelDef.model,
      });
      return resolveConfiguredModel(DEFAULT_CONFIG.models, preferredAgent, "balanced", defaultAgent);
    }
    return resolved;
```

Import `isUnrecognizedLiteralModel` from `../config`. The `catch` block stays byte-identical.

- [ ] **Step 7: Run both test files, then the gates**

Run: `bun test test/unit/cli/plan-runtime.test.ts test/unit/config/schema-types.test.ts --timeout=30000` then `bun run typecheck && bun run lint`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add src/config/schema-types.ts src/config/schema.ts src/config/types.ts src/config/index.ts src/cli/plan-runtime.ts test/unit/config/schema-types.test.ts test/unit/cli/plan-runtime.test.ts
git commit -m "feat(config): ask the tier question in the object form of resolveConfiguredModel

Spec: docs/superpowers/specs/2026-09-02-plan-c-tier-or-model-resolution-design.md §3"
```

---

### Task 2: A pin is not a tier (spec §4)

**Files:**
- Modify: `src/agents/shared/agent-profile-resolver.ts` (whole file — it is 40 lines)
- Modify: `src/prd/types.ts:116` area (two new `StoryRouting` fields)
- Modify: `src/plan/strategies/finalize-routing.ts` (signature + threading)
- Modify: `src/plan/strategies/persist-prd.ts:43` and its args type (thread `models` + `defaultAgent`)
- Test: `test/unit/agents/shared/agent-profile-resolver.test.ts`, `test/unit/plan/strategies/finalize-routing.test.ts`, `test/unit/pipeline/stages/routing-profile-tier.test.ts`

**Interfaces:**
- Consumes: `resolveTierMembership` from Task 1 (via `@/config`).
- Produces:
  ```ts
  export interface ResolvedAgentAssignment {
    agent: string;
    agentProfileId: string;
    /** Set when the profile target names a tier for its agent. Mutually exclusive with profileModelPin. */
    profileModelTier?: ModelTier;
    /** Set when the profile target names a literal model. Mutually exclusive with profileModelTier. */
    profileModelPin?: string;
  }
  export function resolveAgentAssignment(
    selectedProfileId: string | undefined,
    agentRouting: AgentRoutingConfig | undefined,
    storyId: string,
    models: ModelsConfig,
    defaultAgent: string,
  ): ResolvedAgentAssignment | null;
  // finalize-routing:
  export function finalizePrdRouting(
    prd: PRD,
    agentRouting: AgentRoutingConfig | undefined,
    profileName: string | undefined,
    models: ModelsConfig,
    defaultAgent: string,
  ): PRD;
  ```
  New `StoryRouting` fields (also relied on by Tasks 3): `profileModelPin?: string`, `initialModelPin?: string`.

- [ ] **Step 1: Write the failing resolver tests** — in `test/unit/agents/shared/agent-profile-resolver.test.ts` (existing tests must be updated to pass the two new arguments; use a `models` fixture like Task 1's):

```ts
test("tier target sets profileModelTier, no pin (spec §4)", () => {
  const routing = { profiles: [{ id: "p1", target: { agent: "native", model: "cheap" } }], default: undefined }; // adapt to the file's existing AgentRoutingConfig fixture shape
  const a = resolveAgentAssignment("p1", routing, "US-001", models, "claude");
  expect(a).toEqual({ agent: "native", agentProfileId: "p1", profileModelTier: "cheap" });
});

test("literal target sets profileModelPin, no tier (spec §4)", () => {
  const routing = { profiles: [{ id: "p1", target: { agent: "claude", model: "claude-opus-5-1" } }], default: undefined };
  const a = resolveAgentAssignment("p1", routing, "US-001", models, "claude");
  expect(a).toEqual({ agent: "claude", agentProfileId: "p1", profileModelPin: "claude-opus-5-1" });
});
```

(Open the test file first and mirror its real `AgentRoutingConfig` fixture shape — the `profiles`/`default` layout above is indicative, the real one is whatever `resolveAgentAssignment`'s existing tests construct.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/unit/agents/shared/agent-profile-resolver.test.ts --timeout=30000`
Expected: FAIL — wrong arity / `profileModelTier: "claude-opus-5-1"` in the pin case.

- [ ] **Step 3: Implement the resolver split** — new `toAssignment` in `agent-profile-resolver.ts`:

```ts
import type { AgentRoutingConfig, AgentRoutingProfile, ModelsConfig, ModelTier } from "@/config";
import { resolveTierMembership } from "@/config";
import { getSafeLogger } from "@/logger";

const NATIVE_AGENT = "native";

function toAssignment(p: AgentRoutingProfile, models: ModelsConfig, defaultAgent: string): ResolvedAgentAssignment {
  const membership = resolveTierMembership(models, p.target.agent, p.target.model, defaultAgent);
  if (!membership.isTier) {
    return { agent: p.target.agent, agentProfileId: p.id, profileModelPin: p.target.model };
  }
  if (membership.viaDefaultAgentFallback && (p.target.agent === NATIVE_AGENT) !== (defaultAgent === NATIVE_AGENT)) {
    // Spec §2 step 2: the fallback-resolved entry may name a provider this agent's protocol cannot serve.
    getSafeLogger()?.warn("routing", "Profile tier resolves only via the default agent across a protocol boundary", {
      profileId: p.id,
      agent: p.target.agent,
      tier: p.target.model,
      defaultAgent,
    });
  }
  return { agent: p.target.agent, agentProfileId: p.id, profileModelTier: p.target.model };
}
```

Widen `resolveAgentAssignment` to accept and thread `models` + `defaultAgent` into both existing `toAssignment(...)` call sites (selected profile and default profile). Update `ResolvedAgentAssignment` as in Interfaces.

- [ ] **Step 4: Add the `StoryRouting` fields** in `src/prd/types.ts`, next to `profileModelTier` (line ~116) and `initialModelTier`:

```ts
  /** Literal model pinned by the matched profile's target — set at plan time; mutually exclusive with profileModelTier (plan C spec §4). */
  profileModelPin?: string;
  /** Pin at first route — written once, never overwritten by escalation. */
  initialModelPin?: string;
```

- [ ] **Step 5: Write the failing finalize-routing test** — in `test/unit/plan/strategies/finalize-routing.test.ts` (update existing calls for the new signature):

```ts
test("a pinned profile persists profileModelPin, never a fake tier (spec §4)", () => {
  // Build a PRD whose story carries routing.agentProfileId "p1", and an agentRouting
  // whose p1 targets { agent: "claude", model: "claude-opus-5-1" } — reuse the file's fixtures.
  const out = finalizePrdRouting(prd, agentRouting, "custom", models, "claude");
  const routing = out.userStories[0].routing;
  expect(routing?.profileModelPin).toBe("claude-opus-5-1");
  expect(routing?.initialModelPin).toBe("claude-opus-5-1");
  expect(routing?.profileModelTier).toBeUndefined();
  expect(routing?.initialModelTier).toBeUndefined();
});
```

- [ ] **Step 6: Verify it fails, then implement finalize-routing threading**

In `finalizePrdRouting` (new signature per Interfaces), pass `models, defaultAgent` into `resolveAgentAssignment`, and build the routing spread with the conditional-spread idiom so absent fields stay absent in `prd.json`:

```ts
    const routing = {
      ...story.routing,
      agent: assignment.agent,
      agentProfileId: assignment.agentProfileId,
      ...(assignment.profileModelTier !== undefined ? { profileModelTier: assignment.profileModelTier } : {}),
      ...(assignment.profileModelPin !== undefined ? { profileModelPin: assignment.profileModelPin } : {}),
      initialAgent: story.routing?.initialAgent ?? assignment.agent,
      initialProfileId: story.routing?.initialProfileId ?? assignment.agentProfileId,
      ...(story.routing?.initialModelTier ?? assignment.profileModelTier
        ? { initialModelTier: story.routing?.initialModelTier ?? assignment.profileModelTier }
        : {}),
      ...(story.routing?.initialModelPin ?? assignment.profileModelPin
        ? { initialModelPin: story.routing?.initialModelPin ?? assignment.profileModelPin }
        : {}),
    } as StoryRouting;
```

Then fix the one src caller: `src/plan/strategies/persist-prd.ts:43`. Find its args type in the same file, add `models: ModelsConfig; defaultAgent: string;`, and update the call to `finalizePrdRouting({...}, args.agentRouting, args.profileName, args.models, args.defaultAgent)`. Find *its* callers with `grep -rn "persistPrd\|PersistArgs" src --include="*.ts"` and thread `config.models` / `config.agent?.default ?? "claude"` from the `NaxConfig` each already has in scope (the plan strategies all receive config).

- [ ] **Step 7: Write the pipeline regression test** — append to `test/unit/pipeline/stages/routing-profile-tier.test.ts`:

```ts
test("a profileModelPin does not poison tier selection — derived tier wins (spec §4)", async () => {
  // Reuse the file's routing-stage harness. Story routing fixture:
  //   { agent: "claude", agentProfileId: "p1", profileModelPin: "claude-opus-5-1", complexity: "simple", ... }
  // with NO profileModelTier. Assert the resolved story.routing.modelTier equals the
  // complexity-derived tier (e.g. "fast" for simple under the default complexityRouting),
  // NOT "claude-opus-5-1".
});
```

Write it as a real test against the file's existing harness (it already routes stories with `profileModelTier` fixtures — copy the nearest test and swap the fixture).

- [ ] **Step 8: Run all touched test files + gates**

Run: `bun test test/unit/agents/shared/agent-profile-resolver.test.ts test/unit/plan/strategies/finalize-routing.test.ts test/unit/pipeline/stages/routing-profile-tier.test.ts --timeout=30000 && bun run typecheck && bun run lint`
Expected: PASS / clean. Also run `bun run test` once here — the signature change ripples through any test constructing these functions.

- [ ] **Step 9: Commit**

```bash
git add src/agents/shared/agent-profile-resolver.ts src/prd/types.ts src/plan/strategies/finalize-routing.ts src/plan/strategies/persist-prd.ts test/unit/agents/shared/agent-profile-resolver.test.ts test/unit/plan/strategies/finalize-routing.test.ts test/unit/pipeline/stages/routing-profile-tier.test.ts
git commit -m "feat(routing): record a profile's literal model as a pin, not a tier

profileModelPin/initialModelPin survive into prd.json under their true name;
profileModelTier is set only when the target names a real tier. Spec §4."
```

(If Step 6's grep touched more files, add them.)

---

### Task 3: Rank from the ladder (spec §5)

**Files:**
- Modify: `src/routing/operating-tier.ts` (full rewrite below — delete `TIER_RANK`)
- Modify: `src/pipeline/stages/routing.ts:42-47` (thread rung inputs)
- Modify: `src/execution/executor-types.ts:100-105` (thread rung inputs)
- Test: `test/unit/routing/operating-tier.test.ts`, `test/unit/execution/executor-types.test.ts`

**Interfaces:**
- Consumes: `TierConfig` from `@/config` (Task 4 consumes `derivedAgent`).
- Produces:
  ```ts
  export interface OperatingTierInput {
    previousTier?: string;
    previousAgent?: string;   // pairs with previousTier — escalation persists both
    profileTier?: string;
    profileAgent?: string;    // the profile assignment's agent
    derivedTier: string;
    derivedAgent?: string;    // set by rung-qualified complexityRouting (Task 4); callers pass undefined until then
    hasEscalationRecords: boolean;
    tierOrder?: TierConfig[]; // absent/empty ⇒ nothing is rankable; only records keep previousTier
  }
  // OperatingTierResult unchanged: { tier, isEscalated, candidateTier, unknownPreviousTier }
  ```

- [ ] **Step 1: Rewrite the failing tests** — `test/unit/routing/operating-tier.test.ts`. Update every existing test to pass the builtin ladder explicitly, and add the new cases:

```ts
const BUILTIN_LADDER = [
  { tier: "fast", attempts: 1 },
  { tier: "balanced", attempts: 1 },
  { tier: "powerful", attempts: 1 },
];
const CUSTOM_LADDER = [
  { tier: "cheap", attempts: 3, agent: "native" },
  { tier: "balanced", attempts: 2, agent: "native" },
  { tier: "balanced", attempts: 2, agent: "claude" },
  { tier: "powerful", attempts: 1, agent: "claude" },
];

// Existing tests: add `tierOrder: BUILTIN_LADDER` to each input; assertions unchanged
// (byte-compatibility bar — the builtin ladder's indices equal the old TIER_RANK).

describe("ladder-derived rank (spec §5)", () => {
  test("recordless higher custom rung is kept", () => {
    const r = resolveOperatingTier({
      previousTier: "balanced", previousAgent: "native",
      derivedTier: "cheap", derivedAgent: "native",
      hasEscalationRecords: false, tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced");
    expect(r.isEscalated).toBe(true);
  });

  test("recordless lower custom rung is discarded", () => {
    const r = resolveOperatingTier({
      previousTier: "cheap", previousAgent: "native",
      derivedTier: "balanced", derivedAgent: "native",
      hasEscalationRecords: false, tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced");
    expect(r.isEscalated).toBe(false);
  });

  test("same tier name ranks by rung, not by name", () => {
    const r = resolveOperatingTier({
      previousTier: "balanced", previousAgent: "claude",
      profileTier: "balanced", profileAgent: "native",
      derivedTier: "cheap",
      hasEscalationRecords: false, tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced"); // claude/balanced (idx 2) beats native/balanced (idx 1)
    expect(r.isEscalated).toBe(true);
  });

  test("escalation record wins regardless of rank (#1522 sideways/down)", () => {
    const r = resolveOperatingTier({
      previousTier: "cheap", previousAgent: "native",
      derivedTier: "powerful", derivedAgent: "claude",
      hasEscalationRecords: true, tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("cheap");
    expect(r.isEscalated).toBe(true);
  });

  test("off-ladder recordless previous rung is discarded and flagged", () => {
    const r = resolveOperatingTier({
      previousTier: "ultra", previousAgent: "native",
      derivedTier: "cheap", derivedAgent: "native",
      hasEscalationRecords: false, tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("cheap");
    expect(r.unknownPreviousTier).toBe(true);
  });

  test("absent ladder: nothing is rankable, records still win", () => {
    const recordless = resolveOperatingTier({
      previousTier: "powerful", derivedTier: "fast", hasEscalationRecords: false,
    });
    expect(recordless.tier).toBe("fast");
    expect(recordless.unknownPreviousTier).toBe(true);
    const recorded = resolveOperatingTier({
      previousTier: "powerful", derivedTier: "fast", hasEscalationRecords: true,
    });
    expect(recorded.tier).toBe("powerful");
  });

  test("agentless tier on an agent-qualified ladder ranks at first name match", () => {
    const r = resolveOperatingTier({
      previousTier: "balanced", // no previousAgent
      derivedTier: "cheap", derivedAgent: "native",
      hasEscalationRecords: false, tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced"); // first "balanced" = idx 1 > cheap idx 0
    expect(r.isEscalated).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `bun test test/unit/routing/operating-tier.test.ts --timeout=30000`
Expected: FAIL — `tierOrder` unknown property errors / custom tiers unranked under the old `TIER_RANK`.

- [ ] **Step 3: Rewrite `src/routing/operating-tier.ts`**

Keep the file's header comment (the #1575 two-callers rationale) and the doc comments on the precedence rules (#1522, Open Item B) — they are load-bearing. Replace `TIER_RANK` and the function bodies:

```ts
import type { TierConfig } from "@/config";

/** Rank = the rung's index in tierOrder. Agent-qualified tuple match when the ladder has agent rungs. */
function rankRung(tierOrder: TierConfig[], tier: string, agent: string | undefined): number | undefined {
  const hasAgentRungs = tierOrder.some((r) => r.agent !== undefined);
  const i =
    hasAgentRungs && agent !== undefined
      ? tierOrder.findIndex((t) => t.tier === tier && t.agent === agent)
      : tierOrder.findIndex((t) => t.tier === tier);
  return i === -1 ? undefined : i;
}

export function resolveOperatingTier(input: OperatingTierInput): OperatingTierResult {
  const { previousTier, previousAgent, profileTier, profileAgent, derivedTier, derivedAgent, hasEscalationRecords } =
    input;
  const tierOrder = input.tierOrder ?? [];

  const candidateTier = profileTier ?? derivedTier;
  const candidateAgent = profileTier !== undefined ? profileAgent : derivedAgent;
  const candidateRank = rankRung(tierOrder, candidateTier, candidateAgent);
  const previousRank = previousTier !== undefined ? rankRung(tierOrder, previousTier, previousAgent) : undefined;

  const isEscalated =
    previousTier !== undefined &&
    (hasEscalationRecords ||
      (previousRank !== undefined && candidateRank !== undefined && previousRank > candidateRank));

  return {
    tier: isEscalated ? previousTier : candidateTier,
    isEscalated,
    candidateTier,
    unknownPreviousTier: previousTier !== undefined && previousRank === undefined && !hasEscalationRecords,
  };
}
```

(`OperatingTierInput` per Interfaces; the tuple-matching rule in `rankRung` deliberately mirrors `getTierConfig`/`escalateTier` in `src/execution/escalation/escalation.ts:43-60` — note that in the doc comment.)

- [ ] **Step 4: Thread the callers**

`src/pipeline/stages/routing.ts` (the `resolveOperatingTier` call at ~42):

```ts
    const operating = resolveOperatingTier({
      previousTier: ctx.story.routing?.modelTier,
      // Escalation persists agent alongside modelTier (tier-escalation.ts) — they travel as a rung.
      previousAgent: ctx.story.routing?.agent,
      profileTier: ctx.story.routing?.profileModelTier,
      // initialAgent is the profile-time agent (written once, never moved by escalation);
      // routing.agent may already be a post-escalation agent.
      profileAgent: ctx.story.routing?.initialAgent ?? ctx.story.routing?.agent,
      derivedTier: decision.modelTier,
      hasEscalationRecords,
      tierOrder: ctx.config.autoMode?.escalation?.tierOrder,
    });
```

`src/execution/executor-types.ts` `buildPreviewRouting` (~100): the same six fields, sourced from `cached` and `config` (`previousAgent: cached?.agent`, `profileAgent: cached?.initialAgent ?? cached?.agent`, `tierOrder: config.autoMode?.escalation?.tierOrder`).

- [ ] **Step 5: Add the #1575 parity test** — append to `test/unit/execution/executor-types.test.ts`:

```ts
test("#1575 parity: preview honours a custom-ladder escalation", () => {
  // config with autoMode.escalation.tierOrder = CUSTOM_LADDER (reuse the file's config factory)
  // story with routing: { modelTier: "balanced", agent: "claude", profileModelTier: "cheap",
  //   initialAgent: "native", complexity: "medium", ... } and one escalations[] record.
  const preview = buildPreviewRouting(story, config);
  expect(preview.modelTier).toBe("balanced"); // record wins; a name-ranked or TIER_RANK preview would discard it
});
```

- [ ] **Step 6: Run the touched suites and the full routing/pipeline suites**

Run: `bun test test/unit/routing/ test/unit/execution/executor-types.test.ts test/unit/pipeline/stages/ --timeout=30000 && bun run typecheck && bun run lint`
Expected: PASS. Existing routing-stage tests must pass unchanged (they use builtin tiers and the DEFAULT_CONFIG ladder `[fast, balanced, powerful]`, whose indices equal the old `TIER_RANK` — this IS the byte-compatibility check).

- [ ] **Step 7: Commit**

```bash
git add src/routing/operating-tier.ts src/pipeline/stages/routing.ts src/execution/executor-types.ts test/unit/routing/operating-tier.test.ts test/unit/execution/executor-types.test.ts
git commit -m "feat(routing): rank operating tiers by tierOrder rung index, delete TIER_RANK

Rungs (tier, agent) rank by ladder position — custom tiers and cross-agent
ladders become rankable; both #1575 callers move in lockstep. Spec §5."
```

---

### Task 4: Rung-qualified complexityRouting (spec §6)

**Files:**
- Modify: `src/config/schemas-execution.ts:11-16` (value schema)
- Modify: `src/config/runtime-types.ts:38` (**net-zero edit** — the file is 578 lines and the file-size gate refuses growth: change the type on the existing line, declare `ComplexityRung` in `src/config/schema-types.ts` and import it via the existing type-import line if one exists; if a new import line is unavoidable, remove a blank line in the same file to stay net-zero)
- Modify: `src/routing/router.ts:100-103` (+ new `complexityToRungAgent`), `src/routing/index.ts` (export)
- Modify: `src/pipeline/stages/routing.ts` (agent seeding + `derivedAgent`)
- Modify: `src/execution/executor-types.ts` (`derivedAgent` in the preview)
- Modify: `src/config/validate.ts:130-138` (object-form validation)
- Test: `test/unit/config/schemas.test.ts`, `test/unit/routing/routing-core.test.ts`, `test/unit/pipeline/stages/default-agent-routing.test.ts`, `test/unit/config/validate.test.ts`

**Interfaces:**
- Consumes: `derivedAgent` input from Task 3.
- Produces:
  ```ts
  // schema-types.ts
  export type ComplexityRung = ModelTier | { tier: ModelTier; agent?: string };
  // router.ts
  export function complexityToModelTier(complexity: Complexity, config: RoutingConfig): ModelTier; // unchanged signature
  export function complexityToRungAgent(complexity: Complexity, config: RoutingConfig): string | undefined;
  ```

- [ ] **Step 1: Write the failing schema + router tests**

`test/unit/config/schemas.test.ts` (append, using the file's schema-parse helpers):

```ts
test("complexityRouting accepts rung objects and bare tiers (spec §6)", () => {
  const parsed = parseConfigWith({ autoMode: { ...base.autoMode, complexityRouting: {
    simple: { tier: "cheap", agent: "native" },
    medium: { tier: "balanced", agent: "native" },
    complex: { tier: "balanced", agent: "claude" },
    expert: "powerful",
  }}});
  expect(parsed.success).toBe(true);
});

test("complexityRouting rung rejects an empty agent", () => {
  const parsed = parseConfigWith({ autoMode: { ...base.autoMode, complexityRouting: {
    ...base.autoMode.complexityRouting, simple: { tier: "cheap", agent: "" },
  }}});
  expect(parsed.success).toBe(false);
});
```

`test/unit/routing/routing-core.test.ts` (append):

```ts
test("complexityToModelTier unwraps rung objects; complexityToRungAgent reads the agent (spec §6)", () => {
  const config = makeRoutingConfig({ complexityRouting: {
    simple: { tier: "cheap", agent: "native" }, medium: "balanced", complex: "balanced", expert: "powerful",
  }});
  expect(complexityToModelTier("simple", config)).toBe("cheap");
  expect(complexityToRungAgent("simple", config)).toBe("native");
  expect(complexityToModelTier("medium", config)).toBe("balanced");
  expect(complexityToRungAgent("medium", config)).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail** (`bun test test/unit/config/schemas.test.ts test/unit/routing/routing-core.test.ts --timeout=30000`)

- [ ] **Step 3: Implement schema, type, router**

`schemas-execution.ts`:

```ts
const ComplexityRungSchema = z.union([
  ModelTierSchema,
  z.object({ tier: ModelTierSchema, agent: z.string().min(1, "agent must be non-empty").optional() }),
]);
// complexityRouting: { simple: ComplexityRungSchema, medium: ..., complex: ..., expert: ... }
```

`schema-types.ts`: `export type ComplexityRung = ModelTier | { tier: ModelTier; agent?: string };` (re-export through the config barrels like Task 1's exports). `runtime-types.ts:38` becomes `complexityRouting: Record<Complexity, ComplexityRung>;` — net-zero, see Files note.

`router.ts`:

```ts
export function complexityToModelTier(complexity: Complexity, config: RoutingConfig): ModelTier {
  const entry = config.autoMode.complexityRouting[complexity];
  if (entry === undefined) return "balanced"; // degrade-don't-throw display default (spec §7)
  return typeof entry === "string" ? entry : entry.tier;
}

/** Agent named by a rung-qualified complexityRouting entry; undefined for the string form. */
export function complexityToRungAgent(complexity: Complexity, config: RoutingConfig): string | undefined {
  const entry = config.autoMode.complexityRouting[complexity];
  return typeof entry === "object" ? entry.agent : undefined;
}
```

Export `complexityToRungAgent` from `src/routing/index.ts` next to `complexityToModelTier` (line 25).

- [ ] **Step 4: Verify Step 1's tests pass, then wire the routing stage**

In `src/pipeline/stages/routing.ts`:

```ts
    // Spec §6: an unprofiled story starts on the rung complexityRouting names.
    // Precedence: PRD-assigned agent (plan-time profile) > run-time classifier > complexity rung.
    const rungAgent = complexityToRungAgent(decision.complexity, ctx.config);
    const routing = { ...decision, modelTier, agent: ctx.story.routing?.agent ?? decision.agent ?? rungAgent };
```

and add `derivedAgent: rungAgent` to the `resolveOperatingTier` input (Task 3's call). Hoist `rungAgent` above that call. In `buildPreviewRouting`, pass `derivedAgent: config.autoMode?.complexityRouting ? complexityToRungAgent(complexity, config) : undefined`.

- [ ] **Step 5: Write the failing pipeline test** — append to `test/unit/pipeline/stages/default-agent-routing.test.ts`, mirroring its harness:

```ts
test("unprofiled story routes to the complexity rung's agent (spec §6)", async () => {
  // config: complexityRouting.simple = { tier: "cheap", agent: "native" }, models.native.cheap defined,
  // story with NO routing.agent and NO agentProfileId, classified simple.
  // Assert story.routing.agent === "native" and story.routing.modelTier === "cheap".
});

test("profiled story ignores the complexity rung's agent", async () => {
  // same config; story.routing.agent = "claude" (profile-assigned).
  // Assert story.routing.agent stays "claude".
});
```

- [ ] **Step 6: Verify they fail → wiring from Step 4 makes them pass**

Run: `bun test test/unit/pipeline/stages/default-agent-routing.test.ts --timeout=30000`

- [ ] **Step 7: Validation for the object form** — in `src/config/validate.ts`, extend the existing complexityRouting block (~130-138) to handle both forms:

```ts
  const defaultAgentKey = config.agent?.default ?? "claude";
  const complexities = ["simple", "medium", "complex", "expert"] as const;
  for (const complexity of complexities) {
    const entry = config.autoMode.complexityRouting[complexity];
    if (entry === undefined) continue;
    const tier = typeof entry === "string" ? entry : entry.tier;
    const owner = typeof entry === "string" ? defaultAgentKey : (entry.agent ?? defaultAgentKey);
    if (typeof entry === "object" && entry.agent !== undefined && !config.models[entry.agent]) {
      errors.push(`complexityRouting.${complexity}: agent "${entry.agent}" is not a key in models`);
      continue;
    }
    if (!Object.keys(config.models[owner] ?? {}).includes(tier)) {
      errors.push(`complexityRouting.${complexity}: tier "${tier}" not found under agent "${owner}"`);
    }
  }
```

(Adapt to the block's existing error-message style; keep the string-form messages byte-identical if tests pin them.) Add validate tests: object rung with unknown agent → error; object rung whose tier is missing under its agent → error; valid object rung → no error.

- [ ] **Step 8: Run all touched suites + gates + full test**

Run: `bun test test/unit/config/ test/unit/routing/ test/unit/pipeline/stages/ test/unit/execution/executor-types.test.ts --timeout=30000 && bun run typecheck && bun run lint && bun run test`
Expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
git add src/config/schemas-execution.ts src/config/schema-types.ts src/config/runtime-types.ts src/config/schema.ts src/config/types.ts src/config/index.ts src/routing/router.ts src/routing/index.ts src/pipeline/stages/routing.ts src/execution/executor-types.ts src/config/validate.ts test/unit/config/schemas.test.ts test/unit/config/validate.test.ts test/unit/routing/routing-core.test.ts test/unit/pipeline/stages/default-agent-routing.test.ts
git commit -m "feat(routing): complexityRouting entries may name a cross-agent rung

string form unchanged (defaultAgent); { tier, agent } places unprofiled
stories on the ladder's cheap rungs. Spec §6."
```

---

### Task 5: Contracts pinned by tests (spec §7)

**Files:**
- Create: `test/unit/execution/escalation/tier-escalation-off-ladder.test.ts`
- Modify: `test/unit/operations/build-hop-callback-tier.test.ts` (only if the case below is missing)
- Modify (comments only): `src/operations/call.ts:69`, `src/routing/router.ts` (`?? "balanced"`), `src/execution/executor-types.ts:99`
- Modify: `src/pipeline/stages/routing.ts` (off-ladder profile warning)

**Interfaces:**
- Consumes: everything from Tasks 3-4; existing escalation test harness (mirror `test/unit/execution/escalation/per-tier-budget.test.ts` fixtures — do not hand-roll new mocks, see `.nax/rules/test-helpers.md`).
- Produces: nothing new — this task pins existing behaviour.

- [ ] **Step 1: Write the off-ladder contract tests** in the new file, reusing `per-tier-budget.test.ts`'s story/config fixtures:

```ts
describe("off-ladder start = fixed rung, no escalation (spec §7)", () => {
  test("off-ladder rung: budget-unbounded warning, never escalates", async () => {
    // config.autoMode.escalation.tierOrder = CUSTOM_LADDER (native-only rungs);
    // story.routing = { modelTier: "powerful", agent: "claude", ... }, attempts well past any budget.
    // Run checkPreIterationEscalation: expect shouldSkipIteration false, prd NOT dirtied,
    // story NOT escalated, and the "escalation budget is unbounded" warning logged once.
  });

  test("attempts === 0 short-circuits before any rung judgement (#1575 guard)", async () => {
    // Same off-ladder story with attempts: 0 → returns { shouldSkipIteration: false, prdDirty: false }
    // without logging the unbounded warning (the early return fires first).
  });
});
```

Write these as real tests against the harness; the comments above are the required assertions, not placeholders to leave in.

- [ ] **Step 2: Run — these should PASS immediately** (they pin existing behaviour): `bun test test/unit/execution/escalation/tier-escalation-off-ladder.test.ts --timeout=30000`. If either FAILS, stop: Task 3/4 broke a contract — fix that regression before proceeding.

- [ ] **Step 3: Check pin-swap precedence coverage**

Run: `grep -n "balanced" test/unit/operations/build-hop-callback-tier.test.ts`
The plan-3 suite should already cover "fallback-map `{ agent, tier }` wins on swap". If the **tierless-pin falls back to `"balanced"`** case is absent, add:

```ts
test("a tierless pinned resolution swaps onto the target's balanced rung (spec §7 last resort)", async () => {
  // hop ctx with effectiveTier "balanced" (the call.ts:69 default for a pin, modelTier absent),
  // swap to an agent with a balanced entry, no fallback-map tier for the candidate.
  // Assert the dispatched modelDef is the swap target's balanced entry.
});
```

- [ ] **Step 4: Annotate the last-resort defaults** (comments only, no behaviour):
  - `src/operations/call.ts:69`: `// Pin default: a pinned (tierless) resolution swaps via "balanced" unless the fallback map names a tier (spec §7).`
  - `src/routing/router.ts` `?? "balanced"` and `src/execution/executor-types.ts:99`: `// degrade-don't-throw display/last-resort default (plan C spec §7)` (Task 4 already added router.ts's — verify, don't duplicate).

- [ ] **Step 5: Off-ladder profile warning at first route** — in `src/pipeline/stages/routing.ts`, after the `resolveOperatingTier` call:

```ts
    const ladder = ctx.config.autoMode?.escalation?.tierOrder ?? [];
    if (
      ctx.story.routing?.profileModelTier !== undefined &&
      ladder.length > 0 &&
      !operating.isEscalated &&
      operating.tier === ctx.story.routing.profileModelTier &&
      !ladder.some((t) => t.tier === operating.tier)
    ) {
      logger?.warn("routing", "Profile targets a rung not on tierOrder — this story will never escalate", {
        storyId: ctx.story.id,
        profileTier: ctx.story.routing.profileModelTier,
        agent: ctx.story.routing?.agent,
      });
    }
```

Add a pipeline test for it in `routing-profile-tier.test.ts` (profile tier absent from the ladder ⇒ warning logged; present ⇒ silent).

- [ ] **Step 6: Run + gates + commit**

```bash
bun test test/unit/execution/escalation/ test/unit/operations/build-hop-callback-tier.test.ts test/unit/pipeline/stages/routing-profile-tier.test.ts --timeout=30000 && bun run typecheck && bun run lint
git add test/unit/execution/escalation/tier-escalation-off-ladder.test.ts test/unit/operations/build-hop-callback-tier.test.ts src/operations/call.ts src/routing/router.ts src/execution/executor-types.ts src/pipeline/stages/routing.ts test/unit/pipeline/stages/routing-profile-tier.test.ts
git commit -m "test(escalation): pin the off-ladder and pin-swap contracts; warn on off-ladder profiles

Off-ladder start = fixed rung + no escalation (attempts===0 guard preserved);
fallback-map tier beats the balanced last resort. Spec §7."
```

---

### Task 6: Ladder validation (spec §8)

**Files:**
- Modify: `src/config/validate.ts` (extend the tierOrder block at ~117-127)
- Test: `test/unit/config/validate.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: two new validation errors; no API change.

- [ ] **Step 1: Write the failing tests** — append to `test/unit/config/validate.test.ts` (reuse its config factory):

```ts
describe("tierOrder rungs resolve in their own agent's map (spec §8)", () => {
  test("rung tier missing under its own agent is an error", () => {
    const config = makeValidConfig({
      models: { claude: builtinTiers, native: { cheap: "opencode-go/deepseek-v4-flash" } },
      tierOrder: [{ tier: "balanced", attempts: 2, agent: "native" }], // native has no balanced
    });
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain('tier "balanced" does not resolve under agent "native"');
  });

  test("agentless rung resolves against the default agent", () => {
    const config = makeValidConfig({ tierOrder: [{ tier: "fast", attempts: 2 }] });
    expect(validateConfig(config).valid).toBe(true);
  });

  test("rung resolving in its own agent map passes", () => {
    const config = makeValidConfig({
      models: { claude: builtinTiers, native: { cheap: "opencode-go/deepseek-v4-flash" } },
      tierOrder: [{ tier: "cheap", attempts: 3, agent: "native" }],
    });
    expect(validateConfig(config).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify the first test fails** (`bun test test/unit/config/validate.test.ts --timeout=30000`)

- [ ] **Step 3: Implement** — inside the existing `tierOrder` validation block (`validate.ts:117-127`), after the agent-key check:

```ts
      // Spec §8: a rung must resolve within its OWN agent's map — resolveModelForAgent's
      // defaultAgent fallback is a runtime safety net, not a rung licence; relying on it
      // ships a config typo that only surfaces mid-run.
      const owner = tc.agent ?? (config.agent?.default ?? "claude");
      const ownerMap = config.models[owner];
      if (ownerMap && ownerMap[tc.tier] === undefined) {
        errors.push(
          `autoMode.escalation.tierOrder: tier "${tc.tier}" does not resolve under agent "${owner}" (its own map)`,
        );
      }
```

(When `ownerMap` is absent the existing agent-key error already fired — do not double-report.)

- [ ] **Step 4: Run + gates + full suite + coverage**

Run: `bun test test/unit/config/validate.test.ts --timeout=30000 && bun run typecheck && bun run lint && bun run test && bun run test:coverage`
Expected: all clean. `test:coverage` matters here — this plan added test files, and the per-file floor is a separate CI gate.

- [ ] **Step 5: Commit**

```bash
git add src/config/validate.ts test/unit/config/validate.test.ts
git commit -m "feat(config): validate tierOrder rungs against their own agent's model map

Spec §8 — the defaultAgent fallback stays a runtime safety net, not a rung licence."
```

---

## Final verification (spec §11)

- [ ] `bun run test` — full suite green.
- [ ] `bun run typecheck && bun run lint` — clean.
- [ ] `bun run test:coverage` — per-file floor holds.
- [ ] Byte-compatibility spot-check: `grep -rn "TIER_RANK" src/` returns nothing; no test file still references it.
- [ ] The spec's §9 do-not-touch list: `git diff main --stat` shows no changes to `build-hop-callback.ts` beyond Task 5's comment (if any), none to `escalation.ts`.
