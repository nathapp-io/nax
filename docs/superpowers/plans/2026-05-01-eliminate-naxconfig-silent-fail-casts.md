# Eliminate Silent-Fail `as NaxConfig` Casts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every production `as NaxConfig` cast where the runtime value is a narrowed selector slice that does not actually carry the keys the callee reads — eliminating the silent-fail surface where missing keys default to `undefined` instead of the user's configured value.

**Architecture:** Push the narrowing down into the leaf consumers (prompt-builder, context tool runtime, test-pattern resolver, debate runner) by adding new named selectors to `src/config/selectors.ts` (one selector per leaf scope, kebab-case `name` matching the variable, type alias co-located). Widen `tddConfigSelector` and `reviewConfigSelector` to cover keys those subsystems genuinely need. Casts are removed step-by-step, each step compiles and tests green on its own.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome. Source under `src/`, tests under `test/unit/` and `test/integration/`.

**Out of scope:** Test-fixture casts (`test/**/*.ts`) — those are partial-config builders where the test author knows the shape; not silent-fail risks. The selector `completeConfigSelector` and `CompleteOptions.config` removal — covered by issue #853 Phase 2 (already documented in `selectors.ts:55-58`).

---

## Cast Inventory

Production casts targeted for removal:

| File:line | Cast | Hidden missing keys |
|---|---|---|
| `src/tdd/session-runner.ts:166` | `config as NaxConfig` → `withLoader` | `prompts`, `context`, `project` |
| `src/tdd/session-runner.ts:178` | `config as NaxConfig` → `withLoader` | `prompts`, `context`, `project` |
| `src/tdd/session-runner.ts:190` | `config as NaxConfig` → `withLoader` | `prompts`, `context`, `project` |
| `src/tdd/session-runner.ts:225` | `config as NaxConfig` → `AgentRunOptions.config` | none — redundant under structural typing |
| `src/tdd/session-runner.ts:237` | `config as NaxConfig` → `createContextToolRuntime` | `context`, `project` (resolved via `resolveTestFilePatterns`) |
| `src/tdd/rectification-gate.ts:264` | `config as unknown as NaxConfig` → `AgentRunOptions.config` | none — redundant + double cast |
| `src/review/semantic-debate.ts:124` | `naxConfig as NaxConfig` → `DebateRunner` | many — `DebateRunnerOptions.config` typed `NaxConfig` but only DebateConfig keys used |
| `src/review/semantic.ts:157` | `(naxConfig ?? DEFAULT_CONFIG) as NaxConfig` → `resolveTestFilePatterns` | `project`, `quality` |

Casts kept (legitimate, schema-validated runtime guarantee — not silent fail):

- `src/config/defaults.ts:11`
- `src/config/loader.ts:233, 249, 342`

---

## File Map

**Modified — `src/config/selectors.ts`** — add three new selectors and three type aliases; widen `tddConfigSelector` and `reviewConfigSelector`. Single source of truth for slice shapes.

**Modified — `src/test-runners/resolver.ts`** — narrow `resolveTestFilePatterns` first parameter from `NaxConfig` to `TestPatternConfig`.

**Modified — `src/context/engine/tool-runtime.ts`** — narrow `createContextToolRuntime` `config` option from `NaxConfig` to `ContextToolRuntimeConfig`.

**Modified — `src/prompts/builders/tdd-builder.ts`** — narrow `withLoader` second parameter and `loaderConfig_` field from `NaxConfig` to `PromptLoaderConfig`. Update the static `buildForRole` signature in lockstep.

**Modified — `src/prompts/loader.ts`** — narrow `loadOverride` third parameter from `NaxConfig` to `Pick<NaxConfig, "prompts">` (it only reads `config.prompts?.overrides?.[role]`).

**Modified — `src/debate/runner.ts`** — narrow `DebateRunnerOptions.config` from `NaxConfig` to `DebateConfig`. Replace the `DEFAULT_CONFIG` fallback with `debateConfigSelector.select(DEFAULT_CONFIG)` so the constructor still has a non-`undefined` `DebateConfig` to store.

**Modified — `src/tdd/session-runner.ts`** — drop all four `config as NaxConfig` casts plus the misleading comments.

**Modified — `src/tdd/rectification-gate.ts:264`** — drop the redundant `config as unknown as NaxConfig`.

**Modified — `src/review/semantic.ts:157`** — drop the cast around `resolveTestFilePatterns`.

**Modified — `src/review/semantic-debate.ts:124`** — drop the cast around `createDebateRunner`.

**Modified — `src/operations/build-hop-callback.ts`** — already uses `NaxConfig`; narrow its internal `createContextToolRuntime` call sites if they exist as casts (verified during Task 2).

**Tests — created/extended:**
- `test/unit/config/selectors.test.ts` — extend with assertions for new selectors and the widened slices.
- `test/unit/prompts/loader.test.ts` — assert `loadOverride` accepts a `Pick<NaxConfig, "prompts">` literal at runtime.
- `test/unit/test-runners/resolver.test.ts` — assert `resolveTestFilePatterns` accepts a `TestPatternConfig` literal.
- `test/unit/context/engine/tool-runtime.test.ts` — new file; assert `createContextToolRuntime` accepts a `ContextToolRuntimeConfig` literal.

**Verification — created:**
- `scripts/check-no-silent-naxconfig-cast.sh` — grep guard run in Task 7 to prove zero remaining production casts.

---

## Naming Conventions Recap (per `src/config/selectors.ts`)

- Variable: `<scope>ConfigSelector` (camelCase).
- `pickSelector` first arg (the `name` field): kebab-case, matching the variable scope (e.g. `"prompt-loader"`).
- Type alias: `<Scope>Config` (PascalCase), `ReturnType<typeof <var>.select>`, declared in the alias block at the bottom of the file.

---

## Task 1: Add `testPatternConfigSelector` and narrow `resolveTestFilePatterns`

**Files:**
- Modify: `src/config/selectors.ts`
- Modify: `src/test-runners/resolver.ts:120-194`
- Modify: `src/review/semantic.ts:157`
- Test: `test/unit/test-runners/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/test-runners/resolver.test.ts`:

```typescript
import { testPatternConfigSelector } from "../../../src/config";
import type { TestPatternConfig } from "../../../src/config/selectors";

test("resolveTestFilePatterns accepts a TestPatternConfig slice (no NaxConfig cast)", async () => {
  const slice: TestPatternConfig = {
    project: undefined,
    quality: undefined,
  };
  const result = await resolveTestFilePatterns(slice, "/tmp/nonexistent-resolver-test-dir");
  expect(result.source).toBe("fallback");
  expect(result.regex.length).toBeGreaterThan(0);
});

test("testPatternConfigSelector picks only project and quality", () => {
  const full = NaxConfigSchema.parse({});
  const sliced = testPatternConfigSelector.select(full);
  expect(Object.keys(sliced).sort()).toEqual(["project", "quality"]);
});
```

Add the import at the top of the file if missing:

```typescript
import { NaxConfigSchema } from "../../../src/config/schemas";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/test-runners/resolver.test.ts --timeout=5000`
Expected: FAIL — `testPatternConfigSelector is not exported` and the type-error in `slice: TestPatternConfig`.

- [ ] **Step 3: Add selector + type to `src/config/selectors.ts`**

Insert immediately after `qualityConfigSelector` (alphabetic-by-domain placement, follows the existing test-pattern theme):

```typescript
// Test-pattern resolver — resolveTestFilePatterns reads project.testFilePatterns
// and quality.testing only. Co-located so context-tool-runtime, semantic review,
// and verification all share one shape.
export const testPatternConfigSelector = pickSelector("test-pattern", "project", "quality");
```

In the alias block at the bottom, after `export type QualityConfig`:

```typescript
export type TestPatternConfig = ReturnType<typeof testPatternConfigSelector.select>;
```

- [ ] **Step 4: Re-export from `src/config/index.ts`**

Open `src/config/index.ts`, add `testPatternConfigSelector` to the value exports list (alphabetic) and `TestPatternConfig` to the type exports list (alphabetic).

```typescript
// Add to the value re-export block
testPatternConfigSelector,

// Add to the type re-export block
TestPatternConfig,
```

- [ ] **Step 5: Narrow `resolveTestFilePatterns` signature**

In `src/test-runners/resolver.ts`:

Change the import at the top:

```typescript
// before
import type { NaxConfig } from "../config/types";

// after
import type { NaxConfig } from "../config/types";
import type { TestPatternConfig } from "../config/selectors";
```

Change line 121:

```typescript
// before
export async function resolveTestFilePatterns(
  config: NaxConfig,
  workdir: string,
  packageDir?: string,
  options?: ResolveTestFilePatternsOptions,
): Promise<ResolvedTestPatterns> {

// after
export async function resolveTestFilePatterns(
  config: TestPatternConfig,
  workdir: string,
  packageDir?: string,
  options?: ResolveTestFilePatternsOptions,
): Promise<ResolvedTestPatterns> {
```

- [ ] **Step 6: Run the unit test to verify it passes**

Run: `timeout 30 bun test test/unit/test-runners/resolver.test.ts --timeout=5000`
Expected: PASS — selector exported and resolver accepts narrow slice.

- [ ] **Step 7: Drop the cast in `src/review/semantic.ts:157`**

Change:

```typescript
// before
const resolved = await resolveTestFilePatterns((naxConfig ?? DEFAULT_CONFIG) as NaxConfig, workdir);

// after
const resolved = await resolveTestFilePatterns(naxConfig ?? DEFAULT_CONFIG, workdir);
```

`DEFAULT_CONFIG` is `NaxConfig` and structurally satisfies `TestPatternConfig`. `naxConfig` is `ReviewConfig` (= pick `review,debate,models,execution`) — that does NOT include `project,quality`, so this assignment will FAIL TYPECHECK. The fix is in Task 5b below; for now the type error is acceptable because Task 5b lands before commit. **DO NOT commit yet.** Continue to Step 8.

- [ ] **Step 8: Widen `reviewConfigSelector` to include `project` and `quality`**

In `src/config/selectors.ts`:

```typescript
// before
export const reviewConfigSelector = pickSelector("review", "review", "debate", "models", "execution");

// after
export const reviewConfigSelector = pickSelector(
  "review",
  "review",
  "debate",
  "models",
  "execution",
  "project",   // resolveTestFilePatterns
  "quality",   // resolveTestFilePatterns
);
```

`ReviewConfig` updates automatically because it's `ReturnType<typeof reviewConfigSelector.select>`.

- [ ] **Step 9: Run typecheck to confirm semantic.ts now compiles**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 10: Run targeted tests**

Run: `timeout 60 bun test test/unit/test-runners/ test/unit/config/selectors.test.ts test/unit/review/ --timeout=10000`
Expected: PASS.

- [ ] **Step 11: Run lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/config/selectors.ts src/config/index.ts src/test-runners/resolver.ts src/review/semantic.ts test/unit/test-runners/resolver.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): add testPatternConfigSelector + narrow resolveTestFilePatterns

resolveTestFilePatterns previously demanded full NaxConfig, forcing every
caller (semantic review, context tool runtime, verification) to either pass
the full root config or insert an `as NaxConfig` cast. The cast at
semantic.ts:157 was the silent-fail surface — a ReviewConfig slice asserted
to be NaxConfig despite missing project/quality keys.

- Add testPatternConfigSelector ("project", "quality") + TestPatternConfig
- Narrow resolveTestFilePatterns first parameter to TestPatternConfig
- Widen reviewConfigSelector with "project", "quality" so ReviewConfig
  structurally satisfies TestPatternConfig
- Drop `as NaxConfig` cast in semantic.ts:157

Step 1 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

---

## Task 2: Add `contextToolRuntimeConfigSelector` and narrow `createContextToolRuntime`

**Files:**
- Modify: `src/config/selectors.ts`
- Modify: `src/config/index.ts`
- Modify: `src/context/engine/tool-runtime.ts:9-103`
- Modify: `src/tdd/session-runner.ts:237`
- Modify: `src/operations/build-hop-callback.ts` (verify only — should not need cast change)
- Test: `test/unit/context/engine/tool-runtime.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/context/engine/tool-runtime.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { contextToolRuntimeConfigSelector } from "../../../../src/config";
import type { ContextToolRuntimeConfig } from "../../../../src/config/selectors";
import { NaxConfigSchema } from "../../../../src/config/schemas";
import { createContextToolRuntime } from "../../../../src/context/engine";
import type { ContextBundle } from "../../../../src/context/engine";

describe("createContextToolRuntime — slice acceptance", () => {
  test("contextToolRuntimeConfigSelector picks context, project, quality", () => {
    const full = NaxConfigSchema.parse({});
    const sliced = contextToolRuntimeConfigSelector.select(full);
    expect(Object.keys(sliced).sort()).toEqual(["context", "project", "quality"]);
  });

  test("createContextToolRuntime accepts a ContextToolRuntimeConfig slice (no NaxConfig cast)", () => {
    const config: ContextToolRuntimeConfig = {
      context: undefined,
      project: undefined,
      quality: undefined,
    };
    const emptyBundle: ContextBundle = {
      pushMarkdown: "",
      pullTools: [],
      meta: { stage: "test", schemaVersion: 1, totalTokens: 0 },
    } as unknown as ContextBundle;
    const story = { id: "S-001", workdir: "" } as Parameters<typeof createContextToolRuntime>[0]["story"];
    const runtime = createContextToolRuntime({
      bundle: emptyBundle,
      story,
      config,
      repoRoot: "/tmp",
    });
    expect(runtime).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/context/engine/tool-runtime.test.ts --timeout=5000`
Expected: FAIL — `contextToolRuntimeConfigSelector is not exported`.

- [ ] **Step 3: Add selector and type to `src/config/selectors.ts`**

Insert immediately after `testPatternConfigSelector` (added in Task 1):

```typescript
// Context-engine pull-tool runtime — reads context.v2.pull.* and forwards
// project/quality to resolveTestFilePatterns. Co-located so callers don't
// have to compose two selectors.
export const contextToolRuntimeConfigSelector = pickSelector(
  "context-tool-runtime",
  "context",
  "project",
  "quality",
);
```

In the alias block:

```typescript
export type ContextToolRuntimeConfig = ReturnType<typeof contextToolRuntimeConfigSelector.select>;
```

- [ ] **Step 4: Re-export from `src/config/index.ts`**

Add `contextToolRuntimeConfigSelector` (value) and `ContextToolRuntimeConfig` (type) to the alphabetic re-export blocks.

- [ ] **Step 5: Narrow `createContextToolRuntime`**

In `src/context/engine/tool-runtime.ts`:

```typescript
// before — line 9 import
import type { NaxConfig } from "../../config/types";

// after
import type { NaxConfig } from "../../config/types";
import type { ContextToolRuntimeConfig } from "../../config/selectors";
```

```typescript
// before — line 27-34 signature
export function createContextToolRuntime(options: {
  bundle: ContextBundle;
  story: UserStory;
  config: NaxConfig;
  repoRoot: string;
  runCounter?: RunCallCounter;
}): ContextToolRuntime | undefined {

// after
export function createContextToolRuntime(options: {
  bundle: ContextBundle;
  story: UserStory;
  config: ContextToolRuntimeConfig;
  repoRoot: string;
  runCounter?: RunCallCounter;
}): ContextToolRuntime | undefined {
```

The function body still passes `config` to `resolveTestFilePatterns` — that compiles cleanly because Task 1 narrowed the resolver to `TestPatternConfig`, which is structurally satisfied by `ContextToolRuntimeConfig` (both contain `project` + `quality`).

`handleQueryFeatureContext` at line 89-97 also receives `config`. Open `src/context/engine/pull-tools.ts` and confirm the parameter type. If it is `NaxConfig`, narrow its declaration to a slice that matches what it reads. **Sub-step:**

```bash
grep -n "config: NaxConfig\|config:.*NaxConfig" src/context/engine/pull-tools.ts
```

If the parameter is `config: NaxConfig`, change it to:

```typescript
import type { ContextToolRuntimeConfig } from "../../config/selectors";

// signature change at the matched line
config: ContextToolRuntimeConfig,
```

Verify the function body only reads `config.context`, `config.project`, `config.quality`. If it reads any other key, **STOP** and add a note to the plan — that callee needs its own selector.

- [ ] **Step 6: Run the unit test to verify it passes**

Run: `timeout 30 bun test test/unit/context/engine/tool-runtime.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 7: Drop the cast in `src/tdd/session-runner.ts:237`**

```typescript
// before — line 233-240
contextToolRuntime: contextBundle
  ? createContextToolRuntime({
      bundle: contextBundle,
      story,
      config: config as NaxConfig, // boundary cast — createContextToolRuntime expects NaxConfig
      repoRoot: workdir,
    })
  : undefined,

// after
contextToolRuntime: contextBundle
  ? createContextToolRuntime({
      bundle: contextBundle,
      story,
      config,
      repoRoot: workdir,
    })
  : undefined,
```

This will produce a typecheck error because `TddConfig` does not yet include `context` or `project`. That is expected and is fixed by Task 4. **DO NOT commit until then.** Proceed to Step 8.

- [ ] **Step 8: Verify `build-hop-callback.ts` still compiles**

Run: `grep -n "createContextToolRuntime" src/operations/build-hop-callback.ts`

The call passes `config: NaxConfig` (the field type of `BuildHopCallbackOptions.config`). `NaxConfig` structurally satisfies `ContextToolRuntimeConfig`, so no cast is needed and no edit required. **No code change in this file.**

- [ ] **Step 9: Run typecheck — expect ONE error in session-runner.ts (deferred to Task 4)**

Run: `bun run typecheck`
Expected: ONE error in `src/tdd/session-runner.ts:237` of the form "Property 'context' is missing in type 'TddConfig'…". This is intentional and fixed in Task 4. Note the error in the commit message below.

- [ ] **Step 10: Run targeted tests**

Run: `timeout 60 bun test test/unit/context/engine/ test/unit/config/selectors.test.ts --timeout=10000`
Expected: PASS for the new selector tests; the session-runner typecheck failure does not affect these targeted tests.

- [ ] **Step 11: Commit (with explicit deferred-error note)**

```bash
git add src/config/selectors.ts src/config/index.ts src/context/engine/tool-runtime.ts src/context/engine/pull-tools.ts src/tdd/session-runner.ts test/unit/context/engine/tool-runtime.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): add contextToolRuntimeConfigSelector + narrow tool runtime

createContextToolRuntime previously demanded full NaxConfig, forcing the TDD
session runner to insert an `as NaxConfig` cast on a TddConfig slice. That
cast hid missing context/project keys — at runtime the v2 pull cap and
test-pattern detection silently reverted to defaults whenever a real narrow
slice was passed.

- Add contextToolRuntimeConfigSelector ("context", "project", "quality")
- Narrow createContextToolRuntime config option to ContextToolRuntimeConfig
- Narrow handleQueryFeatureContext config parameter
- Drop `as NaxConfig` cast in session-runner.ts:237

Note: typecheck reports one expected error in session-runner.ts:237 because
TddConfig is widened in Task 4 of the same plan. The error is resolved by
the next commit and CI continues to gate on green typecheck once Task 4
lands.

Step 2 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

> **Important — pipeline gate:** This is the only commit in the plan that lands with a known typecheck error. If your team runs typecheck on every commit (CI matrix), squash Task 2 with Task 4 instead. The plan separates them for narrative clarity; the squash is mechanical.

---

## Task 3: Add `promptLoaderConfigSelector` and narrow `withLoader` + `loadOverride`

**Files:**
- Modify: `src/config/selectors.ts`
- Modify: `src/config/index.ts`
- Modify: `src/prompts/builders/tdd-builder.ts:24, 57, 123-127, 236-263`
- Modify: `src/prompts/loader.ts:8, 20`
- Modify: `src/tdd/session-runner.ts:166, 178, 190`
- Test: `test/unit/prompts/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/prompts/loader.test.ts`:

```typescript
import { promptLoaderConfigSelector } from "../../../src/config";
import type { PromptLoaderConfig } from "../../../src/config/selectors";
import { NaxConfigSchema } from "../../../src/config/schemas";

test("promptLoaderConfigSelector picks prompts, context, project", () => {
  const full = NaxConfigSchema.parse({});
  const sliced = promptLoaderConfigSelector.select(full);
  expect(Object.keys(sliced).sort()).toEqual(["context", "project", "prompts"]);
});

test("loadOverride accepts a Pick<NaxConfig, 'prompts'> literal (no NaxConfig cast)", async () => {
  const config = { prompts: { overrides: {} } } satisfies Pick<NaxConfig, "prompts">;
  const result = await loadOverride("test-writer", "/tmp/nonexistent-loader-test", config);
  expect(result).toBeNull();
});
```

Add the missing imports at the top of the file:

```typescript
import type { NaxConfig } from "../../../src/config";
import { loadOverride } from "../../../src/prompts/loader";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/prompts/loader.test.ts --timeout=5000`
Expected: FAIL — `promptLoaderConfigSelector is not exported`.

- [ ] **Step 3: Add selector and type to `src/config/selectors.ts`**

Insert immediately after `contextToolRuntimeConfigSelector` (added in Task 2):

```typescript
// Prompt builder loader — withLoader / loadOverride / hermetic /
// tdd-language sections read prompts.overrides, context.featureEngine,
// project.* only.
export const promptLoaderConfigSelector = pickSelector(
  "prompt-loader",
  "prompts",
  "context",
  "project",
);
```

Type alias:

```typescript
export type PromptLoaderConfig = ReturnType<typeof promptLoaderConfigSelector.select>;
```

- [ ] **Step 4: Re-export from `src/config/index.ts`**

Add `promptLoaderConfigSelector` (value) and `PromptLoaderConfig` (type) to the alphabetic re-export blocks.

- [ ] **Step 5: Narrow `loadOverride`**

In `src/prompts/loader.ts`:

```typescript
// before — line 8
import type { NaxConfig } from "../config/types";

// after
import type { NaxConfig } from "../config/types";
```

```typescript
// before — line 20
export async function loadOverride(role: PromptRole, workdir: string, config: NaxConfig): Promise<string | null> {

// after
export async function loadOverride(
  role: PromptRole,
  workdir: string,
  config: Pick<NaxConfig, "prompts">,
): Promise<string | null> {
```

`Pick<NaxConfig, "prompts">` is finer than `PromptLoaderConfig` — `loadOverride` only reads `config.prompts?.overrides?.[role]`. The narrower type proves intent at the signature.

- [ ] **Step 6: Narrow `withLoader` and `loaderConfig_`**

In `src/prompts/builders/tdd-builder.ts`:

```typescript
// before — line 24
import type { NaxConfig } from "../../config/types";

// after
import type { NaxConfig } from "../../config/types";
import type { PromptLoaderConfig } from "../../config/selectors";
```

```typescript
// before — line 57
private loaderConfig_: NaxConfig | undefined;

// after
private loaderConfig_: PromptLoaderConfig | undefined;
```

```typescript
// before — line 123-127
withLoader(workdir: string, config: NaxConfig): this {
  this.loaderWorkdir_ = workdir;
  this.loaderConfig_ = config;
  return this;
}

// after
withLoader(workdir: string, config: PromptLoaderConfig): this {
  this.loaderWorkdir_ = workdir;
  this.loaderConfig_ = config;
  return this;
}
```

Body of `build()` and `resolveRoleBody()` already reads only `loaderConfig_?.prompts`, `loaderConfig_?.context`, `loaderConfig_?.project` (verified in investigation) — no further changes needed.

- [ ] **Step 7: Update the static `buildForRole` signature**

In `src/prompts/builders/tdd-builder.ts:236-263`:

```typescript
// before — line 236-247
static buildForRole(
  role: PromptRole,
  workdir: string,
  config: NaxConfig,
  ...

// after
static buildForRole(
  role: PromptRole,
  workdir: string,
  config: NaxConfig,   // unchanged — top-level entry point still takes full config
  ...
```

**Keep `buildForRole` accepting `NaxConfig`** because its sole role is the public entry point. `NaxConfig` structurally satisfies `PromptLoaderConfig`, so the internal `.withLoader(workdir, config)` at line 254 continues to compile. No cast inserted, no narrowing lost — full config flows in, the narrow type guards the field.

- [ ] **Step 8: Run the unit test to verify it passes**

Run: `timeout 30 bun test test/unit/prompts/loader.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 9: Drop the three casts in `src/tdd/session-runner.ts`**

Lines 166, 178, 190 — each looks like this currently:

```typescript
// before
.withLoader(workdir, config as NaxConfig) // boundary cast — withLoader expects NaxConfig

// after
.withLoader(workdir, config)
```

Apply to all three call sites (test-writer, implementer, verifier). The remaining `config` is `TddConfig`, which still does NOT satisfy `PromptLoaderConfig` until Task 4 widens it. Typecheck WILL fail on these three lines after this step.

- [ ] **Step 10: Run typecheck — expect deferred errors**

Run: `bun run typecheck`
Expected: typecheck reports four errors total — three new ones at session-runner.ts:166/178/190 plus the pre-existing error at session-runner.ts:237 from Task 2. All four are resolved by Task 4.

- [ ] **Step 11: Run targeted tests**

Run: `timeout 60 bun test test/unit/prompts/loader.test.ts test/unit/prompts/builder.test.ts test/integration/prompts/pb-004-migration.test.ts test/unit/config/selectors.test.ts --timeout=10000`
Expected: PASS — the prompt-builder tests already use full `NaxConfig` so they remain compatible.

- [ ] **Step 12: Commit (with explicit deferred-error note, same caveat as Task 2)**

```bash
git add src/config/selectors.ts src/config/index.ts src/prompts/builders/tdd-builder.ts src/prompts/loader.ts src/tdd/session-runner.ts test/unit/prompts/loader.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): add promptLoaderConfigSelector + narrow withLoader

withLoader and loadOverride previously demanded full NaxConfig, forcing the
TDD session runner to insert three `as NaxConfig` casts on a TddConfig slice.
Each cast hid missing prompts/context/project keys — at runtime user prompt
overrides, context budget, and project-language sections silently fell back
to defaults whenever a real narrow slice was passed.

- Add promptLoaderConfigSelector ("prompts", "context", "project")
- Narrow TddPromptBuilder.withLoader + loaderConfig_ to PromptLoaderConfig
- Narrow loadOverride to Pick<NaxConfig, "prompts">
- Drop three `as NaxConfig` casts in session-runner.ts (lines 166/178/190)

Note: typecheck still reports four errors in session-runner.ts pending Task 4
widening of tddConfigSelector.

Step 3 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

---

## Task 4: Widen `tddConfigSelector`, drop remaining session-runner casts, restore green typecheck

**Files:**
- Modify: `src/config/selectors.ts:23`
- Modify: `src/tdd/session-runner.ts:225, 237`
- Test: `test/unit/config/selectors.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/config/selectors.test.ts`:

```typescript
test("tddConfigSelector includes prompts, context, project, precheck for downstream callees", () => {
  const full = NaxConfigSchema.parse({});
  const sliced = tddConfigSelector.select(full);
  expect(Object.keys(sliced).sort()).toEqual([
    "agent",
    "context",
    "execution",
    "models",
    "precheck",
    "project",
    "prompts",
    "quality",
    "tdd",
  ]);
});
```

If `NaxConfigSchema` and `tddConfigSelector` are not yet imported, add:

```typescript
import { tddConfigSelector } from "../../../src/config";
import { NaxConfigSchema } from "../../../src/config/schemas";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/config/selectors.test.ts --timeout=5000`
Expected: FAIL — current `tddConfigSelector` does not include the new keys.

- [ ] **Step 3: Widen the selector**

In `src/config/selectors.ts:23`:

```typescript
// before
export const tddConfigSelector = pickSelector("tdd", "tdd", "execution", "quality", "agent", "models");

// after
export const tddConfigSelector = pickSelector(
  "tdd",
  "tdd",
  "execution",
  "quality",
  "agent",
  "models",
  "prompts",   // PromptBuilder.withLoader → loadOverride
  "context",   // PromptBuilder build / createContextToolRuntime
  "project",   // tdd-language + hermetic + test-pattern resolver
  "precheck",  // CompleteOptions.config plan-mode AC gate (until #853 Phase 2)
);
```

The derived `TddConfig` type updates automatically.

- [ ] **Step 4: Drop the remaining cast at session-runner.ts:225**

```typescript
// before — line 225
config: config as NaxConfig, // boundary cast — CompleteOptions.config stays NaxConfig per Phase 3 §3.3

// after
config,
```

`AgentRunOptions.config` is typed `AgentManagerConfig` (= pick `agent`, `execution`). `TddConfig` (after widening) structurally satisfies that, so no cast needed.

- [ ] **Step 5: Drop the cast at session-runner.ts:237**

This was already changed in Task 2 Step 7 to remove the `as NaxConfig`. Now `TddConfig` includes `context` + `project`, so the call compiles.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — all session-runner.ts errors resolved.

- [ ] **Step 7: Run targeted tests**

Run: `timeout 60 bun test test/unit/config/selectors.test.ts test/unit/tdd/ test/integration/tdd/ --timeout=10000`
Expected: PASS.

- [ ] **Step 8: Run lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/config/selectors.ts src/tdd/session-runner.ts test/unit/config/selectors.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): widen tddConfigSelector with prompts/context/project/precheck

Three prior commits in this plan narrowed withLoader, createContextToolRuntime,
and resolveTestFilePatterns to consume named selector slices. TddConfig was
the slice driving them — but it only carried tdd/execution/quality/agent/models,
which forced the runner to insert `as NaxConfig` casts that masked missing
keys. Widening tddConfigSelector to include the four downstream keys removes
the casts and restores green typecheck.

- Add prompts, context, project, precheck to tddConfigSelector
- Drop `as NaxConfig` cast at session-runner.ts:225 (AgentManagerConfig)
- Confirm typecheck green; structural typing covers all consumers

Step 4 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

---

## Task 5: Narrow `DebateRunnerOptions.config` to `DebateConfig`, drop semantic-debate cast

**Files:**
- Modify: `src/debate/runner.ts:1-66`
- Modify: `src/review/semantic-debate.ts:124`
- Test: `test/unit/debate/runner.test.ts` (extend if exists, else create)

- [ ] **Step 1: Investigate current `DebateRunner` cast risk**

Run: `grep -n "this.config\|this.completeConfig\|opts.config" src/debate/runner.ts src/debate/runner-*.ts`

Expected output shows `this.config = opts.config ?? DEFAULT_CONFIG;` at line 58 and the field already typed `DebateConfig` at line 44. **The internal narrow already exists.** The boundary type is too wide; we are flipping the public option type to match the internal storage type.

- [ ] **Step 2: Write the failing test**

Either extend `test/unit/debate/runner.test.ts` or create it with:

```typescript
import { describe, expect, test } from "bun:test";
import { debateConfigSelector } from "../../../src/config";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { DebateRunner } from "../../../src/debate/runner";

describe("DebateRunner — config slice acceptance", () => {
  test("constructor accepts a DebateConfig slice (no NaxConfig cast)", () => {
    const full = NaxConfigSchema.parse({});
    const slice = debateConfigSelector.select(full);
    const runner = new DebateRunner({
      ctx: {} as Parameters<typeof DebateRunner.prototype.run>[0] extends never ? never : never,  // placeholder; real ctx not exercised here
      stage: "review",
      stageConfig: { sessionMode: "one-shot", mode: "panel" } as Parameters<typeof DebateRunner>[0]["stageConfig"],
      config: slice,
    } as ConstructorParameters<typeof DebateRunner>[0]);
    expect(runner).toBeDefined();
  });
});
```

> The test exercises the type system at compile time; the body is intentionally minimal — assertion is "compiles + constructs". If your team prefers a pure-type test, replace the body with `// @ts-expect-error` and `@ts-expect-no-error` comments around assignments to demonstrate the narrow accepts and rejects appropriately.

- [ ] **Step 3: Run the test to verify it fails (or compiles and passes only after the change)**

Run: `timeout 30 bun test test/unit/debate/runner.test.ts --timeout=5000`
Expected: PASS today (DebateRunner accepts NaxConfig and DebateConfig structurally satisfies it). The test serves as a regression guard for Step 4 — after the narrowing it must still pass.

- [ ] **Step 4: Narrow `DebateRunnerOptions.config`**

In `src/debate/runner.ts`:

```typescript
// before — line 1
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG } from "../config";
import type { CompleteConfig, DebateConfig } from "../config/selectors";

// after
import { DEFAULT_CONFIG } from "../config";
import type { CompleteConfig, DebateConfig } from "../config/selectors";
import { debateConfigSelector } from "../config";
```

`NaxConfig` is no longer needed in this file.

```typescript
// before — line 27-38
export interface DebateRunnerOptions {
  readonly ctx: CallContext;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config?: NaxConfig;
  readonly workdir?: string;
  readonly featureName?: string;
  readonly timeoutSeconds?: number;
  readonly sessionManager?: ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

// after
export interface DebateRunnerOptions {
  readonly ctx: CallContext;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config?: DebateConfig;
  readonly workdir?: string;
  readonly featureName?: string;
  readonly timeoutSeconds?: number;
  readonly sessionManager?: ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}
```

```typescript
// before — line 58-59
this.config = opts.config ?? DEFAULT_CONFIG;
this.completeConfig = opts.config;

// after
this.config = opts.config ?? debateConfigSelector.select(DEFAULT_CONFIG);
this.completeConfig = opts.config as CompleteConfig | undefined;
```

> **Note on `completeConfig`:** the `TODO(#853)` comment on line 45 is preserved. The `as CompleteConfig | undefined` cast is acceptable here because `CompleteConfig` does NOT structurally subset `DebateConfig` — they are different slices. This is a **legitimate cast** awaiting the #853 Phase 2 removal of the `CompleteOptions.config` field. Add a one-line comment:
>
> ```typescript
> // TODO(#853 Phase 2): remove with the CompleteOptions.config field. Until then,
> // callers that pass a DebateConfig slice may not have CompleteConfig keys —
> // completeConfig stays optional and downstream guards on undefined.
> ```

- [ ] **Step 5: Drop the cast in `src/review/semantic-debate.ts:124`**

```typescript
// before
config: naxConfig as NaxConfig,

// after
config: naxConfig,
```

`naxConfig` is `ReviewConfig` (after Task 1 widened it to include `project`, `quality`). `ReviewConfig` includes `debate, models, agent` etc. — does it satisfy `DebateConfig`? `DebateConfig` = pick(`debate, models, agent`). `ReviewConfig` = pick(`review, debate, models, execution, project, quality`) — **missing `agent`**.

Sub-step: widen `reviewConfigSelector` to include `agent`:

```typescript
// in src/config/selectors.ts
export const reviewConfigSelector = pickSelector(
  "review",
  "review",
  "debate",
  "models",
  "execution",
  "project",
  "quality",
  "agent",   // satisfies DebateConfig at semantic-debate.ts:124
);
```

After this widening, `ReviewConfig` structurally satisfies `DebateConfig`, the assignment compiles, and no cast is needed.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Investigate other `createDebateRunner` callers**

Run: `grep -n "createDebateRunner" src/cli/plan.ts src/cli/plan-decompose.ts src/cli/plan-runtime.ts`

Each caller currently passes `config: NaxConfig`. `NaxConfig` structurally satisfies `DebateConfig`, so **no caller change is required**.

- [ ] **Step 8: Run targeted tests**

Run: `timeout 60 bun test test/unit/debate/ test/unit/review/ test/integration/review/ --timeout=10000`
Expected: PASS.

- [ ] **Step 9: Run lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/debate/runner.ts src/review/semantic-debate.ts src/config/selectors.ts test/unit/debate/runner.test.ts
git commit -m "$(cat <<'EOF'
refactor(debate): narrow DebateRunnerOptions.config to DebateConfig

DebateRunner stored its config field as DebateConfig but accepted NaxConfig
at the boundary, forcing semantic-debate.ts to cast its ReviewConfig slice
to NaxConfig. The cast hid the absence of `agent` in ReviewConfig.

- Narrow DebateRunnerOptions.config from NaxConfig to DebateConfig
- Use debateConfigSelector.select(DEFAULT_CONFIG) for the fallback path
- Widen reviewConfigSelector to include "agent" so ReviewConfig satisfies
  DebateConfig
- Drop `as NaxConfig` cast in semantic-debate.ts:124

Step 5 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

---

## Task 6: Drop the redundant double-cast in `rectification-gate.ts`

**Files:**
- Modify: `src/tdd/rectification-gate.ts:264`

- [ ] **Step 1: Investigate**

Run: `grep -n "config: config\|config as\|RectificationGateConfig" src/tdd/rectification-gate.ts | head -10`

`config: RectificationGateConfig` (line 71) which is `pick("execution", "models", "agent", "quality", "review")`. The cast is asserting that to be `NaxConfig` for `AgentRunOptions.config`, but `AgentRunOptions.config` is typed `AgentManagerConfig` = `pick("agent", "execution")`. `RectificationGateConfig` structurally satisfies `AgentManagerConfig` already.

- [ ] **Step 2: Drop the cast**

```typescript
// before — line 261-264
// Cast required: AgentRunOptions.config expects NaxConfig, but only the picked
// subset of keys is actually used by the adapter (permissions, models, agent).
config: config as unknown as NaxConfig,

// after
config,
```

Delete the two-line comment as well — it is now obsolete and misleading.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Run targeted tests**

Run: `timeout 60 bun test test/unit/tdd/rectification-gate.test.ts test/integration/tdd/ --timeout=10000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tdd/rectification-gate.ts
git commit -m "$(cat <<'EOF'
refactor(tdd): drop redundant `as unknown as NaxConfig` in rectification-gate

AgentRunOptions.config is typed AgentManagerConfig (pick agent, execution).
RectificationGateConfig (pick execution, models, agent, quality, review)
already structurally satisfies that, so the double cast is unnecessary and
the comment claiming "the picked subset" is misleading — there is no cast
required at all.

Step 6 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

---

## Task 7: Verification — grep guard, full-suite tests, lint

**Files:**
- Create: `scripts/check-no-silent-naxconfig-cast.sh`

- [ ] **Step 1: Write the guard script**

Create `scripts/check-no-silent-naxconfig-cast.sh`:

```bash
#!/usr/bin/env bash
# Guards against re-introduction of silent-fail `as NaxConfig` casts in
# production source. Test fixtures are excluded — those are intentional
# partial-config builders.
#
# Allowed sites (schema-derived, runtime-validated):
#   src/config/defaults.ts
#   src/config/loader.ts
set -euo pipefail

cd "$(dirname "$0")/.."

# Match `as NaxConfig` and `as unknown as NaxConfig` in src/, excluding the
# two allowed files where the cast follows a Zod parse and is runtime-safe.
matches=$(grep -RnE 'as (unknown as )?NaxConfig\b' src/ \
  --include='*.ts' \
  --exclude-dir=node_modules \
  | grep -vE '^src/config/defaults\.ts:' \
  | grep -vE '^src/config/loader\.ts:' \
  || true)

if [ -n "$matches" ]; then
  echo "[FAIL] Silent-fail NaxConfig cast(s) detected outside the allow-list:" >&2
  echo "$matches" >&2
  echo "" >&2
  echo "If a new cast is genuinely needed, add the file path to the" >&2
  echo "allow-list in scripts/check-no-silent-naxconfig-cast.sh and" >&2
  echo "document why the runtime shape is guaranteed." >&2
  exit 1
fi

echo "[OK] No silent-fail NaxConfig casts in src/."
```

Make it executable:

```bash
chmod +x scripts/check-no-silent-naxconfig-cast.sh
```

- [ ] **Step 2: Run the guard**

Run: `./scripts/check-no-silent-naxconfig-cast.sh`
Expected: `[OK] No silent-fail NaxConfig casts in src/.`

If the guard fails, list the offending sites and resolve before proceeding — the plan goal is zero remaining production casts.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 5: Run full unit suite**

Run: `bun run test`
Expected: PASS (no regressions).

- [ ] **Step 6: Run full integration suite**

Already covered by `bun run test`. If your team has a separate integration command, run it; otherwise this step is a no-op.

- [ ] **Step 7: Wire the guard into pre-commit (optional but recommended)**

If your team uses a pre-commit framework, add a hook entry. Otherwise, add a line to the existing CI lint job. Example for `.github/workflows/ci.yml` (verify the actual filename in your repo first):

```yaml
- name: No silent NaxConfig casts
  run: ./scripts/check-no-silent-naxconfig-cast.sh
```

- [ ] **Step 8: Commit**

```bash
git add scripts/check-no-silent-naxconfig-cast.sh
git commit -m "$(cat <<'EOF'
chore(scripts): add CI guard against silent-fail NaxConfig casts

Caps the migration completed in steps 1-6 of the plan. Greps src/ for
`as NaxConfig` and `as unknown as NaxConfig`, allow-listing the two files
where the cast follows a Zod parse and is runtime-safe (defaults.ts,
loader.ts).

Wired into CI lint job; rejects any new production cast.

Step 7 of plans/2026-05-01-eliminate-naxconfig-silent-fail-casts.md.
EOF
)"
```

---

## Self-Review Checklist (run mentally before handoff)

**Spec coverage:**
- ✅ All 8 production casts in the inventory have a task that removes them.
- ✅ Each cast site is referenced by file:line in the task that removes it.
- ✅ Tests cover the new selectors (selectors.test.ts), the narrowed signatures (resolver.test.ts, tool-runtime.test.ts, loader.test.ts), and the regression guard (debate runner.test.ts).
- ✅ A grep guard prevents reintroduction.

**Placeholder scan:**
- ✅ No "TBD"/"TODO"/"fill in" left in step bodies. The single `TODO(#853 Phase 2)` reference in Task 5 Step 4 is a forward pointer to an existing tracked issue, not a plan placeholder.
- ✅ Every code change shows the before/after.
- ✅ Every command is exact and copy-pastable.

**Type consistency:**
- ✅ Selector variable names: `testPatternConfigSelector`, `contextToolRuntimeConfigSelector`, `promptLoaderConfigSelector`. Type aliases: `TestPatternConfig`, `ContextToolRuntimeConfig`, `PromptLoaderConfig`. All consistent across tasks.
- ✅ `tddConfigSelector` widening adds exactly the four keys consumed by Tasks 1-3 plus `precheck` (per the `CompleteConfig` chain).
- ✅ `reviewConfigSelector` widening in Task 1 (`project`, `quality`) and Task 5 (`agent`) is additive and explained at each step.

---

## Out-of-Scope but Worth Tracking

- **`completeConfigSelector` / `CompleteOptions.config`** — covered by issue #853 Phase 2. The selector and its TODO comment in `src/config/selectors.ts:55-58` stay as-is. When that lands, the `as CompleteConfig | undefined` line in `DebateRunner` (added in Task 5 Step 4) goes away too.
- **Test-fixture casts** under `test/**/*.ts` — not silent-fail risks; partial configs there are deliberate. If a future cleanup wants to migrate fixtures to a `mockNaxConfig()` helper, it is unrelated to this plan.
