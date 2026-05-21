# TDD Isolation Enforcement & Per-Phase Observability Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the TDD isolation checks and per-phase progress logs that were lost in the StoryOrchestrator consolidation (SPEC-story-orchestrator-consolidation.md), so three-session-tdd runs again enforce session boundaries (test-writer ⇏ source, implementer ⇏ tests) and emit the same `tdd` stage log lines as the pre-consolidation path.

**Architecture:** Isolation checks move into each op's `verify` hook (`testWriterOp` / `implementerOp` / `verifierOp`). The per-phase `beforeRef` (git ref captured just before each phase dispatches) is threaded into the op's input by `StoryOrchestratorPlan.runPhase`, which becomes the single emitter of per-phase begin/end and isolation log lines. Post-run aggregation already supports surfacing `IsolationCheck` from `phaseOutputs[op.name].isolation` (SPEC §3 line 211) — we wire it up.

**Tech Stack:** TypeScript strict, Bun-native, `bun:test`. Affected modules: `src/operations/{write-test,implement,verify}.ts`, `src/execution/story-orchestrator.ts`, `src/execution/post-run.ts`, `src/tdd/isolation.ts` (caller side only). Existing isolation helpers (`verifyTestWriterIsolation`, `verifyImplementerIsolation`) are reused as-is.

---

## File Structure

| File | Responsibility | New / Modify |
|:---|:---|:---|
| `src/operations/write-test.ts` | Add `beforeRef` to input; add `verify` hook running test-writer isolation; expose `isolation` on output | Modify |
| `src/operations/implement.ts` | Same, with implementer isolation | Modify |
| `src/operations/verify.ts` | Same, with implementer isolation (verifier inherits the implementer rule); merge into existing `verify`/`recover` chain | Modify |
| `src/execution/story-orchestrator.ts` | `runPhase` captures `beforeRef` pre-dispatch, decorates TDD slot inputs, emits `tdd`-stage logs (begin / end / isolation / "Created test files" / "Running full test suite gate") | Modify |
| `src/execution/post-run.ts` | Surface `phaseOutputs[*].isolation` into pipeline-context for runner reporting (SPEC §3 line 211) | Modify |
| `test/unit/operations/write-test-op.test.ts` | Add isolation `verify` hook tests | Modify |
| `test/unit/operations/implementer-op.test.ts` | Add isolation `verify` hook tests | Modify (or create — verify first) |
| `test/unit/operations/verifier-op.test.ts` | Add isolation `verify` hook tests | Modify (or create) |
| `test/unit/execution/story-orchestrator-logs.test.ts` | New: assert per-phase log emission and beforeRef threading | Create |
| `test/unit/execution/post-run-isolation.test.ts` | New: assert isolation aggregation from phaseOutputs | Create |

---

## Background Context for Implementers

### What this plan restores

Compare a current run log (`/home/williamkhoo/Desktop/projects/nathapp/ai-coder/nax-global/nax-tdd-calc/features/tdd-calc/runs/2026-05-21T02-30-12.jsonl`) to a pre-consolidation run (`/home/williamkhoo/Desktop/projects/nathapp/ai-coder/nax-global/nax/features/plan-asymmetric-pipeline/runs/2026-05-12T04-59-04.jsonl` line 398+). The current run is missing:

| Log line | Pre-consolidation emitter |
|:---|:---|
| `info tdd "-> Session: test-writer"` (and `implementer` / `verifier`) | `src/tdd/session-runner.ts:207` |
| `info tdd "Session complete: <role>"` | `src/tdd/session-runner.ts:282` |
| `info tdd "Isolation maintained"` (per role) | `src/tdd/session-runner.ts:354` |
| `info tdd "Created test files"` (count + paths) | `src/tdd/session-runner.ts` (around the chain) |
| `info tdd "-> Running full test suite gate (before Verifier)"` | `src/tdd/rectification-gate.ts` |

The functional regression: `verifyImplementerIsolation` has **zero production callers**, and `verifyTestWriterIsolation` is only called from `autofix-guards.ts` (a different concern). Three-session-tdd runs no longer enforce boundaries.

### Why `verify` and not `parse`

The op's `verify` hook (signature `(parsed, input, ctx) => Promise<O | null>`) runs after `parse` succeeds and has access to `VerifyContext<C>` which exposes `packageView.packageDir`. It is the documented seam for "validate parsed output against on-disk artifacts" (ADR-020 §D4). Isolation is exactly that: read `git diff <beforeRef>`, attach result to the parsed output.

The op's `parse` is synchronous-ish and meant for output-to-shape transformation. Putting isolation there couples shape transformation with filesystem I/O — wrong layer.

### Why `runPhase` owns `beforeRef`

Isolation needs the git ref captured **just before each phase dispatches** (test-writer's beforeRef = pre-test-writer state; implementer's beforeRef = post-test-writer state; verifier's beforeRef = post-implementer state). `plan-inputs.ts` runs once at orchestrator build time — too early to know per-phase pre-state. `runPhase` is the only point that runs immediately before each dispatch.

The chosen pattern: `runPhase` captures the ref via `captureGitRef(packageDir)`, then decorates the slot input with `{ ...slot.input, beforeRef }` before passing to `callOp`. Inputs are typed; we add `beforeRef?: string` to `TestWriterInput` / `ImplementerInput` / `VerifierInput`. The mutation is local to the dispatch — slot.input is not modified in place.

### Verifier already declares `isolation` on its output

`src/operations/verify.ts:21` already has `readonly isolation?: IsolationCheck` on `VerifierOutput`, but nothing populates it. Wiring it up satisfies an existing-but-unused type contract.

---

## Task 1: Add `beforeRef` to TestWriterInput + isolation verify hook

**Files:**
- Modify: `src/operations/write-test.ts`
- Test: `test/unit/operations/write-test-op.test.ts`

### Step 1: Write the failing tests

- [ ] **Step 1.1: Add isolation tests to `test/unit/operations/write-test-op.test.ts`**

Append at the end of the existing describe block (before the final `});`):

```typescript
describe("testWriterOp.verify — isolation", () => {
  test("attaches isolation result when beforeRef provided and only test files changed", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("test/foo.test.ts\n").body,
      exited: Promise.resolve(0),
    })) as any;

    try {
      const parsed = {
        success: true,
        filesChanged: ["test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
        config: DEFAULT_CONFIG.tdd,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await testWriterOp.verify!(parsed, input, ctx as any);

      expect(result).not.toBeNull();
      expect(result!.isolation).toBeDefined();
      expect(result!.isolation!.passed).toBe(true);
      expect(result!.isolation!.violations).toEqual([]);
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("attaches isolation result with violations when source files changed", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("src/foo.ts\ntest/foo.test.ts\n").body,
      exited: Promise.resolve(0),
    })) as any;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts", "test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
        config: DEFAULT_CONFIG.tdd,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await testWriterOp.verify!(parsed, input, ctx as any);

      expect(result!.isolation!.passed).toBe(false);
      expect(result!.isolation!.violations).toContain("src/foo.ts");
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("returns parsed unchanged when beforeRef absent (skip isolation)", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const parsed = {
      success: true,
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };
    const input = { story: { id: "US-001" } as any }; // no beforeRef
    const ctx = {
      packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
      config: DEFAULT_CONFIG.tdd,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await testWriterOp.verify!(parsed, input, ctx as any);
    expect(result).toEqual(parsed);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/write-test-op.test.ts --timeout=10000`
Expected: 3 new tests fail with "testWriterOp.verify is undefined" or equivalent.

### Step 2: Implement the verify hook

- [ ] **Step 2.1: Update `src/operations/write-test.ts`**

Replace the entire file with:

```typescript
import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { _isolationDeps, verifyTestWriterIsolation } from "../tdd/isolation";
import type { IsolationCheck } from "../tdd/types";
import { parseSessionJsonOutput } from "./_session-output";
import type { RunOperation } from "./types";

void _isolationDeps; // re-export to keep test mocks pointed at the same singleton

export interface TestWriterInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
  /**
   * Git ref captured by the orchestrator just before this phase dispatches.
   * When present, the op's `verify` hook runs test-writer isolation against this ref.
   * Absent in legacy / ad-hoc callers — isolation is then skipped.
   */
  readonly beforeRef?: string;
}

export interface TestWriterOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  /** Populated by `verify` when input.beforeRef was supplied. */
  readonly isolation?: IsolationCheck;
}

export const testWriterOp: RunOperation<TestWriterInput, TestWriterOutput, TddConfig> = {
  kind: "run",
  name: "test-writer",
  stage: "run",
  session: { role: "test-writer", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
    const context = [input.contextMarkdown, input.featureContextMarkdown].filter(Boolean).join("\n\n");
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: context || `Write tests for story: ${input.story.id}`,
        overridable: false,
      },
      ...(input.constitution ? { constitution: input.constitution } : {}),
    };
  },
  parse(output, _input, _ctx): TestWriterOutput {
    if (!output) return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    if (output.startsWith('Agent "')) {
      return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output };
    }
    const envelope = parseSessionJsonOutput(output);
    return {
      success: envelope.parsed ? envelope.success : true,
      filesChanged: envelope.filesChanged,
      estimatedCostUsd: 0,
      durationMs: 0,
      output: envelope.output,
    };
  },
  async verify(parsed, input, ctx): Promise<TestWriterOutput | null> {
    if (!input.beforeRef) return parsed;
    const cfg = ctx.config;
    const allowedPaths = cfg.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
    const testFilePatterns =
      typeof ctx.packageView.config.execution?.smartTestRunner === "object" &&
      ctx.packageView.config.execution.smartTestRunner !== null
        ? ctx.packageView.config.execution.smartTestRunner.testFilePatterns
        : undefined;
    const isolation = await verifyTestWriterIsolation(
      ctx.packageView.packageDir,
      input.beforeRef,
      allowedPaths,
      testFilePatterns,
    );
    return { ...parsed, isolation };
  },
};

/** Backward-compat alias — callers may use either name. */
export const writeTddTestOp = testWriterOp;
```

- [ ] **Step 2.2: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/operations/write-test-op.test.ts --timeout=10000`
Expected: All tests in the file pass (existing + 3 new).

### Step 3: Commit

- [ ] **Step 3.1: Commit**

```bash
git add src/operations/write-test.ts test/unit/operations/write-test-op.test.ts
git commit -m "feat(tdd): test-writer isolation enforcement via verify hook"
```

---

## Task 2: Add `beforeRef` to ImplementerInput + isolation verify hook

**Files:**
- Modify: `src/operations/implement.ts`
- Test: `test/unit/operations/implementer-op.test.ts` (create if absent)

### Step 1: Verify or create the test file

- [ ] **Step 1.1: Check if test file exists**

Run: `ls test/unit/operations/implementer-op.test.ts 2>/dev/null || ls test/unit/operations/implement.test.ts 2>/dev/null || echo MISSING`

If `MISSING`, create the file at `test/unit/operations/implement.test.ts` with this skeleton:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("implementerOp", () => {
  describe("verify — isolation", () => {
    // Tests appended below
  });
});
```

### Step 2: Write the failing tests

- [ ] **Step 2.1: Add the isolation tests**

In the `describe("verify — isolation", ...)` block, add:

```typescript
test("attaches isolation with warnings when implementer touched test files", async () => {
  const { implementerOp } = await import("@/operations");
  const { DEFAULT_CONFIG } = await import("@/config");
  const { _isolationDeps } = await import("@/tdd");

  const origSpawn = _isolationDeps.spawn;
  _isolationDeps.spawn = ((_cmd: string[]) => ({
    stdout: new Response("src/foo.ts\ntest/foo.test.ts\n").body,
    exited: Promise.resolve(0),
  })) as any;

  try {
    const parsed = {
      success: true,
      filesChanged: ["src/foo.ts", "test/foo.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };
    const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
    const ctx = {
      packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
      config: DEFAULT_CONFIG.tdd,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await implementerOp.verify!(parsed, input, ctx as any);
    expect(result).not.toBeNull();
    expect(result!.isolation).toBeDefined();
    expect(result!.isolation!.passed).toBe(true);
    expect(result!.isolation!.warnings).toContain("test/foo.test.ts");
  } finally {
    _isolationDeps.spawn = origSpawn;
  }
});

test("attaches passing isolation when implementer touched only source files", async () => {
  const { implementerOp } = await import("@/operations");
  const { DEFAULT_CONFIG } = await import("@/config");
  const { _isolationDeps } = await import("@/tdd");

  const origSpawn = _isolationDeps.spawn;
  _isolationDeps.spawn = ((_cmd: string[]) => ({
    stdout: new Response("src/foo.ts\n").body,
    exited: Promise.resolve(0),
  })) as any;

  try {
    const parsed = {
      success: true,
      filesChanged: ["src/foo.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };
    const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
    const ctx = {
      packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
      config: DEFAULT_CONFIG.tdd,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await implementerOp.verify!(parsed, input, ctx as any);
    expect(result!.isolation!.passed).toBe(true);
    expect(result!.isolation!.warnings ?? []).toEqual([]);
  } finally {
    _isolationDeps.spawn = origSpawn;
  }
});

test("returns parsed unchanged when beforeRef absent", async () => {
  const { implementerOp } = await import("@/operations");
  const { DEFAULT_CONFIG } = await import("@/config");

  const parsed = {
    success: true,
    filesChanged: [],
    estimatedCostUsd: 0,
    durationMs: 0,
    output: "ok",
  };
  const input = { story: { id: "US-001" } as any };
  const ctx = {
    packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
    config: DEFAULT_CONFIG.tdd,
    readFile: async () => null,
    fileExists: async () => false,
  };

  const result = await implementerOp.verify!(parsed, input, ctx as any);
  expect(result).toEqual(parsed);
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/implement.test.ts --timeout=10000`
Expected: 3 new tests fail with "implementerOp.verify is undefined".

### Step 3: Implement the verify hook

- [ ] **Step 3.1: Update `src/operations/implement.ts`**

Replace the entire file with:

```typescript
import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { verifyImplementerIsolation } from "../tdd/isolation";
import type { IsolationCheck } from "../tdd/types";
import { parseSessionJsonOutput } from "./_session-output";
import { shouldKeepSessionOpen } from "./execution-gates";
import type { RunOperation } from "./types";

export interface ImplementerInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
  /**
   * Git ref captured by the orchestrator just before this phase dispatches.
   * When present, the op's `verify` hook runs implementer isolation against this ref.
   * Absent in legacy / ad-hoc callers — isolation is then skipped.
   */
  readonly beforeRef?: string;
}

export interface ImplementerOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  /** Populated by `verify` when input.beforeRef was supplied. */
  readonly isolation?: IsolationCheck;
}

export const implementerOp: RunOperation<ImplementerInput, ImplementerOutput, TddConfig> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  session: { role: "implementer", lifetime: "warm" },
  config: tddConfigSelector,
  keepOpen: (_input, ctx) => shouldKeepSessionOpen(ctx.config, "implementer"),
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
    const context = [input.contextMarkdown, input.featureContextMarkdown].filter(Boolean).join("\n\n");
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: context || `Implement story: ${input.story.id}`,
        overridable: false,
      },
      ...(input.constitution ? { constitution: input.constitution } : {}),
    };
  },
  parse(output, _input, _ctx): ImplementerOutput {
    if (!output) return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    if (output.startsWith('Agent "')) {
      return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output };
    }
    const envelope = parseSessionJsonOutput(output);
    return {
      success: envelope.parsed ? envelope.success : true,
      filesChanged: envelope.filesChanged,
      estimatedCostUsd: 0,
      durationMs: 0,
      output: envelope.output,
    };
  },
  async verify(parsed, input, ctx): Promise<ImplementerOutput | null> {
    if (!input.beforeRef) return parsed;
    const testFilePatterns =
      typeof ctx.packageView.config.execution?.smartTestRunner === "object" &&
      ctx.packageView.config.execution.smartTestRunner !== null
        ? ctx.packageView.config.execution.smartTestRunner.testFilePatterns
        : undefined;
    const isolation = await verifyImplementerIsolation(ctx.packageView.packageDir, input.beforeRef, testFilePatterns);
    return { ...parsed, isolation };
  },
};

/** Backward-compat alias — callers may use either name. */
export const implementTddOp = implementerOp;
```

- [ ] **Step 3.2: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/operations/implement.test.ts --timeout=10000`
Expected: All tests pass.

### Step 4: Commit

- [ ] **Step 4.1: Commit**

```bash
git add src/operations/implement.ts test/unit/operations/implement.test.ts
git commit -m "feat(tdd): implementer isolation enforcement via verify hook"
```

---

## Task 3: Compose verifier isolation into the existing verify/recover chain

**Files:**
- Modify: `src/operations/verify.ts`
- Test: `test/unit/operations/verifier-op.test.ts` (or `verify.test.ts` — check existing name)

The verifier already has `verify` (returns parsed if success, else null) and `recover` (reads `.nax-verifier-verdict.json`). We need to:
1. Add `beforeRef` to `VerifierInput`.
2. When `input.beforeRef` is present, run `verifyImplementerIsolation` and attach result to the returned output.
3. Apply both on the happy path (`verify` returns parsed.success ? parsed : null) and the recover path.

### Step 1: Locate the test file

- [ ] **Step 1.1: Find the verifier test file**

Run: `ls test/unit/operations/ | grep -iE "verif"`

Expected: a file like `verify.test.ts` or `verifier-op.test.ts`. Use that path in the next steps.

### Step 2: Write the failing tests

- [ ] **Step 2.1: Append isolation tests to the verifier test file**

```typescript
describe("verifierOp.verify — isolation", () => {
  test("attaches isolation result when beforeRef supplied (happy path)", async () => {
    const { verifierOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("src/foo.ts\n").body,
      exited: Promise.resolve(0),
    })) as any;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
      };
      const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
        config: DEFAULT_CONFIG.tdd,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await verifierOp.verify!(parsed, input, ctx as any);
      expect(result).not.toBeNull();
      expect(result!.isolation).toBeDefined();
      expect(result!.isolation!.passed).toBe(true);
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("still returns null when parsed.success=false (defer to recover)", async () => {
    const { verifierOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const parsed = {
      success: false,
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
    };
    const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
    const ctx = {
      packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
      config: DEFAULT_CONFIG.tdd,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await verifierOp.verify!(parsed, input, ctx as any);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/operations/verify.test.ts --timeout=10000` (adjust path)
Expected: First new test fails — `isolation` not populated.

### Step 3: Implement

- [ ] **Step 3.1: Update `src/operations/verify.ts`**

Replace the `parse` / `verify` / `recover` block with:

```typescript
async function runVerifierIsolation(
  beforeRef: string | undefined,
  ctx: import("./types").VerifyContext<TddConfig>,
): Promise<IsolationCheck | undefined> {
  if (!beforeRef) return undefined;
  const testFilePatterns =
    typeof ctx.packageView.config.execution?.smartTestRunner === "object" &&
    ctx.packageView.config.execution.smartTestRunner !== null
      ? ctx.packageView.config.execution.smartTestRunner.testFilePatterns
      : undefined;
  return verifyImplementerIsolation(ctx.packageView.packageDir, beforeRef, testFilePatterns);
}

export const verifierOp: RunOperation<VerifierInput, VerifierOutput, TddConfig> = {
  kind: "run",
  name: "verifier",
  stage: "verify",
  session: { role: "verifier", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: `Verify implementation for story: ${input.story.id}`,
        overridable: false,
      },
    };
  },
  parse(output, _input, _ctx): VerifierOutput {
    const envelope = parseSessionJsonOutput(output);
    return { ...envelope, estimatedCostUsd: 0, durationMs: 0 };
  },
  async verify(parsed, input, ctx): Promise<VerifierOutput | null> {
    if (!parsed.success) return null;
    const isolation = await runVerifierIsolation(input.beforeRef, ctx);
    return isolation ? { ...parsed, isolation } : parsed;
  },
  async recover(input, verifyCtx): Promise<VerifierOutput | null> {
    const packageDir = verifyCtx.packageView.packageDir;
    try {
      const verdict = await readVerdict(packageDir);
      if (!verdict) return null;
      const testsAllPassing = verdict.tests.allPassing === true;
      const categorization = categorizeVerdict(verdict, testsAllPassing);
      const isolation = await runVerifierIsolation(input.beforeRef, verifyCtx);
      return {
        success: categorization.success,
        filesChanged: [],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
        ...(categorization.failureCategory && { failureCategory: categorization.failureCategory }),
        ...(categorization.reviewReason && { reviewReason: categorization.reviewReason }),
        ...(isolation && { isolation }),
      };
    } finally {
      await cleanupVerdict(packageDir);
    }
  },
};
```

Also add `beforeRef` field to `VerifierInput`:

```typescript
export interface VerifierInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  /** See TestWriterInput.beforeRef */
  readonly beforeRef?: string;
}
```

And add the import at the top of the file:

```typescript
import { verifyImplementerIsolation } from "../tdd/isolation";
```

- [ ] **Step 3.2: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/operations/verify.test.ts --timeout=10000`
Expected: All tests pass.

### Step 4: Commit

- [ ] **Step 4.1: Commit**

```bash
git add src/operations/verify.ts test/unit/operations/verify.test.ts
git commit -m "feat(tdd): verifier isolation merged into verify/recover chain"
```

---

## Task 4: Orchestrator captures `beforeRef` and threads it into TDD slot inputs

**Files:**
- Modify: `src/execution/story-orchestrator.ts`
- Test: `test/unit/execution/story-orchestrator-logs.test.ts` (create)

### Step 1: Write the failing test

- [ ] **Step 1.1: Create `test/unit/execution/story-orchestrator-logs.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps } from "@/execution/story-orchestrator";
import { _captureGitRefDeps } from "@/utils/git";

describe("StoryOrchestrator runPhase — beforeRef threading", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCapture: typeof _captureGitRefDeps.spawn;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    origCapture = _captureGitRefDeps.spawn;
  });

  afterEach(() => {
    _storyOrchestratorDeps.callOp = origCallOp;
    _captureGitRefDeps.spawn = origCapture;
  });

  test("decorates TDD slot inputs with captured beforeRef before dispatch", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");
    const { testWriterOp } = await import("@/operations");

    let capturedInput: unknown;
    _storyOrchestratorDeps.callOp = (async (_ctx: any, _op: any, input: any) => {
      capturedInput = input;
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    }) as any;

    // Mock git ref capture to return a deterministic value
    _captureGitRefDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("abc1234\n").body,
      exited: Promise.resolve(0),
    })) as any;

    const builder = new StoryOrchestratorBuilder();
    builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });

    const plan = builder.build({ packageDir: "/tmp/x" } as any);
    await plan.run();

    expect((capturedInput as { beforeRef?: string }).beforeRef).toBe("abc1234");
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/story-orchestrator-logs.test.ts --timeout=10000`
Expected: Fails — `beforeRef` is undefined on captured input.

### Step 2: Implement beforeRef capture in runPhase

- [ ] **Step 2.1: Update `src/execution/story-orchestrator.ts`**

Add an import at the top:

```typescript
import { captureGitRef } from "../utils/git";
```

Update `_storyOrchestratorDeps` to include `captureGitRef`:

```typescript
export const _storyOrchestratorDeps = {
  callOp,
  captureGitRef,
};
```

Update `runPhase` to capture ref and decorate input for the three TDD ops:

```typescript
const TDD_OP_NAMES = new Set<string>(["test-writer", "implementer", "verifier"]);

async function runPhase(
  ctx: CallContext,
  slot: AnySlot,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<unknown> {
  const scope = ctx.runtime.costAggregator.openScope();
  const isTddPhase = TDD_OP_NAMES.has(slot.op.name);
  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : null;
  const dispatchInput =
    isTddPhase && beforeRef
      ? { ...(slot.input as Record<string, unknown>), beforeRef }
      : slot.input;

  try {
    const output = await _storyOrchestratorDeps.callOp(
      { ...ctx, scopeId: scope.scopeId },
      slot.op,
      dispatchInput,
    );
    phaseOutputs[slot.op.name] = output;
    return output;
  } finally {
    phaseCosts[slot.op.name] = (phaseCosts[slot.op.name] ?? 0) + scope.snapshot().totalCostUsd;
    scope.close();
  }
}
```

- [ ] **Step 2.2: Verify `captureGitRef` is exported from `src/utils/git`**

Run: `grep -n "export.*captureGitRef" src/utils/git.ts`
Expected: A line like `export async function captureGitRef`. If missing or named differently, adjust the import.

- [ ] **Step 2.3: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/story-orchestrator-logs.test.ts --timeout=10000`
Expected: Pass.

### Step 3: Commit

- [ ] **Step 3.1: Commit**

```bash
git add src/execution/story-orchestrator.ts test/unit/execution/story-orchestrator-logs.test.ts
git commit -m "feat(tdd): orchestrator captures beforeRef per phase for isolation checks"
```

---

## Task 5: Emit per-phase begin/end logs in runPhase

**Files:**
- Modify: `src/execution/story-orchestrator.ts`
- Test: extend `test/unit/execution/story-orchestrator-logs.test.ts`

### Step 1: Write the failing test

- [ ] **Step 1.1: Append a logging test**

In `test/unit/execution/story-orchestrator-logs.test.ts`, add:

```typescript
describe("StoryOrchestrator runPhase — log emission", () => {
  test("emits '-> Session: <role>' and 'Session complete: <role>' for TDD phases", async () => {
    const { StoryOrchestratorBuilder, _storyOrchestratorDeps } = await import("@/execution/story-orchestrator");
    const { testWriterOp } = await import("@/operations");
    const { getLogger } = await import("@/logger");

    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["test/foo.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
    })) as any;
    _storyOrchestratorDeps.captureGitRef = (async () => "abc1234") as any;

    const logs: Array<{ level: string; stage: string; msg: string; data?: unknown }> = [];
    const logger = getLogger();
    const origInfo = logger.info;
    logger.info = ((stage: string, msg: string, data?: unknown) => {
      logs.push({ level: "info", stage, msg, data });
    }) as any;

    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      const plan = builder.build({ packageDir: "/tmp/x", storyId: "US-001" } as any);
      await plan.run();
    } finally {
      logger.info = origInfo;
    }

    expect(logs.some((l) => l.stage === "tdd" && l.msg === "-> Session: test-writer")).toBe(true);
    expect(logs.some((l) => l.stage === "tdd" && l.msg === "Session complete: test-writer")).toBe(true);
  });

  test("emits 'Created test files' after test-writer with filesChanged count", async () => {
    const { StoryOrchestratorBuilder, _storyOrchestratorDeps } = await import("@/execution/story-orchestrator");
    const { testWriterOp } = await import("@/operations");
    const { getLogger } = await import("@/logger");

    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["test/a.test.ts", "test/b.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
    })) as any;
    _storyOrchestratorDeps.captureGitRef = (async () => "abc1234") as any;

    const logs: Array<{ stage: string; msg: string; data?: any }> = [];
    const logger = getLogger();
    const origInfo = logger.info;
    logger.info = ((stage: string, msg: string, data?: unknown) => {
      logs.push({ stage, msg, data });
    }) as any;

    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      const plan = builder.build({ packageDir: "/tmp/x", storyId: "US-001" } as any);
      await plan.run();
    } finally {
      logger.info = origInfo;
    }

    const createdLog = logs.find((l) => l.stage === "tdd" && l.msg === "Created test files");
    expect(createdLog).toBeDefined();
    expect(createdLog!.data.testFilesCount).toBe(2);
    expect(createdLog!.data.testFiles).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  test("emits 'Isolation maintained' when phase output carries passing isolation", async () => {
    const { StoryOrchestratorBuilder, _storyOrchestratorDeps } = await import("@/execution/story-orchestrator");
    const { testWriterOp } = await import("@/operations");
    const { getLogger } = await import("@/logger");

    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["test/a.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
      isolation: { passed: true, violations: [], description: "ok" },
    })) as any;
    _storyOrchestratorDeps.captureGitRef = (async () => "abc1234") as any;

    const logs: Array<{ stage: string; msg: string }> = [];
    const logger = getLogger();
    const origInfo = logger.info;
    logger.info = ((stage: string, msg: string) => {
      logs.push({ stage, msg });
    }) as any;

    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      const plan = builder.build({ packageDir: "/tmp/x", storyId: "US-001" } as any);
      await plan.run();
    } finally {
      logger.info = origInfo;
    }

    expect(logs.some((l) => l.stage === "tdd" && l.msg === "Isolation maintained")).toBe(true);
  });

  test("emits 'Running full test suite gate' for fullSuiteGate phase", async () => {
    const { StoryOrchestratorBuilder, _storyOrchestratorDeps } = await import("@/execution/story-orchestrator");
    const { fullSuiteGateOp } = await import("@/operations");
    const { getLogger } = await import("@/logger");

    _storyOrchestratorDeps.callOp = (async () => ({ success: true, gateOutput: {} })) as any;
    _storyOrchestratorDeps.captureGitRef = (async () => "abc1234") as any;

    const logs: Array<{ stage: string; msg: string }> = [];
    const logger = getLogger();
    const origInfo = logger.info;
    logger.info = ((stage: string, msg: string) => {
      logs.push({ stage, msg });
    }) as any;

    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addFullSuiteGate({ op: fullSuiteGateOp, input: {} as any });
      const plan = builder.build({ packageDir: "/tmp/x", storyId: "US-001" } as any);
      await plan.run();
    } finally {
      logger.info = origInfo;
    }

    expect(logs.some((l) => l.stage === "tdd" && l.msg.includes("Running full test suite gate"))).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/story-orchestrator-logs.test.ts --timeout=10000`
Expected: New tests fail — no log emission yet.

### Step 2: Implement log emission

- [ ] **Step 2.1: Update `runPhase` in `src/execution/story-orchestrator.ts`**

Replace the function body with:

```typescript
async function runPhase(
  ctx: CallContext,
  slot: AnySlot,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<unknown> {
  const logger = getSafeLogger();
  const opName = slot.op.name;
  const isTddPhase = TDD_OP_NAMES.has(opName);

  // Pre-phase: capture git ref for TDD phases; emit phase-begin log.
  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : null;
  const dispatchInput =
    isTddPhase && beforeRef
      ? { ...(slot.input as Record<string, unknown>), beforeRef }
      : slot.input;

  if (isTddPhase) {
    logger?.info("tdd", `-> Session: ${opName}`, { storyId: ctx.storyId, role: opName });
  } else if (opName === "full-suite-gate") {
    logger?.info("tdd", "-> Running full test suite gate (before Verifier)", { storyId: ctx.storyId });
  }

  const phaseStartedAt = Date.now();
  const scope = ctx.runtime.costAggregator.openScope();
  try {
    const output = await _storyOrchestratorDeps.callOp({ ...ctx, scopeId: scope.scopeId }, slot.op, dispatchInput);
    phaseOutputs[opName] = output;

    // Post-phase logs (TDD only):
    //   - "Session complete: <role>" with duration
    //   - "Created test files" after test-writer with filesChanged
    //   - "Isolation maintained" / "Isolation violated" from output.isolation
    if (isTddPhase) {
      const durationMs = Date.now() - phaseStartedAt;
      logger?.info("tdd", `Session complete: ${opName}`, {
        storyId: ctx.storyId,
        role: opName,
        durationMs,
      });

      const filesChanged = (output as { filesChanged?: readonly string[] })?.filesChanged ?? [];
      if (opName === "test-writer" && filesChanged.length > 0) {
        logger?.info("tdd", "Created test files", {
          storyId: ctx.storyId,
          testFilesCount: filesChanged.length,
          testFiles: [...filesChanged],
        });
      }

      const isolation = (output as { isolation?: { passed: boolean; violations: string[] } })?.isolation;
      if (isolation) {
        if (isolation.passed) {
          logger?.info("tdd", "Isolation maintained", { storyId: ctx.storyId, role: opName });
        } else {
          logger?.error("tdd", "Isolation violated", {
            storyId: ctx.storyId,
            role: opName,
            violations: isolation.violations,
          });
        }
      }
    }

    return output;
  } finally {
    phaseCosts[opName] = (phaseCosts[opName] ?? 0) + scope.snapshot().totalCostUsd;
    scope.close();
  }
}
```

- [ ] **Step 2.2: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/story-orchestrator-logs.test.ts --timeout=10000`
Expected: All tests pass.

- [ ] **Step 2.3: Run the full orchestrator/execution test suite to catch regressions**

Run: `timeout 120 bun test test/unit/execution/ test/integration/tdd/ --timeout=10000`
Expected: All pass (no regressions on builder/orchestrator tests).

### Step 3: Commit

- [ ] **Step 3.1: Commit**

```bash
git add src/execution/story-orchestrator.ts test/unit/execution/story-orchestrator-logs.test.ts
git commit -m "feat(tdd): per-phase begin/end/isolation logs in StoryOrchestrator"
```

---

## Task 6: Aggregate isolation results into pipeline-context for runner reporting

**Files:**
- Modify: `src/execution/post-run.ts`
- Test: `test/unit/execution/post-run-isolation.test.ts` (create)

SPEC §3 line 211 says: *"Any `IsolationCheck` on phase outputs | Aggregate into pipeline-context for runner reporting"*. We now have the `IsolationCheck` on `phaseOutputs[opName].isolation`. The aggregation needs a home — find or add a `tddIsolations` field on `PipelineContext` and write to it from `applyPostRunInspection`.

### Step 1: Write the failing test

- [ ] **Step 1.1: Create `test/unit/execution/post-run-isolation.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";

describe("applyPostRunInspection — isolation aggregation", () => {
  test("collects isolation from each TDD phase output into ctx.tddIsolations", async () => {
    const { applyPostRunInspection } = await import("@/execution/post-run");
    const { makeStory, makeNaxConfig } = await import("../../helpers");

    const ctx = {
      story: makeStory(),
      config: makeNaxConfig(),
      workdir: "/tmp/x",
      routing: { testStrategy: "three-session-tdd", modelTier: "balanced" } as any,
      prd: { feature: "f" } as any,
      // tddIsolations slot to be populated
    } as any;

    const planResult = {
      success: true,
      phaseOutputs: {
        "test-writer": {
          success: true,
          filesChanged: ["test/a.test.ts"],
          isolation: { passed: true, violations: [], description: "tw ok" },
        },
        implementer: {
          success: true,
          filesChanged: ["src/a.ts"],
          isolation: { passed: true, violations: [], description: "impl ok" },
        },
        verifier: { success: true, filesChanged: [] },
      },
      phaseCosts: {},
      totalCostUsd: 0,
      durationMs: 0,
    };

    await applyPostRunInspection(ctx, planResult as any, {
      capturedTokenUsage: undefined,
      capturedResponse: "",
      capturedCostUsd: 0,
      tddMode: { isLite: false, rollbackEnabled: false },
      initialRef: "abc",
    });

    expect(ctx.tddIsolations).toBeDefined();
    expect(ctx.tddIsolations["test-writer"].passed).toBe(true);
    expect(ctx.tddIsolations.implementer.passed).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/post-run-isolation.test.ts --timeout=10000`
Expected: Fails — `ctx.tddIsolations` is undefined.

### Step 2: Implement the aggregation

- [ ] **Step 2.1: Add `tddIsolations` to `PipelineContext`**

In `src/pipeline/types.ts`, add to the `PipelineContext` interface (find the section near `tddFailureCategory`):

```typescript
/** Isolation results aggregated from TDD phase outputs. Set by applyPostRunInspection. */
readonly tddIsolations?: Record<string, import("../execution/types").IsolationCheck>;
```

(If the surrounding declarations use `readonly` consistently, follow suit. If they use mutable fields, drop `readonly`.)

- [ ] **Step 2.2: Populate it in `applyPostRunInspection`**

In `src/execution/post-run.ts`, inside `applyPostRunInspection` (around the existing TDD failure category derivation), add:

```typescript
// Aggregate isolation from phase outputs (SPEC §3 line 211).
const tddIsolations: Record<string, import("./types").IsolationCheck> = {};
for (const opName of ["test-writer", "implementer", "verifier"] as const) {
  const phaseOutput = planResult.phaseOutputs[opName] as { isolation?: import("./types").IsolationCheck } | undefined;
  if (phaseOutput?.isolation) {
    tddIsolations[opName] = phaseOutput.isolation;
  }
}
if (Object.keys(tddIsolations).length > 0) {
  (ctx as { tddIsolations?: typeof tddIsolations }).tddIsolations = tddIsolations;
}
```

- [ ] **Step 2.3: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/post-run-isolation.test.ts --timeout=10000`
Expected: Pass.

### Step 3: Commit

- [ ] **Step 3.1: Commit**

```bash
git add src/execution/post-run.ts src/pipeline/types.ts test/unit/execution/post-run-isolation.test.ts
git commit -m "feat(tdd): aggregate phase isolation into ctx.tddIsolations"
```

---

## Task 7: End-to-end smoke — full unit + integration suite + lint + typecheck

**Files:** No source changes — verification only.

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: All checks pass. If `check-logger-storyid` baseline goes up because of the new log calls, lower it with `bun run check:logger-storyid --update-baseline` *only if all new calls include `storyId`* (they should — verify by grep).

- [ ] **Step 3: Run unit suites for changed areas**

Run: `timeout 300 bun test test/unit/operations/ test/unit/execution/ test/unit/pipeline/ test/integration/tdd/ --timeout=15000`
Expected: All pass.

- [ ] **Step 4: Manual log-format smoke**

Skim the diff: the four new log lines must use `storyId` as the first key in the data object (project rule — `.claude/rules/project-conventions.md`):

```typescript
logger.info("tdd", "-> Session: test-writer", { storyId: ctx.storyId, role: "test-writer" });
```

Not:

```typescript
logger.info("tdd", "-> Session: test-writer", { role: "test-writer", storyId: ctx.storyId }); // ❌
```

- [ ] **Step 5: Final commit (only if any fix-ups above)**

```bash
git add -p   # stage any fix-ups
git commit -m "chore(tdd): final lint/typecheck cleanup"
```

---

## Self-Review Checklist

**Spec coverage:**
- SPEC §3 line 211 "Any `IsolationCheck` on phase outputs | Aggregate into pipeline-context for runner reporting" — Task 6 (`ctx.tddIsolations`).
- Restored logs: `-> Session: <role>` (Task 5), `Session complete: <role>` (Task 5), `Isolation maintained` (Task 5), `Created test files` (Task 5), `-> Running full test suite gate (before Verifier)` (Task 5).
- Functional isolation: test-writer (Task 1), implementer (Task 2), verifier (Task 3).

**Placeholder scan:** No "TBD"/"fill in"/"similar to" references. Each step contains complete code. ✓

**Type consistency:**
- `beforeRef?: string` added to `TestWriterInput` (Task 1) / `ImplementerInput` (Task 2) / `VerifierInput` (Task 3).
- `isolation?: IsolationCheck` on `TestWriterOutput` (Task 1) / `ImplementerOutput` (Task 2) — verifier already declared it.
- `IsolationCheck` imported from `src/tdd/types` (which re-exports from `src/execution/types`) — consistent across all three ops.
- `runPhase` reads `output.isolation` and `output.filesChanged` — both fields populated by the op `parse` + `verify` chain set in Tasks 1–3.
- `_storyOrchestratorDeps.captureGitRef` added (Task 4); referenced by Task 5 tests via the same dep.

**Risks / known limitations:**
- The orchestrator's `beforeRef` capture happens *just before* each phase dispatches. For the test-writer phase, `beforeRef` reflects pre-test-writer state — correct. For implementer, `beforeRef` reflects post-test-writer — so the diff captures only implementer changes. Correct. For verifier, `beforeRef` reflects post-implementer — verifier should not modify any source/test files, so the diff should be empty. If verifier writes the verdict file, that's not in `src/` or `test/` and won't trigger isolation. ✓
- `runPhase`'s log emission depends on `slot.op.name` matching the literal `"test-writer"` / `"implementer"` / `"verifier"`. Custom slot overrides using different op names would not emit TDD logs. The current callers (`buildPlanForStrategy`) always use the canonical ops — acceptable.
- `ctx.tddIsolations` is added as a mutable field on `PipelineContext`. The existing `tddFailureCategory` field is also assigned via mutation in `applyPostRunInspection`, so this matches the existing pattern.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-tdd-isolation-and-observability-restoration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
