# Plan-Time Agent Selection on the `nax plan --from` Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ADR-025 Part C plan-time agent selection fire on the canonical `nax plan --from <spec>` path (all plan modes), and convert `--decompose` from a re-selection step into a pure inheritance step.

**Architecture:** Today Part C selection (capability cards → `agentProfileId` → `routing.agent` + root `routingProfile`) lives only in `decomposeOp`, which `nax plan --from` never calls. We move selection to the plan path by: (1) extracting a shared `resolveAgentAssignment` resolver; (2) injecting capability cards + an `agentProfileId` schema field into the shared `PlanPromptBuilder` so the planner *emits* a selection in the same LLM call (ADR's "fold into the existing call" — no second op); (3) preserving that field through the PRD sanitizer; (4) applying a mode-agnostic `finalizePrdRouting` post-step that resolves the id → agent and writes the root `routingProfile`; (5) making `decompose` inherit the parent story's assignment instead of re-selecting.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Zod config schemas, the `callOp`/Operation framework.

---

## File Structure

| File | Responsibility | Action |
|:---|:---|:---|
| `src/agents/shared/agent-profile-resolver.ts` | SSOT: profile-id → `{agent, agentProfileId, profileModelTier}` | **Create** |
| `src/agents/shared/index.ts` | Barrel export for the resolver | Modify |
| `src/operations/decompose.ts` | Stop self-selecting; delegate parse to shared parser only | Modify |
| `src/config/selectors.ts` | Add `routing` to `planConfigSelector` | Modify |
| `src/plan/strategies/types.ts` | Add `profileName` to `PlanModeContext` | Modify |
| `src/plan/strategies/context-builder.ts` | Populate `profileName` from full config | Modify |
| `src/prompts/builders/plan-builder.ts` | Inject cards + `agentProfileId` schema field into `build()` / `buildDraft()` | Modify |
| `src/operations/plan.ts`, `plan-refine.ts`, `plan-draft.ts` | Pass profiles into the builder | Modify |
| `src/prd/schema.ts` | Preserve `routing.agentProfileId` through the sanitizer | Modify |
| `src/plan/strategies/finalize-routing.ts` | Mode-agnostic PRD routing finalizer | **Create** |
| `src/plan/strategies/single.ts`, `write-prd.ts` | Apply `finalizePrdRouting` before write | Modify |
| `src/cli/plan-command.ts` | Apply `finalizePrdRouting` in pipeline mode | Modify |
| `src/prd/decompose-mapper.ts` | Inherit parent routing onto sub-stories | Modify |
| `src/cli/plan-decompose.ts` | Pass parent routing to the mapper | Modify |

---

## Task 1: Extract the shared agent-profile resolver

**Files:**
- Create: `src/agents/shared/agent-profile-resolver.ts`
- Test: `test/unit/agents/shared/agent-profile-resolver.test.ts`
- Modify: `src/agents/shared/index.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/shared/agent-profile-resolver.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveAgentAssignment } from "@/agents/shared/agent-profile-resolver";
import type { AgentRoutingConfig } from "@/config";

const routing: AgentRoutingConfig = {
  enabled: true,
  strategy: "off",
  default: "opencode-structural",
  profiles: [
    { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical"] },
    { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design"] },
  ],
};

describe("resolveAgentAssignment", () => {
  test("resolves a known profile id to its target agent + tier", () => {
    expect(resolveAgentAssignment("claude-final", routing, "US-001")).toEqual({
      agent: "claude",
      agentProfileId: "claude-final",
      profileModelTier: "balanced",
    });
  });

  test("falls back to the default profile for an unknown id (never invents an agent)", () => {
    expect(resolveAgentAssignment("does-not-exist", routing, "US-001")).toEqual({
      agent: "opencode",
      agentProfileId: "opencode-structural",
      profileModelTier: "fast",
    });
  });

  test("falls back to the default profile when no id is selected", () => {
    expect(resolveAgentAssignment(undefined, routing, "US-001")).toEqual({
      agent: "opencode",
      agentProfileId: "opencode-structural",
      profileModelTier: "fast",
    });
  });

  test("returns null when routing is disabled", () => {
    expect(resolveAgentAssignment("claude-final", { ...routing, enabled: false }, "US-001")).toBeNull();
  });

  test("returns null when no profiles exist", () => {
    expect(resolveAgentAssignment("x", { ...routing, profiles: [], default: undefined }, "US-001")).toBeNull();
  });

  test("returns null for unknown id when no default is configured", () => {
    expect(resolveAgentAssignment("x", { ...routing, default: undefined }, "US-001")).toBeNull();
  });

  test("returns null for undefined agentRouting", () => {
    expect(resolveAgentAssignment("claude-final", undefined, "US-001")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/agents/shared/agent-profile-resolver.test.ts --timeout=5000`
Expected: FAIL — `Cannot find module '@/agents/shared/agent-profile-resolver'`.

- [ ] **Step 3: Write the resolver**

Create `src/agents/shared/agent-profile-resolver.ts`:

```typescript
/**
 * Agent-profile resolver — SSOT for "which agent does this profile id mean?".
 *
 * Maps a story's selected `agentProfileId` to a concrete `(agent, tier)`
 * assignment. Shared by plan-time selection (src/plan) and any other consumer
 * that needs the same mapping. Pure — no I/O beyond an advisory warn.
 *
 * ADR-025 §5: never invent an agent. An unknown id falls back to the configured
 * default profile (with a warn); a missing id falls back silently to the default.
 * Returns null when routing is disabled, no profiles exist, or no profile applies.
 */

import type { AgentRoutingConfig, AgentRoutingProfile, ModelTier } from "@/config";
import { getSafeLogger } from "@/logger";

export interface ResolvedAgentAssignment {
  agent: string;
  agentProfileId: string;
  profileModelTier: ModelTier;
}

export function resolveAgentAssignment(
  selectedProfileId: string | undefined,
  agentRouting: AgentRoutingConfig | undefined,
  storyId: string,
): ResolvedAgentAssignment | null {
  if (agentRouting?.enabled !== true) return null;

  const profiles = agentRouting.profiles ?? [];
  if (profiles.length === 0) return null;

  const defaultProfile = agentRouting.default
    ? profiles.find((p) => p.id === agentRouting.default)
    : undefined;

  if (selectedProfileId) {
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (profile) return toAssignment(profile);

    // ADR-025 §5 — never invent an agent: warn and fall through to the default.
    getSafeLogger()?.warn(
      "routing",
      `Story ${storyId} selected unknown agent profile "${selectedProfileId}" — falling back to ${
        defaultProfile ? `default profile "${defaultProfile.id}"` : "no profile"
      }`,
      { storyId, agentProfileId: selectedProfileId },
    );
  }

  return defaultProfile ? toAssignment(defaultProfile) : null;
}

function toAssignment(p: AgentRoutingProfile): ResolvedAgentAssignment {
  return { agent: p.target.agent, agentProfileId: p.id, profileModelTier: p.target.model };
}
```

> VERIFIED: `ModelTier`, `AgentRoutingConfig`, and `AgentRoutingProfile` are all exported from the `@/config` barrel (`src/config/index.ts:46-48`; `ModelTier` originates in `src/config/schema-types.ts:13`). `prd/types.ts` itself imports `ModelTier` from `../config`, which is why the resolver imports it from `@/config`, **not** `@/prd/types`.

- [ ] **Step 4: Export from the barrel**

In `src/agents/shared/index.ts`, add:

```typescript
export { resolveAgentAssignment, type ResolvedAgentAssignment } from "./agent-profile-resolver";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/agents/shared/agent-profile-resolver.test.ts --timeout=5000`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agents/shared/agent-profile-resolver.ts src/agents/shared/index.ts test/unit/agents/shared/agent-profile-resolver.test.ts
git commit -m "feat(routing): extract shared resolveAgentAssignment resolver (ADR-025)"
```

---

## Task 2: Add `routing` to the plan config selector + thread `profileName`

**Files:**
- Modify: `src/config/selectors.ts:26`
- Modify: `src/plan/strategies/types.ts:32-51`
- Modify: `src/plan/strategies/context-builder.ts:67,83-102`
- Test: `test/unit/config/selectors.test.ts` (or create if absent)

- [ ] **Step 1: Write the failing test**

Add to `test/unit/config/selectors.test.ts` (create the file if it does not exist, with the standard imports):

```typescript
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";
import { planConfigSelector } from "@/config";

describe("planConfigSelector", () => {
  test("includes routing so plan-time agent selection can read routing.agents", () => {
    const full = NaxConfigSchema.parse({});
    const slice = planConfigSelector.select(full);
    expect(slice.routing).toBeDefined();
    expect(slice.routing?.agents).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/config/selectors.test.ts --timeout=5000`
Expected: FAIL — `slice.routing` is `undefined`.

- [ ] **Step 3: Add `routing` to the selector**

In `src/config/selectors.ts`, change line 26 from:

```typescript
export const planConfigSelector = pickSelector("plan", "plan", "debate", "agent", "project");
```

to:

```typescript
export const planConfigSelector = pickSelector("plan", "plan", "debate", "agent", "project", "routing");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/config/selectors.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Add `profileName` to `PlanModeContext`**

In `src/plan/strategies/types.ts`, inside the `PlanModeContext` interface (after `readonly config: PlanConfig;` on line 45), add:

```typescript
  /** Loader-resolved config-profile name (config.profile), recorded on the PRD root for run-side drift detection. */
  readonly profileName: string | undefined;
```

> NOTE: `config.profile` is `z.string().default("default")` (`src/config/schemas.ts:402`), so in practice `profileName` is always a string ("default" when no `--profile`). The `| undefined` is kept only so unit tests can pass `undefined` directly. Consequence: **every** plan now writes a `routingProfile` field (minimum `"default"`) — consistent with the existing `--decompose` and pipeline behavior (`config.profile ?? "default"`). When no profiles are configured (the common case), `resolveAgentAssignment` returns `null` and no `routing.agent` is added, so the only change for non-routing users is the presence of the `routingProfile: "default"` root field.

- [ ] **Step 6: Populate `profileName` in the context builder**

In `src/plan/strategies/context-builder.ts`, in the returned object (the block starting line 83), add a field alongside `config`:

```typescript
    config,
    profileName: fullConfig.profile,
```

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors (every `PlanModeContext` literal is built by `buildPlanModeContext`, so adding the field there satisfies the type).

- [ ] **Step 8: Commit**

```bash
git add src/config/selectors.ts src/plan/strategies/types.ts src/plan/strategies/context-builder.ts test/unit/config/selectors.test.ts
git commit -m "feat(routing): expose routing slice + profileName to plan strategies (ADR-025)"
```

---

## Task 3: Emit `agentProfileId` from the planner — cards + schema in `PlanPromptBuilder`

**Files:**
- Modify: `src/prompts/builders/plan-builder.ts:280-390` (`build`), `:397-493` (`buildDraft`)
- Test: `test/unit/prompts/builders/plan-builder-profiles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/prompts/builders/plan-builder-profiles.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { PlanPromptBuilder } from "@/prompts";
import type { AgentRoutingProfile } from "@/config";

const profiles: AgentRoutingProfile[] = [
  { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical edits"] },
  { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design work"] },
];

describe("PlanPromptBuilder agent profiles", () => {
  test("build(): injects capability cards and an agentProfileId schema field when profiles exist", () => {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      "spec",
      "context",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profiles,
    );
    expect(taskContext).toContain("## Agent Profiles");
    expect(taskContext).toContain("opencode-structural");
    expect(outputFormat).toContain("agentProfileId");
  });

  test("build(): omits cards and the schema field when no profiles", () => {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build("spec", "context");
    expect(taskContext).not.toContain("## Agent Profiles");
    expect(outputFormat).not.toContain("agentProfileId");
  });

  test("buildDraft(): injects cards + agentProfileId schema field when profiles exist", () => {
    const { task } = new PlanPromptBuilder().buildDraft({
      feature: "f",
      branchName: "feat/f",
      specContent: "spec",
      codebaseContext: "context",
      manifestSection: "manifest",
      citationThreshold: 0.5,
      profiles,
    });
    expect(task.content).toContain("## Agent Profiles");
    expect(task.content).toContain("agentProfileId");
  });
});
```

> NOTE: `buildDraft` takes a `PlanDraftBuildInput`. Add `profiles?: AgentRoutingProfile[]` to that interface in this file (it is declared near the top of `plan-builder.ts`). Confirm the other required `PlanDraftBuildInput` fields match the current interface when writing the test literal.

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/prompts/builders/plan-builder-profiles.test.ts --timeout=5000`
Expected: FAIL — `build()` ignores the 8th arg; `taskContext` has no cards.

- [ ] **Step 3: Add the import and a shared card helper call**

At the top of `src/prompts/builders/plan-builder.ts`, add:

```typescript
import type { AgentRoutingProfile } from "@/config";
import { OneShotPromptBuilder } from "./one-shot-builder";
```

- [ ] **Step 4: Wire cards + schema into `build()`**

In `build()`, change the signature (line 280) to add a final parameter:

```typescript
  build(
    specContent: string,
    codebaseContext: string,
    outputFilePath?: string,
    packages?: string[],
    packageDetails?: PackageSummary[],
    projectProfile?: ProjectProfile,
    proposers?: { fileReadAccess?: boolean; fileReadBudget?: number },
    profiles?: AgentRoutingProfile[],
  ): PlanningPromptParts {
```

Immediately before `const taskContext = ...` (line 300), add:

```typescript
    const cards = OneShotPromptBuilder.agentCapabilityCards(profiles ?? []);
    const agentProfilesSection = cards
      ? `\n\n${cards}\n\n${OneShotPromptBuilder.agentProfileInstruction()}`
      : "";
```

Append the section to `taskContext`. Change the closing backtick of the `taskContext` template (currently ends with `${CONTEXT_VS_EXPECTED_FILES_RULE}\`;` at line 342) to:

```typescript
${CONTEXT_VS_EXPECTED_FILES_RULE}${agentProfilesSection}`;
```

In the `outputFormat` routing schema (lines 375-380), add the `agentProfileId` line. Change:

```typescript
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "noTestJustification": "string — REQUIRED when testStrategy is no-test, explains why tests are unnecessary",
        "reasoning": "string — brief classification rationale"
      },
```

to (add a conditional line only when cards are present):

```typescript
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "noTestJustification": "string — REQUIRED when testStrategy is no-test, explains why tests are unnecessary",
        "reasoning": "string — brief classification rationale"${
          cards
            ? `,\n        "agentProfileId": "string — optional, the id of the best-matching profile from the Agent Profiles table above; omit if none fits"`
            : ""
        }
      },
```

- [ ] **Step 5: Wire cards + schema into `buildDraft()`**

Add `profiles?: AgentRoutingProfile[];` to the `PlanDraftBuildInput` interface near the top of the file.

In `buildDraft()` (line 397), before building `task.content`, add:

```typescript
    const cards = OneShotPromptBuilder.agentCapabilityCards(input.profiles ?? []);
    const agentProfilesSection = cards
      ? `\n\n${cards}\n\n${OneShotPromptBuilder.agentProfileInstruction()}`
      : "";
```

Append `${agentProfilesSection}` to `task.content` immediately after `${CONTEXT_VS_EXPECTED_FILES_RULE}` (line 459) and before `## Output Schema`. And in the `buildDraft` routing schema (lines 479-483), apply the same conditional `agentProfileId` line:

```typescript
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "reasoning": "string — brief classification rationale"${
          cards
            ? `,\n        "agentProfileId": "string — optional, the id of the best-matching profile from the Agent Profiles table above; omit if none fits"`
            : ""
        }
      }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/prompts/builders/plan-builder-profiles.test.ts --timeout=5000`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/prompts/builders/plan-builder.ts test/unit/prompts/builders/plan-builder-profiles.test.ts
git commit -m "feat(routing): inject agent capability cards + agentProfileId schema into plan prompts (ADR-025)"
```

---

## Task 4: Pass profiles from the plan ops into the builder

**Files:**
- Modify: `src/operations/plan.ts:55` (build call)
- Modify: `src/operations/plan-refine.ts:328,346` (build calls)
- Modify: `src/operations/plan-draft.ts:185` (buildDraft call)
- Test: covered by Task 6 integration test (these are wiring edits with no independent branch)

- [ ] **Step 1: Add a profiles helper at each op build site**

In each op's `build(input, ctx)`, compute profiles from the now-available `routing` slice. Add this line at the top of each `build`:

```typescript
    const agentRouting = ctx.config.routing?.agents;
    const profiles = agentRouting?.enabled === true ? (agentRouting.profiles ?? []) : [];
```

- [ ] **Step 2: Thread profiles into `plan.ts` (single/interactive)**

In `src/operations/plan.ts`, find the `new PlanPromptBuilder().build(...)` call (line ~55) and append `profiles` as the final argument, matching the new signature order:

```typescript
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      input.outputPath,
      input.packages,
      input.packageDetails,
      input.projectProfile,
      undefined,
      profiles,
    );
```

> NOTE: match the exact argument list already present in `plan.ts` for the first 7 params — only append `profiles`. If `proposers` is currently omitted, pass `undefined` in its slot as shown.

- [ ] **Step 3: Thread profiles into `plan-refine.ts`**

In `src/operations/plan-refine.ts`, both `new PlanPromptBuilder().build(...)` (line ~328) and `const builder = new PlanPromptBuilder()` usage (line ~346) must pass `profiles`. For the `.build(...)` call, append `profiles` as the final argument exactly as in Step 2. (The line 346 `builder` is used for repair prompts that take no profiles — leave it unchanged.)

- [ ] **Step 4: Thread profiles into `plan-draft.ts`**

In `src/operations/plan-draft.ts`, find `new PlanPromptBuilder().buildDraft(input)` (line ~185). Change to pass profiles through the input object:

```typescript
    return new PlanPromptBuilder().buildDraft({ ...input, profiles });
```

- [ ] **Step 5: Run the plan op unit tests**

Run: `timeout 60 bun test test/unit/operations/ --timeout=10000`
Expected: PASS — existing op tests still pass (profiles default to `[]` so prompts are unchanged when no profiles configured).

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/operations/plan.ts src/operations/plan-refine.ts src/operations/plan-draft.ts
git commit -m "feat(routing): pass agent profiles from plan ops into the prompt builder (ADR-025)"
```

---

## Task 5: Preserve `routing.agentProfileId` through the PRD sanitizer

**Files:**
- Modify: `src/prd/schema.ts:291-299`
- Test: `test/unit/prd/schema-agent-profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/prd/schema-agent-profile.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { validatePlanOutput } from "@/prd";

describe("PRD sanitizer preserves agentProfileId", () => {
  test("keeps routing.agentProfileId emitted by the planner", () => {
    const raw = JSON.stringify({
      project: "p",
      feature: "f",
      branchName: "feat/f",
      userStories: [
        {
          id: "US-001",
          title: "t",
          description: "d",
          acceptanceCriteria: ["When X, then Y"],
          tags: [],
          dependencies: [],
          routing: {
            complexity: "medium",
            testStrategy: "tdd-simple",
            reasoning: "because",
            agentProfileId: "opencode-structural",
          },
        },
      ],
    });
    const prd = validatePlanOutput(raw, "f", "feat/f");
    expect(prd.userStories[0].routing.agentProfileId).toBe("opencode-structural");
  });

  test("omits agentProfileId when the planner did not emit one", () => {
    const raw = JSON.stringify({
      project: "p",
      feature: "f",
      branchName: "feat/f",
      userStories: [
        {
          id: "US-001",
          title: "t",
          description: "d",
          acceptanceCriteria: ["When X, then Y"],
          tags: [],
          dependencies: [],
          routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "because" },
        },
      ],
    });
    const prd = validatePlanOutput(raw, "f", "feat/f");
    expect(prd.userStories[0].routing.agentProfileId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/prd/schema-agent-profile.test.ts --timeout=5000`
Expected: FAIL — first test: `agentProfileId` is `undefined` (stripped by the sanitizer).

- [ ] **Step 3: Preserve the field in the sanitizer**

In `src/prd/schema.ts`, inside the returned `routing` object (lines 291-299), add a conditional spread for `agentProfileId`. The `routing` value is already read into a local `routing` variable earlier in the function. Change:

```typescript
    routing: {
      complexity,
      testStrategy,
      reasoning:
        typeof routing.reasoning === "string" && routing.reasoning.trim().length > 0
          ? routing.reasoning.trim()
          : "validated from LLM output",
      ...(noTestJustification !== undefined ? { noTestJustification } : {}),
    },
```

to:

```typescript
    routing: {
      complexity,
      testStrategy,
      reasoning:
        typeof routing.reasoning === "string" && routing.reasoning.trim().length > 0
          ? routing.reasoning.trim()
          : "validated from LLM output",
      ...(noTestJustification !== undefined ? { noTestJustification } : {}),
      ...(typeof routing.agentProfileId === "string" && routing.agentProfileId.trim().length > 0
        ? { agentProfileId: routing.agentProfileId.trim() }
        : {}),
    },
```

> NOTE: `routing` here refers to the per-story raw routing object the sanitizer reads (the same local used for `routing.reasoning`). Confirm its name at the call site; if it is accessed as `s.routing`, use `s.routing?.agentProfileId` instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/prd/schema-agent-profile.test.ts --timeout=5000`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/prd/schema.ts test/unit/prd/schema-agent-profile.test.ts
git commit -m "fix(prd): preserve routing.agentProfileId through the PRD sanitizer (ADR-025)"
```

---

## Task 6: Mode-agnostic `finalizePrdRouting` post-step

**Files:**
- Create: `src/plan/strategies/finalize-routing.ts`
- Modify: `src/plan/strategies/index.ts` (barrel — add export)
- Test: `test/unit/plan/strategies/finalize-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/plan/strategies/finalize-routing.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { finalizePrdRouting } from "@/plan/strategies/finalize-routing";
import type { AgentRoutingConfig } from "@/config";
import type { PRD } from "@/prd/types";

const agentRouting: AgentRoutingConfig = {
  enabled: true,
  strategy: "off",
  default: "opencode-structural",
  profiles: [
    { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical"] },
    { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design"] },
  ],
};

function prdWith(routing: Record<string, unknown>): PRD {
  return {
    project: "p",
    feature: "f",
    branchName: "feat/f",
    userStories: [
      {
        id: "US-001",
        title: "t",
        description: "d",
        acceptanceCriteria: ["a"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        attempts: 0,
        escalations: [],
        routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "r", ...routing },
      },
    ],
  } as unknown as PRD;
}

describe("finalizePrdRouting", () => {
  test("resolves agentProfileId to agent + tier and stamps origin fields", () => {
    const out = finalizePrdRouting(prdWith({ agentProfileId: "claude-final" }), agentRouting, "cross-agent");
    const r = out.userStories[0].routing;
    expect(r.agent).toBe("claude");
    expect(r.agentProfileId).toBe("claude-final");
    expect(r.profileModelTier).toBe("balanced");
    expect(r.initialAgent).toBe("claude");
    expect(r.initialProfileId).toBe("claude-final");
    expect(out.routingProfile).toBe("cross-agent");
  });

  test("applies the default profile when no id was selected", () => {
    const out = finalizePrdRouting(prdWith({}), agentRouting, undefined);
    expect(out.userStories[0].routing.agent).toBe("opencode");
    expect(out.routingProfile).toBe("default");
  });

  test("never overwrites an existing initialAgent (escalation origin is sticky)", () => {
    const out = finalizePrdRouting(
      prdWith({ agentProfileId: "claude-final", initialAgent: "opencode", initialProfileId: "opencode-structural" }),
      agentRouting,
      "cross-agent",
    );
    expect(out.userStories[0].routing.initialAgent).toBe("opencode");
    expect(out.userStories[0].routing.initialProfileId).toBe("opencode-structural");
  });

  test("leaves stories untouched when routing is disabled but still records routingProfile", () => {
    const out = finalizePrdRouting(prdWith({}), { ...agentRouting, enabled: false }, "cross-agent");
    expect(out.userStories[0].routing.agent).toBeUndefined();
    expect(out.routingProfile).toBe("cross-agent");
  });

  test("does not mutate the input PRD", () => {
    const input = prdWith({ agentProfileId: "claude-final" });
    finalizePrdRouting(input, agentRouting, "cross-agent");
    expect(input.userStories[0].routing.agent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/plan/strategies/finalize-routing.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `finalizePrdRouting`**

Create `src/plan/strategies/finalize-routing.ts`:

```typescript
/**
 * finalize-routing.ts — mode-agnostic plan-time agent selection post-step.
 *
 * Runs after any plan strategy produces a PRD (single, refine, debate, pipeline).
 * Resolves each story's emitted routing.agentProfileId to a concrete agent + tier
 * via the shared resolver, stamps origin fields once (ADR-025 §2), and records the
 * resolved config-profile name at the PRD root for run-side drift detection.
 *
 * Pure — returns a new PRD; never mutates the input (coding-style: immutability).
 */

import { resolveAgentAssignment } from "@/agents/shared";
import type { AgentRoutingConfig } from "@/config";
import type { PRD } from "@/prd/types";

export function finalizePrdRouting(
  prd: PRD,
  agentRouting: AgentRoutingConfig | undefined,
  profileName: string | undefined,
): PRD {
  const userStories = prd.userStories.map((story) => {
    const assignment = resolveAgentAssignment(story.routing?.agentProfileId, agentRouting, story.id);
    if (!assignment) return story;
    return {
      ...story,
      routing: {
        ...story.routing,
        agent: assignment.agent,
        agentProfileId: assignment.agentProfileId,
        profileModelTier: assignment.profileModelTier,
        // Origin tracking — write once, never overwrite (ADR-025 §2).
        initialAgent: story.routing?.initialAgent ?? assignment.agent,
        initialProfileId: story.routing?.initialProfileId ?? assignment.agentProfileId,
      },
    };
  });

  return { ...prd, userStories, routingProfile: profileName ?? "default" };
}
```

- [ ] **Step 4: Export from the barrel**

In `src/plan/strategies/index.ts`, add:

```typescript
export { finalizePrdRouting } from "./finalize-routing";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/plan/strategies/finalize-routing.test.ts --timeout=5000`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/plan/strategies/finalize-routing.ts src/plan/strategies/index.ts test/unit/plan/strategies/finalize-routing.test.ts
git commit -m "feat(routing): add mode-agnostic finalizePrdRouting post-step (ADR-025)"
```

---

## Task 7: Apply `finalizePrdRouting` at every plan write site

**Files:**
- Modify: `src/plan/strategies/single.ts:41` (single mode)
- Modify: `src/plan/strategies/write-prd.ts:29,35,57` (refine + debate)
- Modify: `src/cli/plan-command.ts:202-208` (pipeline mode)
- Test: `test/unit/plan/strategies/single.test.ts` (extend) + Task 8 integration

- [ ] **Step 1: Write the failing test (single mode)**

Add to `test/unit/plan/strategies/single.test.ts` (or create, mirroring the existing single-strategy test setup — it stubs `_singlePlanDeps.callOp` to return a PRD and asserts on the written file). The new case asserts the written PRD carries a resolved agent. Use the strategy with a `ctx` whose `config.routing.agents` has a default profile and `profileName: "cross-agent"`, stub `callOp` to return a PRD whose story has `routing.agentProfileId: "claude-final"`, and assert the written JSON contains `"agent": "claude"` and `"routingProfile": "cross-agent"`.

```typescript
test("single mode resolves agentProfileId and writes routingProfile", async () => {
  // Arrange: build a PlanModeContext with routing.agents configured (see existing
  // single.test.ts helpers for ctx construction); stub callOp to return:
  //   { project:"p", feature:"f", branchName:"feat/f", userStories:[{ ...,
  //     routing:{ complexity:"medium", testStrategy:"tdd-simple", reasoning:"r",
  //     agentProfileId:"claude-final" } }] }
  // and ctx.profileName = "cross-agent".
  // Act: await new SinglePlanStrategy().execute(ctx)
  // Assert: the JSON written to ctx.outputPath contains '"agent": "claude"'
  //   and '"routingProfile": "cross-agent"'.
});
```

> NOTE: reuse the existing `single.test.ts` context/stub helpers verbatim; only the `routing.agents` config, `profileName`, and the stubbed PRD story's `agentProfileId` are new. If `single.test.ts` does not exist, model the ctx on `buildPlanModeContext`'s return shape and stub `_singlePlanDeps.callOp`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/plan/strategies/single.test.ts --timeout=5000`
Expected: FAIL — written PRD has no `agent` / `routingProfile`.

- [ ] **Step 3: Apply finalize in single mode**

In `src/plan/strategies/single.ts`, add the import:

```typescript
import { finalizePrdRouting } from "./finalize-routing";
```

Change the write (line 41) from:

```typescript
      assertIsValidPrd(prd);
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify({ ...prd, project: ctx.projectName }, null, 2));
```

to:

```typescript
      assertIsValidPrd(prd);
      const finalized = finalizePrdRouting(
        { ...prd, project: ctx.projectName },
        ctx.config.routing?.agents,
        ctx.profileName,
      );
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalized, null, 2));
```

Also apply finalize in the recovery branch (lines 47-50): wrap `recoveredPrd` the same way before writing.

- [ ] **Step 4: Apply finalize in `writeOrRecoverPrd` (refine + debate)**

In `src/plan/strategies/write-prd.ts`, add the import:

```typescript
import { finalizePrdRouting } from "./finalize-routing";
```

There are three `writeFile` sites (lines 29, 35, 57). At each, wrap the PRD object through `finalizePrdRouting` before stringifying. For the line 29 site, change:

```typescript
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify({ ...prd, project: ctx.projectName }, null, 2));
```

to:

```typescript
      const finalized = finalizePrdRouting(
        { ...prd, project: ctx.projectName },
        ctx.config.routing?.agents,
        ctx.profileName,
      );
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalized, null, 2));
```

Apply the identical wrapping at the line 35 site (`normalizedPrd`) and the line 57 site (`recoveredPrd`).

- [ ] **Step 5: Apply finalize in pipeline mode**

In `src/cli/plan-command.ts`, add the import:

```typescript
import { finalizePrdRouting } from "../plan/strategies";
```

Change the pipeline write block (lines 202-208) from:

```typescript
      const prdToWrite = {
        ...verdict.prd,
        project: projectName,
        routingProfile: config.profile ?? "default",
      };
      await _planDeps.writeFile(outputPath, JSON.stringify(prdToWrite, null, 2));
```

to:

```typescript
      const prdToWrite = finalizePrdRouting(
        { ...verdict.prd, project: projectName },
        config.routing?.agents,
        config.profile,
      );
      await _planDeps.writeFile(outputPath, JSON.stringify(prdToWrite, null, 2));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `timeout 60 bun test test/unit/plan/ --timeout=10000`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/plan/strategies/single.ts src/plan/strategies/write-prd.ts src/cli/plan-command.ts test/unit/plan/strategies/single.test.ts
git commit -m "feat(routing): apply finalizePrdRouting at all plan write sites (ADR-025)"
```

---

## Task 8: Convert `--decompose` from re-selection to inheritance

**Files:**
- Modify: `src/operations/decompose.ts:35-51,52-106` (drop card injection + parse-side selection)
- Modify: `src/prd/decompose-mapper.ts:27-77` (inherit parent routing)
- Modify: `src/cli/plan-decompose.ts:96,193-198` (drop debate profiles, pass parent routing)
- Test: `test/unit/prd/decompose-mapper.test.ts` (extend), `test/unit/operations/decompose.test.ts` (adjust)

- [ ] **Step 1: Write the failing test (mapper inheritance)**

Add to `test/unit/prd/decompose-mapper.test.ts`:

```typescript
import { mapDecomposedStoriesToUserStories } from "@/prd/decompose-mapper";

test("sub-stories inherit the parent story's agent assignment", () => {
  const subs = mapDecomposedStoriesToUserStories(
    [
      {
        id: "US-001-A",
        title: "t",
        description: "d",
        acceptanceCriteria: ["a"],
        tags: [],
        dependencies: [],
        contextFiles: ["src/x.ts"],
        complexity: "simple",
        reasoning: "r",
        estimatedLOC: 0,
        risks: [],
        testStrategy: "tdd-simple",
      },
    ],
    "US-001",
    "packages/api",
    { agent: "claude", agentProfileId: "claude-final", profileModelTier: "balanced" },
  );
  expect(subs[0].routing.agent).toBe("claude");
  expect(subs[0].routing.agentProfileId).toBe("claude-final");
  expect(subs[0].routing.profileModelTier).toBe("balanced");
  expect(subs[0].routing.initialAgent).toBe("claude");
  expect(subs[0].routing.initialProfileId).toBe("claude-final");
});

test("sub-stories carry no agent when the parent had none", () => {
  const subs = mapDecomposedStoriesToUserStories(
    [
      {
        id: "US-001-A", title: "t", description: "d", acceptanceCriteria: ["a"], tags: [], dependencies: [],
        contextFiles: ["src/x.ts"], complexity: "simple", reasoning: "r", estimatedLOC: 0, risks: [], testStrategy: "tdd-simple",
      },
    ],
    "US-001",
    undefined,
    undefined,
  );
  expect(subs[0].routing.agent).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/prd/decompose-mapper.test.ts --timeout=5000`
Expected: FAIL — mapper signature has no 4th param; `agent` undefined.

- [ ] **Step 3: Add the parent-routing parameter to the mapper**

In `src/prd/decompose-mapper.ts`, change the signature (line 27) and the `routing` block (lines 67-75):

```typescript
import type { StoryRouting, UserStory } from "./types";

export function mapDecomposedStoriesToUserStories(
  stories: DecomposedStory[],
  parentStoryId: string,
  parentWorkdir?: string,
  parentRouting?: Pick<StoryRouting, "agent" | "agentProfileId" | "profileModelTier" | "initialAgent" | "initialProfileId">,
): UserStory[] {
```

Replace the `routing` object (lines 67-75) with inheritance from the parent:

```typescript
      routing: {
        complexity: story.complexity,
        testStrategy: story.testStrategy ?? ("test-after" as const),
        reasoning: story.reasoning,
        modelTier: parentRouting?.profileModelTier ?? ("balanced" as const),
        ...(parentRouting?.agent !== undefined && { agent: parentRouting.agent }),
        ...(parentRouting?.agentProfileId !== undefined && { agentProfileId: parentRouting.agentProfileId }),
        ...(parentRouting?.profileModelTier !== undefined && { profileModelTier: parentRouting.profileModelTier }),
        // Origin tracking inherited from the parent (write once).
        ...(parentRouting?.agent !== undefined && {
          initialAgent: parentRouting.initialAgent ?? parentRouting.agent,
        }),
        ...(parentRouting?.agentProfileId !== undefined && {
          initialProfileId: parentRouting.initialProfileId ?? parentRouting.agentProfileId,
        }),
      },
```

> NOTE: confirm `StoryRouting` is the exported interface name in `src/prd/types.ts` for the routing sub-object (lines 60-96). If it is named differently, use that name in the `Pick<...>`.

- [ ] **Step 4: Pass parent routing from the decompose command**

In `src/cli/plan-decompose.ts`, change the `mapDecomposedStoriesToUserStories` call (lines 193-198) to pass `targetStory.routing`:

```typescript
  const subStoriesWithParent: UserStory[] = mapDecomposedStoriesToUserStories(
    // biome-ignore lint/style/noNonNullAssertion: loop guarantees decompStories is set
    decompStories!,
    options.storyId,
    targetStory.workdir,
    targetStory.routing,
  );
```

Also remove the now-dead debate profile injection (lines 95-96): replace `profilesForDebate` with an empty array so the debate decompose prompt no longer injects cards. Change:

```typescript
        const agentRoutingForDebate = config.routing?.agents;
        const profilesForDebate = agentRoutingForDebate?.enabled === true ? (agentRoutingForDebate.profiles ?? []) : [];
```

to:

```typescript
        // ADR-025: decompose inherits the parent's agent; it does not re-select.
        const profilesForDebate: never[] = [];
```

- [ ] **Step 5: Stop `decomposeOp` from injecting cards and re-selecting**

In `src/operations/decompose.ts`, in `build()` (lines 36-45) force `profiles` to empty:

```typescript
  build(input, _ctx) {
    // ADR-025: decompose inherits the parent story's agent (see decompose-mapper),
    // so it never injects capability cards or asks the model to re-select.
    const prompt = buildDecomposePromptSync({
      specContent: input.specContent,
      codebaseContext: input.codebaseContext,
      targetStory: input.targetStory,
      siblings: input.siblings,
      maxAcCount: input.maxAcCount,
      profiles: [],
    });

    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
```

Replace the entire `parse` (lines 52-106) with the plain parser (no profile resolution):

```typescript
  parse(output, _input, _ctx) {
    return parseDecomposeOutput(output);
  },
```

Remove the now-unused `_decomposeOpDeps` import of `getSafeLogger` only if nothing else uses it; otherwise leave it. Remove the now-unused `decomposeConfigSelector`'s `routing` dependency only if no other field is read — leave the selector as-is to avoid churn.

- [ ] **Step 6: Update the decompose op test**

In `test/unit/operations/decompose.test.ts`, remove/disable any assertions expecting `decomposeOp` to resolve `agentProfileId → routing.agent` (that behavior now lives in the plan path + mapper inheritance). Keep assertions that the op parses stories and complexity correctly.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `timeout 60 bun test test/unit/prd/decompose-mapper.test.ts test/unit/operations/decompose.test.ts --timeout=10000`
Expected: PASS.

- [ ] **Step 8: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/operations/decompose.ts src/prd/decompose-mapper.ts src/cli/plan-decompose.ts test/unit/prd/decompose-mapper.test.ts test/unit/operations/decompose.test.ts
git commit -m "refactor(routing): decompose inherits parent agent instead of re-selecting (ADR-025)"
```

---

## Task 9: End-to-end integration test on the `nax plan --from` path

**Files:**
- Test: `test/integration/cli/plan-agent-selection.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/integration/cli/plan-agent-selection.test.ts`. It drives `planCommand` in refine mode with a stubbed agent that returns a PRD whose stories include `routing.agentProfileId`, a config carrying `routing.agents.profiles` + `profile: "cross-agent"`, and asserts the written `prd.json` has resolved `routing.agent` + root `routingProfile`.

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCommand, _planDeps } from "@/cli";
import { NaxConfigSchema } from "@/config/schemas";

describe("nax plan --from applies plan-time agent selection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("resolves agentProfileId to routing.agent and writes routingProfile", async () => {
    // Arrange a temp .nax repo, a spec file, and a config with profiles.
    // Stub _planDeps so the strategy's callOp returns a PRD whose first story has
    //   routing.agentProfileId === "claude-final".
    // Build config via:
    const config = NaxConfigSchema.parse({
      plan: { mode: "refine" },
      profile: "cross-agent",
      routing: {
        strategy: "keyword",
        agents: {
          enabled: true,
          strategy: "off",
          default: "opencode-structural",
          profiles: [
            { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical"] },
            { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design"] },
          ],
        },
      },
    });
    // ... set up workdir + spec, run planCommand, then:
    // const prd = JSON.parse(readFileSync(join(workdir, ".nax/features/f/prd.json"), "utf8"));
    // expect(prd.userStories[0].routing.agent).toBe("claude");
    // expect(prd.userStories[0].routing.agentProfileId).toBe("claude-final");
    // expect(prd.routingProfile).toBe("cross-agent");
  });
});
```

> NOTE: model the temp-repo + `_planDeps` stubbing on the existing plan integration tests under `test/integration/cli/` (search for ones that call `planCommand`). Reuse `test/helpers/temp.ts` (`makeTempDir`/`withTempDir`) for the workdir rather than raw `mkdtempSync`. The key assertions are the three `expect` lines.

- [ ] **Step 2: Run the integration test**

Run: `timeout 60 bun test test/integration/cli/plan-agent-selection.test.ts --timeout=15000`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/cli/plan-agent-selection.test.ts
git commit -m "test(routing): integration test for plan-time agent selection on --from path"
```

---

## Task 10: Full-suite gate + manual verification

- [ ] **Step 1: Run the full suite**

Run: `bun run test`
Expected: green (no new failures). Investigate any `exit 124/132/134` per `.claude/rules/testing-commands.md` — do not retry blindly.

- [ ] **Step 2: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 3: Manual smoke on the real feature**

Run (against the rs-stock repo that surfaced the bug):

```bash
cd /home/williamkhoo/Desktop/projects/work/rs-stock/rs-stock
nax plan -f cross-ticker-get-indicators-v2 --from .nax/features/cross-ticker-get-indicators/spec.md --profile cross-agent
```

Then verify the PRD now carries selection:

```bash
python3 -c "import json; d=json.load(open('.nax/features/cross-ticker-get-indicators-v2/prd.json')); print('routingProfile:', d.get('routingProfile')); [print(s['id'], s['routing'].get('agent'), s['routing'].get('agentProfileId')) for s in d['userStories']]"
```

Expected: `routingProfile: cross-agent` and each story prints a resolved `agent` + `agentProfileId` (no longer all `None`).

- [ ] **Step 4: Final commit (if any doc/changelog touch-ups)**

```bash
git add -A
git commit -m "docs(routing): note plan-time selection now fires on nax plan --from (ADR-025)"
```

---

## Self-Review Notes

- **Spec coverage:** Part C "selection folds into the planning call" → Tasks 3-4 (emit) + 5 (persist) + 6-7 (resolve/write). "PRD is the reviewable artifact" → Task 6 writes `routing.agent` + root `routingProfile`. "Never invent an agent" → Task 1 default-fallback + warn. "Origin tracking written once" → Task 6 `initialAgent`/`initialProfileId` sticky. Decompose decision (user directive) → Task 8 inheritance.
- **Out of scope (already shipped per ADR-025):** Part B cross-agent escalation (`escalateTier` rung-index, `TierConfigSchema.agent`) and the `tierOrder`↔profiles cross-validation superRefine. This plan only lights up the plan-path emit/resolve; it does not touch escalation.
- **Type consistency:** `ResolvedAgentAssignment` fields (`agent`/`agentProfileId`/`profileModelTier`) are used identically in Tasks 1, 6, and the mapper (Task 8). `finalizePrdRouting(prd, agentRouting, profileName)` signature is identical at all three call sites (Task 7).
- **Risk — debate mode:** `DebatePlanStrategy` writes via `writeOrRecoverPrd` (Task 7 covers it) but the debate *prompt* may not inject cards (debate-plan op composition differs). If debate stories never emit `agentProfileId`, `finalizePrdRouting` still applies the **default** profile — acceptable degradation, not a crash. Wiring cards into the debate plan prompt is a documented follow-up, not part of this plan.
