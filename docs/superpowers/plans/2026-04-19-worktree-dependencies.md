# Worktree Dependency Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `execution.worktreeDependencies` and a single shared dependency-preparation hook that runs before story execution in both sequential and parallel worktree flows, with no dependency-directory symlink fallback.

**Architecture:** Split worktree lifecycle from worktree dependency preparation. `WorktreeManager` stays responsible for creating/removing/listing worktrees and repo-runtime excludes, while a new `src/worktree/dependencies.ts` module resolves `inherit | provision | off`, prepares the worktree, and returns a `WorktreeDependencyContext` consumed by later execution. Sequential `runIteration()` and parallel `runParallelBatch()` both invoke the same preparation API and treat dependency-prep failures as terminal pre-execution failures instead of normal pipeline escalation.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, Zod config schema, bun:test

---

## File Map

| Action | File | What changes |
|:---|:---|:---|
| Modify | `src/config/runtime-types.ts` | Add `worktreeDependencies` config types under `ExecutionConfig` |
| Modify | `src/config/schemas.ts` | Add Zod schema/defaults and `setupCommand` validation |
| Modify | `src/config/merge.ts` | Preserve root/project merge semantics for new execution config block |
| Modify | `src/tdd/types.ts` | Add a dedicated dependency-prep failure category if phase 1 records it in shared story state |
| Modify | `src/pipeline/types.ts` | Add dependency-prep context field(s) used by downstream execution |
| Modify | `src/worktree/manager.ts` | Remove `node_modules` symlink logic; keep lifecycle + `.env` handling only if still intended |
| Modify | `src/worktree/types.ts` | Define shared dependency-prep types |
| Create | `src/worktree/dependencies.ts` | Implement `prepareWorktreeDependencies()` and mode-specific behavior |
| Modify | `src/worktree/index.ts` | Export dependency-prep API/types |
| Create | `src/utils/command-argv.ts` | Shared `parseCommandToArgv()` utility extracted from hooks so provisioning can reuse safe argv parsing |
| Modify | `src/hooks/runner.ts` | Reuse extracted argv parser instead of owning a second parser |
| Modify | `src/execution/iteration-runner.ts` | Invoke dependency-prep hook before pipeline execution; short-circuit on prep failure |
| Modify | `src/execution/parallel-batch.ts` | Invoke same hook for each fresh worktree and carry returned context into workers |
| Modify | `src/execution/parallel-worker.ts` | Consume dependency-prep context (`cwd`/`env`) instead of recomputing workdir alone |
| Modify | `src/pipeline/stages/execution.ts` | Pass dependency-prep env through `AgentRunOptions.env` |
| Modify | `src/pipeline/stages/verify.ts` | Pass dependency-prep env into verification command execution |
| Modify | `src/pipeline/stages/review.ts` | Ensure review-stage command runners receive dependency-prep env if they spawn checks |
| Modify | `src/verification/executor.ts` | Merge normalized env stripping with dependency-prep env rather than discarding it |
| Create | `test/unit/config/worktree-dependencies-schema.test.ts` | Schema/default/validation coverage |
| Modify | `test/unit/config/story-isolation-schema.test.ts` | Keep existing execution schema coverage aligned with the new config block |
| Modify | `test/unit/execution/worktree-manager.test.ts` | Remove symlink expectations; add regression assertions for no dependency symlinking |
| Modify | `test/integration/worktree/manager.test.ts` | Replace `node_modules` symlink assertions with no-symlink regression tests |
| Create | `test/unit/worktree/dependencies.test.ts` | Unit tests for mode resolution, allowlist behavior, setup command execution, and returned context |
| Modify | `test/unit/execution/parallel-batch.test.ts` | Assert active parallel path calls the shared prep hook before worker execution |
| Modify | `test/unit/execution/iteration-runner.test.ts` | Assert sequential worktree path calls the shared prep hook before pipeline execution |

## Architecture Notes To Honor During Implementation

- The issue body is stale about the active code path. The real integration points are [src/execution/iteration-runner.ts](/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/src/execution/iteration-runner.ts) and [src/execution/parallel-batch.ts](/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/src/execution/parallel-batch.ts), not `parallel-coordinator.ts`.
- The current repo still hardcodes `node_modules` symlinking in [src/worktree/manager.ts](/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/src/worktree/manager.ts), so the migration is intentionally behavior-changing.
- `setupCommand` must not use ad hoc `command.split(/\s+/)` parsing. The clean path is to extract the safe argv parser already present in [src/hooks/runner.ts](/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/src/hooks/runner.ts) into a shared utility and reuse it.
- The spec requires `inherit` to remain the default. That means phase 1 must ship at least one concrete allowlisted `inherit` strategy. If code exploration proves there is no safe first strategy, stop and change the spec before implementation instead of silently weakening the contract.

### Task 1: Add config schema, runtime types, and failure typing

**Files:**
- Modify: `src/config/runtime-types.ts`
- Modify: `src/config/schemas.ts`
- Modify: `src/config/merge.ts`
- Modify: `src/tdd/types.ts`
- Create: `test/unit/config/worktree-dependencies-schema.test.ts`
- Modify: `test/unit/config/story-isolation-schema.test.ts`

- [ ] **Step 1: Write failing config tests first**

```typescript
// test/unit/config/worktree-dependencies-schema.test.ts
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema, DEFAULT_CONFIG } from "../../../src/config/schema";

function withWorktreeDependencies(value: unknown): Record<string, unknown> {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      worktreeDependencies: value,
    },
  };
}

describe("execution.worktreeDependencies schema", () => {
  test("DEFAULT_CONFIG defaults mode to inherit", () => {
    expect(DEFAULT_CONFIG.execution.worktreeDependencies.mode).toBe("inherit");
    expect(DEFAULT_CONFIG.execution.worktreeDependencies.setupCommand).toBeNull();
  });

  test.each(["inherit", "provision", "off"] as const)("accepts mode=%s", (mode) => {
    const result = NaxConfigSchema.safeParse(
      withWorktreeDependencies({ mode, setupCommand: mode === "provision" ? "bun install" : null }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects setupCommand outside provision mode", () => {
    const result = NaxConfigSchema.safeParse(
      withWorktreeDependencies({ mode: "inherit", setupCommand: "bun install" }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects invalid mode", () => {
    const result = NaxConfigSchema.safeParse(
      withWorktreeDependencies({ mode: "symlink", setupCommand: null }),
    );
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Add runtime types and schema**

In `src/config/runtime-types.ts`, add:

```typescript
export interface WorktreeDependenciesConfig {
  mode: "inherit" | "provision" | "off";
  setupCommand?: string | null;
}
```

and thread it into `ExecutionConfig`:

```typescript
/** Strategy for preparing fresh git worktrees before story execution. */
worktreeDependencies: WorktreeDependenciesConfig;
```

In `src/config/schemas.ts`, add a dedicated schema:

```typescript
const WorktreeDependenciesConfigSchema = z
  .object({
    mode: z.enum(["inherit", "provision", "off"]).default("inherit"),
    setupCommand: z.string().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "provision" && value.setupCommand) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["setupCommand"],
        message: "execution.worktreeDependencies.setupCommand requires mode 'provision'",
      });
    }
  });
```

and wire it into `ExecutionConfigSchema.default(...)`:

```typescript
worktreeDependencies: {
  mode: "inherit",
  setupCommand: null,
},
```

If phase 1 stores dependency-prep failures in story state, extend `FailureCategory` in `src/tdd/types.ts` with:

```typescript
| "dependency-prep"
```

This is the least invasive shared failure-type seam because [src/prd/index.ts](/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/src/prd/index.ts) already persists `failureCategory` through `markStoryFailed()`.

- [ ] **Step 3: Keep merge/default behavior coherent**

In `src/config/merge.ts`, ensure package overrides do not accidentally wipe the nested config:

```typescript
execution: {
  ...root.execution,
  ...packageOverride.execution,
  worktreeDependencies:
    packageOverride.execution?.worktreeDependencies !== undefined
      ? {
          ...root.execution.worktreeDependencies,
          ...packageOverride.execution.worktreeDependencies,
        }
      : root.execution.worktreeDependencies,
  smartTestRunner: packageOverride.execution?.smartTestRunner ?? root.execution.smartTestRunner,
  regressionGate: {
    ...root.execution.regressionGate,
    ...packageOverride.execution?.regressionGate,
  },
  verificationTimeoutSeconds:
    packageOverride.execution?.verificationTimeoutSeconds ?? root.execution.verificationTimeoutSeconds,
},
```

- [ ] **Step 4: Run focused config tests**

Run:

```bash
bun test test/unit/config/worktree-dependencies-schema.test.ts test/unit/config/story-isolation-schema.test.ts --timeout=30000
```

Expected: PASS, including default-mode and invalid-`setupCommand` coverage.

- [ ] **Step 5: Commit**

```bash
git add src/config/runtime-types.ts src/config/schemas.ts src/config/merge.ts src/tdd/types.ts test/unit/config/worktree-dependencies-schema.test.ts test/unit/config/story-isolation-schema.test.ts
git commit -m "feat(config): add worktree dependency strategy schema"
```

---

### Task 2: Remove dependency symlinking from `WorktreeManager`

**Files:**
- Modify: `src/worktree/manager.ts`
- Modify: `test/unit/execution/worktree-manager.test.ts`
- Modify: `test/integration/worktree/manager.test.ts`

- [ ] **Step 1: Replace symlink expectations with regression tests**

Update integration coverage so the manager no longer promises `node_modules` reuse:

```typescript
test("does not create node_modules symlink in worktree", async () => {
  const manager = new WorktreeManager();
  const storyId = "story-456";

  const nodeModulesPath = join(projectRoot, "node_modules");
  mkdirSync(nodeModulesPath, { recursive: true });
  writeFileSync(join(nodeModulesPath, "test.txt"), "test content");

  await manager.create(projectRoot, storyId);

  const worktreePath = join(projectRoot, ".nax-wt", storyId);
  const targetPath = join(worktreePath, "node_modules");

  expect(existsSync(targetPath)).toBe(false);
});
```

Keep `.env` behavior only if the code owner confirms it remains intentional repo-runtime setup rather than dependency preparation. If that decision is not explicit, remove `.env` symlinking in the same change instead of leaving a second hidden worktree mutation behind.

- [ ] **Step 2: Remove dependency-specific logic from `WorktreeManager.create()`**

Delete the block:

```typescript
const nodeModulesSource = join(projectRoot, "node_modules");
if (existsSync(nodeModulesSource)) {
  const nodeModulesTarget = join(worktreePath, "node_modules");
  symlinkSync(nodeModulesSource, nodeModulesTarget, "dir");
}
```

and clean up now-unused imports:

```typescript
import { existsSync } from "node:fs";
```

should become:

```typescript
import { existsSync } from "node:fs";
// only keep if .env handling remains
```

If `.env` stays, update the method comment so it no longer claims dependency symlinks:

```typescript
/**
 * Creates a git worktree at .nax-wt/<storyId>/ with branch nax/<storyId>.
 * Repo-runtime files may be mirrored separately, but dependency preparation
 * is handled outside WorktreeManager.
 */
```

- [ ] **Step 3: Run manager tests**

Run:

```bash
bun test test/unit/execution/worktree-manager.test.ts test/integration/worktree/manager.test.ts --timeout=30000
```

Expected: PASS with no test asserting `node_modules` symlink creation.

- [ ] **Step 4: Commit**

```bash
git add src/worktree/manager.ts test/unit/execution/worktree-manager.test.ts test/integration/worktree/manager.test.ts
git commit -m "refactor(worktree): remove dependency symlink behavior from manager"
```

---

### Task 3: Build the shared dependency-preparation module and safe command parser

**Files:**
- Create: `src/utils/command-argv.ts`
- Modify: `src/hooks/runner.ts`
- Modify: `src/worktree/types.ts`
- Create: `src/worktree/dependencies.ts`
- Modify: `src/worktree/index.ts`
- Create: `test/unit/worktree/dependencies.test.ts`

- [ ] **Step 1: Extract the argv parser into a reusable utility**

Create:

```typescript
// src/utils/command-argv.ts
import { buildAllowedEnv } from "../agents/shared/env";

export function parseCommandToArgv(command: string): string[] {
  const safeEnv = buildAllowedEnv();
  const home = (safeEnv.HOME as string | undefined) ?? "";
  const args: string[] = [];
  let current = "";
  let i = 0;
  const s = command.trim();

  while (i < s.length) {
    const ch = s[i];

    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      i++;
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < s.length && s[i] !== "'") current += s[i++];
      i++;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
          current += s[i + 1];
          i += 2;
        } else {
          current += s[i++];
        }
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) args.push(current);
  return args.map((token) => (token.startsWith("~/") && home ? home + token.slice(1) : token));
}
```

Update [src/hooks/runner.ts](/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/src/hooks/runner.ts) to import this helper instead of owning its own parser.

- [ ] **Step 2: Define shared dependency-prep types**

Expand `src/worktree/types.ts` with:

```typescript
export interface WorktreeDependencyContext {
  cwd: string;
  env?: Record<string, string>;
}

export interface PrepareWorktreeDependenciesOptions {
  projectRoot: string;
  worktreeRoot: string;
  storyId: string;
  storyWorkdir?: string;
  config: import("../config").NaxConfig;
}

export class WorktreeDependencyPreparationError extends Error {
  readonly failureCategory = "dependency-prep" as const;

  constructor(
    message: string,
    readonly mode: "inherit" | "provision" | "off",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorktreeDependencyPreparationError";
  }
}
```

- [ ] **Step 3: Implement `prepareWorktreeDependencies()`**

Create `src/worktree/dependencies.ts` with an injectable `_worktreeDependencyDeps` and a single exported entrypoint:

```typescript
export async function prepareWorktreeDependencies(
  options: PrepareWorktreeDependenciesOptions,
): Promise<WorktreeDependencyContext> {
  const dependencyConfig = options.config.execution.worktreeDependencies;
  const resolvedCwd = options.storyWorkdir
    ? join(options.worktreeRoot, options.storyWorkdir)
    : options.worktreeRoot;

  switch (dependencyConfig.mode) {
    case "off":
      return { cwd: resolvedCwd };

    case "provision":
      return runProvisioning({ ...options, resolvedCwd, dependencyConfig });

    case "inherit":
      return resolveInheritance({ ...options, resolvedCwd });
  }
}
```

Recommended phase-1 helpers:

```typescript
function resolveInheritance(...): Promise<WorktreeDependencyContext>
function runProvisioning(...): Promise<WorktreeDependencyContext>
function detectPhaseOneInheritanceSupport(...): "plain-binaries" | null
```

Phase-1 inheritance recommendation:

```typescript
// Keep v1 narrow instead of pretending JS/Turbo monorepos are solved.
// Example safe first strategy:
// - no local dependency manifest requiring install
// - commands rely only on tracked files or binaries already available on PATH
// Return { cwd: resolvedCwd } with no env mutation.
```

If no safe concrete strategy survives code review, stop and update the spec to make `off` or `provision` the default. Do not smuggle in a fake `inherit` implementation.

Provisioning implementation should:

```typescript
const command = dependencyConfig.setupCommand;
if (!command) {
  throw new WorktreeDependencyPreparationError(
    "[worktree-deps] provision mode requires setupCommand in phase 1",
    "provision",
  );
}

const argv = parseCommandToArgv(command);
const proc = _worktreeDependencyDeps.spawn(argv, {
  cwd: resolvedCwd,
  stdout: "pipe",
  stderr: "pipe",
});
```

and raise a mode-specific error on non-zero exit:

```typescript
throw new WorktreeDependencyPreparationError(
  `[worktree-deps] provision failed in ${resolvedCwd}: ${output || "unknown error"}`,
  "provision",
);
```

- [ ] **Step 4: Write focused unit tests**

Add tests covering:

```typescript
test("off returns worktree cwd without spawning setup", async () => { ... });
test("provision parses setupCommand into argv and runs it once", async () => { ... });
test("inherit throws explicit unsupported error for non-allowlisted repo", async () => { ... });
test("inherit returns context for allowlisted phase-1 strategy", async () => { ... });
test("provision uses story workdir when provided", async () => { ... });
```

- [ ] **Step 5: Run unit tests**

Run:

```bash
bun test test/unit/worktree/dependencies.test.ts test/unit/config/worktree-dependencies-schema.test.ts --timeout=30000
```

Expected: PASS, including explicit unsupported-`inherit` behavior.

- [ ] **Step 6: Commit**

```bash
git add src/utils/command-argv.ts src/hooks/runner.ts src/worktree/types.ts src/worktree/dependencies.ts src/worktree/index.ts test/unit/worktree/dependencies.test.ts
git commit -m "feat(worktree): add shared dependency preparation module"
```

---

### Task 4: Integrate the shared hook into sequential and parallel worktree execution

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/execution/iteration-runner.ts`
- Modify: `src/execution/parallel-batch.ts`
- Modify: `src/execution/parallel-worker.ts`
- Modify: `src/pipeline/stages/execution.ts`
- Modify: `src/pipeline/stages/verify.ts`
- Modify: `src/pipeline/stages/review.ts`
- Modify: `src/verification/executor.ts`
- Modify: `test/unit/execution/iteration-runner.test.ts`
- Modify: `test/unit/execution/parallel-batch.test.ts`

- [ ] **Step 1: Add dependency context to `PipelineContext`**

In `src/pipeline/types.ts`, add:

```typescript
worktreeDependencyContext?: import("../worktree/types").WorktreeDependencyContext;
```

This is the clean place to carry prep results because both agent execution and verification stages already consume `ctx.workdir` and optional env-like inputs downstream.

- [ ] **Step 2: Call the hook in sequential worktree mode before `runPipeline()`**

In `src/execution/iteration-runner.ts`, after worktree creation and before `captureGitRef()`:

```typescript
let dependencyContext: WorktreeDependencyContext | undefined;

if (ctx.config.execution.storyIsolation === "worktree") {
  dependencyContext = await prepareWorktreeDependencies({
    projectRoot: ctx.workdir,
    worktreeRoot: effectiveWorkdir,
    storyId: story.id,
    storyWorkdir: story.workdir,
    config: effectiveConfig,
  });
}
```

Use its cwd in the pipeline context:

```typescript
const resolvedWorkdir =
  dependencyContext?.cwd ??
  (ctx.config.execution.storyIsolation === "worktree"
    ? story.workdir
      ? join(effectiveWorkdir, story.workdir)
      : effectiveWorkdir
    : story.workdir
      ? join(ctx.workdir, story.workdir)
      : ctx.workdir);
```

and store:

```typescript
worktreeDependencyContext: dependencyContext,
```

On `WorktreeDependencyPreparationError`, do not call `runPipeline()`. Instead:

```typescript
markStoryFailed(prd, story.id, "dependency-prep", "worktree-dependencies", ctx.statusWriter);
await savePRD(prd, ctx.prdPath);
await _iterationRunnerDeps.worktreeManager.remove(ctx.workdir, story.id);
return {
  prd,
  storiesCompletedDelta: 0,
  costDelta: 0,
  prdDirty: true,
  finalAction: "fail",
  reason: error.message,
};
```

- [ ] **Step 3: Call the same hook in parallel batch mode**

In `src/execution/parallel-batch.ts`, after `worktreeManager.create()` and per-story config resolution, prepare dependencies per story:

```typescript
const dependencyContexts = new Map<string, WorktreeDependencyContext>();

for (const story of stories) {
  const storyConfig = storyEffectiveConfigs.get(story.id) ?? config;
  const worktreeRoot = worktreePaths.get(story.id)!;

  try {
    const dependencyContext = await prepareWorktreeDependencies({
      projectRoot: workdir,
      worktreeRoot,
      storyId: story.id,
      storyWorkdir: story.workdir,
      config: storyConfig,
    });
    dependencyContexts.set(story.id, dependencyContext);
  } catch (error) {
    failed.push({
      story,
      pipelineResult: {
        success: false,
        finalAction: "fail",
        reason: error instanceof Error ? error.message : String(error),
        stoppedAtStage: "worktree-dependencies",
        context: { ...pipelineContext, story, stories: [story], workdir: worktreeRoot },
      },
    });
    await worktreeManager.remove(workdir, story.id);
  }
}
```

Then pass `dependencyContexts` into `executeParallelBatch()` and skip failed-prep stories entirely.

- [ ] **Step 4: Make the worker and stages consume the returned context**

Update `executeStoryInWorktree()` in `src/execution/parallel-worker.ts` to receive a `WorktreeDependencyContext` and use it instead of recomputing `join(worktreePath, story.workdir)`.

In `src/pipeline/stages/execution.ts`, when constructing `AgentRunOptions`, pass:

```typescript
env: ctx.worktreeDependencyContext?.env,
```

In `src/pipeline/stages/verify.ts` and any review-stage quality runner, thread the env into verification execution:

```typescript
const mergedEnv = normalizeEnvironment({
  ...(process.env as Record<string, string | undefined>),
  ...ctx.worktreeDependencyContext?.env,
}, ctx.config.quality.stripEnvVars);
```

and ensure `executeWithTimeout()` receives `mergedEnv`.

This is required because the spec says the dependency-prep return value is the only supported handoff into later execution.

- [ ] **Step 5: Add active-path tests**

Sequential test shape:

```typescript
test("storyIsolation=worktree prepares dependencies before runPipeline", async () => {
  const prepCalls: string[] = [];
  _iterationRunnerDeps.prepareWorktreeDependencies = mock(async () => {
    prepCalls.push("prep");
    return { cwd: "/tmp/project/.nax-wt/US-001/pkg", env: { PATH: "/tmp/bin" } };
  });
  _iterationRunnerDeps.runPipeline = mock(async () => {
    prepCalls.push("pipeline");
    return makePipelineSuccess();
  });
  expect(prepCalls).toEqual(["prep", "pipeline"]);
});
```

Parallel test shape:

```typescript
test("runParallelBatch prepares dependencies before executeParallelBatch", async () => {
  const calls: string[] = [];
  _parallelBatchDeps.prepareWorktreeDependencies = mock(async () => {
    calls.push("prep");
    return { cwd: "/tmp/project/.nax-wt/US-001", env: { PATH: "/tmp/bin" } };
  });
  _parallelBatchDeps.executeParallelBatch = mock(async () => {
    calls.push("worker");
    return emptyBatchResult();
  });
  expect(calls).toEqual(["prep", "worker"]);
});
```

- [ ] **Step 6: Run targeted execution tests**

Run:

```bash
bun test test/unit/execution/iteration-runner.test.ts test/unit/execution/parallel-batch.test.ts --timeout=30000
```

Expected: PASS, including prep-before-pipeline ordering and prep-failure short-circuit behavior.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/types.ts src/execution/iteration-runner.ts src/execution/parallel-batch.ts src/execution/parallel-worker.ts src/pipeline/stages/execution.ts src/pipeline/stages/verify.ts src/pipeline/stages/review.ts src/verification/executor.ts test/unit/execution/iteration-runner.test.ts test/unit/execution/parallel-batch.test.ts
git commit -m "feat(execution): invoke shared worktree dependency preparation"
```

---

### Task 5: Full regression sweep and migration verification

**Files:**
- Modify: any stale tests asserting symlink reuse
- Modify: any docs/comments that still describe `node_modules` symlinking as supported behavior

- [ ] **Step 1: Remove stale assertions and comments**

Search and clean:

```bash
rg -n "symlink.*node_modules|node_modules.*symlink|worktreeDependencies|prepareWorktreeDependencies|dependency-prep" src test docs/specs
```

Expected after cleanup:
- no docs in `src/` or tests claim `WorktreeManager` symlinks `node_modules`
- active-path tests point at `iteration-runner` and `parallel-batch`
- failure messaging includes `[worktree-deps]`

- [ ] **Step 2: Run the focused worktree/config suite**

Run:

```bash
bun test \
  test/unit/config/worktree-dependencies-schema.test.ts \
  test/unit/worktree/dependencies.test.ts \
  test/unit/execution/worktree-manager.test.ts \
  test/integration/worktree/manager.test.ts \
  test/unit/execution/iteration-runner.test.ts \
  test/unit/execution/parallel-batch.test.ts \
  --timeout=30000
```

Expected: PASS with no dependency symlink expectations.

- [ ] **Step 3: Run repo-level safety gates**

Run:

```bash
bun run typecheck
bun run lint
```

Expected: both PASS.

- [ ] **Step 4: Record the unresolved product check explicitly if needed**

If `inherit` ships only with a very narrow allowlist, update the implementation notes/comments in `src/worktree/dependencies.ts` to state exactly what is supported in phase 1 and why common JS/Turbo repos are intentionally unsupported. Do not let the default mode imply broad compatibility that the code does not actually provide.

- [ ] **Step 5: Commit**

```bash
git add src test docs/specs
git commit -m "test(worktree): cover dependency preparation migration"
```

---

## Self-Review Against Spec

- Spec coverage:
  - `execution.worktreeDependencies` config and validation is covered in Task 1.
  - Removing dependency symlinks from `WorktreeManager` is covered in Task 2.
  - Shared dependency-prep hook for sequential and parallel active paths is covered in Task 4.
  - `inherit | provision | off`, setup command parsing, and failure behavior are covered in Task 3 and Task 4.
  - Regression coverage and migration cleanup are covered in Task 5.
- Placeholder scan:
  - No `TODO`, `TBD`, or “implement later” markers remain.
  - The main uncertainty is explicit, not hidden: phase-1 `inherit` needs a real allowlisted strategy or a spec change.
- Type consistency:
  - The plan uses `worktreeDependencies`, `WorktreeDependencyContext`, `prepareWorktreeDependencies()`, and `dependency-prep` consistently.

Plan complete and saved to `docs/superpowers/plans/2026-04-19-worktree-dependencies.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
