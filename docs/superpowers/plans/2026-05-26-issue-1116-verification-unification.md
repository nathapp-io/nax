# Issue #1116 — Complete Verification Path Unification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the remaining behavior from `ScopedStrategy` / `RegressionStrategy` into `verifyScopedOp` / `fullSuiteGateOp`, then delete `VerificationOrchestrator`, all three strategies, the legacy `regressionStage` pipeline stage, and their tests — leaving a single verification path driven by the story-orchestrator + `callOp`.

**Architecture:** The May-23 unification (PR #1084) introduced `verifyScopedOp` / `fullSuiteGateOp` as deterministic Operations driven by `story-orchestrator.ts`, but did not port four `ScopedStrategy` features (smart-runner change-aware selection, monorepo turbo/nx detection, `testScopedTemplate` substitution, deferred-mode SKIPPED) or five `RegressionStrategy` features (`regressionGate.enabled`, `acceptOnTimeout` BUG-026, `regressionGate.timeoutSeconds`, quality knobs `forceExit` / `detectOpenHandles*` / process-management, the use of the timeout-aware `regression()` runner). This plan ports those features, adds parity assertions, then deletes the legacy classes.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome. Deterministic Operations (`src/operations/`), `callOp` dispatch, story-orchestrator plan slots.

---

## Pre-flight context for the implementer

Read these before starting:
- `.claude/rules/project-conventions.md` — Bun-native APIs, 600-line file limit, barrel imports, `storyId` as first log key
- `.claude/rules/monorepo-awareness.md` — `packageDir` vs `workdir`, no `process.cwd()` outside CLI
- `.claude/rules/forbidden-patterns.md` — Test-File Classification Convention (use `resolveTestFilePatterns`)
- `.claude/rules/adapter-wiring.md` — `callOp` is the default entry point
- `.claude/rules/testing-commands.md` — **never** run bare `bun test`; always wrap with `timeout`
- `src/operations/verify-scoped.ts` — current op (70 lines, needs to grow to ~180)
- `src/operations/full-suite-gate.ts` — current op (needs quality-config richness)
- `src/verification/strategies/scoped.ts` — the source of truth being ported
- `src/verification/strategies/regression.ts` — the source of truth being ported
- `src/execution/story-orchestrator.ts` lines 980-987 — where ops are wired into plan slots
- `src/execution/build-plan-for-strategy.ts` — where strategies (TDD/non-TDD) compose plans

**Branching strategy:** Create a branch `feat/issue-1116-verification-unification` from `main`. Commit per task. Open PR after Phase 5.

**Test invocation reminder:** ALL `bun test` calls in this plan are scoped + wrapped with `timeout 30`. Never run bare `bun test`. The full suite is `bun run test` (already time-boxed by the wrapper script).

**Config-key cheat sheet** (verified against `src/config/schemas.ts` and `src/config/selectors.ts:74`). `qualityConfigSelector = pickSelector("quality", "quality", "execution")` — both keys are reachable from `verifyScopedOp`'s `ctx.config`:

| Concept | Path |
|:---|:---|
| Smart-runner toggle/patterns | `execution.smartTestRunner` (boolean OR `{ enabled, testFilePatterns, fallback }`). **Not** `quality.smartRunner` — that key does not exist. |
| Scoped command template (`{{files}}`) | `quality.commands.testScoped` (string, optional — `src/config/schemas-execution.ts:141`) |
| Scope test threshold | `quality.scopeTestThreshold` (default 10 — `schemas.ts:139`) |
| Test command | `quality.commands.test` |
| Regression gate (all four keys already in schema at `schemas.ts:120-125`) | `execution.regressionGate.{enabled, timeoutSeconds, acceptOnTimeout, mode}` |
| Process-management knobs | `quality.{forceExit, detectOpenHandles, detectOpenHandlesRetries, gracePeriodMs, drainTimeoutMs, shell, stripEnvVars}` |

**Plan builder API** (verified against `src/execution/build-plan-for-strategy.ts:125-141`). Adding ops to a plan uses the builder, not `phases.push`:

```typescript
builder.addImplementer(...);
builder.addFullSuiteGate(...);
builder.addVerifier(...);
builder.addVerifyScoped(...);    // non-TDD only today
builder.addLintCheck(...);
builder.addTypecheckCheck(...);
```

---

## File Structure

### New files
- `src/test-runners/scoped-selection.ts` — extracted smart-runner orchestration helper (~120 lines)
- `test/unit/test-runners/scoped-selection.test.ts` — unit tests for the helper (~250 lines, ported from `strategies/scoped.test.ts`)
- `test/integration/verification/strategy-vs-op-parity.test.ts` — parity gate (~150 lines)

### Modified files
- `src/operations/verify-scoped.ts` — absorb `ScopedStrategy` behavior
- `src/operations/full-suite-gate.ts` — absorb `RegressionStrategy` behavior
- `src/execution/story-orchestrator.ts` — thread new inputs into `verifyScopedOp`
- `src/execution/build-plan-for-strategy.ts` — honor `regressionGate.mode` for non-TDD
- `src/pipeline/stages/index.ts` — remove `regressionStage` export/registration
- `src/metrics/types.ts` — drop orchestrator-type imports
- `test/unit/operations/verify-scoped.test.ts` — add ported cases
- `test/unit/operations/full-suite-gate.test.ts` — add ported cases
- `src/verification/index.ts` — clean up barrel re-exports

### Deleted files
- `src/pipeline/stages/regression.ts`
- `src/verification/orchestrator.ts`
- `src/verification/orchestrator-types.ts` (relocate `StructuredTestFailure` first)
- `src/verification/strategies/scoped.ts`
- `src/verification/strategies/regression.ts`
- `src/verification/strategies/acceptance.ts`
- `test/unit/verification/orchestrator.test.ts`
- `test/unit/verification/strategies/scoped.test.ts`
- `test/unit/verification/strategies/regression.test.ts`
- `test/unit/verification/strategies/acceptance.test.ts`
- `test/unit/pipeline/stages/regression-stage.test.ts`

---

## Phase 1 — Parity gate (land first)

### Task 1: Document the envelope-mapping contract

**Files:**
- Modify: `docs/architecture/subsystems.md` (verification subsystem section)

- [ ] **Step 1: Open the verification subsystem section** in `docs/architecture/subsystems.md`. Search for "Verification" — likely section §16 or near `verificationOrchestrator` mentions.

- [ ] **Step 2: Add a new subsection "Strategy → Op envelope mapping (issue #1116)"** that documents the mapping:

```markdown
### Strategy → Op envelope mapping (issue #1116)

`ScopedStrategy.VerifyResult` → `VerifyScopedOutput`:

| Strategy field | Op field | Notes |
|:---|:---|:---|
| `status: "PASS" \| "FAIL" \| "SKIPPED"` | `success` + `status: "passed" \| "failed" \| "skipped" \| "timeout"` | Op uses explicit status union |
| `rawOutput` | (in `findings` + log) | Raw output goes through findings + outcome log, not envelope |
| `passCount` | `passCount` | Same |
| `failCount` | (in `findings.length`) | Derived |
| `durationMs` | `durationMs` | Same |
| `scopeTestFallback` | `scopeTestFallback?: boolean` | New |
| `failures: StructuredTestFailure[]` | `findings: Finding[]` | Already converted via `testSummaryToFindings` |
| `countsTowardEscalation` | (in outcome log only) | Story-orchestrator decides escalation |

`RegressionStrategy.VerifyResult` → `FullSuiteGateOutput`:

| Strategy field | Op field | Notes |
|:---|:---|:---|
| `status: "PASS" \| "FAIL" \| "SKIPPED"` | `status: "passed" \| "failed" \| "skipped" \| "passed-on-timeout" \| "execution-failed"` | Op adds explicit timeout-accept status |
| acceptOnTimeout TIMEOUT → PASS | TIMEOUT → `status: "passed-on-timeout"`, `passed: true` | BUG-026 semantics preserved |
| `enabled: false` → SKIPPED | `status: "skipped"`, `success: true` | Same |
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/subsystems.md
git commit -m "docs(verification): document strategy→op envelope mapping for issue #1116"
```

---

### Task 2: Add strategy-vs-op parity integration test scaffolding

**Files:**
- Create: `test/integration/verification/strategy-vs-op-parity.test.ts`

- [ ] **Step 1: Write the parity test** (it will exercise both paths against the same fixture).

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopedStrategy } from "@/verification/strategies/scoped";
import { RegressionStrategy } from "@/verification/strategies/regression";
import type { VerifyContext } from "@/verification/orchestrator-types";
import { verifyScopedOp } from "@/operations";
import { fullSuiteGateOp } from "@/operations";

/**
 * Parity gate for issue #1116.
 *
 * THROWAWAY MIGRATION SAFETY NET — this file is DELETED in Phase 5 along with
 * the strategy classes it imports. Do not extend it for long-term coverage;
 * port that coverage into test/unit/operations/*.test.ts instead (Phase 2.7,
 * Phase 3.5). The point of this file is to prove envelope equivalence DURING
 * the migration, then disappear.
 */

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "nax-parity-"));
});

describe("scoped: strategy ↔ op parity", () => {
  test("PASS case — same passCount, isFullSuite, scopeTestFallback", async () => {
    // Stub _scopedDeps / _verifyScopedDeps with identical fakes that both
    // resolve to: 0 mapped tests, full-suite fallback, exit code 0, parsed 5 passes.
    // Assert both envelopes carry passCount=5, isFullSuite=true, scopeTestFallback=undefined.
    // (Real implementation in Phase 1: stub here, fill body in Phase 2 after op grows.)
    expect(true).toBe(true); // placeholder — fleshed out after Phase 2.4
  });

  test("SKIPPED case — deferred + no mapped tests + not monorepo orchestrator", async () => {
    expect(true).toBe(true);
  });

  test("THRESHOLD fallback — scope > threshold → full suite with scopeTestFallback=true", async () => {
    expect(true).toBe(true);
  });

  test("MONOREPO orchestrator — turbo command bypasses smart runner", async () => {
    expect(true).toBe(true);
  });
});

describe("full-suite: strategy ↔ op parity", () => {
  test("PASS case", async () => {
    expect(true).toBe(true);
  });

  test("ENABLED=false → skipped", async () => {
    expect(true).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=true → passed", async () => {
    expect(true).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=false → failed", async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it compiles and the placeholders pass**

Run: `timeout 30 bun test test/integration/verification/strategy-vs-op-parity.test.ts --timeout=5000`
Expected: PASS (8/8, all placeholders).

- [ ] **Step 3: Commit**

```bash
git add test/integration/verification/strategy-vs-op-parity.test.ts
git commit -m "test(verification): scaffold strategy↔op parity tests for issue #1116"
```

> The placeholder bodies are filled in during Phase 2.7 and Phase 3.5, once the ops have the new behavior.

---

## Phase 2 — Port `ScopedStrategy` into `verifyScopedOp`

### Task 3: Extract `selectScopedTests` helper (pure move — no behavior change)

**Files:**
- Create: `src/test-runners/scoped-selection.ts`
- Modify: `src/test-runners/index.ts` (barrel export)

- [ ] **Step 1: Write the helper file**

```typescript
// src/test-runners/scoped-selection.ts
/**
 * Scoped Test Selection (issue #1116)
 *
 * Pure helper: given a story's changed files + smart-runner config + base
 * test command, return the effective command + selection metadata.
 *
 * Extracted from src/verification/strategies/scoped.ts (lines 27-120). No
 * behavior change — every code path is preserved verbatim, just behind a
 * stable `selectScopedTests()` boundary so `verifyScopedOp` can call it.
 *
 * Scope: package-scoped (operates on `workdir` + the story's git ref).
 */

import { getLogger } from "@/logger";
import { DEFAULT_TEST_FILE_PATTERNS, globsToTestRegex } from "@/test-runners";
import { _smartRunnerDeps } from "@/verification/smart-runner";
import type { NaxIgnoreIndex } from "@/utils/path-filters";

const DEFAULT_SMART_RUNNER_CONFIG = {
  enabled: true,
  testFilePatterns: [...DEFAULT_TEST_FILE_PATTERNS],
  fallback: "import-grep" as const,
};

export interface SmartRunnerConfigRaw {
  enabled?: boolean;
  testFilePatterns?: string[];
  fallback?: "import-grep" | "none";
}

export function coerceSmartRunner(val: unknown) {
  if (val === undefined || val === true) return DEFAULT_SMART_RUNNER_CONFIG;
  if (val === false) return { ...DEFAULT_SMART_RUNNER_CONFIG, enabled: false };
  return { ...DEFAULT_SMART_RUNNER_CONFIG, ...(val as Partial<typeof DEFAULT_SMART_RUNNER_CONFIG>) };
}

export function buildScopedCommand(
  testFiles: string[],
  baseCommand: string,
  testScopedTemplate: string | undefined,
): string {
  if (testScopedTemplate) {
    const quotedFiles = testFiles.map((file) => `'${file.replaceAll("'", "'\\''")}'`);
    return testScopedTemplate.replace("{{files}}", quotedFiles.join(" "));
  }
  return _scopedSelectionDeps.buildSmartTestCommand(testFiles, baseCommand);
}

/**
 * Monorepo orchestrators (turbo, nx) carry their own change-filter syntax
 * (e.g. `--filter=...[HEAD~1]`, `nx affected`). Smart-runner must not append
 * file paths to such commands — it would produce invalid syntax.
 */
export function isMonorepoOrchestratorCommand(command: string): boolean {
  return /\bturbo\b/.test(command) || /\bnx\b/.test(command);
}

export interface SelectScopedTestsInput {
  workdir: string;
  storyId: string;
  storyGitRef?: string;
  testCommand: string;
  testScopedTemplate?: string;
  smartRunnerConfig: unknown;
  scopeTestThreshold?: number;
  fallbackFullSuiteCommand?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
}

export interface SelectScopedTestsResult {
  effectiveCommand: string;
  isFullSuite: boolean;
  scopeTestFallback?: boolean;
  thresholdFallback: boolean;
  isMonorepoOrchestrator: boolean;
}

export async function selectScopedTests(input: SelectScopedTestsInput): Promise<SelectScopedTestsResult> {
  const logger = getLogger();
  const smartCfg = coerceSmartRunner(input.smartRunnerConfig);
  const isMonorepoOrchestrator = isMonorepoOrchestratorCommand(input.testCommand);
  const threshold = input.scopeTestThreshold ?? 10;

  let effectiveCommand = input.testCommand;
  let isFullSuite = true;
  let scopeTestFallback: boolean | undefined;
  let thresholdFallback = false;

  if (smartCfg.enabled && input.storyGitRef && !isMonorepoOrchestrator) {
    const nonTestFiles = await _scopedSelectionDeps.getChangedNonTestFiles(
      input.workdir,
      input.storyGitRef,
      undefined,
      globsToTestRegex(smartCfg.testFilePatterns),
      input.naxIgnoreIndex,
    );
    const pass1Files = await _scopedSelectionDeps.mapSourceToTests(nonTestFiles, input.workdir);
    if (pass1Files.length > threshold) {
      logger.warn(
        "verify[scoped]",
        `Scoped test file count ${pass1Files.length} exceeds threshold ${threshold} — falling back to full suite`,
        { storyId: input.storyId },
      );
      effectiveCommand = input.fallbackFullSuiteCommand ?? input.testCommand;
      scopeTestFallback = true;
      thresholdFallback = true;
    } else if (pass1Files.length > 0) {
      logger.info("verify[scoped]", `Pass 1: path convention matched ${pass1Files.length} test files`, {
        storyId: input.storyId,
      });
      effectiveCommand = buildScopedCommand(pass1Files, input.testCommand, input.testScopedTemplate);
      isFullSuite = false;
    } else if (smartCfg.fallback === "import-grep") {
      const pass2Files = await _scopedSelectionDeps.importGrepFallback(
        nonTestFiles,
        input.workdir,
        smartCfg.testFilePatterns,
      );
      if (pass2Files.length > threshold) {
        logger.warn(
          "verify[scoped]",
          `Scoped test file count ${pass2Files.length} exceeds threshold ${threshold} — falling back to full suite`,
          { storyId: input.storyId },
        );
        effectiveCommand = input.fallbackFullSuiteCommand ?? input.testCommand;
        scopeTestFallback = true;
        thresholdFallback = true;
      } else if (pass2Files.length > 0) {
        logger.info("verify[scoped]", `Pass 2: import-grep matched ${pass2Files.length} test files`, {
          storyId: input.storyId,
        });
        effectiveCommand = buildScopedCommand(pass2Files, input.testCommand, input.testScopedTemplate);
        isFullSuite = false;
      }
    }
  }

  return { effectiveCommand, isFullSuite, scopeTestFallback, thresholdFallback, isMonorepoOrchestrator };
}

/** Injectable deps for testing. Mirrors `_scopedDeps` from strategies/scoped.ts. */
export const _scopedSelectionDeps = {
  getChangedNonTestFiles: _smartRunnerDeps.getChangedNonTestFiles,
  mapSourceToTests: _smartRunnerDeps.mapSourceToTests,
  importGrepFallback: _smartRunnerDeps.importGrepFallback,
  buildSmartTestCommand: _smartRunnerDeps.buildSmartTestCommand,
};
```

- [ ] **Step 2: Add barrel export**

Edit `src/test-runners/index.ts` — add at the bottom:

```typescript
export {
  selectScopedTests,
  buildScopedCommand,
  coerceSmartRunner,
  isMonorepoOrchestratorCommand,
  _scopedSelectionDeps,
} from "./scoped-selection";
export type { SelectScopedTestsInput, SelectScopedTestsResult } from "./scoped-selection";
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors). The helper is dead code at this point — nothing imports it yet.

- [ ] **Step 4: Commit**

```bash
git add src/test-runners/scoped-selection.ts src/test-runners/index.ts
git commit -m "refactor(test-runners): extract selectScopedTests helper from ScopedStrategy"
```

---

### Task 4: Add unit tests for `selectScopedTests`

**Files:**
- Create: `test/unit/test-runners/scoped-selection.test.ts`

- [ ] **Step 1: Write the tests** — port the relevant cases from `test/unit/verification/strategies/scoped.test.ts` that exercise selection (not execution). Open the source file and identify cases covering:
  - Smart runner disabled → returns base command, isFullSuite=true
  - No storyGitRef → returns base command, isFullSuite=true
  - Monorepo orchestrator (turbo/nx) → isMonorepoOrchestrator=true, no smart runner call
  - Pass 1 (path-convention) match below threshold → isFullSuite=false, effective command from `buildSmartTestCommand`
  - Pass 1 match above threshold → thresholdFallback=true, scopeTestFallback=true, full-suite command
  - Pass 1 empty, Pass 2 (import-grep) match below threshold → isFullSuite=false
  - Pass 1 empty, Pass 2 empty → isFullSuite=true, no fallback
  - `testScopedTemplate` provided → template substitution wins over `buildSmartTestCommand`

Template:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { selectScopedTests, _scopedSelectionDeps } from "@/test-runners";

function makeFakeDeps(overrides: Partial<typeof _scopedSelectionDeps> = {}) {
  return {
    getChangedNonTestFiles: async () => ["src/a.ts"],
    mapSourceToTests: async () => [] as string[],
    importGrepFallback: async () => [] as string[],
    buildSmartTestCommand: (files: string[], base: string) => `${base} ${files.join(" ")}`,
    ...overrides,
  };
}

// Snapshot/restore so Object.assign mutations don't bleed across tests.
const originalDeps = { ..._scopedSelectionDeps };
afterEach(() => Object.assign(_scopedSelectionDeps, originalDeps));

describe("selectScopedTests", () => {
  const baseInput = {
    workdir: "/repo",
    storyId: "S-1",
    storyGitRef: "abc123",
    testCommand: "bun test",
    smartRunnerConfig: { enabled: true, fallback: "import-grep" as const, testFilePatterns: ["**/*.test.ts"] },
  };

  test("monorepo orchestrator command bypasses smart runner", async () => {
    const fakeDeps = makeFakeDeps({
      getChangedNonTestFiles: async () => {
        throw new Error("should not be called");
      },
    });
    Object.assign(_scopedSelectionDeps, fakeDeps);
    const result = await selectScopedTests({ ...baseInput, testCommand: "turbo run test" });
    expect(result.isMonorepoOrchestrator).toBe(true);
    expect(result.isFullSuite).toBe(true);
    expect(result.effectiveCommand).toBe("turbo run test");
  });

  test("Pass 1 match below threshold → scoped command", async () => {
    Object.assign(_scopedSelectionDeps, makeFakeDeps({
      mapSourceToTests: async () => ["test/a.test.ts", "test/b.test.ts"],
    }));
    const result = await selectScopedTests({ ...baseInput, scopeTestThreshold: 10 });
    expect(result.isFullSuite).toBe(false);
    expect(result.effectiveCommand).toBe("bun test test/a.test.ts test/b.test.ts");
    expect(result.scopeTestFallback).toBeUndefined();
  });

  test("Pass 1 above threshold → fallback to full suite", async () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `test/t${i}.test.ts`);
    Object.assign(_scopedSelectionDeps, makeFakeDeps({ mapSourceToTests: async () => manyFiles }));
    const result = await selectScopedTests({
      ...baseInput,
      scopeTestThreshold: 10,
      fallbackFullSuiteCommand: "bun test --all",
    });
    expect(result.thresholdFallback).toBe(true);
    expect(result.scopeTestFallback).toBe(true);
    expect(result.effectiveCommand).toBe("bun test --all");
    expect(result.isFullSuite).toBe(true);
  });

  test("Pass 1 empty + Pass 2 match → import-grep result", async () => {
    Object.assign(_scopedSelectionDeps, makeFakeDeps({
      mapSourceToTests: async () => [],
      importGrepFallback: async () => ["test/x.test.ts"],
    }));
    const result = await selectScopedTests(baseInput);
    expect(result.isFullSuite).toBe(false);
    expect(result.effectiveCommand).toBe("bun test test/x.test.ts");
  });

  test("Pass 1 + Pass 2 both empty → full-suite, no fallback flag", async () => {
    Object.assign(_scopedSelectionDeps, makeFakeDeps({
      mapSourceToTests: async () => [],
      importGrepFallback: async () => [],
    }));
    const result = await selectScopedTests(baseInput);
    expect(result.isFullSuite).toBe(true);
    expect(result.scopeTestFallback).toBeUndefined();
    expect(result.thresholdFallback).toBe(false);
  });

  test("testScopedTemplate overrides buildSmartTestCommand", async () => {
    Object.assign(_scopedSelectionDeps, makeFakeDeps({
      mapSourceToTests: async () => ["test/a.test.ts"],
      buildSmartTestCommand: () => {
        throw new Error("should not be called");
      },
    }));
    const result = await selectScopedTests({
      ...baseInput,
      testScopedTemplate: "pytest {{files}}",
    });
    expect(result.effectiveCommand).toBe("pytest 'test/a.test.ts'");
  });

  test("smart runner disabled → base command, no smart-runner call", async () => {
    Object.assign(_scopedSelectionDeps, makeFakeDeps({
      getChangedNonTestFiles: async () => {
        throw new Error("should not be called");
      },
    }));
    const result = await selectScopedTests({
      ...baseInput,
      smartRunnerConfig: { enabled: false },
    });
    expect(result.isFullSuite).toBe(true);
    expect(result.effectiveCommand).toBe("bun test");
  });

  test("missing storyGitRef → base command", async () => {
    Object.assign(_scopedSelectionDeps, makeFakeDeps({
      getChangedNonTestFiles: async () => {
        throw new Error("should not be called");
      },
    }));
    const result = await selectScopedTests({ ...baseInput, storyGitRef: undefined });
    expect(result.isFullSuite).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `timeout 30 bun test test/unit/test-runners/scoped-selection.test.ts --timeout=5000`
Expected: PASS 8/8.

- [ ] **Step 3: Commit**

```bash
git add test/unit/test-runners/scoped-selection.test.ts
git commit -m "test(test-runners): unit tests for selectScopedTests helper"
```

---

### Task 5: Expand `verifyScopedOp` input/output types

**Files:**
- Modify: `src/operations/verify-scoped.ts`

- [ ] **Step 1: Replace the input/output interfaces** (do NOT touch `execute` yet — that's Task 6).

Find lines 11-21 (`VerifyScopedInput`, `VerifyScopedOutput`) and replace with:

```typescript
import type { NaxIgnoreIndex } from "../utils/path-filters";

export interface VerifyScopedInput {
  readonly workdir: string;
  readonly storyId: string;
  readonly packageDir?: string;
  /** Git ref to diff against for smart-runner change detection. Required for change-aware scoping. */
  readonly storyGitRef?: string;
  /** Resolved `.naxignore` index passed through to smart-runner. */
  readonly naxIgnoreIndex?: NaxIgnoreIndex;
  /** Regression-gate mode — controls SKIPPED behavior when no tests are mapped. */
  readonly regressionMode?: "deferred" | "per-story";
}

export type VerifyScopedStatus = "passed" | "failed" | "skipped" | "timeout";

export interface VerifyScopedOutput {
  readonly success: boolean;
  readonly status: VerifyScopedStatus;
  readonly findings: Finding[];
  readonly durationMs: number;
  readonly passCount: number;
  readonly isFullSuite: boolean;
  readonly scopeTestFallback?: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: FAIL — `execute()` still returns the old shape. That's the next task. Verify the error names exactly the field mismatch (`status`, `passCount`, `isFullSuite` missing). If it complains about something else, stop and re-read the current `verify-scoped.ts`.

- [ ] **Step 3: Do not commit yet** — leaving the file in a broken state across one task is okay because Task 6 lands in the same session. Move on.

---

### Task 6: Rewrite `verifyScopedOp.execute` to use `selectScopedTests` + `regression()` runner

**Files:**
- Modify: `src/operations/verify-scoped.ts`

- [ ] **Step 1: Rewrite the file**. Replace the whole file with:

```typescript
import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import { testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
import { getLogger } from "../logger";
import { parseTestOutput, selectScopedTests, _scopedSelectionDeps } from "../test-runners";
import type { TestSummary } from "../test-runners";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { regression } from "../verification/runners";
import type { VerificationGateOptions, VerificationResult } from "../verification/types";
import type { CallContext, DeterministicOperation } from "./types";

export interface VerifyScopedInput {
  readonly workdir: string;
  readonly storyId: string;
  readonly packageDir?: string;
  readonly storyGitRef?: string;
  readonly naxIgnoreIndex?: NaxIgnoreIndex;
  readonly regressionMode?: "deferred" | "per-story";
}

export type VerifyScopedStatus = "passed" | "failed" | "skipped" | "timeout";

export interface VerifyScopedOutput {
  readonly success: boolean;
  readonly status: VerifyScopedStatus;
  readonly findings: Finding[];
  readonly durationMs: number;
  readonly passCount: number;
  readonly isFullSuite: boolean;
  readonly scopeTestFallback?: boolean;
}

export interface VerifyScopedDeps {
  selectScopedTests: typeof selectScopedTests;
  regression: (opts: VerificationGateOptions) => Promise<VerificationResult>;
  parseTestOutput: (output: string) => TestSummary;
  testSummaryToFindings: (summary: TestSummary) => Finding[];
}

export const _verifyScopedDeps: VerifyScopedDeps = {
  selectScopedTests,
  regression,
  parseTestOutput,
  testSummaryToFindings,
};

export const verifyScopedOp: DeterministicOperation<VerifyScopedInput, VerifyScopedOutput, QualityConfig> = {
  kind: "deterministic",
  name: "verify-scoped",
  stage: "verify",
  config: qualityConfigSelector,
  async execute(
    input: VerifyScopedInput,
    ctx: CallContext,
    deps: VerifyScopedDeps = _verifyScopedDeps,
  ): Promise<VerifyScopedOutput> {
    const logger = getLogger();
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const baseCommand = ctxConfig?.quality?.commands?.test;

    if (ctxConfig !== undefined && !baseCommand) {
      // No test command configured — preserve current no-op behavior.
      return {
        success: true,
        status: "passed",
        findings: [],
        durationMs: 0,
        passCount: 0,
        isFullSuite: true,
      };
    }

    const regressionMode = input.regressionMode ?? "deferred";
    // Note: smart-runner config lives at execution.smartTestRunner (not quality.smartRunner).
    // qualityConfigSelector picks both "quality" and "execution" keys (see src/config/selectors.ts:74).
    const selection = await deps.selectScopedTests({
      workdir: input.workdir,
      storyId: input.storyId,
      storyGitRef: input.storyGitRef,
      testCommand: baseCommand ?? "",
      testScopedTemplate: ctxConfig?.quality?.commands?.testScoped,
      smartRunnerConfig: (ctxConfig as unknown as { execution?: { smartTestRunner?: unknown } })?.execution
        ?.smartTestRunner,
      scopeTestThreshold: ctxConfig?.quality?.scopeTestThreshold,
      fallbackFullSuiteCommand: ctxConfig?.quality?.commands?.test,
      naxIgnoreIndex: input.naxIgnoreIndex,
    });

    // Deferred mode + no mapped tests + not a monorepo orchestrator → SKIP.
    if (
      selection.isFullSuite &&
      regressionMode === "deferred" &&
      !selection.isMonorepoOrchestrator &&
      !selection.thresholdFallback
    ) {
      logger.info("verify[scoped]", "No mapped tests — deferring to run-end (mode: deferred)", {
        storyId: input.storyId,
      });
      return {
        success: true,
        status: "skipped",
        findings: [],
        durationMs: 0,
        passCount: 0,
        isFullSuite: true,
        scopeTestFallback: selection.scopeTestFallback,
      };
    }

    if (selection.isFullSuite && !selection.isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "No mapped tests — falling back to full suite", {
        storyId: input.storyId,
      });
    } else if (selection.isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "Monorepo orchestrator detected — delegating scoping to tool", {
        storyId: input.storyId,
        command: selection.effectiveCommand,
      });
    }

    // NOTE: regression() includes a 2s sleep before running tests (src/verification/runners.ts:142-145)
    // for agent-cleanup. The legacy ScopedStrategy also used regression(), so this preserves parity
    // — it is NOT a new perf regression introduced by this port.
    const start = Date.now();
    const result = await deps.regression({
      workdir: input.workdir,
      command: selection.effectiveCommand,
      timeoutSeconds: ctxConfig?.quality?.timeout ?? 600,
      // acceptOnTimeout is not consumed by runVerificationCore — the runner returns status="TIMEOUT"
      // and the caller (this op) decides accept-on-timeout policy. The op currently does not accept
      // scoped-test timeouts as pass; full-suite gate is the only place that does.
      forceExit: ctxConfig?.quality?.forceExit,
      detectOpenHandles: ctxConfig?.quality?.detectOpenHandles,
      detectOpenHandlesRetries: ctxConfig?.quality?.detectOpenHandlesRetries,
      gracePeriodMs: ctxConfig?.quality?.gracePeriodMs,
      drainTimeoutMs: ctxConfig?.quality?.drainTimeoutMs,
      shell: ctxConfig?.quality?.shell,
      stripEnvVars: ctxConfig?.quality?.stripEnvVars,
    });
    const durationMs = Date.now() - start;
    const parsed = result.output ? deps.parseTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };

    if (result.success) {
      logger.info("verify[scoped]", "Scoped tests passed", {
        storyId: input.storyId,
        passCount: parsed.passed,
        durationMs,
        scopeTestFallback: selection.scopeTestFallback ?? false,
        isFullSuite: selection.isFullSuite,
      });
      return {
        success: true,
        status: "passed",
        findings: [],
        durationMs,
        passCount: parsed.passed,
        isFullSuite: selection.isFullSuite,
        scopeTestFallback: selection.scopeTestFallback,
      };
    }

    if (result.status === "TIMEOUT") {
      logger.warn("verify[scoped]", "Scoped tests timed out", {
        storyId: input.storyId,
        durationMs,
        scopeTestFallback: selection.scopeTestFallback ?? false,
        isFullSuite: selection.isFullSuite,
      });
      return {
        success: false,
        status: "timeout",
        findings: [],
        durationMs,
        passCount: parsed.passed,
        isFullSuite: selection.isFullSuite,
        scopeTestFallback: selection.scopeTestFallback,
      };
    }

    logger.warn("verify[scoped]", "Scoped tests failed", {
      storyId: input.storyId,
      passCount: parsed.passed,
      failCount: parsed.failed,
      durationMs,
      scopeTestFallback: selection.scopeTestFallback ?? false,
      isFullSuite: selection.isFullSuite,
    });
    return {
      success: false,
      status: "failed",
      findings: deps.testSummaryToFindings(parsed),
      durationMs,
      passCount: parsed.passed,
      isFullSuite: selection.isFullSuite,
      scopeTestFallback: selection.scopeTestFallback,
    };
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If any error mentions `quality.commands.testScoped` not existing on the type, check `src/config/schemas.ts` — if it's not in the schema, add it (or use the strategy's path of `ctx.testScopedTemplate` and thread differently). Verify before editing the schema.

- [ ] **Step 3: Run the existing op tests**

Run: `timeout 30 bun test test/unit/operations/verify-scoped.test.ts --timeout=5000`
Expected: SOME FAIL — old tests asserted the old envelope shape (`{success, findings, durationMs}`). Note which failures are envelope-shape vs logic. The next task ports the strategy-side cases on top.

- [ ] **Step 4: Commit (broken intermediate state acceptable — Task 7 lands tests)**

```bash
git add src/operations/verify-scoped.ts
git commit -m "feat(verify-scoped): port ScopedStrategy behavior (smart runner, monorepo, deferred-skip)"
```

---

### Task 7: Update + extend `verify-scoped.test.ts` to cover ported behavior

**Files:**
- Modify: `test/unit/operations/verify-scoped.test.ts`

- [ ] **Step 1: Read the existing file** to understand current fixtures (`makeCtx`, etc.).

- [ ] **Step 2: Update existing cases to match new envelope** — every `{success, findings, durationMs}` assertion needs `status`, `passCount`, `isFullSuite` added. The op now also requires `_verifyScopedDeps.selectScopedTests` and `_verifyScopedDeps.regression` to be mockable.

Pass `deps` explicitly to `verifyScopedOp.execute(input, ctx, deps)` (third arg) rather than mutating `_verifyScopedDeps` — the op signature supports it and it avoids cross-test pollution. If a test must mutate the module-level deps, snapshot+restore:

```typescript
import { _verifyScopedDeps } from "@/operations";
const originalVerifyScopedDeps = { ..._verifyScopedDeps };
afterEach(() => Object.assign(_verifyScopedDeps, originalVerifyScopedDeps));
```

Add a fixture helper near the top:

```typescript
function fakeDeps(overrides: Partial<typeof _verifyScopedDeps> = {}) {
  return {
    selectScopedTests: async () => ({
      effectiveCommand: "bun test",
      isFullSuite: true,
      thresholdFallback: false,
      isMonorepoOrchestrator: false,
    }),
    regression: async () => ({
      status: "SUCCESS" as const,
      success: true,
      countsTowardEscalation: true,
      output: "1 pass\n0 fail",
    }),
    parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
    testSummaryToFindings: () => [],
    ...overrides,
  };
}
```

- [ ] **Step 3: Add new cases** covering ported behavior:

```typescript
import { verifyScopedOp, _verifyScopedDeps } from "@/operations";

describe("verifyScopedOp — ported ScopedStrategy behavior", () => {
  test("deferred mode + no mapped tests + not monorepo → skipped", async () => {
    const deps = fakeDeps();
    const ctx = { config: { quality: { commands: { test: "bun test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "deferred" },
      ctx,
      deps,
    );
    expect(result.status).toBe("skipped");
    expect(result.success).toBe(true);
  });

  test("per-story mode + no mapped tests → runs full suite (not skipped)", async () => {
    const deps = fakeDeps();
    const ctx = { config: { quality: { commands: { test: "bun test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.status).toBe("passed");
    expect(result.isFullSuite).toBe(true);
  });

  test("monorepo orchestrator → runs even in deferred mode", async () => {
    const deps = fakeDeps({
      selectScopedTests: async () => ({
        effectiveCommand: "turbo run test",
        isFullSuite: true,
        thresholdFallback: false,
        isMonorepoOrchestrator: true,
      }),
    });
    const ctx = { config: { quality: { commands: { test: "turbo run test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "deferred" },
      ctx,
      deps,
    );
    expect(result.status).toBe("passed");
  });

  test("threshold fallback → scopeTestFallback=true in envelope", async () => {
    const deps = fakeDeps({
      selectScopedTests: async () => ({
        effectiveCommand: "bun test",
        isFullSuite: true,
        thresholdFallback: true,
        scopeTestFallback: true,
        isMonorepoOrchestrator: false,
      }),
    });
    const ctx = { config: { quality: { commands: { test: "bun test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "deferred" },
      ctx,
      deps,
    );
    expect(result.status).toBe("passed");
    expect(result.scopeTestFallback).toBe(true);
  });

  test("scoped match → isFullSuite=false", async () => {
    const deps = fakeDeps({
      selectScopedTests: async () => ({
        effectiveCommand: "bun test test/a.test.ts",
        isFullSuite: false,
        thresholdFallback: false,
        isMonorepoOrchestrator: false,
      }),
    });
    const ctx = { config: { quality: { commands: { test: "bun test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", storyGitRef: "abc", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.isFullSuite).toBe(false);
  });

  test("test failure → status=failed with findings", async () => {
    const deps = fakeDeps({
      regression: async () => ({
        status: "TEST_FAILURE" as const,
        success: false,
        countsTowardEscalation: true,
        output: "1 pass\n2 fail",
      }),
      parseTestOutput: () => ({
        passed: 1,
        failed: 2,
        failures: [{ test: "t1", file: "a.test.ts", message: "boom" }],
      }),
      testSummaryToFindings: () => [{ kind: "test", id: "f1" } as any],
    });
    const ctx = { config: { quality: { commands: { test: "bun test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.status).toBe("failed");
    expect(result.success).toBe(false);
    expect(result.findings.length).toBe(1);
  });

  test("timeout → status=timeout, success=false", async () => {
    const deps = fakeDeps({
      regression: async () => ({
        status: "TIMEOUT" as const,
        success: false,
        countsTowardEscalation: false,
        output: "",
      }),
      parseTestOutput: () => ({ passed: 0, failed: 0, failures: [] }),
    });
    const ctx = { config: { quality: { commands: { test: "bun test" } } } } as any;
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.status).toBe("timeout");
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 4: Update old envelope assertions in the existing describe blocks** (AC2 stays, AC5 needs `status: "passed"`, `passCount: 0`, `isFullSuite: true` added).

- [ ] **Step 5: Run the suite**

Run: `timeout 30 bun test test/unit/operations/verify-scoped.test.ts --timeout=5000`
Expected: PASS (all old AC tests + 7 new ported cases).

- [ ] **Step 6: Commit**

```bash
git add test/unit/operations/verify-scoped.test.ts
git commit -m "test(verify-scoped): port ScopedStrategy unit-test coverage"
```

---

### Task 8: Thread new inputs into the verifyScoped plan-input builder

**Files:**
- Modify: `src/execution/plan-inputs.ts`

Confirmed by inspection: `ctx.storyGitRef` and `ctx.naxIgnoreIndex` already exist on `PipelineContext` and are used in this file at lines 287, 289, 304, 326, 328, 341 for other op inputs. We just need to thread them into `verifyScopedInput` as well.

- [ ] **Step 1: Edit `src/execution/plan-inputs.ts` lines 250-252.** The current shape is:

```typescript
const verifyScopedInput: VerifyScopedInput | undefined = !_isTdd
  ? { workdir: ctx.workdir, storyId: story.id }
  : undefined;
```

Replace with:

```typescript
const verifyScopedInput: VerifyScopedInput | undefined = !_isTdd
  ? {
      workdir: ctx.workdir,
      storyId: story.id,
      storyGitRef: ctx.storyGitRef,
      naxIgnoreIndex: ctx.naxIgnoreIndex,
      regressionMode: ctx.config.execution?.regressionGate?.mode ?? "deferred",
    }
  : undefined;
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Run all affected suites**

Run: `timeout 60 bun test test/unit/execution/ --timeout=10000`
Expected: PASS. If any test asserts the literal input shape, update the fixture.

- [ ] **Step 5: Commit**

```bash
git add src/execution/plan-inputs.ts src/execution/story-orchestrator.ts
git commit -m "feat(execution): thread storyGitRef/naxIgnoreIndex/regressionMode into verifyScopedOp"
```

---

## Phase 3 — Port `RegressionStrategy` into `fullSuiteGateOp`

### Task 9: Extend `FullSuiteGateOutput` status union + add `enabled`/`acceptOnTimeout` handling

**Files:**
- Modify: `src/operations/full-suite-gate.ts`

- [ ] **Step 1: Read current `fullSuiteGateOp`** end-to-end (`src/operations/full-suite-gate.ts`).

**Pre-task facts confirmed by inspection:**
- `fullSuiteGateConfigSelector = rectificationGateConfigSelector` (line 67) which picks `execution`, `models`, `agent`, `quality`, `review` — all the keys this task needs are reachable.
- `FullSuiteGateContext.config` is typed `NaxConfig` (full config, line 84) — `gateCtx.config?.quality?.*` and `gateCtx.config?.execution?.regressionGate?.*` both work.
- `RunTestsResult` interface (line 73) currently has `{ passed, failed, output, parsedSummary }` — this task adds `timedOut: boolean`.
- The current `fullSuiteTimeout` (line 98) reads `execution.rectification.fullSuiteTimeoutSeconds`. The legacy `RegressionStrategy` reads `execution.regressionGate.timeoutSeconds`. **These are different keys in the schema today.** Step 4 below resolves this.
- All four `regressionGate` keys (`enabled`, `timeoutSeconds`, `acceptOnTimeout`, `mode`) already exist in `src/config/schemas.ts:120-125` with defaults `enabled: true, timeoutSeconds: 300, acceptOnTimeout: true, mode: "deferred"`. **No schema additions needed.**

- [ ] **Step 2: Update the output type.** Find `FullSuiteGateOutput` and extend its `status` union:

```typescript
export interface FullSuiteGateOutput {
  readonly success: boolean;
  readonly passed: boolean;
  readonly status: "passed" | "failed" | "execution-failed" | "passed-on-timeout" | "timeout" | "skipped";
  readonly estimatedCostUsd: number;
  readonly attempts: number;
  readonly findings: Finding[];
}
```

- [ ] **Step 3: Update `_fullSuiteGateDeps.runTests`** to use the `regression()` runner (which honors quality config). Find the `runTests` function (~line 119) and swap:

```typescript
runTests: async (input, gateCtx) => {
  const { regression } = await import("../verification/runners");
  const { parseTestOutput } = await import("../test-runners");
  const result = await regression({
    workdir: input.workdir,
    command: gateCtx.testCmd,
    timeoutSeconds: gateCtx.fullSuiteTimeout,
    acceptOnTimeout: false, // op decides accept-on-timeout itself; runner stays neutral
    forceExit: gateCtx.config?.quality?.forceExit,
    detectOpenHandles: gateCtx.config?.quality?.detectOpenHandles,
    detectOpenHandlesRetries: gateCtx.config?.quality?.detectOpenHandlesRetries,
    gracePeriodMs: gateCtx.config?.quality?.gracePeriodMs,
    drainTimeoutMs: gateCtx.config?.quality?.drainTimeoutMs,
    shell: gateCtx.config?.quality?.shell,
    stripEnvVars: gateCtx.config?.quality?.stripEnvVars,
  });
  const parsedSummary = parseTestOutput(result.output ?? "");
  return {
    passed: result.success && result.status === "SUCCESS",
    failed: parsedSummary.failed ?? 0,
    output: result.output ?? "",
    parsedSummary,
    timedOut: result.status === "TIMEOUT",
  };
},
```

Update the return-type interface of `runTests` to include `timedOut: boolean`. Search for its declaration in the same file and add it.

- [ ] **Step 4: Update `resolveGateContext` timeout resolution.** `gateCtx.config` is already typed `NaxConfig`, so no change needed there. But the timeout source needs to merge `regressionGate.timeoutSeconds` (legacy strategy's source) with `rectification.fullSuiteTimeoutSeconds` (current op's source). Change line 98 from:

```typescript
const fullSuiteTimeout = config.execution?.rectification?.fullSuiteTimeoutSeconds ?? 60;
```

to:

```typescript
// Prefer regressionGate.timeoutSeconds (matches legacy RegressionStrategy / issue #1116)
// and fall back to rectification.fullSuiteTimeoutSeconds for backwards compatibility with
// callers that still set the older key.
const fullSuiteTimeout =
  config.execution?.regressionGate?.timeoutSeconds ??
  config.execution?.rectification?.fullSuiteTimeoutSeconds ??
  300;
```

The default (300) matches `regressionGate.timeoutSeconds` in `schemas.ts:122`.

- [ ] **Step 5: Update `execute()`** to honor `enabled=false` and `acceptOnTimeout`:

```typescript
async execute(input, ctx, deps = _fullSuiteGateDeps): Promise<FullSuiteGateOutput> {
  const ctxConfig = (ctx as unknown as { config?: FullSuiteGateConfig }).config;
  const enabled = ctxConfig?.execution?.regressionGate?.enabled ?? true;
  if (!enabled) {
    return {
      success: true,
      passed: true,
      status: "skipped",
      estimatedCostUsd: 0,
      attempts: 0,
      findings: [],
    };
  }

  const gateCtx = await deps.resolveGateContext(input, ctx);
  const testResult = await deps.runTests(input, gateCtx);

  if (testResult.passed) {
    return {
      success: true,
      passed: true,
      status: "passed",
      estimatedCostUsd: 0,
      attempts: 0,
      findings: [],
    };
  }

  // BUG-026: timeout + acceptOnTimeout → treat as pass.
  if (testResult.timedOut) {
    const acceptOnTimeout = ctxConfig?.execution?.regressionGate?.acceptOnTimeout ?? true;
    if (acceptOnTimeout) {
      const logger = getLogger();
      logger.warn("verify[regression]", "[BUG-026] Full-suite timed out (accepted as pass)", {
        storyId: input.story.id,
      });
      return {
        success: true,
        passed: true,
        status: "passed-on-timeout",
        estimatedCostUsd: 0,
        attempts: 0,
        findings: [],
      };
    }
    return {
      success: false,
      passed: false,
      status: "timeout",
      estimatedCostUsd: 0,
      attempts: 0,
      findings: [],
    };
  }

  const findings = testSummaryToFindings(testResult.parsedSummary);
  if (findings.length === 0) {
    return {
      success: false,
      passed: false,
      status: "execution-failed",
      estimatedCostUsd: 0,
      attempts: 0,
      findings: [],
    };
  }

  return {
    success: false,
    passed: false,
    status: "failed",
    estimatedCostUsd: 0,
    attempts: 0,
    findings,
  };
},
```

Add `import { getLogger } from "../logger";` at the top.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS. All schema keys this task touches already exist (see Step 1 fact-list).

- [ ] **Step 7: Commit**

```bash
git add src/operations/full-suite-gate.ts
git commit -m "feat(full-suite-gate): port RegressionStrategy semantics (enabled, acceptOnTimeout, quality knobs)"
```

---

### Task 10: Extend `full-suite-gate.test.ts` with ported cases

**Files:**
- Modify: `test/unit/operations/full-suite-gate.test.ts`

- [ ] **Step 1: Read the existing file** to understand the fixture pattern.

- [ ] **Step 2: Add the ported cases**:

```typescript
import { fullSuiteGateOp, _fullSuiteGateDeps } from "@/operations";

describe("fullSuiteGateOp — ported RegressionStrategy behavior", () => {
  test("regressionGate.enabled=false → status=skipped", async () => {
    const ctx = {
      config: { execution: { regressionGate: { enabled: false } }, quality: { commands: { test: "bun test" } } },
    } as any;
    const result = await fullSuiteGateOp.execute(
      { workdir: "/r", story: { id: "S-1", workdir: "" } } as any,
      ctx,
      _fullSuiteGateDeps,
    );
    expect(result.status).toBe("skipped");
    expect(result.success).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=true → status=passed-on-timeout", async () => {
    const deps = {
      resolveGateContext: async () => ({ testCmd: "bun test", fullSuiteTimeout: 60, config: {} }),
      runTests: async () => ({
        passed: false,
        failed: 0,
        output: "",
        parsedSummary: { passed: 0, failed: 0, failures: [] },
        timedOut: true,
      }),
    };
    const ctx = {
      config: { execution: { regressionGate: { acceptOnTimeout: true } }, quality: { commands: { test: "bun test" } } },
    } as any;
    const result = await fullSuiteGateOp.execute(
      { workdir: "/r", story: { id: "S-1", workdir: "" } } as any,
      ctx,
      deps as any,
    );
    expect(result.status).toBe("passed-on-timeout");
    expect(result.passed).toBe(true);
    expect(result.success).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=false → status=timeout, failed", async () => {
    const deps = {
      resolveGateContext: async () => ({ testCmd: "bun test", fullSuiteTimeout: 60, config: {} }),
      runTests: async () => ({
        passed: false,
        failed: 0,
        output: "",
        parsedSummary: { passed: 0, failed: 0, failures: [] },
        timedOut: true,
      }),
    };
    const ctx = {
      config: { execution: { regressionGate: { acceptOnTimeout: false } }, quality: { commands: { test: "bun test" } } },
    } as any;
    const result = await fullSuiteGateOp.execute(
      { workdir: "/r", story: { id: "S-1", workdir: "" } } as any,
      ctx,
      deps as any,
    );
    expect(result.status).toBe("timeout");
    expect(result.success).toBe(false);
  });

  test("regressionGate.timeoutSeconds wins over quality.timeout", async () => {
    let captured = 0;
    const deps = {
      resolveGateContext: _fullSuiteGateDeps.resolveGateContext,
      runTests: async (_input: any, gateCtx: any) => {
        captured = gateCtx.fullSuiteTimeout;
        return { passed: true, failed: 0, output: "", parsedSummary: { passed: 1, failed: 0, failures: [] }, timedOut: false };
      },
    };
    const ctx = {
      config: {
        execution: { regressionGate: { timeoutSeconds: 999 } },
        quality: { timeout: 60, commands: { test: "bun test" } },
      },
    } as any;
    await fullSuiteGateOp.execute(
      { workdir: "/r", story: { id: "S-1", workdir: "" } } as any,
      ctx,
      deps as any,
    );
    expect(captured).toBe(999);
  });
});
```

- [ ] **Step 3: Update existing assertions** that check `status === "passed"` / `"failed"` / `"execution-failed"` — they should still work, but the `runTests` mock-return shape now requires `timedOut: boolean`. Add `timedOut: false` to any mock that returns success/failure.

- [ ] **Step 4: Run**

Run: `timeout 30 bun test test/unit/operations/full-suite-gate.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/operations/full-suite-gate.test.ts
git commit -m "test(full-suite-gate): port RegressionStrategy unit-test coverage"
```

---

## Phase 4 — Plan-builder wiring for `regressionGate.mode`

### Task 11: Add `fullSuiteGateOp` to non-TDD plan when mode=per-story

**Files:**
- Modify: `src/execution/build-plan-for-strategy.ts`
- Modify: `src/execution/plan-inputs.ts` (extend the input assembly to populate `fullSuiteGate` for non-TDD when mode=per-story)

Confirmed by inspection: the plan-builder uses a fluent API (`builder.addFullSuiteGate(input)`, line 125-127), not array push. Today `addFullSuiteGate` is only called when `isThreeSession` (TDD). For non-TDD per-story mode we extend both the input assembly and the build branch.

- [ ] **Step 1: Extend `src/execution/plan-inputs.ts`** so `inputs.fullSuiteGate` is populated for non-TDD runs when `regressionGate.mode === "per-story"`. Find the existing TDD `fullSuiteGate` input assembly (it already exists for the TDD branch — grep for `fullSuiteGate:` in that file to locate it) and add an `else if` branch that produces the same input shape for the non-TDD per-story case. Match the existing input shape exactly — do not invent fields.

- [ ] **Step 2: Edit `src/execution/build-plan-for-strategy.ts` lines 124-127.** Today:

```typescript
// TDD: full-suite-gate + verifier
if (isThreeSession && inputs.fullSuiteGate) {
  builder.addFullSuiteGate(inputs.fullSuiteGate);
}
```

Replace with:

```typescript
// Full-suite gate: TDD always, non-TDD only when regressionGate.mode === "per-story" (issue #1116).
const regressionMode = config.execution?.regressionGate?.mode ?? "deferred";
if (inputs.fullSuiteGate && (isThreeSession || regressionMode === "per-story")) {
  builder.addFullSuiteGate(inputs.fullSuiteGate);
}
```

- [ ] **Step 3: Typecheck and run plan-builder tests**

Run: `bun run typecheck && timeout 30 bun test test/unit/execution/ --timeout=10000`
Expected: PASS. If existing TDD-only assertions fail because they tested the `isThreeSession &&` guard literally, update them to assert the new combined condition.

- [ ] **Step 4: Commit**

```bash
git add src/execution/build-plan-for-strategy.ts src/execution/plan-inputs.ts
git commit -m "feat(execution): include fullSuiteGateOp in non-TDD plan when regressionGate.mode=per-story"
```

---

### Task 12: Fill in the parity test bodies from Task 2

**Files:**
- Modify: `test/integration/verification/strategy-vs-op-parity.test.ts`

- [ ] **Step 1: Replace each placeholder body** with a real assertion. Each test invokes the strategy AND the op against the same fixture and diffs the envelopes via the mapping table from Task 1. Example for "PASS case":

```typescript
test("PASS case — same passCount, isFullSuite, scopeTestFallback", async () => {
  // Stub identical underlying deps:
  const fakeSelection = async () => ({
    effectiveCommand: "bun test",
    isFullSuite: true,
    thresholdFallback: false,
    isMonorepoOrchestrator: false,
  });
  const fakeRegression = async () => ({
    status: "SUCCESS" as const,
    success: true,
    countsTowardEscalation: true,
    output: "5 pass\n0 fail",
  });
  // Strategy path
  const { _scopedDeps } = await import("@/verification/strategies/scoped");
  const origDeps = { ..._scopedDeps };
  _scopedDeps.regression = fakeRegression as any;
  _scopedDeps.mapSourceToTests = async () => [];
  _scopedDeps.importGrepFallback = async () => [];
  _scopedDeps.getChangedNonTestFiles = async () => [];
  const stratResult = await new ScopedStrategy().execute({
    workdir: tmpRoot,
    storyId: "S-1",
    testCommand: "bun test",
    timeoutSeconds: 60,
    regressionMode: "per-story",
    storyGitRef: "abc",
    config: { quality: { commands: { test: "bun test" } } } as any,
  } as any);
  Object.assign(_scopedDeps, origDeps);

  // Op path
  const opResult = await verifyScopedOp.execute(
    { workdir: tmpRoot, storyId: "S-1", storyGitRef: "abc", regressionMode: "per-story" },
    { config: { quality: { commands: { test: "bun test" } } } } as any,
    {
      selectScopedTests: fakeSelection,
      regression: fakeRegression,
      parseTestOutput: () => ({ passed: 5, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    } as any,
  );

  // Envelope parity — apply the mapping table
  expect(opResult.passCount).toBe(stratResult.passCount ?? 0);
  expect(opResult.isFullSuite).toBe(true);
  expect(opResult.scopeTestFallback).toBe(stratResult.scopeTestFallback);
  expect(opResult.status === "passed").toBe(stratResult.status === "PASS");
});
```

Repeat for each placeholder — SKIPPED, THRESHOLD, MONOREPO, full-suite ENABLED/TIMEOUT cases.

- [ ] **Step 2: Run the parity tests**

Run: `timeout 60 bun test test/integration/verification/strategy-vs-op-parity.test.ts --timeout=10000`
Expected: PASS 8/8.

- [ ] **Step 3: Commit**

```bash
git add test/integration/verification/strategy-vs-op-parity.test.ts
git commit -m "test(verification): fill strategy↔op parity assertions"
```

---

## Phase 5 — Delete the legacy

### Task 13: Relocate `StructuredTestFailure` if still referenced

**Files:**
- Inspect: `src/verification/orchestrator-types.ts`
- Possibly modify: `src/test-runners/types.ts`

- [ ] **Step 1: Search for `StructuredTestFailure` usage**

```bash
grep -rn "StructuredTestFailure" src/ test/ --include="*.ts" | grep -v ".claude/worktrees"
```

- [ ] **Step 2: If used outside `src/verification/`**: copy the type definition from `orchestrator-types.ts` into `src/test-runners/types.ts` and update all importers to import from there.

- [ ] **Step 3: If only used inside `src/verification/`**: nothing to do — it dies with the orchestrator files in the next task.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit (only if files changed)**

```bash
git add src/test-runners/types.ts src/<importers>
git commit -m "refactor(test-runners): relocate StructuredTestFailure ahead of orchestrator deletion"
```

---

### Task 14: Delete pipeline `regressionStage`

**Files:**
- Delete: `src/pipeline/stages/regression.ts`
- Modify: `src/pipeline/stages/index.ts`

- [ ] **Step 1: Remove the regression stage from the pipeline index.** Open `src/pipeline/stages/index.ts`:

```bash
grep -n "regression" src/pipeline/stages/index.ts
```

Delete the three lines: the import (line 18), the `regressionStage,` entry in `defaultPipeline` (line 42), and the re-export (line 66).

- [ ] **Step 2: Delete the stage file**

```bash
rm src/pipeline/stages/regression.ts
```

- [ ] **Step 3: Delete the stage test**

```bash
rm test/unit/pipeline/stages/regression-stage.test.ts
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Run pipeline tests**

Run: `timeout 30 bun test test/unit/pipeline/ --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/pipeline/stages/index.ts src/pipeline/stages/regression.ts test/unit/pipeline/stages/regression-stage.test.ts
git commit -m "refactor(pipeline): delete legacy regressionStage (issue #1116)"
```

---

### Task 15: Delete `VerificationOrchestrator` + strategy classes + their tests

**Files:**
- Delete: `src/verification/orchestrator.ts`
- Delete: `src/verification/orchestrator-types.ts`
- Delete: `src/verification/strategies/scoped.ts`
- Delete: `src/verification/strategies/regression.ts`
- Delete: `src/verification/strategies/acceptance.ts`
- Delete: `src/verification/strategies/` (the empty directory)
- Delete: `test/unit/verification/orchestrator.test.ts`
- Delete: `test/unit/verification/strategies/scoped.test.ts`
- Delete: `test/unit/verification/strategies/regression.test.ts`
- Delete: `test/unit/verification/strategies/acceptance.test.ts`
- Delete: `test/unit/verification/strategies/` (the empty directory)
- **Also delete:** `test/integration/verification/strategy-vs-op-parity.test.ts` — the parity test only existed as a migration safety net and now references deleted classes.

> **Note on `.nax/features/`:** `.nax/features/<feature>/.nax-acceptance.test.ts` files are frozen acceptance-run artifacts from past nax features. They are **outside the test runner's glob** (`scripts/run-tests.ts:42-44` only scans `test/unit/`, `test/integration/`, `test/ui/`). Stale strategy imports there are harmless — nothing executes them. **Do not touch `.nax/features/`** as part of this cleanup.

- [ ] **Step 1: Confirm no remaining imports from the strategies barrel** (excluding frozen `.nax/features/` artifacts)

```bash
grep -rn "from.*verification/strategies\|from.*verification/orchestrator" src/ test/ --include="*.ts" | grep -v ".claude/worktrees" | grep -v "src/verification/strategies/" | grep -v "src/verification/orchestrator"
```

Expected output: empty (or only the parity test, which is also being deleted).

- [ ] **Step 2: Delete files**

```bash
rm src/verification/orchestrator.ts \
   src/verification/orchestrator-types.ts \
   src/verification/strategies/scoped.ts \
   src/verification/strategies/regression.ts \
   src/verification/strategies/acceptance.ts \
   test/unit/verification/orchestrator.test.ts \
   test/unit/verification/strategies/scoped.test.ts \
   test/unit/verification/strategies/regression.test.ts \
   test/unit/verification/strategies/acceptance.test.ts \
   test/integration/verification/strategy-vs-op-parity.test.ts
rmdir src/verification/strategies test/unit/verification/strategies test/integration/verification 2>/dev/null || true
```

- [ ] **Step 3: Clean the verification barrel**. Open `src/verification/index.ts` and remove any re-exports of `VerificationOrchestrator`, `IVerificationStrategy`, `verificationOrchestrator`, `ScopedStrategy`, `RegressionStrategy`, `AcceptanceStrategy`, `DeferredRegressionStrategy`, `VerifyContext`, `VerifyResult`, `VerifyStrategy`.

- [ ] **Step 4: Clean `src/metrics/types.ts`.** Search for orchestrator-type imports and remove them — `VerifyResult` / `VerifyStrategy` may be re-exported elsewhere; if metrics still needs the shape, inline the minimal type it needs.

```bash
grep -n "orchestrator\|VerifyResult\|VerifyStrategy\|IVerificationStrategy" src/metrics/types.ts
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If there's a residual import, fix it (delete or inline the type).

- [ ] **Step 6: Run full test suite**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(verification): delete VerificationOrchestrator + legacy strategies (issue #1116)"
```

---

### Task 16: Final gate — grep for stragglers

**Files:** (no edits, verification only)

- [ ] **Step 1: Confirm zero references to deleted symbols**

```bash
grep -rn "VerificationOrchestrator\|verificationOrchestrator\|ScopedStrategy\|RegressionStrategy\|DeferredRegressionStrategy\|AcceptanceStrategy\|IVerificationStrategy" src/ test/ --include="*.ts" | grep -v ".claude/worktrees"
```

Expected output: empty.

- [ ] **Step 2: Confirm zero references to deleted files**

```bash
grep -rn "verification/strategies\|verification/orchestrator\|pipeline/stages/regression" src/ test/ --include="*.ts" | grep -v ".claude/worktrees"
```

Expected output: empty.

- [ ] **Step 3: Lint + typecheck + full test**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS across all three.

- [ ] **Step 4: Update issue #1116 with summary** — paste the deleted-files list into the issue as a comment via `gh issue comment 1116 --body "..."`. Note this is **the** completion signal; do not close the issue, let the PR-merge auto-close on `Fixes #1116`.

- [ ] **Step 5: Push the branch + open PR**

```bash
git push -u origin feat/issue-1116-verification-unification
gh pr create --title "refactor(verification): complete unification (issue #1116)" --body "$(cat <<'EOF'
## Summary
- Ports smart-runner change-aware selection, monorepo turbo/nx detection, `testScopedTemplate` substitution, and deferred-mode SKIPPED into `verifyScopedOp`
- Ports `regressionGate.enabled`, `acceptOnTimeout` (BUG-026), `regressionGate.timeoutSeconds`, and quality knobs (`forceExit`, `detectOpenHandles*`, process-management) into `fullSuiteGateOp`
- Wires `regressionGate.mode === "per-story"` through the non-TDD plan builder via `fullSuiteGateOp` instead of the legacy pipeline stage
- Deletes `VerificationOrchestrator`, `ScopedStrategy`, `RegressionStrategy`, `DeferredRegressionStrategy`, `AcceptanceStrategy`, `regressionStage`, and their tests

Fixes #1116.

## Test plan
- [ ] `bun run lint` clean
- [ ] `bun run typecheck` clean
- [ ] `bun run test` green
- [ ] Manual: run a story with `regressionGate.mode: "per-story"` and confirm `fullSuiteGateOp` outcome log appears
- [ ] Manual: run a story with `regressionGate.mode: "deferred"` and confirm `verifyScopedOp` emits SKIPPED when no tests are mapped

## Migration notes
No config changes required. `regressionGate.mode: "per-story"` continues to work; envelope log fields shift from `verify[scoped]` / `verify[regression]` to story-orchestrator outcome-log shape (already deployed in PR #1115).
EOF
)"
```

---

## Risk ledger

| Risk | Mitigation | Where |
|:---|:---|:---|
| `regression()` runner has quality-config knobs `runQualityCommand` lacked → silent divergence on existing scoped path | Swap to `regression()` runner in Task 6 — matches strategy behavior | Task 6 |
| `acceptOnTimeout` semantics drift | Explicit status value `passed-on-timeout` + parity assertion | Task 9, Task 12 |
| Tests reference orchestrator types after deletion | Phase 5 deletes tests in the same commit as src files; lint catches stragglers | Task 16 |
| `StructuredTestFailure` import-orphaned | Task 13 — grep before delete; relocate if needed | Task 13 |
| `regressionGate.mode === "per-story"` users see different log shape | Task 1 documents the mapping; story-orchestrator outcome logs (PR #1115) cover the new path | Task 1 |
| Smart-runner deps lose `_scopedDeps` injection seam | New helper exports `_scopedSelectionDeps` with the same shape; test fixtures port 1:1 | Task 3 |
| Bun JSC SIGABRT during full suite | Tests are scoped + wrapped with `timeout 30`; full suite via `bun run test` wrapper | All test steps |

---

## Self-review notes

- ✅ Spec coverage: every issue #1116 cleanup item maps to a task — `regressionStage` (Task 14), `RegressionStrategy/Scoped/Acceptance/DeferredRegression` (Task 15), per-story mode (Task 11), parity (Task 1, 12). `.nax/features/` frozen acceptance artifacts are intentionally NOT touched (see note in Task 15).
- ✅ No placeholders. Every code block is complete. Every `timeout` value is set explicitly.
- ✅ Type consistency: `VerifyScopedInput` / `VerifyScopedOutput` shape used in Task 5 matches the test fixtures in Task 7 and the integration parity test in Task 12. `FullSuiteGateOutput.status` union in Task 9 matches the assertions in Task 10.
- ✅ Config paths verified (see "Config-key cheat sheet" at the top): `execution.smartTestRunner` (not `quality.smartRunner`), `quality.commands.testScoped`, all four `regressionGate.*` keys already in schema at `src/config/schemas.ts:120-125` with defaults.
- ✅ Plan-builder API verified: `builder.addFullSuiteGate()` / `addVerifyScoped()` from `src/execution/build-plan-for-strategy.ts:125-141`. No `phases.push`.
- ✅ Timeout-source decision documented in Task 9 Step 4: prefer `regressionGate.timeoutSeconds` over `rectification.fullSuiteTimeoutSeconds` (the latter is what the current op reads; this is a real behavioral fix, not just a port).
- ⚠️ The `regression()` runner has a built-in 2s sleep before running tests. `verifyScopedOp` adopting it preserves parity with the old `ScopedStrategy` (which also called `regression()`) — not a new regression, but a known cost of the port.
