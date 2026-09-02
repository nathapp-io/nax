# Plan C — Tier-or-Model Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `{ agent, model }` mean "a tier when the string names a tier for that agent, a literal model otherwise" everywhere it appears, derive tier ordering from `tierOrder` instead of the hardcoded `TIER_RANK`, and let `complexityRouting` place stories on cross-agent rungs.

**Architecture:** Three derivations replace hardcoded builtin-name lists: tier *identity* from membership in `models[agent]` (fallback-inclusive), tier *ordering* from rung index in `autoMode.escalation.tierOrder`, and initial *placement* from rung-qualified `complexityRouting`. Plus two existing behaviours pinned as contracts (off-ladder = no escalation; pin-swap tier precedence) and validation that every ladder rung resolves in its own agent's map.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, Zod config schemas, Biome.

**Spec:** `docs/superpowers/specs/2026-09-02-plan-c-tier-or-model-resolution-design.md` — read it first; tasks cite its sections.

> **Revision 2 (2026-09-02)** — reviewed against the working tree at `b2b07335c`. Seven corrections
> applied: the real file-size gate is 600/800 (no net-zero editing needed anywhere); Task 4's pipeline
> tests moved to `routing-profile-tier.test.ts` (the file they named does not exist); every test-helper
> name replaced with the real one (`makeNaxConfig`, `cfg`, `baseConfig`/`withTierOrder`); Task 2 gained
> the second `finalizeAndWritePrd` call site and a `decompose-mapper.ts` step that keeps a pin from
> decaying to `"balanced"`; Task 4's validation step moved ahead of its pipeline tests; and the
> string-form `complexityRouting` error message is now pinned byte-identical.
> **Revision 3 (2026-09-02)** — second review pass. Three corrections: (1) revision 2's Task 2 Step 7
> seeded substory `modelTier` with the PIN LITERAL — that re-creates the pin-disguised-as-tier defect
> at substory level and makes dispatch throw `MODEL_NOT_FOUND` (`resolveModelForAgent` treats
> `modelTier` as a tier key); the seed stays tier-only and the pin travels via its own fields.
> (2) The profile↔ladder binding superRefine (`src/config/schemas.ts:522-534`, ADR-025 §4) hard-errors
> any profile target with no matching rung — a literal-model pin target can NEVER match a rung, so
> without relaxing it Task 2's pin feature is unloadable; new Step 7b relaxes it (tier targets keep the
> error, pin targets are exempt) and amends ADR-025 §4/§5. (3) Task 6 was a HALF-DUPLICATE gate:
> `schemas.ts:512-517` already hard-errors an agent-qualified rung whose tier is missing under its own
> agent — the genuine gap is only the AGENTLESS rung vs the default agent's map; Task 6 narrowed.
> Also: Task 5's off-ladder warning covers PERSISTED PRD state (stale/legacy rungs) — an in-config
> tier-naming profile target can't be off-ladder, the schema rejects it first.
> Verified-correct and NOT to be re-checked: every `src/` line reference lands; `ModelTier` is
> `"fast" | "balanced" | "powerful" | (string & {})` so `ComplexityRung` is expressible;
> `ModelTierSchema` is `z.string().min(1)`, not an enum, so the Zod union is sound; the inline-`require`
> idiom is at `schema-types.ts:140`; `resolveModel`'s `"unknown"` is at `:158`; all three tier tests in
> `executor-types.test.ts` survive deleting `TIER_RANK`; the repo's own `.nax/config.json` ladder is
> agentless, so Task 6's new validation does not break it. `isBuiltinModelTier` becomes an unused
> export after Task 1 — there is no knip gate, so leave it or delete it, either is fine.

## Global Constraints

- **No new builtin tier names.** `fast`/`balanced`/`powerful` stay defaults-only; the open keyspace does the rest (spec §1).
- **Never touch:** `pinnedModelAgent` semantics (`src/operations/build-hop-callback.ts:304-306`), `MODEL_SHORTHAND_TIERS` contents/precedence, `escalateTier`/budget mechanics, the absent-`modelTier`-on-pin design (nax#1739) (spec §9).
- **The `attempts === 0` early return in `checkPreIterationEscalation` (`src/execution/escalation/tier-escalation.ts:145-155`) must survive verbatim** — its `@design` comment explains why (#1575).
- **Byte-compatibility bar:** a config using only builtin tiers, no custom tiers, no object-form `complexityRouting` routes every story identically to before (spec §11).
- Project gates: **file-size ratchet = 600 lines for `src/**`, 800 for `test/**`** (`scripts/check-file-sizes.ts`); already-oversized files are grandfathered in `scripts/baselines/file-sizes-baseline.json` and may not GROW. Among the files this plan touches, only `src/execution/escalation/tier-escalation.ts` (603) is baselined — and this plan does not change it. `src/config/runtime-types.ts` (578) and `src/routing/router.ts` (400) are UNDER the limit and may grow normally; no net-zero editing is required anywhere. Functions ≤30 lines; conventional commits; `bun test <file> --timeout=30000` for targeted runs; `bun run test` + `bun run typecheck` + `bun run lint` before each commit; `bun run test:coverage` after tasks that add test files.
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
    const config = makeNaxConfig({ plan: { model: { agent: "claude", model: "turbo" } } });
    const r = resolvePlanModelSelection(config, "claude");
    expect(r.modelTier).toBe("balanced");
  });

  test("legitimate provider-qualified pin passes through untouched", () => {
    const config = makeNaxConfig({ plan: { model: { agent: "claude", model: "opencode-go/qwen-4" } } });
    const r = resolvePlanModelSelection(config, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.model).toBe("opencode-go/qwen-4");
  });
});
```

(`makeNaxConfig` is already imported at `test/unit/cli/plan-runtime.test.ts:9` from `@test/helpers` — use it; do not hand-roll a config, see `.nax/rules/test-helpers.md`.)

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
- Modify: `src/plan/strategies/persist-prd.ts:43` + `PersistPrdArgs` (thread `models` + `defaultAgent`)
- Modify: `src/cli/plan-command.ts:213` (the **second** `finalizeAndWritePrd` call site — see Step 6)
- Modify: `src/prd/decompose-mapper.ts` (param type ~32 + two pin spreads — see Step 7; `modelTier` seed UNCHANGED)
- Modify: `src/config/schemas.ts:522-534` (binding gate relaxed for pin targets — see Step 7b)
- Modify: `docs/adr/ADR-025-agent-routing-and-cross-agent-escalation.md` §4/§5, `docs/adr/ADR-027-adapter-protocol-split.md` §7 (amendments — see Step 7b)
- Test: `test/unit/agents/shared/agent-profile-resolver.test.ts`, `test/unit/plan/strategies/finalize-routing.test.ts`, `test/unit/pipeline/stages/routing-profile-tier.test.ts`, `test/unit/config/schemas.test.ts`, the decompose-mapper suite

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

Then fix the one `finalizePrdRouting` call site, `src/plan/strategies/persist-prd.ts:43` (inside
`finalizeAndWritePrd`). Add `readonly models: ModelsConfig;` and `readonly defaultAgent: string;` to
**`PersistPrdArgs`** (line ~49 — note the real type name is `PersistPrdArgs`, not `PersistArgs`), and
update the call to `finalizePrdRouting({...}, args.agentRouting, args.profileName, args.models, args.defaultAgent)`.

🚨 **There are TWO entry points that build a `PersistPrdArgs`, not one.** `persistPrd(ctx, prd)` is the
strategies' wrapper, but `finalizeAndWritePrd` is exported and called directly by the CLI. Find both with:

```bash
grep -rn "finalizeAndWritePrd\|persistPrd\|PersistPrdArgs" src --include="*.ts"
```

Expected hits to update (verified on `b2b07335c`):
- `src/plan/strategies/persist-prd.ts:50` — `persistPrd`: thread `models: ctx.config.models`, `defaultAgent: ctx.config.agent?.default ?? "claude"`.
- `src/cli/plan-command.ts:213` — direct `finalizeAndWritePrd({...})` call: thread the same two from the `NaxConfig` in scope there.

A grep for `persistPrd` alone will NOT surface `plan-command.ts`, and `PersistArgs` matches nothing.

- [ ] **Step 7: Carry the pin through decompose** — `src/prd/decompose-mapper.ts`

🚨 **Do not skip this.** `mapDecomposedStoriesToUserStories` reads `profileModelTier` in three places.
Once Step 3 stops writing `profileModelTier` for a literal target, a substory of a **pinned** parent
would silently drop the pin — the parent's assignment must travel to its substories.

⛔ **The pin must NOT be written into `modelTier`.** `modelTier` is a rung name: dispatch resolves it
through `resolveModelForAgent(models, agent, tier)` (throws `MODEL_NOT_FOUND` for a literal model id)
and `resolveOperatingTier` ranks it. Writing the pin there re-creates at substory level exactly the
defect spec §4 removes. The `modelTier` seed stays **tier-only** (unchanged line ~76:
`parentRouting?.profileModelTier ?? story.routing?.profileModelTier ?? "balanced"` — a pinned parent's
substory seeds `"balanced"` and the routing stage derives its real tier from complexity, same as the
parent, per spec §4 "the pin is applied at model-resolution time, not at rung-selection time").

Widen the `parentRouting` param type (line ~32) and add the pin passthroughs:

```ts
  parentRouting?: Pick<
    StoryRouting,
    "agent" | "agentProfileId" | "profileModelTier" | "profileModelPin" | "initialAgent" | "initialProfileId"
  >,
```

Mirror the two existing `profileModelTier` conditional spreads (the `story.routing` baseline one and
the `parentRouting` override one) with `profileModelPin` ones, in the same override order:

```ts
        ...(story.routing?.profileModelPin !== undefined && { profileModelPin: story.routing.profileModelPin }),
        // (next to the parentRouting overrides:)
        ...(parentRouting?.profileModelPin !== undefined && { profileModelPin: parentRouting.profileModelPin }),
```

Test: add one case to the decompose-mapper suite — a parent carrying `profileModelPin` and no
`profileModelTier` produces substories whose `routing.profileModelPin` is the pin and whose
`routing.modelTier` is `"balanced"` (the tier-only seed), never the pin literal.
Find the suite with `grep -rln "mapDecomposedStoriesToUserStories" test/`.

- [ ] **Step 7b: Relax the profile↔ladder binding gate for pin targets + amend ADR-025**

🚨 **Without this, the pin feature is unloadable.** `NaxConfigSchema.superRefine`
(`src/config/schemas.ts:522-534`, implementing ADR-025 §4) hard-errors every profile whose
`target.(agent, model)` matches no `tierOrder` rung — and a literal-model pin target can never match a
rung, so any config that pins a model is rejected at load. The binding invariant is right for tier
targets (escalation from them needs a defined path) and meaningless for pins (a pinned story never
escalates by tier — nax#1739).

In the superRefine, gate the rung check on the tier question, using Task 1's resolver:

```ts
    for (const [pi, profile] of profiles.entries()) {
      const { agent: pAgent, model: pModel } = profile.target;
      // Plan C (spec §4): a target that names a tier must bind to a rung; a target that names a
      // literal model is a pin — exempt from binding, and exempt from tier escalation.
      const namesTier = resolveTierMembership(data.models ?? {}, pAgent, pModel, data.agent?.default ?? "claude").isTier;
      const hasMatchingRung = tierOrder.some((r) => r.tier === pModel && r.agent === pAgent);
      if (namesTier && !hasMatchingRung) {
        // ...existing addIssue unchanged...
      }
```

(Apply the shorthand alias first if `MODEL_SHORTHAND_TIERS[pModel.toLowerCase()]` maps — an aliased
target is a tier target. Keep the agent-exists check below it unconditional.)

Tests (`test/unit/config/schemas.test.ts`, next to the existing binding tests — find them with
`grep -rn "has no matching rung" test/ src/` and mirror their fixture): a profile pinning
`claude-opus-5-1` on an agent-qualified ladder parses successfully; a profile targeting a tier with no
matching rung still errors with the existing message.

Then amend the ADRs (same commit — the code and its governing invariant move together):
- `docs/adr/ADR-025-agent-routing-and-cross-agent-escalation.md` §4: after the binding bullet, add —
  "**Amended by plan C (2026-09-02):** the binding invariant applies to targets that name a *tier* for
  their agent (per the tier-or-model contract in
  `docs/superpowers/specs/2026-09-02-plan-c-tier-or-model-resolution-design.md` §2). A target that
  names a literal model is a **pin**: exempt from rung binding, recorded as `profileModelPin` (never as
  a tier), and excluded from tier escalation (nax#1739)."
- Same file §5, after the "PRD agent wins" bullet, add — "**Amended by plan C (2026-09-02):** when the
  PRD leaves agent unset and the classifier abstains, a rung-qualified `complexityRouting` entry may
  seed the agent (precedence: PRD agent → `decision.agent` → complexity-rung agent → default)."
- `docs/adr/ADR-027-adapter-protocol-split.md` §7 (custom tiers lose their attribution), append one
  line — "**Implemented by plan C** with two refinements: membership is fallback-inclusive
  (`models[agent]`, else `models[defaultAgent]`), and a non-tier object-form string resolves as a
  literal pin (warned when unrecognizable) rather than throwing."

- [ ] **Step 8: Write the pipeline regression test** — append to `test/unit/pipeline/stages/routing-profile-tier.test.ts`:

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

- [ ] **Step 9: Run all touched test files + gates**

Run: `bun test test/unit/agents/shared/agent-profile-resolver.test.ts test/unit/plan/strategies/finalize-routing.test.ts test/unit/pipeline/stages/routing-profile-tier.test.ts --timeout=30000 && bun run typecheck && bun run lint`
Expected: PASS / clean. Also run `bun run test` once here — the signature change ripples through any test constructing these functions.

- [ ] **Step 10: Commit**

```bash
git add src/agents/shared/agent-profile-resolver.ts src/prd/types.ts src/prd/decompose-mapper.ts src/plan/strategies/finalize-routing.ts src/plan/strategies/persist-prd.ts src/cli/plan-command.ts src/config/schemas.ts docs/adr/ADR-025-agent-routing-and-cross-agent-escalation.md docs/adr/ADR-027-adapter-protocol-split.md test/unit/agents/shared/agent-profile-resolver.test.ts test/unit/plan/strategies/finalize-routing.test.ts test/unit/pipeline/stages/routing-profile-tier.test.ts test/unit/config/schemas.test.ts
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
- Modify: `src/config/runtime-types.ts:38` (change the type on the existing line; declare `ComplexityRung` in `src/config/schema-types.ts` and import it. The file is 578 lines against a 600-line limit and is NOT baselined, so a normal import line is fine — do not contort to stay net-zero)
- Modify: `src/routing/router.ts:100-103` (+ new `complexityToRungAgent`), `src/routing/index.ts` (export)
- Modify: `src/pipeline/stages/routing.ts` (agent seeding + `derivedAgent`)
- Modify: `src/execution/executor-types.ts` (`derivedAgent` in the preview)
- Modify: `src/config/validate.ts:129-138` (object-form validation — do this BEFORE the pipeline tests, see Step 5)
- Test: `test/unit/config/schemas.test.ts`, `test/unit/routing/routing-core.test.ts`, `test/unit/pipeline/stages/routing-profile-tier.test.ts`, `test/unit/config/validate.test.ts`

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

`test/unit/config/schemas.test.ts` — this file has NO generic parse helper. It has
`baseConfig(models)` (line 17, models only) and a describe-local `withTierOrder()`
(line ~402). Add a describe-local `withComplexityRouting` in the same shape:

```ts
describe("complexityRouting — rung-qualified entries (spec §6)", () => {
  const MODELS = {
    claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
    native: { cheap: "opencode-go/deepseek-v4-flash" },
  };

  function withComplexityRouting(complexityRouting: unknown, models: unknown = MODELS) {
    return NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      models,
      autoMode: { ...DEFAULT_CONFIG.autoMode, complexityRouting },
    });
  }

  test("accepts rung objects and bare tiers", () => {
    expect(
      withComplexityRouting({
        simple: { tier: "cheap", agent: "native" },
        medium: { tier: "balanced", agent: "native" },
        complex: { tier: "balanced", agent: "claude" },
        expert: "powerful",
      }).success,
    ).toBe(true);
  });

  test("rejects an empty agent on a rung", () => {
    expect(
      withComplexityRouting({
        ...DEFAULT_CONFIG.autoMode.complexityRouting,
        simple: { tier: "cheap", agent: "" },
      }).success,
    ).toBe(false);
  });
});
```

`test/unit/routing/routing-core.test.ts` (append):

```ts
test("complexityToModelTier unwraps rung objects; complexityToRungAgent reads the agent (spec §6)", () => {
  // makeNaxConfig is already imported in this file (line 11) from "@test/helpers".
  const config = makeNaxConfig({ autoMode: { ...DEFAULT_CONFIG.autoMode, complexityRouting: {
    simple: { tier: "cheap", agent: "native" }, medium: "balanced", complex: "balanced", expert: "powerful",
  }}});
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

`schema-types.ts`: `export type ComplexityRung = ModelTier | { tier: ModelTier; agent?: string };` (re-export through the config barrels like Task 1's exports). `runtime-types.ts:38` becomes `complexityRouting: Record<Complexity, ComplexityRung>;`.

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

- [ ] **Step 5: Teach `validate.ts` the object form — BEFORE any test uses it**

🚨 **Ordering matters.** After Step 3 the schema accepts `{ tier, agent }`, but `validate.ts:129-138`
still does `configuredTiers.includes(tier)` against what is now an *object* — every object-form config
fails validation with a bogus "must be one of" error, which would break Step 6's pipeline tests for a
reason that has nothing to do with routing. Do this step before writing them.

Replace the existing complexityRouting block (`src/config/validate.ts:129-138`). The **string form's
message stays byte-identical** — no test pins it (`grep -rn "must be one of" test/` is empty), but the
byte-compatibility bar (spec §11) covers user-visible errors too:

```ts
  const defaultAgentKey = config.agent?.default ?? "claude";
  const complexities = ["simple", "medium", "complex", "expert"] as const;
  for (const complexity of complexities) {
    const entry = config.autoMode.complexityRouting[complexity];
    if (entry === undefined) continue;

    // String form: message BYTE-IDENTICAL to the pre-plan-C one (spec §11).
    if (typeof entry === "string") {
      const configuredTiers = Object.keys(config.models[defaultAgentKey] ?? {});
      if (!configuredTiers.includes(entry)) {
        errors.push(`complexityRouting.${complexity} must be one of: ${configuredTiers.join(", ")} (got '${entry}')`);
      }
      continue;
    }

    // Object form: new shape, new messages — nothing pre-existing to preserve.
    if (entry.agent !== undefined && config.models[entry.agent] === undefined) {
      errors.push(`complexityRouting.${complexity}: agent "${entry.agent}" is not a key in models`);
      continue;
    }
    const owner = entry.agent ?? defaultAgentKey;
    if (!Object.keys(config.models[owner] ?? {}).includes(entry.tier)) {
      errors.push(`complexityRouting.${complexity}: tier "${entry.tier}" not found under agent "${owner}"`);
    }
  }
```

Add validate tests (using `cfg(overrides)` — see Task 6 Step 1 for its real shape): object rung with an
unknown agent → error; object rung whose tier is missing under its agent → error; valid object rung →
no error; **and a string-form regression asserting the old message verbatim**.

Run: `bun test test/unit/config/validate.test.ts --timeout=30000` → PASS.

- [ ] **Step 6: Write the failing pipeline tests** — append to `test/unit/pipeline/stages/routing-profile-tier.test.ts`

That file (509 lines, limit 800) already carries the routing-stage harness these need: `makePRD`,
`makeCtx`, and the `_routingDeps.resolveRouting` / `isGreenfieldStory` stubbing idiom, plus the H2
describe block covering exactly this precedence ("decision.agent applies when the PRD leaves agent
unset", "PRD agent still wins"). Add a sibling describe and copy the nearest H2 test's setup:

```ts
describe("routingStage — H3: complexity-rung agent seeding (spec §6)", () => {
  test("unprofiled story routes to the complexity rung's agent", async () => {
    // config: complexityRouting.simple = { tier: "cheap", agent: "native" }, models.native.cheap defined;
    // story with NO routing.agent and NO agentProfileId, resolveRouting stubbed to complexity "simple".
    // Assert story.routing.agent === "native" and story.routing.modelTier === "cheap".
  });

  test("profiled story ignores the complexity rung's agent", async () => {
    // same config; story.routing.agent = "claude" (profile-assigned).
    // Assert story.routing.agent stays "claude".
  });
});
```

Write these as real tests against that harness — the comments are the required assertions, not
placeholders to leave in.

- [ ] **Step 7: Verify they fail → the Step 4 wiring makes them pass**

Run: `bun test test/unit/pipeline/stages/routing-profile-tier.test.ts --timeout=30000`

- [ ] **Step 8: Run all touched suites + gates + full test**

Run: `bun test test/unit/config/ test/unit/routing/ test/unit/pipeline/stages/ test/unit/execution/executor-types.test.ts --timeout=30000 && bun run typecheck && bun run lint && bun run test`
Expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
git add src/config/schemas-execution.ts src/config/schema-types.ts src/config/runtime-types.ts src/config/schema.ts src/config/types.ts src/config/index.ts src/routing/router.ts src/routing/index.ts src/pipeline/stages/routing.ts src/execution/executor-types.ts src/config/validate.ts test/unit/config/schemas.test.ts test/unit/config/validate.test.ts test/unit/routing/routing-core.test.ts test/unit/pipeline/stages/routing-profile-tier.test.ts
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

- [ ] **Step 5: Off-ladder profile warning at first route** — in `src/pipeline/stages/routing.ts`, after the `resolveOperatingTier` call.

Scope note (revision 3): this warning exists for **persisted PRD state** — a `profileModelTier` routed
under an older or different config whose ladder no longer carries that rung. An in-config profile
target that names a tier can never be off-ladder: the binding superRefine (`schemas.ts:522-534`,
kept for tier targets by Task 2 Step 7b) rejects the config first.

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
- Consumes: nothing new. Produces: one new validation error; no API change.

🚨 **Scope (revision 3): agentless rungs only.** `NaxConfigSchema.superRefine`
(`src/config/schemas.ts:512-517`) ALREADY hard-errors an **agent-qualified** rung whose tier is missing
under its own agent — adding it again in `validateConfig` would be a duplicate gate
[[feedback-check-for-a-duplicate-gate-before-calling-one-unwired]]. The genuine gap is the **agentless**
rung: `{ tier: "typo", attempts: 2 }` is validated by nobody against the default agent's map today and
only surfaces mid-run as "budget unbounded" + a failed resolution. Spec §8's "today only the agent key
is checked" is true of `validate.ts` but not of the schema — the spec carries the same correction.

- [ ] **Step 1: Write the failing tests** — append to `test/unit/config/validate.test.ts`. Its
factory is `cfg(overrides)` (line 18) — a DEFAULT_CONFIG merge that nests `autoMode.escalation`,
so `tierOrder` goes at `autoMode.escalation.tierOrder`, NOT at the top level:

```ts
describe("agentless tierOrder rungs resolve against the default agent's map (spec §8)", () => {
  const BUILTINS = { fast: "haiku", balanced: "sonnet", powerful: "opus" };
  const MODELS = { claude: BUILTINS, native: { cheap: "opencode-go/deepseek-v4-flash" } };

  test("agentless rung whose tier is missing from the default agent's map is an error", () => {
    const config = cfg({
      models: MODELS,
      autoMode: { escalation: { tierOrder: [{ tier: "cheap", attempts: 2 }] } }, // claude has no "cheap"
    });
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain('tier "cheap" does not resolve under agent "claude"');
  });

  test("agentless rung naming a default-agent tier passes", () => {
    const config = cfg({
      models: MODELS,
      autoMode: { escalation: { tierOrder: [{ tier: "fast", attempts: 2 }] } },
    });
    expect(validateConfig(config).valid).toBe(true);
  });

  test("agent-qualified rung is left to the schema gate (no duplicate error here)", () => {
    // schemas.ts:512-517 owns this case; validateConfig must not re-report it.
    const config = cfg({
      models: MODELS,
      autoMode: { escalation: { tierOrder: [{ tier: "cheap", attempts: 3, agent: "native" }] } },
    });
    expect(validateConfig(config).valid).toBe(true);
  });
});
```

(`cfg` merges over `DEFAULT_CONFIG`, whose `complexityRouting` names the builtin tiers — keep
`claude` in `models` so the pre-existing complexityRouting validation stays satisfied.)

- [ ] **Step 2: Run to verify the first test fails** (`bun test test/unit/config/validate.test.ts --timeout=30000`)

- [ ] **Step 3: Implement** — inside the existing `tierOrder` validation block (`validate.ts:117-127`), after the agent-key check:

```ts
      // Spec §8 (narrowed, revision 3): only AGENTLESS rungs — schemas.ts:512-517 already
      // hard-errors an agent-qualified rung whose tier is missing under its own agent.
      // An agentless rung resolves against the default agent's map, and a typo there
      // otherwise only surfaces mid-run as "budget unbounded" + a failed resolution.
      if (tc.agent === undefined) {
        const owner = config.agent?.default ?? "claude";
        const ownerMap = config.models[owner];
        if (ownerMap && ownerMap[tc.tier] === undefined) {
          errors.push(
            `autoMode.escalation.tierOrder: tier "${tc.tier}" does not resolve under agent "${owner}" (the default agent)`,
          );
        }
      }
```

(When `ownerMap` is absent the existing default-agent models error already fired — do not double-report.
Update the first test's expected substring to match: `does not resolve under agent "claude" (the default agent)`.)

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
- [ ] `bun scripts/check-file-sizes.ts` — no file newly over 600 (src) / 800 (test), no baselined file grown.
- [ ] Pin survives decompose: `grep -n "profileModelPin" src/prd/decompose-mapper.ts` returns the param type + two spread sites from Task 2 Step 7 — and `grep -n 'profileModelPin' src/prd/decompose-mapper.ts | grep modelTier` returns NOTHING (the pin never seeds `modelTier`).
- [ ] Binding gate relaxed: a config with a literal-model profile pin parses (Task 2 Step 7b test), and ADR-025 §4/§5 + ADR-027 §7 carry the amendments.
- [ ] Both PRD write paths threaded: `grep -rn "finalizeAndWritePrd" src/` shows `plan-command.ts` passing `models` and `defaultAgent`.
