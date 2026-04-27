# ADR-018 Wave 3 Phase F — TDD Orchestrator Rewire

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `ThreeSessionRunner`, create 3 TDD op config objects, create `session-op.ts` shared helper, rewire `runThreeSessionTdd` to use `runTddSessionOp` ×3, split `orchestrator.ts` to under 400 lines.

**Architecture:** The three TDD sessions (test-writer → implementer → verifier) are currently dispatched via `ThreeSessionRunner → runThreeSessionTddFromCtx → runThreeSessionTdd → runTddSession × 3`. Phase F collapses `ThreeSessionRunner` (which is a pointless thin class), creates typed op config objects for each role, creates a `runTddSessionOp` shared helper that wraps `runTddSession`, and rewires the orchestrator to use it. Between-session logic (greenfield detection, verdict processing) is extracted into named helpers to bring `orchestrator.ts` under 400 lines.

**Tech Stack:** TypeScript strict, Bun 1.3.7+, `bun:test`

---

## File Map

| File | Change |
|:-----|:-------|
| `src/prompts/builders/tdd-builder.ts` | Add `static buildForRole(role, workdir, config, story, opts)` |
| `src/tdd/session-op.ts` | **New** — `TddRunOp` interface + `runTddSessionOp(op, options, beforeRef, bundle?, binding?)` |
| `src/operations/write-test.ts` | **New** — `writeTddTestOp: TddRunOp` |
| `src/operations/implement.ts` | **New** — `implementTddOp: TddRunOp` |
| `src/operations/verify.ts` | **New** — `verifyTddOp: TddRunOp` |
| `src/tdd/orchestrator-ctx.ts` | **New** — move `runThreeSessionTddFromCtx` here |
| `src/tdd/orchestrator.ts` | Rewire sessions to `runTddSessionOp`; extract helpers; must stay under 400 lines |
| `src/tdd/three-session-runner.ts` | **Delete** |
| `src/pipeline/stages/execution.ts` | Replace `ThreeSessionRunner` with direct `runThreeSessionTddFromCtx` call |
| `src/operations/index.ts` | Export new ops |
| `src/tdd/index.ts` | Export `runTddSessionOp`, `TddRunOp` from `session-op.ts`; add `orchestrator-ctx.ts` exports |

---

## Context

`src/tdd/orchestrator.ts` is currently 710 lines — **way over the 400-line limit**. The split strategy:

1. Move `runThreeSessionTddFromCtx` (lines 547–710, 163 lines) → `src/tdd/orchestrator-ctx.ts`
2. Extract greenfield-check helper (lines 262–329, ~68 lines) → helper function at bottom of `orchestrator.ts`
3. Extract verdict-processing helper (lines 424–490, ~67 lines) → helper function at bottom of `orchestrator.ts`
4. Replace 3 `runTddSession(…)` calls with `runTddSessionOp(op, options, …)` — saves ~15 lines per session

After: `orchestrator.ts` ≈ 350 lines, `orchestrator-ctx.ts` ≈ 165 lines.

---

## Task 1: Add `TddPromptBuilder.buildForRole()` static method

**Files:**
- Modify: `src/prompts/builders/tdd-builder.ts`
- Test: `test/unit/prompts/tdd-builder.test.ts` (add test)

### Why this helper?

`session-runner.ts` currently has 40 lines of per-role `switch` logic to build the prompt (lines 164–201). Moving this into a static method on `TddPromptBuilder` lets `session-op.ts` call a single method, and keeps all prompt-assembly logic inside the builder class.

- [ ] **Step 1: Write a failing test for `TddPromptBuilder.buildForRole`**

Add to `test/unit/prompts/tdd-builder.test.ts`:

```typescript
describe("TddPromptBuilder.buildForRole", () => {
  test("builds a non-empty prompt for test-writer", async () => {
    const story = makeStory();
    const config = makeNaxConfig({ quality: { commands: { test: "bun test" } } });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("builds a non-empty prompt for implementer", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.buildForRole("implementer", "/tmp", config, story, { lite: false });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("builds a non-empty prompt for verifier", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.buildForRole("verifier", "/tmp", config, story, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
```

Run: `timeout 30 bun test test/unit/prompts/tdd-builder.test.ts --timeout=5000`
Expected: FAIL with "buildForRole is not a function"

- [ ] **Step 2: Add the static method to `TddPromptBuilder`**

In `src/prompts/builders/tdd-builder.ts`, add before the closing `}` of the class:

```typescript
/**
 * Build the full prompt string for a given TDD role.
 * Consolidates the per-role switch logic from session-runner.ts.
 */
static buildForRole(
  role: import("./tdd-builder").TddPromptBuilder extends { role: infer R } ? never : PromptRole,
  workdir: string,
  config: NaxConfig,
  story: UserStory,
  opts: {
    lite?: boolean;
    contextMarkdown?: string;
    featureContextMarkdown?: string;
    contextBundle?: import("../../context/engine").ContextBundle;
    constitution?: string;
  },
): Promise<string> {
  const variant =
    role === "implementer" ? ((opts.lite ? "lite" : "standard") as const) : undefined;
  const isolation =
    role === "test-writer" ? ((opts.lite ? "lite" : "strict") as const) : undefined;
  return TddPromptBuilder.for(role, { variant, isolation })
    .withLoader(workdir, config)
    .story(story)
    .context(opts.contextMarkdown)
    .v2FeatureContext(opts.contextBundle?.pushMarkdown)
    .featureContext(opts.contextBundle ? undefined : opts.featureContextMarkdown)
    .constitution(opts.constitution)
    .testCommand(config.quality?.commands?.test)
    .hermeticConfig(config.quality?.testing)
    .build();
}
```

**Note on the role type**: the parameter type for `role` is `PromptRole` (already imported at top of file as `import type { PromptOptions, PromptRole, PromptSection } from "../core"`). The complex conditional type in the template above is wrong — just use `PromptRole` directly:

```typescript
static buildForRole(
  role: PromptRole,
  workdir: string,
  config: NaxConfig,
  story: UserStory,
  opts: {
    lite?: boolean;
    contextMarkdown?: string;
    featureContextMarkdown?: string;
    contextBundle?: import("../../context/engine").ContextBundle;
    constitution?: string;
  },
): Promise<string> {
  const variant =
    role === "implementer" ? ((opts.lite ? "lite" : "standard") as const) : undefined;
  const isolation =
    role === "test-writer" ? ((opts.lite ? "lite" : "strict") as const) : undefined;
  return TddPromptBuilder.for(role, { variant, isolation })
    .withLoader(workdir, config)
    .story(story)
    .context(opts.contextMarkdown)
    .v2FeatureContext(opts.contextBundle?.pushMarkdown)
    .featureContext(opts.contextBundle ? undefined : opts.featureContextMarkdown)
    .constitution(opts.constitution)
    .testCommand(config.quality?.commands?.test)
    .hermeticConfig(config.quality?.testing)
    .build();
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/prompts/tdd-builder.test.ts --timeout=5000`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/prompts/builders/tdd-builder.ts test/unit/prompts/tdd-builder.test.ts
git commit -m "refactor(adr-018): add TddPromptBuilder.buildForRole static method"
```

---

## Task 2: Create `src/tdd/session-op.ts` — shared helper

**Files:**
- Create: `src/tdd/session-op.ts`
- Create: `test/unit/tdd/session-op.test.ts`

### What this does

`runTddSessionOp(op, options, beforeRef, contextBundle?, sessionBinding?)` is the single entrypoint for running one TDD session. It:
1. Resolves the model tier for the role
2. Computes contextMarkdown/interactionBridge inclusion based on role
3. Calls `runTddSession` with the fully-resolved arguments

This eliminates the duplicated per-role argument-resolution in `runThreeSessionTdd`.

- [ ] **Step 1: Write a failing test**

Create `test/unit/tdd/session-op.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { UserStory } from "../../../src/prd";
import { _sessionRunnerDeps } from "../../../src/tdd/session-runner";
import { writeTddTestOp, implementTddOp, verifyTddOp, runTddSessionOp } from "../../../src/tdd/session-op";
import { makeNaxConfig } from "../../helpers";

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Test",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
    attempts: 0,
    priorFailures: [],
  } as unknown as UserStory;
}

const mockAgent = {
  name: "mock",
  displayName: "Mock Agent",
  binary: "mock",
  capabilities: {
    supportedTiers: ["fast", "balanced", "powerful"] as ("fast" | "balanced" | "powerful")[],
    maxContextTokens: 200_000,
    features: new Set<"tdd" | "review" | "refactor" | "batch">(),
  },
  isInstalled: mock(async () => true),
  buildCommand: mock(() => [] as string[]),
  complete: mock(async () => ({ output: "", costUsd: 0, source: "fallback" as const })),
  plan: mock(async () => ({ specContent: "" })),
  decompose: mock(async () => ({ stories: [] })),
  deriveSessionName: mock(() => "nax-test"),
  closePhysicalSession: mock(async () => {}),
  openSession: mock(async () => ({ id: "mock-session", agentName: "mock" })),
  sendTurn: mock(async () => ({ output: "ok", internalRoundTrips: 1, cost: { total: 0.01 } })),
  closeSession: mock(async () => {}),
};

let origDeps: Record<string, unknown>;
beforeEach(() => {
  origDeps = { ...(_sessionRunnerDeps as unknown as Record<string, unknown>) };
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  _sessionRunnerDeps.getChangedFiles = mock(async () => ["test/foo.test.ts"]);
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "ref");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "prompt");
});
afterEach(() => {
  Object.assign(_sessionRunnerDeps, origDeps);
});

describe("runTddSessionOp", () => {
  test("writeTddTestOp has role test-writer", () => {
    expect(writeTddTestOp.role).toBe("test-writer");
  });

  test("implementTddOp has role implementer", () => {
    expect(implementTddOp.role).toBe("implementer");
  });

  test("verifyTddOp has role verifier", () => {
    expect(verifyTddOp.role).toBe("verifier");
  });

  test("runs a test-writer session and returns TddSessionResult", async () => {
    const config = makeNaxConfig({
      agent: { default: "claude" },
      execution: { sessionTimeoutSeconds: 300 },
      quality: { commands: { test: "bun test" } },
      tdd: { testWriterAllowedPaths: [], rollbackOnFailure: false },
    });
    const options = {
      agent: mockAgent as never,
      story: makeStory(),
      config,
      workdir: "/tmp/fake",
      modelTier: "balanced" as const,
    };
    const result = await runTddSessionOp(writeTddTestOp, options, "HEAD");
    expect(result.role).toBe("test-writer");
    expect(typeof result.success).toBe("boolean");
  });
});
```

Run: `timeout 30 bun test test/unit/tdd/session-op.test.ts --timeout=5000`
Expected: FAIL with module not found

- [ ] **Step 2: Create `src/tdd/session-op.ts`**

```typescript
/**
 * TDD Session Op — shared helper for dispatching a single TDD role session.
 *
 * Wraps runTddSession with per-role model-tier resolution, contextMarkdown
 * and interactionBridge inclusion rules.
 */

import { buildInteractionBridge } from "../interaction/bridge-builder";
import type { TddSessionResult, TddSessionRole } from "./types";
import { runTddSession } from "./session-runner";
import type { TddSessionBinding } from "./session-runner";
import type { ThreeSessionTddOptions } from "./orchestrator";

/** Thin op spec that identifies a TDD session role. */
export interface TddRunOp {
  readonly role: TddSessionRole;
}

export const writeTddTestOp: TddRunOp = { role: "test-writer" };
export const implementTddOp: TddRunOp = { role: "implementer" };
export const verifyTddOp: TddRunOp = { role: "verifier" };

/**
 * Run one TDD session for the given op spec.
 *
 * Resolves per-role model tier, contextMarkdown/interactionBridge inclusion,
 * and isolation flags before delegating to runTddSession.
 */
export async function runTddSessionOp(
  op: TddRunOp,
  options: ThreeSessionTddOptions,
  beforeRef: string,
  contextBundle?: import("../context/engine").ContextBundle,
  sessionBinding?: TddSessionBinding,
): Promise<TddSessionResult> {
  const { role } = op;
  const {
    agent,
    story,
    config,
    workdir,
    modelTier,
    featureName,
    contextMarkdown,
    featureContextMarkdown,
    constitution,
    lite = false,
    interactionChain,
    projectDir,
    abortSignal,
  } = options;

  // Per-role model tier resolution
  const tier =
    role === "test-writer"
      ? (config.tdd.sessionTiers?.testWriter ?? "balanced")
      : role === "implementer"
        ? (config.tdd.sessionTiers?.implementer ?? modelTier)
        : (config.tdd.sessionTiers?.verifier ?? "fast");

  // Verifier skips contextMarkdown and interactionBridge
  const includeContext = role !== "verifier";
  const sessionLite = role !== "verifier" ? lite : false;
  const skipIsolation = role !== "verifier" ? lite : false;

  const bridge = includeContext
    ? buildInteractionBridge(interactionChain, {
        featureName,
        storyId: story.id,
        stage: "execution",
      })
    : undefined;

  return runTddSession(
    role,
    agent,
    story,
    config,
    workdir,
    tier,
    beforeRef,
    includeContext ? contextMarkdown : undefined,
    sessionLite,
    skipIsolation,
    constitution,
    featureName,
    bridge,
    projectDir,
    featureContextMarkdown,
    contextBundle,
    sessionBinding,
    abortSignal,
  );
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/tdd/session-op.test.ts --timeout=5000`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tdd/session-op.ts test/unit/tdd/session-op.test.ts
git commit -m "feat(adr-018): add session-op.ts with runTddSessionOp helper and 3 op specs"
```

---

## Task 3: Create 3 TDD op files in `src/operations/`

**Files:**
- Create: `src/operations/write-test.ts`
- Create: `src/operations/implement.ts`
- Create: `src/operations/verify.ts`

### Why separate files?

The ADR requires 3 ops in `src/operations/` — these are the canonical `RunOperation`-compatible config objects (kind: "run") that represent each TDD session. They re-export from `session-op.ts` and add the `kind`/`stage`/`session` fields that `RunOperation` requires. This keeps them usable as operation specs for future `callOp` integration.

- [ ] **Step 1: Create `src/operations/write-test.ts`**

```typescript
import type { SessionRole } from "../session/types";
import type { TddSessionRole } from "../tdd/types";

export interface TddRunOpSpec {
  readonly kind: "run";
  readonly role: TddSessionRole;
  readonly stage: "run";
  readonly session: { readonly role: SessionRole; readonly lifetime: "fresh" | "warm" };
}

export { writeTddTestOp } from "../tdd/session-op";
export type { TddRunOp } from "../tdd/session-op";
```

Wait — re-reading the design: the op files should be the canonical source of the op objects. Let me revise: `session-op.ts` exports the actual op constants (`writeTddTestOp`, `implementTddOp`, `verifyTddOp`), and `src/operations/write-test.ts` etc. just re-export them for the operations barrel.

- [ ] **Step 1: Create `src/operations/write-test.ts`**

```typescript
export { writeTddTestOp } from "../tdd/session-op";
export type { TddRunOp } from "../tdd/session-op";
```

- [ ] **Step 2: Create `src/operations/implement.ts`**

```typescript
export { implementTddOp } from "../tdd/session-op";
```

- [ ] **Step 3: Create `src/operations/verify.ts`**

```typescript
export { verifyTddOp } from "../tdd/session-op";
```

- [ ] **Step 4: Update `src/operations/index.ts` to export the new ops**

Add to `src/operations/index.ts`:

```typescript
export { writeTddTestOp } from "./write-test";
export type { TddRunOp } from "./write-test";
export { implementTddOp } from "./implement";
export { verifyTddOp } from "./verify";
```

- [ ] **Step 5: Verify typecheck clean**

Run: `bun run typecheck`
Expected: clean (no errors)

- [ ] **Step 6: Commit**

```bash
git add src/operations/write-test.ts src/operations/implement.ts src/operations/verify.ts src/operations/index.ts
git commit -m "feat(adr-018): add write-test, implement, verify TDD op files to operations barrel"
```

---

## Task 4: Extract `runThreeSessionTddFromCtx` to `orchestrator-ctx.ts`

**Files:**
- Create: `src/tdd/orchestrator-ctx.ts`
- Modify: `src/tdd/orchestrator.ts` (delete `runThreeSessionTddFromCtx` from it)
- Modify: `src/tdd/index.ts` (update exports to import from `orchestrator-ctx`)

This brings `orchestrator.ts` from 710 → ~538 lines.

- [ ] **Step 1: Create `src/tdd/orchestrator-ctx.ts` with the moved function**

Paste verbatim the `runThreeSessionTddFromCtx` function (lines 539–710 of current `orchestrator.ts`) plus its necessary imports:

```typescript
/**
 * Pipeline-context adapter for the three-session TDD orchestrator.
 *
 * Provides runThreeSessionTddFromCtx which assembles per-role context bundles
 * (v2 path) and record/binding hooks before delegating to runThreeSessionTdd.
 */

import type { PipelineContext } from "../pipeline/types";
import { appendScratchEntry, readDigestFile, writeDigestFile } from "../session/scratch-writer";
import { errorMessage } from "../utils/errors";
import { getLogger } from "../logger";
import type { TddSessionRole, ThreeSessionTddResult } from "./types";
import type { ThreeSessionTddOptions } from "./orchestrator";
import { runThreeSessionTdd } from "./orchestrator";

export async function runThreeSessionTddFromCtx(
  ctx: PipelineContext,
  opts: { agent: import("../agents").AgentAdapter; dryRun?: boolean; lite?: boolean },
): Promise<ThreeSessionTddResult> {
  // [paste full function body from orchestrator.ts lines 551–710]
}
```

**Exact body to paste** (copy from `orchestrator.ts` lines 551–710):

```typescript
  let tddContextBundles: ThreeSessionTddOptions["tddContextBundles"];
  let getTddContextBundle: ThreeSessionTddOptions["getTddContextBundle"];
  let recordTddSessionOutcome: ThreeSessionTddOptions["recordTddSessionOutcome"];
  const sessionIdByRole = new Map<TddSessionRole, string>();
  const getTddSessionBinding: ThreeSessionTddOptions["getTddSessionBinding"] = (role) => {
    if (!ctx.sessionManager) return undefined;
    const id = sessionIdByRole.get(role);
    if (!id) return undefined;
    return { sessionManager: ctx.sessionManager, sessionId: id };
  };

  if (ctx.config.context?.v2?.enabled) {
    const { assembleForStage } = await import("../context/engine");
    const stageByRole: Record<TddSessionRole, string> = {
      "test-writer": "tdd-test-writer",
      implementer: "tdd-implementer",
      verifier: "tdd-verifier",
    };
    const priorDigestByRole = new Map<TddSessionRole, string | undefined>();
    const scratchDirByRole = new Map<TddSessionRole, string | undefined>();
    const storyScratchDirs = new Set<string>(ctx.sessionScratchDir ? [ctx.sessionScratchDir] : []);

    const ensureRoleScratchDir = (role: TddSessionRole): string | undefined => {
      const existing = scratchDirByRole.get(role);
      if (existing !== undefined) return existing;
      let created: string | undefined;
      if (ctx.sessionManager && ctx.prd.feature) {
        const reuseExisting =
          role === "implementer" && ctx.sessionId && ctx.sessionScratchDir
            ? ctx.sessionManager.get(ctx.sessionId)
            : undefined;
        const descriptor =
          reuseExisting ??
          ctx.sessionManager.create({
            role,
            agent: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude",
            workdir: ctx.workdir,
            projectDir: ctx.projectDir,
            featureName: ctx.prd.feature,
            storyId: ctx.story.id,
          });
        created = descriptor.scratchDir;
        sessionIdByRole.set(role, descriptor.id);
      } else {
        created = ctx.sessionScratchDir;
      }
      scratchDirByRole.set(role, created);
      if (created) storyScratchDirs.add(created);
      return created;
    };

    const resolvePriorDigest = async (role: TddSessionRole): Promise<string | undefined> => {
      if (role === "test-writer") return ctx.contextBundle?.digest;
      const priorRole: TddSessionRole = role === "implementer" ? "test-writer" : "implementer";
      const inMemory = priorDigestByRole.get(priorRole);
      if (inMemory) return inMemory;
      const priorStageKey = stageByRole[priorRole];
      for (const dir of storyScratchDirs) {
        try {
          const onDisk = await readDigestFile(dir, priorStageKey);
          if (onDisk) return onDisk;
        } catch {
          // best-effort
        }
      }
      return undefined;
    };

    getTddContextBundle = async (role) => {
      const scratchDir = ensureRoleScratchDir(role);
      const bundle = await assembleForStage(ctx, stageByRole[role], {
        priorStageDigest: await resolvePriorDigest(role),
        storyScratchDirs: [...storyScratchDirs],
      });
      if (bundle) {
        priorDigestByRole.set(role, bundle.digest);
        ctx.contextBundle = bundle;
        if (scratchDir) {
          try {
            await writeDigestFile(scratchDir, stageByRole[role], bundle.digest);
          } catch (error) {
            getLogger().warn("tdd", "Failed to persist TDD stage digest — continuing", {
              storyId: ctx.story.id,
              role,
              error: errorMessage(error),
            });
          }
        }
      }
      return bundle ?? undefined;
    };

    recordTddSessionOutcome = async (result) => {
      const scratchDir = ensureRoleScratchDir(result.role);
      if (!scratchDir) return;
      try {
        await appendScratchEntry(scratchDir, {
          kind: "tdd-session",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: stageByRole[result.role],
          role: result.role,
          success: result.success,
          filesChanged: result.filesChanged,
          outputTail: result.outputTail ?? "",
          writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
        });
        const digest = priorDigestByRole.get(result.role);
        if (digest) {
          await writeDigestFile(scratchDir, stageByRole[result.role], digest);
        }
      } catch (error) {
        getLogger().warn("tdd", "Failed to persist TDD session scratch — continuing", {
          storyId: ctx.story.id,
          role: result.role,
          error: errorMessage(error),
        });
      }
    };
  }

  return runThreeSessionTdd({
    agent: opts.agent,
    story: ctx.story,
    config: ctx.config,
    workdir: ctx.workdir,
    modelTier: ctx.routing.modelTier,
    featureName: ctx.prd.feature,
    contextMarkdown: ctx.contextMarkdown,
    featureContextMarkdown: ctx.featureContextMarkdown,
    tddContextBundles,
    getTddContextBundle,
    recordTddSessionOutcome,
    getTddSessionBinding,
    constitution: ctx.constitution?.content,
    dryRun: opts.dryRun ?? false,
    lite: opts.lite ?? false,
    interactionChain: ctx.interaction,
    projectDir: ctx.projectDir,
    abortSignal: ctx.abortSignal,
  });
```

- [ ] **Step 2: Remove `runThreeSessionTddFromCtx` from `src/tdd/orchestrator.ts`**

Delete lines 539–710 from `orchestrator.ts` (the comment + entire `runThreeSessionTddFromCtx` function). Also remove any imports from orchestrator.ts that are now only used by the moved function.

Imports to remove from orchestrator.ts (check each is not used elsewhere in the file):
- `appendScratchEntry, readDigestFile, writeDigestFile` from `../session/scratch-writer`
- `type PipelineContext` from `../pipeline/types`

- [ ] **Step 3: Update `src/tdd/index.ts` barrel**

Change the export line for `runThreeSessionTddFromCtx`:

```typescript
// Before:
export { runThreeSessionTdd, runThreeSessionTddFromCtx } from "./orchestrator";

// After:
export { runThreeSessionTdd } from "./orchestrator";
export { runThreeSessionTddFromCtx } from "./orchestrator-ctx";
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 5: Run affected tests**

Run: `timeout 30 bun test test/unit/tdd/ --timeout=5000`
Expected: all green

- [ ] **Step 6: Verify line count**

Run: `wc -l src/tdd/orchestrator.ts`
Expected: ~538 lines (reduced from 710; still need Task 5 to get under 400)

- [ ] **Step 7: Commit**

```bash
git add src/tdd/orchestrator-ctx.ts src/tdd/orchestrator.ts src/tdd/index.ts
git commit -m "refactor(adr-018): extract runThreeSessionTddFromCtx to orchestrator-ctx.ts"
```

---

## Task 5: Rewire `orchestrator.ts` — use `runTddSessionOp` + extract helpers

**Files:**
- Modify: `src/tdd/orchestrator.ts`

This is the core rewire. Replace 3 `runTddSession(…)` blocks with `runTddSessionOp(op, options, ref, bundle, binding)`. Extract greenfield-check and verdict-processing logic into named helper functions. Target: `orchestrator.ts` **under 400 lines**.

### Current structure (lines 109–537 after Task 4)

The function body has three distinct extractable blocks:

**Block A (lines ~262–329): Greenfield detection** — checks if test-writer produced zero files, queries `isGreenfieldStory`, returns early failure if truly greenfield.

**Block B (lines ~424–490): Verdict processing** — reads verdict, handles categorization, fallback path for no-verdict.

### Step 1: Write the failing test (regression guard)

The existing test in `test/unit/tdd/orchestrator-totals.test.ts` calls `runThreeSessionTdd` directly. These must pass unchanged after the rewire.

Run: `timeout 30 bun test test/unit/tdd/orchestrator-totals.test.ts --timeout=5000`
Expected: GREEN (baseline, must remain green throughout)

### Step 2: Extract `checkGreenfieldOrPause` helper

- [ ] Add this helper function **at the bottom** of `src/tdd/orchestrator.ts` (before the closing brace of the file, after `runThreeSessionTdd`):

```typescript
/**
 * After a test-writer session, determine if the project is genuinely greenfield
 * (no pre-existing tests and session created no new test files).
 * Returns an early-failure ThreeSessionTddResult if greenfield pause is needed,
 * or null to continue.
 */
async function checkGreenfieldOrPause(
  session1: TddSessionResult,
  workdir: string,
  config: import("../config").NaxConfig,
  story: UserStory,
  sessions: TddSessionResult[],
  lite: boolean,
): Promise<ThreeSessionTddResult | null> {
  const logger = getLogger();
  const _tddTestFilePatterns =
    typeof config.execution?.smartTestRunner === "object" && config.execution.smartTestRunner !== null
      ? config.execution.smartTestRunner.testFilePatterns
      : undefined;
  const testFilesCreated = session1.filesChanged.filter((f) => isTestFile(f, _tddTestFilePatterns));

  if (testFilesCreated.length > 0) return null; // normal path: tests were created

  // No new test files — check if pre-existing tests exist
  const resolvedForGreenfield = await resolveTestFilePatterns(config, workdir);
  let hasPreExistingTests = false;
  try {
    hasPreExistingTests = !(await isGreenfieldStory(story, workdir, resolvedForGreenfield.globs));
    const dirCheck = Bun.spawn(["test", "-d", workdir], { stdout: "pipe", stderr: "pipe" });
    if ((await dirCheck.exited) !== 0) hasPreExistingTests = false;
  } catch {
    hasPreExistingTests = false;
  }

  if (hasPreExistingTests) {
    logger.info("tdd", "Test writer created no new files but tests already exist in repo — proceeding to implementer", {
      storyId: story.id,
    });
    return null; // pre-existing tests: proceed
  }

  // Truly greenfield
  const reviewReason = "Test writer session created no test files (greenfield project)";
  logger.warn("tdd", "[WARN] Test writer created no test files - greenfield detected", {
    storyId: story.id,
    reviewReason,
    filesChanged: session1.filesChanged,
  });
  return {
    success: false,
    sessions,
    needsHumanReview: true,
    reviewReason,
    failureCategory: "greenfield-no-tests",
    totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
    lite,
  };
}
```

### Step 3: Extract `processVerdictOutcome` helper

- [ ] Add this helper function at the bottom of `src/tdd/orchestrator.ts`:

```typescript
/**
 * Process the verifier verdict (or fall back to running tests directly).
 * Returns the final { allSuccessful, needsHumanReview, reviewReason, finalFailureCategory }.
 */
async function processVerdictOutcome(
  verdict: import("./verdict").VerifierVerdict | null,
  sessions: TddSessionResult[],
  workdir: string,
  config: import("../config").NaxConfig,
  story: UserStory,
): Promise<{
  allSuccessful: boolean;
  needsHumanReview: boolean;
  reviewReason: string | undefined;
  finalFailureCategory: import("./types").FailureCategory | undefined;
}> {
  const logger = getLogger();
  let allSuccessful = sessions.every((s) => s.success);
  let needsHumanReview = false;
  let reviewReason: string | undefined;
  let finalFailureCategory: import("./types").FailureCategory | undefined;

  if (verdict !== null) {
    const categorization = categorizeVerdict(verdict, verdict.tests.allPassing);
    if (categorization.success) {
      logger.info("tdd", "[OK] Verifier verdict: approved", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        testsAllPassing: verdict.tests.allPassing,
      });
      allSuccessful = true;
      needsHumanReview = false;
    } else {
      logger.warn("tdd", "[WARN] Verifier verdict: rejected", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        failureCategory: categorization.failureCategory,
        reviewReason: categorization.reviewReason,
      });
      allSuccessful = false;
      finalFailureCategory = categorization.failureCategory;
      needsHumanReview = true;
      reviewReason = categorization.reviewReason;
    }
  } else if (!allSuccessful) {
    logger.info("tdd", "-> Running post-TDD test verification (no verdict file)", { storyId: story.id });
    const testCmd = config.quality?.commands?.test ?? "bun test";
    const postVerify = await executeWithTimeout(testCmd, 120, undefined, { cwd: workdir });
    const testsActuallyPass = postVerify.success && postVerify.exitCode === 0;
    const truncatedStdout = postVerify.output ? truncateTestOutput(postVerify.output) : "";
    const truncatedStderr = postVerify.error ? truncateTestOutput(postVerify.error) : "";
    if (testsActuallyPass) {
      logger.info("tdd", "Sessions had non-zero exits but tests pass - treating as success", {
        storyId: story.id,
        stdout: truncatedStdout,
      });
      allSuccessful = true;
      needsHumanReview = false;
    } else {
      logger.warn("tdd", "[WARN] Post-TDD verification: tests still failing", {
        storyId: story.id,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
      });
      needsHumanReview = true;
      reviewReason = "Verifier session identified issues and tests still fail";
      finalFailureCategory = "tests-failing";
    }
  }

  return { allSuccessful, needsHumanReview, reviewReason, finalFailureCategory };
}
```

### Step 4: Rewire `runThreeSessionTdd` to use `runTddSessionOp`

- [ ] Replace the 3 `runTddSession(...)` call blocks in `runThreeSessionTdd` with `runTddSessionOp` calls.

**Replace Session 1 (test-writer)** — find the block:
```typescript
    const testWriterTier = config.tdd.sessionTiers?.testWriter ?? "balanced";
    const testWriterBundle = (await getTddContextBundle?.("test-writer")) ?? tddContextBundles?.testWriter;
    session1 = await runTddSession(
      "test-writer",
      agent,
      story,
      config,
      workdir,
      testWriterTier,
      session1Ref,
      contextMarkdown,
      lite,
      lite,
      constitution,
      featureName,
      buildInteractionBridge(interactionChain, { featureName, storyId: story.id, stage: "execution" }),
      projectDir,
      featureContextMarkdown,
      testWriterBundle,
      getTddSessionBinding?.("test-writer"),
      abortSignal,
    );
```

Replace with:
```typescript
    const testWriterBundle = (await getTddContextBundle?.("test-writer")) ?? tddContextBundles?.testWriter;
    session1 = await runTddSessionOp(
      writeTddTestOp,
      options,
      session1Ref,
      testWriterBundle,
      getTddSessionBinding?.("test-writer"),
    );
```

**Replace Session 2 (implementer)** — find:
```typescript
  const implementerTier = config.tdd.sessionTiers?.implementer ?? modelTier;
  const implementerBundle = (await getTddContextBundle?.("implementer")) ?? tddContextBundles?.implementer;
  const session2 = await runTddSession(
    "implementer",
    agent,
    story,
    config,
    workdir,
    implementerTier,
    session2Ref,
    contextMarkdown,
    lite,
    lite,
    constitution,
    featureName,
    buildInteractionBridge(interactionChain, { featureName, storyId: story.id, stage: "execution" }),
    projectDir,
    featureContextMarkdown,
    implementerBundle,
    getTddSessionBinding?.("implementer"),
    abortSignal,
  );
```

Replace with:
```typescript
  const implementerBundle = (await getTddContextBundle?.("implementer")) ?? tddContextBundles?.implementer;
  const session2 = await runTddSessionOp(
    implementTddOp,
    options,
    session2Ref,
    implementerBundle,
    getTddSessionBinding?.("implementer"),
  );
```

**Replace Session 3 (verifier)** — find:
```typescript
  const verifierTier = config.tdd.sessionTiers?.verifier ?? "fast";
  const verifierBundle = (await getTddContextBundle?.("verifier")) ?? tddContextBundles?.verifier;
  const session3 = await runTddSession(
    "verifier",
    agent,
    story,
    config,
    workdir,
    verifierTier,
    session3Ref,
    undefined,
    false,
    false,
    constitution,
    featureName,
    undefined,
    projectDir,
    featureContextMarkdown,
    verifierBundle,
    getTddSessionBinding?.("verifier"),
    abortSignal,
  );
```

Replace with:
```typescript
  const verifierBundle = (await getTddContextBundle?.("verifier")) ?? tddContextBundles?.verifier;
  const session3 = await runTddSessionOp(
    verifyTddOp,
    options,
    session3Ref,
    verifierBundle,
    getTddSessionBinding?.("verifier"),
  );
```

### Step 5: Replace inline greenfield detection with helper call

- [ ] Find the large greenfield detection block (after `sessions.push(session1); await recordTddSessionOutcome?.(session1);` and before the `logger.info("tdd", "Created test files"...` log). Replace it with:

```typescript
  if (!isRetry) {
    const greenfieldPause = await checkGreenfieldOrPause(session1!, workdir, config, story, sessions, lite);
    if (greenfieldPause) return greenfieldPause;
  }
```

### Step 6: Replace inline verdict processing with helper call

- [ ] Find the verdict processing block (after `sessions.push(session3); await recordTddSessionOutcome?.(session3);`) and replace it with:

```typescript
  const verdict = await readVerdict(workdir);
  await cleanupVerdict(workdir);
  const { allSuccessful, needsHumanReview, reviewReason, finalFailureCategory } =
    await processVerdictOutcome(verdict, sessions, workdir, config, story);
```

### Step 7: Update imports in `orchestrator.ts`

- [ ] Add `runTddSessionOp, writeTddTestOp, implementTddOp, verifyTddOp` import:

```typescript
import { runTddSessionOp, writeTddTestOp, implementTddOp, verifyTddOp } from "./session-op";
```

- [ ] Remove `runTddSession` import (now only called via `runTddSessionOp`):
Remove `rollbackToRef, runTddSession, truncateTestOutput` from `./session-runner` import.
Add back only `rollbackToRef, truncateTestOutput` (still needed for rollback and verdict fallback).

- [ ] Remove `buildInteractionBridge` import if no longer used in `runThreeSessionTdd` body.

### Step 8: Verify line count

- [ ] Run: `wc -l src/tdd/orchestrator.ts`
  Expected: < 400 lines

### Step 9: Run tests

- [ ] Run: `timeout 30 bun test test/unit/tdd/ --timeout=5000`
  Expected: all green

- [ ] **Step 10: Commit**

```bash
git add src/tdd/orchestrator.ts src/tdd/session-op.ts
git commit -m "refactor(adr-018): rewire runThreeSessionTdd to use runTddSessionOp ×3; extract greenfield + verdict helpers"
```

---

## Task 6: Delete `ThreeSessionRunner`; update `execution.ts`

**Files:**
- Delete: `src/tdd/three-session-runner.ts`
- Modify: `src/pipeline/stages/execution.ts`

### What `execution.ts` needs after deletion

`ThreeSessionRunner.run()` returned `ThreeSessionStoryRunOutcome` which wraps `ThreeSessionTddResult`. After deletion, `execution.ts` calls `runThreeSessionTddFromCtx` directly and synthesizes the same fields inline.

- [ ] **Step 1: Check for any other importers of `three-session-runner`**

Run: `grep -rn "three-session-runner\|ThreeSessionRunner\|ThreeSessionStoryRunOutcome\|ThreeSessionRunnerContext" src/ test/`
Expected: only in `execution.ts` and `three-session-runner.ts` itself (and `session/session-runner.ts` for `SessionRunnerContext`/`StoryRunOutcome` — those stay)

- [ ] **Step 2: Update `src/pipeline/stages/execution.ts`**

**Remove** the import line:
```typescript
import { ThreeSessionRunner } from "../../tdd/three-session-runner";
```

**Add** the import for `runThreeSessionTddFromCtx`:
```typescript
import { runThreeSessionTddFromCtx } from "../../tdd";
```

Also add `AgentResult` to the imports from agents (needed for synthesizing primaryResult):
```typescript
import type { AgentResult } from "../../agents/types";
```

**Replace** the `ThreeSessionRunner` block (lines 59–83 of `execution.ts`):

```typescript
      const tddRunner = new ThreeSessionRunner();
      const outcome = await tddRunner.run({
        pipelineContext: ctx,
        agent,
        dryRun: false,
        lite: isLiteMode,
        sessionId: ctx.sessionId,
        sessionManager: ctx.sessionManager,
        defaultAgent,
        runOptions: {
          prompt: ctx.prompt ?? "",
          workdir: ctx.workdir,
          modelTier: ctx.routing.modelTier,
          modelDef: resolveModelForAgent(
            ctx.rootConfig.models,
            ctx.routing.agent ?? defaultAgent,
            ctx.routing.modelTier,
            defaultAgent,
          ),
          timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
          pipelineStage: "run",
          config: ctx.config,
        },
      });
```

**With:**

```typescript
      const tddResult = await runThreeSessionTddFromCtx(ctx, {
        agent,
        dryRun: false,
        lite: isLiteMode,
      });
      const primaryResult: AgentResult = {
        success: tddResult.success,
        estimatedCost: tddResult.totalCost,
        rateLimited: false,
        output: "",
        exitCode: tddResult.success ? 0 : 1,
        durationMs: tddResult.totalDurationMs ?? 0,
        ...(tddResult.totalTokenUsage && { tokenUsage: tddResult.totalTokenUsage }),
      };
      const outcome = {
        success: tddResult.success,
        primaryResult,
        totalCost: tddResult.totalCost,
        totalTokenUsage: tddResult.totalTokenUsage,
        fallbacks: [],
        needsHumanReview: tddResult.needsHumanReview,
        reviewReason: tddResult.reviewReason,
        failureCategory: tddResult.failureCategory,
        fullSuiteGatePassed: tddResult.fullSuiteGatePassed,
        lite: tddResult.lite,
      };
```

The rest of the `execution.ts` block (setting `ctx.agentResult`, checking `fullSuiteGatePassed`, etc.) stays exactly as is.

Also **remove** `resolveModelForAgent` from imports if it's no longer used in the TDD path (check if it's still used in the single-session path — it is, at line ~163, so keep it).

- [ ] **Step 3: Delete `src/tdd/three-session-runner.ts`**

```bash
rm src/tdd/three-session-runner.ts
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 5: Run the full test suite**

Run: `timeout 60 bun test test/unit/tdd/ test/unit/pipeline/stages/execution.test.ts --timeout=10000`
Expected: all green

Check if execution stage tests exist:
```bash
ls test/unit/pipeline/stages/
```

If `execution.test.ts` exists, run it. If not, run the broader:
```bash
timeout 60 bun test test/unit/pipeline/ --timeout=10000
```

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/stages/execution.ts src/tdd/three-session-runner.ts src/tdd/orchestrator-ctx.ts
git commit -m "refactor(adr-018): delete ThreeSessionRunner; execution.ts calls runThreeSessionTddFromCtx directly"
```

---

## Task 7: Update barrels + final verification + create PR

**Files:**
- Modify: `src/tdd/index.ts` (add `runTddSessionOp`, `TddRunOp`, `writeTddTestOp`, `implementTddOp`, `verifyTddOp`)
- Modify: `docs/superpowers/plans/2026-04-26-adr-018-wave-3.md` (mark Phase F as Done)

- [ ] **Step 1: Update `src/tdd/index.ts` to export session-op exports**

Add to `src/tdd/index.ts`:
```typescript
export { runTddSessionOp, writeTddTestOp, implementTddOp, verifyTddOp } from "./session-op";
export type { TddRunOp } from "./session-op";
```

- [ ] **Step 2: Run full test suite**

Run: `bun run test`
Expected: all green

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: clean

- [ ] **Step 5: Verify line counts**

```bash
wc -l src/tdd/orchestrator.ts src/tdd/orchestrator-ctx.ts src/tdd/session-op.ts \
        src/operations/write-test.ts src/operations/implement.ts src/operations/verify.ts
```

Expected:
- `orchestrator.ts`: < 400
- `orchestrator-ctx.ts`: < 200
- `session-op.ts`: < 100
- Each op file: < 10

- [ ] **Step 6: Verify Phase F exit criteria**

```bash
# ThreeSessionRunner is gone
grep -r "ThreeSessionRunner" src/ && echo "FAIL: ThreeSessionRunner still exists" || echo "OK: ThreeSessionRunner deleted"

# session-op.ts exports all three ops
grep -n "writeTddTestOp\|implementTddOp\|verifyTddOp" src/tdd/session-op.ts

# orchestrator.ts uses runTddSessionOp
grep -n "runTddSessionOp" src/tdd/orchestrator.ts

# orchestrator.ts is under 400 lines
wc -l src/tdd/orchestrator.ts
```

- [ ] **Step 7: Update ADR-018 wave 3 tracking doc**

In `docs/superpowers/plans/2026-04-26-adr-018-wave-3.md`, update Phase F exit criteria checkboxes from `- [ ]` to `- [x]`.

- [ ] **Step 8: Commit final state**

```bash
git add src/tdd/index.ts docs/superpowers/plans/2026-04-26-adr-018-wave-3.md
git commit -m "refactor(adr-018): Phase F complete — update barrels and mark exit criteria"
```

- [ ] **Step 9: Create PR**

```bash
gh pr create \
  --title "refactor(adr-018): Wave 3 Phase F — TDD orchestrator rewire" \
  --body "$(cat <<'EOF'
## Summary

- Deletes `ThreeSessionRunner` class — `execution.ts` now calls `runThreeSessionTddFromCtx` directly
- Creates `src/tdd/session-op.ts` with `runTddSessionOp(op, options, beforeRef, bundle?, binding?)` shared helper
- Creates `writeTddTestOp`, `implementTddOp`, `verifyTddOp` op config objects in `src/operations/`
- Rewires `runThreeSessionTdd` to use `runTddSessionOp` ×3 instead of direct `runTddSession` calls
- Extracts `runThreeSessionTddFromCtx` to `orchestrator-ctx.ts`; extracts `checkGreenfieldOrPause` + `processVerdictOutcome` helpers
- Adds `TddPromptBuilder.buildForRole()` static method consolidating per-role prompt assembly
- All files under 400-line limit; `orchestrator.ts` reduced from 710 → <400 lines

## Phase F exit criteria

- [x] `ThreeSessionRunner` class deleted
- [x] `runThreeSessionTdd` calls `runTddSessionOp` for each of write-test, implement, verify
- [x] `tdd-builder.ts` exposes `buildForRole` static method
- [x] Between-session logic (greenfield detection, verdict reading) is preserved
- [x] `bun run typecheck` clean
- [x] `bun run test` green

## Test plan

- [ ] `bun run test` — full suite green
- [ ] `bun run typecheck` — no errors
- [ ] `bun run lint` — no warnings
- [ ] `grep -r "ThreeSessionRunner" src/` — no results
- [ ] `wc -l src/tdd/orchestrator.ts` — under 400 lines
EOF
)"
```

---

## Reference: Key Files

| File | Role |
|:-----|:-----|
| `src/tdd/orchestrator.ts` | Main TDD orchestration — `runThreeSessionTdd` (now uses `runTddSessionOp`) |
| `src/tdd/orchestrator-ctx.ts` | Pipeline adapter — `runThreeSessionTddFromCtx` |
| `src/tdd/session-op.ts` | Op specs + `runTddSessionOp` helper |
| `src/tdd/session-runner.ts` | Low-level session runner — `runTddSession` (unchanged) |
| `src/operations/write-test.ts` | Re-exports `writeTddTestOp` |
| `src/operations/implement.ts` | Re-exports `implementTddOp` |
| `src/operations/verify.ts` | Re-exports `verifyTddOp` |
| `src/pipeline/stages/execution.ts` | Calls `runThreeSessionTddFromCtx` directly (no more `ThreeSessionRunner`) |
