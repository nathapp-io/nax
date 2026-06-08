# Issue 1 — Per-Role Model Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the implementer follow the story's `routing.modelTier` (+ escalation), and make the test-writer/verifier follow `tdd.sessionTiers`, instead of all three silently dispatching on the hardcoded `"balanced"` tier.

**Architecture:** The three per-story run-ops (`implementerOp`, `testWriterOp`, `verifierOp`) declare no `model` resolver, so `callOp` falls through to `resolveOpModel(op) ?? "balanced"` (`src/operations/call.ts:140`). Fix = add a `model` resolver to each op. Implementer reads `input.story.routing.modelTier` (escalation mutates this field in the PRD before re-dispatch, so it is escalation-aware for free). Test-writer/verifier read `tdd.sessionTiers.{testWriter,verifier}`, which we widen to a full `ConfiguredModel` with a Zod `.default("fast")` so unconfigured repos get a sensible tier instead of the accidental `"balanced"`.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, Zod config schema.

**Background:** Full diagnosis in `docs/findings/2026-06-08-model-tier-and-quality-gate-diagnosis.md` (Issue 1). `storyMetrics.modelUsed` (derived from `routing.modelTier`) is **correct by design** — do NOT change it.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/config/schemas-execution.ts` | `TddConfigSchema.sessionTiers` shape | Modify — widen to `ConfiguredModel`, add defaults |
| `src/operations/implement.ts` | implementer run-op | Modify — add `model` resolver |
| `src/operations/write-test.ts` | test-writer run-op | Modify — add `model` resolver |
| `src/operations/verify.ts` | verifier run-op | Modify — add `model` resolver |
| `test/unit/config/sessiontiers-defaults.test.ts` | schema default coverage | Create |
| `test/unit/operations/per-role-model-resolver.test.ts` | op `model` resolver coverage | Create |

---

## Task 1: Widen `tdd.sessionTiers` schema with `ConfiguredModel` + defaults

**Files:**
- Modify: `src/config/schemas-execution.ts:251-257`
- Test: `test/unit/config/sessiontiers-defaults.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/sessiontiers-defaults.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { TddConfigSchema } from "@/config/schemas-execution";

describe("tdd.sessionTiers defaults", () => {
  test("materializes testWriter/verifier defaults when sessionTiers is absent", () => {
    const parsed = TddConfigSchema.parse({
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
    });
    expect(parsed.sessionTiers?.testWriter).toBe("fast");
    expect(parsed.sessionTiers?.verifier).toBe("fast");
  });

  test("respects an explicit tier string", () => {
    const parsed = TddConfigSchema.parse({
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
      sessionTiers: { testWriter: "balanced" },
    });
    expect(parsed.sessionTiers?.testWriter).toBe("balanced");
    expect(parsed.sessionTiers?.verifier).toBe("fast"); // default still applied
  });

  test("accepts a ConfiguredModel object ({ agent, model })", () => {
    const parsed = TddConfigSchema.parse({
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
      sessionTiers: { verifier: { agent: "claude", model: "haiku" } },
    });
    expect(parsed.sessionTiers?.verifier).toEqual({ agent: "claude", model: "haiku" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/config/sessiontiers-defaults.test.ts --timeout=5000`
Expected: FAIL — `testWriter` is `undefined` (current schema is `z.string().optional()` with no default).

- [ ] **Step 3: Edit the schema**

In `src/config/schemas-execution.ts`, the file already imports from `./schemas-model` at line 7:

```typescript
import { ModelTierSchema, TierConfigSchema } from "./schemas-model";
```

Add `ConfiguredModelSchema` to that existing import (do NOT add a second import line):

```typescript
import { ConfiguredModelSchema, ModelTierSchema, TierConfigSchema } from "./schemas-model";
```

Then replace the `sessionTiers` block (currently lines 251-257):

```typescript
  sessionTiers: z
    .object({
      testWriter: z.string().optional(),
      implementer: z.string().optional(),
      verifier: z.string().optional(),
    })
    .optional(),
```

with:

```typescript
  sessionTiers: z
    .object({
      // ConfiguredModel = tier string ("fast") OR { agent, model } cross-agent pin.
      testWriter: ConfiguredModelSchema.default("fast"),
      verifier: ConfiguredModelSchema.default("fast"),
      // implementer is routing-driven (story.routing.modelTier + escalation); this
      // field is intentionally NOT consumed. Kept optional so legacy configs parse.
      implementer: ConfiguredModelSchema.optional(),
    })
    .default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/config/sessiontiers-defaults.test.ts --timeout=5000`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/schemas-execution.ts test/unit/config/sessiontiers-defaults.test.ts
git commit -m "feat(config): tdd.sessionTiers accepts ConfiguredModel with fast default"
```

---

## Task 2: Implementer follows `story.routing.modelTier` (escalation-aware)

**Files:**
- Modify: `src/operations/implement.ts:36-42` (add `model` to `implementerOp`)
- Test: `test/unit/operations/per-role-model-resolver.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/per-role-model-resolver.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { implementerOp } from "@/operations";
import type { UserStory } from "@/prd";

function storyWithTier(tier: string | undefined): UserStory {
  return {
    id: "US-001",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    dependencies: [],
    status: "pending",
    passes: false,
    attempts: 0,
    routing: tier ? { complexity: "medium", modelTier: tier, testStrategy: "tdd-simple", reasoning: "" } : undefined,
  } as unknown as UserStory;
}

const buildCtx = { config: {} as any, packageView: {} as any };

describe("implementerOp.model — routing-driven", () => {
  test("returns the story's initial modelTier", () => {
    const resolver = implementerOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({ story: storyWithTier("fast") }, buildCtx)).toBe("fast");
  });

  test("follows the escalated tier (escalation mutates story.routing.modelTier)", () => {
    const resolver = implementerOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({ story: storyWithTier("powerful") }, buildCtx)).toBe("powerful");
  });

  test("returns undefined when routing is absent (callOp then defaults)", () => {
    const resolver = implementerOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({ story: storyWithTier(undefined) }, buildCtx)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "implementerOp" --timeout=5000`
Expected: FAIL — `implementerOp.model` is `undefined` (op declares no `model`).

- [ ] **Step 3: Add the `model` resolver**

In `src/operations/implement.ts`, inside the `implementerOp` object, add a `model` line immediately after `config: tddConfigSelector,` (line 41):

```typescript
export const implementerOp: RunOperation<ImplementerInput, ImplementerOutput, TddConfig> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  session: { role: "implementer", lifetime: "warm" },
  config: tddConfigSelector,
  // Routing-driven: escalation mutates story.routing.modelTier in the PRD before
  // re-dispatch, so reading it here is escalation-aware. Returns undefined for
  // ad-hoc callers without routing — callOp then falls back to its default tier.
  model: (input) => input.story.routing?.modelTier,
  keepOpen: (_input, ctx) => shouldKeepSessionOpen(ctx.config, "implementer"),
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "implementerOp" --timeout=5000`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/operations/implement.ts test/unit/operations/per-role-model-resolver.test.ts
git commit -m "fix(execution): implementer follows story routing tier + escalation (ADR Issue-1)"
```

---

## Task 3: Test-writer follows `tdd.sessionTiers.testWriter`

**Files:**
- Modify: `src/operations/write-test.ts:43-52` (add `model` to `testWriterOp`)
- Test: `test/unit/operations/per-role-model-resolver.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/per-role-model-resolver.test.ts`:

```typescript
import { testWriterOp } from "@/operations";

function tddBuildCtx(sessionTiers?: Record<string, unknown>) {
  return { config: { tdd: { sessionTiers } }, packageView: {} as any };
}

describe("testWriterOp.model — tdd.sessionTiers.testWriter", () => {
  test("returns the configured testWriter tier", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ testWriter: "fast" }))).toBe("fast");
  });

  test("passes a ConfiguredModel object through unchanged", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ testWriter: { agent: "claude", model: "haiku" } }))).toEqual({
      agent: "claude",
      model: "haiku",
    });
  });

  test("returns undefined when sessionTiers is absent (callOp then defaults)", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "testWriterOp" --timeout=5000`
Expected: FAIL — `testWriterOp.model` is `undefined`.

- [ ] **Step 3: Add the `model` resolver**

In `src/operations/write-test.ts`, inside `testWriterOp`, add a `model` line immediately after `config: tddConfigSelector,` (line 51):

```typescript
  config: tddConfigSelector,
  // Test-writing is a cheap scoped task — follows the configured per-role tier.
  // Defaults to "fast" via the schema; undefined only for partial test configs.
  model: (_input, ctx) => ctx.config.tdd?.sessionTiers?.testWriter,
  keepOpen: (_input, ctx) => shouldKeepSessionOpen(ctx.config, "test-writer"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "testWriterOp" --timeout=5000`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/operations/write-test.ts test/unit/operations/per-role-model-resolver.test.ts
git commit -m "fix(execution): test-writer follows tdd.sessionTiers.testWriter"
```

---

## Task 4: Verifier follows `tdd.sessionTiers.verifier`

**Files:**
- Modify: `src/operations/verify.ts:149-154` (add `model` to `verifierOp`)
- Test: `test/unit/operations/per-role-model-resolver.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/per-role-model-resolver.test.ts`:

```typescript
import { verifierOp } from "@/operations";

describe("verifierOp.model — tdd.sessionTiers.verifier", () => {
  test("returns the configured verifier tier", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ verifier: "fast" }))).toBe("fast");
  });

  test("returns undefined when sessionTiers is absent", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "verifierOp" --timeout=5000`
Expected: FAIL — `verifierOp.model` is `undefined`.

- [ ] **Step 3: Add the `model` resolver**

In `src/operations/verify.ts`, the op header is (lines 149-155):

```typescript
export const verifierOp: RunOperation<VerifierInput, VerifierOutput, TddConfig> = {
  kind: "run",
  name: "verifier",
  stage: "verify",
  session: { role: "verifier", lifetime: "fresh" },
  config: tddConfigSelector,
  // retry: makeParseRetryStrategy({ ... }) follows
```

Add a `model` line immediately after `config: tddConfigSelector,`:

```typescript
  config: tddConfigSelector,
  // Verification is a cheap scoped task — follows the configured per-role tier.
  model: (_input, ctx) => ctx.config.tdd?.sessionTiers?.verifier,
```

(Field order within the object literal is irrelevant; this just keeps it next to `config`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "verifierOp" --timeout=5000`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full resolver + schema suite**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts test/unit/config/sessiontiers-defaults.test.ts --timeout=5000`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/operations/verify.ts test/unit/operations/per-role-model-resolver.test.ts
git commit -m "fix(execution): verifier follows tdd.sessionTiers.verifier"
```

---

## Task 5: Integration guard — `callOp` resolves the per-role tier end-to-end

This proves the resolver output actually reaches `effectiveTier` (not just that the resolver returns a value).

**Files:**
- Test: `test/unit/operations/per-role-model-resolver.test.ts` (append)

- [ ] **Step 1: Write the failing/【regression】test**

Append a test that exercises `resolveOpModel` → `resolveConfiguredModel` the way `callOp` does. Reuse the exported helpers if available; otherwise assert via `callOp` with a fake runtime. Minimal version asserting the contract `callOp` relies on (`call.ts:140,147`):

```typescript
import { resolveConfiguredModel } from "@/config"; // barrel re-exports it (src/config/index.ts:39)

describe("per-role tier reaches effectiveTier (callOp contract)", () => {
  const models = {
    opencode: { fast: "minimax/MiniMax-M2.7", balanced: "opencode-go/deepseek-v4-pro", powerful: "minimax/MiniMax-M3" },
  };

  test("fast story → implementer resolves to the fast model, NOT balanced", () => {
    const opModel = (implementerOp.model as any)({ story: storyWithTier("fast") }, buildCtx) ?? "balanced";
    const resolved = resolveConfiguredModel(models as any, "opencode", opModel, "opencode");
    expect(resolved.modelTier).toBe("fast");
  });

  test("unconfigured test-writer still defaults to fast via schema, not balanced", () => {
    // Simulate schema-defaulted config: sessionTiers.testWriter === "fast"
    const opModel = (testWriterOp.model as any)({}, tddBuildCtx({ testWriter: "fast" })) ?? "balanced";
    const resolved = resolveConfiguredModel(models as any, "opencode", opModel, "opencode");
    expect(resolved.modelTier).toBe("fast");
  });
});
```

> Verified: `resolveConfiguredModel` is exported from the `@/config` barrel (`src/config/index.ts:39`, defined at `src/config/schema-types.ts:74`). Signature: `resolveConfiguredModel(models, agentName, configuredModel, defaultAgent)` returning `{ agent, modelTier, modelDef }`.

- [ ] **Step 2: Run test to verify it fails (or passes if resolver tasks are already merged)**

Run: `timeout 30 bun test test/unit/operations/per-role-model-resolver.test.ts -t "effectiveTier" --timeout=5000`
Expected: PASS once Tasks 2-4 are in (this is a regression lock, guarding against a future re-introduction of the hardcoded `"balanced"`).

- [ ] **Step 3: Commit**

```bash
git add test/unit/operations/per-role-model-resolver.test.ts
git commit -m "test(execution): lock per-role tier resolution through callOp contract"
```

---

## Task 6: Full verification gate

- [ ] **Step 1: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 2: Run the affected suites**

Run: `timeout 60 bun test test/unit/operations/ test/unit/config/ --timeout=10000`
Expected: PASS. Investigate any op test that injected `config` assuming the old behavior.

- [ ] **Step 3: Full suite**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 4: Final commit (only if fixups were needed)**

```bash
git add -A
git commit -m "test(execution): fixups for per-role model tier suites"
```

---

## Self-Review Checklist (completed by author)

- **Spec coverage:** implementer→routing (Task 2), test-writer→sessionTiers.testWriter (Task 3), verifier→sessionTiers.verifier (Task 4), schema default+ConfiguredModel (Task 1), escalation-awareness (Task 2 test), end-to-end tier reaches dispatch (Task 5). Metrics intentionally unchanged (documented in header).
- **Placeholder scan:** none — all code shown; the only soft note is the `resolveConfiguredModel` import-path confirmation in Task 5, with a concrete fallback.
- **Type consistency:** `model` resolver signature `(input, ctx) => ConfiguredModel | undefined` matches `OperationModel<I, C>` (`src/operations/types.ts:255`). `ctx.config.tdd?.sessionTiers?.testWriter` matches the slice access already used at `write-test.ts:92`.
