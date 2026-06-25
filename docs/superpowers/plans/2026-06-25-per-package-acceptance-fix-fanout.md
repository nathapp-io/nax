# Per-Package Acceptance Fix Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub #1277 — make the monorepo acceptance fix cycle fan out per failed package (each scoped to its own `packageDir`, test path, command, and sliced output) instead of running one batched session over the repo root that drops non-first packages.

**Architecture:** The acceptance *runner* (`acceptanceStage`) is already multi-package: it spawns each package's test in its own cwd. The leak is downstream — the stage discards per-package output (only `combinedOutput` survives) and the fix loop anchors everything to `failedPackages[0]` with `packageDir = repo root`. We (1) retain per-package output + AC slices on each `failedPackages` entry, then (2) loop over failed packages, building a fresh `FixCycle` + `FixCycleContext` scoped to each package, with per-package diagnosis and a per-package retry budget, followed by (3) a final full validation pass to catch cross-package regressions.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome. ACP-only agent protocol. Fix cycles via `runFixCycle` (`src/findings/`). Ops via `callOp`.

## Global Constraints

- **Bun-native APIs only** — `Bun.file()`, `Bun.spawn()`, `Bun.sleep()`. No Node.js `fs`/`child_process`/`setTimeout`-for-delay.
- **TypeScript strict** — no `any` without justification.
- **Logging** — use `src/logger`; every pipeline-stage log call includes `storyId` as the **first** key, plus `packageDir` for cross-package work. No `console.log`.
- **Test command** — never bare `bun test`. Use `timeout 30 bun test <path> --timeout=5000` for iteration; `bun run test` / `bun run test:bail` for full suite.
- **Errors** — `NaxError` with `code` + `context.stage`; chain `cause`.
- **Imports** — value imports from barrels (`@/config`, `@/findings`); type-only imports may use leaf paths.
- **File-size limits** — 600 lines source, 800 lines test (ratcheted by `bun run check:file-sizes`).
- **Monorepo awareness** — use `packageDir` for per-package scope; never `process.cwd()` in `src/execution/`, `src/pipeline/`.

---

## File Structure

| File | Responsibility | Change |
|:--|:--|:--|
| `src/pipeline/types.ts` | `PipelineContext.acceptanceFailures` type | Modify — add `output` + `failedACs` to `failedPackages[]` entries |
| `src/pipeline/stages/acceptance.ts` | Acceptance runner; aggregates per-package results | Modify — retain per-package `output` + `failedACs` on each `failedPackages` entry |
| `src/execution/lifecycle/acceptance-loop.ts` | Acceptance retry loop + fix-cycle construction | Modify — per-package fan-out, per-package `buildFixCycleCtx`, package-filtered validation, final full pass |
| `src/execution/lifecycle/acceptance-fix.ts` | `resolveAcceptanceDiagnosis` (no change to behavior) | No change — called per-package by the loop |
| `test/unit/pipeline/stages/acceptance.test.ts` | Acceptance stage tests | Modify — assert per-package `output`/`failedACs` recorded |
| `test/unit/execution/lifecycle/acceptance-loop.test.ts` | `resolveAcceptanceFixTarget` tests | Modify — single-package-arg target resolution |
| `test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts` | Fix-cycle construction tests | Modify — per-package `packageDir`, per-package budget, fan-out |

---

## Task 1: Retain per-package output + AC slices in the data model

The fix loop cannot slice output per package because `acceptanceFailures` keeps only `combinedOutput` and a deduped global `failedACs`. This task attaches each package's own `output` and `failedACs` to its `failedPackages` entry. **This is the gating change** — without it, fan-out feeds every session the same combined dump.

**Files:**
- Modify: `src/pipeline/types.ts:178-183` (extend `failedPackages` entry type)
- Modify: `src/pipeline/stages/acceptance.ts:147-152` (extend local `failedPackages` array type), `:218-223` and `:235-236` (push per-package `output` + `failedACs`)
- Test: `test/unit/pipeline/stages/acceptance.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `acceptanceFailures.failedPackages[]` entries now carry `output: string` and `failedACs: string[]`. Type shape (used by Task 2/3):
  ```typescript
  {
    testPath: string;
    packageDir: string;
    testFramework?: string;
    commandOverride?: string;
    output: string;        // NEW — this package's own stdout+stderr
    failedACs: string[];   // NEW — this package's own failed AC ids (not deduped global)
  }
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/unit/pipeline/stages/acceptance.test.ts` (inside the existing top-level `describe` for the acceptance stage, near the existing "records failed package metadata" test ~line 208):

```typescript
test("records per-package output and failedACs on each failed package entry", async () => {
  // Two packages fail with DIFFERENT ACs and different output.
  const ctx = makeCtx({
    acceptanceTestPaths: [
      {
        testPath: "/tmp/test-workdir/apps/api/.nax-acceptance.test.ts",
        packageDir: "/tmp/test-workdir/apps/api",
        testFramework: "jest",
        commandOverride: "npx jest {{FILE}}",
      },
      {
        testPath: "/tmp/test-workdir/apps/web/.nax-acceptance.test.ts",
        packageDir: "/tmp/test-workdir/apps/web",
        testFramework: "vitest",
        commandOverride: "pnpm vitest run {{FILE}}",
      },
    ],
  });
  // makeCtx's spawn mock must return per-package output. See Step 3 note: the
  // existing test harness drives output via the spawn stub keyed on cwd.
  const result = await acceptanceStage.execute(ctx);

  expect(result.action).toBe("fail");
  const pkgs = ctx.acceptanceFailures?.failedPackages ?? [];
  // Each failed package carries its OWN output slice and its OWN failedACs.
  const api = pkgs.find((p) => p.packageDir === "/tmp/test-workdir/apps/api");
  const web = pkgs.find((p) => p.packageDir === "/tmp/test-workdir/apps/web");
  expect(api?.output).toContain("api");
  expect(web?.output).toContain("web");
  expect(api?.failedACs).toEqual(["AC-1"]);
  expect(web?.failedACs).toEqual(["AC-2"]);
  // The combined view is still intact for back-compat.
  expect(ctx.acceptanceFailures?.failedACs).toEqual(["AC-1", "AC-2"]);
});
```

> **Note:** Read the existing `makeCtx` / spawn mock in this file first (top of file). The existing "AC-1: runs each test file from its package directory" test (~line 57) shows how the spawn stub is keyed on `cwd`; reuse that pattern to make `apps/api` emit output containing `"api"` + an `AC-1` failure and `apps/web` emit `"web"` + an `AC-2` failure. If the current stub returns one fixed output for all packages, extend it to switch on `opts.cwd` (mirror the existing per-cwd assertion at ~line 57).

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/pipeline/stages/acceptance.test.ts --timeout=5000`
Expected: FAIL — the new test errors because `p.output` / `p.failedACs` are `undefined` (fields don't exist yet).

- [ ] **Step 3: Extend the `failedPackages` entry type in `src/pipeline/types.ts`**

Replace lines 177-183:

```typescript
    /** Package-scoped failures from acceptance stage for monorepo command/path routing. */
    failedPackages?: Array<{
      testPath: string;
      packageDir: string;
      testFramework?: string;
      commandOverride?: string;
    }>;
```

with:

```typescript
    /** Package-scoped failures from acceptance stage for monorepo command/path routing. */
    failedPackages?: Array<{
      testPath: string;
      packageDir: string;
      testFramework?: string;
      commandOverride?: string;
      /** This package's own combined stdout+stderr (not the cross-package dump). */
      output: string;
      /** This package's own failed AC ids (not the deduped global union). */
      failedACs: string[];
    }>;
```

- [ ] **Step 4: Retain per-package output + ACs in `src/pipeline/stages/acceptance.ts`**

First, extend the local `failedPackages` array type. Replace lines 147-152:

```typescript
    const failedPackages: Array<{
      testPath: string;
      packageDir: string;
      testFramework?: string;
      commandOverride?: string;
    }> = [];
```

with:

```typescript
    const failedPackages: Array<{
      testPath: string;
      packageDir: string;
      testFramework?: string;
      commandOverride?: string;
      output: string;
      failedACs: string[];
    }> = [];
```

Next, the crash-path push (currently line 222):

```typescript
        failedPackages.push({ testPath, packageDir, testFramework, commandOverride });
```

becomes (the crash path uses the `AC-ERROR` sentinel as this package's failed AC):

```typescript
        failedPackages.push({ testPath, packageDir, testFramework, commandOverride, output, failedACs: ["AC-ERROR"] });
```

Next, the AC-failure push (currently line 236):

```typescript
        failedPackages.push({ testPath, packageDir, testFramework, commandOverride });
```

becomes (use this package's own `actualFailures`, not the global union):

```typescript
        failedPackages.push({ testPath, packageDir, testFramework, commandOverride, output, failedACs: actualFailures });
```

> **Note:** `output` and `actualFailures` are both already in scope at both push sites (`output` defined ~line 192, `actualFailures` ~line 199). The `AC-HOOK` sentinel, if present, is already merged into `actualFailures` upstream, so no special handling needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/pipeline/stages/acceptance.test.ts --timeout=5000`
Expected: PASS — all existing tests plus the new per-package test.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors (the `AcceptanceTestRunResult.failedPackages` type in acceptance-loop.ts derives from `PipelineContext`, so it inherits the new fields automatically).

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/stages/acceptance.ts test/unit/pipeline/stages/acceptance.test.ts
git commit -m "feat(acceptance): retain per-package output and failedACs on failed package entries (#1277)"
```

---

## Task 2: Make `resolveAcceptanceFixTarget` resolve a single package

Today `resolveAcceptanceFixTarget` takes the whole `failedPackages` array and uses `[0]`. Change it to take **one** package entry so the per-package loop in Task 3 can call it per package. Keep the `acceptanceTestPaths` fallback for the single-package (no-monorepo) case.

**Files:**
- Modify: `src/execution/lifecycle/acceptance-loop.ts:116-139` (`resolveAcceptanceFixTarget` signature + body)
- Test: `test/unit/execution/lifecycle/acceptance-loop.test.ts:285-358`

**Interfaces:**
- Consumes: the extended `failedPackages` entry from Task 1.
- Produces: new signature
  ```typescript
  resolveAcceptanceFixTarget(
    acceptanceTestPaths: AcceptanceTestPathEntry[] | undefined,
    failedPackage: { testPath: string; packageDir: string; commandOverride?: string } | undefined,
    config: NaxConfig,
  ): { acceptanceTestPath: string; testCommand: string | undefined }
  ```
  Callers now pass a single package entry (or `undefined`), not the array.

- [ ] **Step 1: Update the failing tests**

In `test/unit/execution/lifecycle/acceptance-loop.test.ts`, the `resolveAcceptanceFixTarget` suite (~line 285) currently passes an **array** as the second arg. Update each call to pass a **single entry**. Replace the "prefers failed package commandOverride and testPath" test body:

```typescript
  test("prefers failed package commandOverride and testPath", () => {
    const result = resolveAcceptanceFixTarget(
      [
        {
          testPath: "/repo/apps/api/.nax-acceptance.test.ts",
          packageDir: "/repo/apps/api",
          commandOverride: "npx jest {{FILE}}",
          testFramework: "jest",
        },
      ],
      {
        testPath: "/repo/apps/api/.nax-acceptance.test.ts",
        packageDir: "/repo/apps/api",
        commandOverride: "pnpm vitest run {{FILE}}",
      },
      config,
    );
    expect(result.acceptanceTestPath).toBe("/repo/apps/api/.nax-acceptance.test.ts");
    expect(result.testCommand).toBe("pnpm vitest run {{FILE}}");
  });
```

And add a test proving a non-first package resolves correctly (the bug regression):

```typescript
  test("resolves the given package, not just the first acceptanceTestPaths entry", () => {
    const result = resolveAcceptanceFixTarget(
      [
        { testPath: "/repo/apps/api/.nax-acceptance.test.ts", packageDir: "/repo/apps/api", commandOverride: "npx jest {{FILE}}" },
        { testPath: "/repo/apps/web/.nax-acceptance.test.ts", packageDir: "/repo/apps/web", commandOverride: "pnpm vitest run {{FILE}}" },
      ],
      { testPath: "/repo/apps/web/.nax-acceptance.test.ts", packageDir: "/repo/apps/web", commandOverride: "pnpm vitest run {{FILE}}" },
      config,
    );
    expect(result.acceptanceTestPath).toBe("/repo/apps/web/.nax-acceptance.test.ts");
    expect(result.testCommand).toBe("pnpm vitest run {{FILE}}");
  });
```

> **Note:** Update the remaining calls in this suite (the "uses failed package path and config command…" test ~line 333, and any `undefined`/empty-array cases) to pass a single entry or `undefined` as the second argument. For the "no failed package" case, pass `undefined` and keep the existing expectation that it falls back to `acceptanceTestPaths[0]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/execution/lifecycle/acceptance-loop.test.ts --timeout=5000`
Expected: FAIL — type/shape mismatch (function still expects an array and reads `[0]`).

- [ ] **Step 3: Update `resolveAcceptanceFixTarget`**

Replace lines 116-139 of `src/execution/lifecycle/acceptance-loop.ts`:

```typescript
export function resolveAcceptanceFixTarget(
  acceptanceTestPaths: AcceptanceTestPathEntry[] | undefined,
  failedPackage:
    | { testPath: string; packageDir: string; commandOverride?: string }
    | undefined,
  config: NaxConfig,
): {
  acceptanceTestPath: string;
  testCommand: string | undefined;
} {
  const matchedEntry = failedPackage
    ? acceptanceTestPaths?.find(
        (entry) => entry.testPath === failedPackage.testPath || entry.packageDir === failedPackage.packageDir,
      )
    : undefined;
  const selectedPathEntry = matchedEntry ?? acceptanceTestPaths?.[0];
  return {
    acceptanceTestPath: failedPackage?.testPath ?? selectedPathEntry?.testPath ?? "",
    testCommand:
      failedPackage?.commandOverride ??
      matchedEntry?.commandOverride ??
      config.acceptance.command ??
      config.quality?.commands?.test,
  };
}
```

- [ ] **Step 4: Update the single existing caller**

At `src/execution/lifecycle/acceptance-loop.ts:457-461`, the call currently passes `failures.failedPackages` (array). Change it to pass the first failed package entry so existing single-package behavior is preserved until Task 3 wires the loop:

```typescript
    const { acceptanceTestPath, testCommand } = resolveAcceptanceFixTarget(
      ctx.acceptanceTestPaths,
      failures.failedPackages?.[0],
      ctx.config,
    );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/execution/lifecycle/acceptance-loop.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/execution/lifecycle/acceptance-loop.ts test/unit/execution/lifecycle/acceptance-loop.test.ts
git commit -m "refactor(acceptance): resolve fix target for a single package (#1277)"
```

---

## Task 3: Scope the fix cycle to one package + filter validation

Add a per-package `packageDir` to the fix-cycle context, and make validation re-run only the target package. This is the structural change that scopes the agent's cwd to the failing package.

**Files:**
- Modify: `src/execution/lifecycle/acceptance-loop.ts` — `buildFixCycleCtx` (`:170-184`), `runAcceptanceTestsOnce` (`:215-228`), `runAcceptanceFixCycle` (`:242-312`)
- Test: `test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts`

**Interfaces:**
- Consumes: extended `failedPackages` entry (Task 1), single-package `resolveAcceptanceFixTarget` (Task 2).
- Produces:
  ```typescript
  buildFixCycleCtx(ctx, runtime, storyId, packageDir: string): FixCycleContext
  runAcceptanceTestsOnce(ctx, prd, packageFilter?: AcceptanceTestPathEntry[]): Promise<AcceptanceTestRunResult>
  runAcceptanceFixCycle(
    ctx, prd,
    initialFailures: { failedACs: string[]; testOutput: string },
    diagnosis, acceptanceTestPath, testCommand?,
    fixTarget?: { packageDir: string; testPath: string },  // NEW — scopes cwd + validation
  ): Promise<FixCycleResult<Finding>>
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts` (reuse the file's existing `makeCtx`/`makePrd`/`makeDiagnosis` + the `_acceptanceFixCycleDeps.runFixCycle` spy pattern around line 138):

```typescript
test("scopes fix cycle packageDir to the fixTarget package, not repo root", async () => {
  let capturedCtx: FixCycleContext | undefined;
  _acceptanceFixCycleDeps.runFixCycle = async (_cycle, cycleCtx) => {
    capturedCtx = cycleCtx;
    return { iterations: [], finalFindings: [], exitReason: "resolved" };
  };

  await runAcceptanceFixCycle(
    makeCtx(),                                   // ctx.workdir = repo root
    makePrd(),
    { failedACs: ["AC-1"], testOutput: "boom" },
    makeDiagnosis(),
    "/repo/apps/api/.nax-acceptance.test.ts",
    "npx jest {{FILE}}",
    { packageDir: "/repo/apps/api", testPath: "/repo/apps/api/.nax-acceptance.test.ts" },
  );

  expect(capturedCtx?.packageDir).toBe("/repo/apps/api");
});
```

> **Note:** Restore `_acceptanceFixCycleDeps.runFixCycle` in an `afterEach` if the file doesn't already (check the existing teardown). Import `FixCycleContext` as a type from `@/findings` if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts --timeout=5000`
Expected: FAIL — `capturedCtx.packageDir` is `ctx.workdir` (repo root), not `/repo/apps/api`; and `runAcceptanceFixCycle` doesn't yet accept a 7th `fixTarget` arg.

- [ ] **Step 3: Add `packageDir` param to `buildFixCycleCtx`**

Replace `src/execution/lifecycle/acceptance-loop.ts:170-184`:

```typescript
function buildFixCycleCtx(
  ctx: AcceptanceLoopContext,
  runtime: NonNullable<AcceptanceLoopContext["runtime"]>,
  storyId: string,
  packageDir: string,
): FixCycleContext {
  return {
    runtime,
    packageView: runtime.packages.resolve(packageDir),
    packageDir,
    storyId,
    featureName: ctx.feature,
    // agentName captured once at cycle construction time; fallback changes not reflected mid-cycle
    agentName: ctx.agentManager?.getDefault() ?? "claude",
  };
}
```

- [ ] **Step 4: Add a package filter to `runAcceptanceTestsOnce`**

Replace `src/execution/lifecycle/acceptance-loop.ts:215-228`:

```typescript
async function runAcceptanceTestsOnce(
  ctx: AcceptanceLoopContext,
  prd: PRD,
  packageFilter?: AcceptanceTestPathEntry[],
): Promise<AcceptanceTestRunResult> {
  const baseCtx: AcceptanceLoopContext = packageFilter
    ? { ...ctx, acceptanceTestPaths: packageFilter }
    : ctx;
  const acceptanceContext = buildAcceptanceContext(baseCtx, prd);
  const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
  const result = await acceptanceStage.execute(acceptanceContext);
  if (result.action !== "fail") return { passed: true, failedACs: [], testOutput: "" };
  const failures = acceptanceContext.acceptanceFailures;
  if (!failures || failures.failedACs.length === 0) return { passed: true, failedACs: [], testOutput: "" };
  return {
    passed: false,
    failedACs: failures.failedACs,
    testOutput: failures.testOutput,
    failedPackages: failures.failedPackages,
  };
}
```

> **Note:** `buildAcceptanceContext` reads `ctx.acceptanceTestPaths` (line 209), so overriding it on a shallow-cloned ctx restricts the acceptance run to just the filtered package(s). This is immutable — we never mutate `ctx`.

- [ ] **Step 5: Thread `fixTarget` through `runAcceptanceFixCycle`**

Update the signature and the two internal uses. Replace the signature (lines 242-249):

```typescript
export async function runAcceptanceFixCycle(
  ctx: AcceptanceLoopContext,
  prd: PRD,
  initialFailures: { failedACs: string[]; testOutput: string },
  diagnosis: DiagnosisResult,
  acceptanceTestPath: string,
  testCommand?: string,
  fixTarget?: { packageDir: string; testPath: string },
): Promise<FixCycleResult<Finding>> {
```

Replace the `cycleCtx` construction (line 259):

```typescript
  const cycleCtx = buildFixCycleCtx(ctx, runtime, storyId, fixTarget?.packageDir ?? ctx.workdir);
```

Replace the `validate` body (lines 297-303) so validation re-runs only the target package when scoped:

```typescript
    validate: async (_ctx, _opts: { mode: "full" | "lite" }) => {
      const packageFilter = fixTarget
        ? ctx.acceptanceTestPaths?.filter((entry) => entry.packageDir === fixTarget.packageDir)
        : undefined;
      const result = await runAcceptanceTestsOnce(ctx, prd, packageFilter);
      if (result.passed) return [];
      currentTestOutput = result.testOutput;
      currentFailedACs = result.failedACs;
      return findingsForDiagnosis(result.failedACs, result.testOutput, diagnosis);
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors. The existing single caller (line 493) still works — `fixTarget` is optional and omitted there for now (wired in Task 4).

```bash
git add src/execution/lifecycle/acceptance-loop.ts test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts
git commit -m "feat(acceptance): scope fix cycle and validation to a single package (#1277)"
```

---

## Task 4: Fan out the acceptance fix per failed package

Replace the single diagnosis + single fix cycle in `runAcceptanceLoop` (steps 4–5, lines 436-518) with a loop over `failures.failedPackages`: per-package diagnosis (over that package's sliced output), per-package fix cycle (scoped via Task 3), then a final **full** validation pass to catch cross-package regressions. Budget is **per-package** (documented decision: each package gets its own `maxRetries` budget).

**Files:**
- Modify: `src/execution/lifecycle/acceptance-loop.ts:436-518` (the diagnosis + fix-cycle section of `runAcceptanceLoop`)
- Test: `test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts`

**Interfaces:**
- Consumes: Task 1 (per-package output/ACs), Task 2 (single-package target), Task 3 (`fixTarget`-scoped cycle + filtered validation).
- Produces: no new exported symbols; `runAcceptanceLoop` now fans out internally. Exit contract (`buildResult(...)`) unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts`. This test drives `runAcceptanceLoop` with two failed packages and asserts a fix cycle runs for **each** (not just the first). Reuse the file's existing harness for `acceptanceStage` mocking; if the harness only mocks `runAcceptanceFixCycle`, spy on it:

```typescript
test("runs a fix cycle for every failed package, not just the first", async () => {
  const fixedPackages: string[] = [];
  _acceptanceFixCycleDeps.runFixCycle = async (_cycle, cycleCtx) => {
    fixedPackages.push(cycleCtx.packageDir);
    return { iterations: [], finalFindings: [], exitReason: "resolved" };
  };

  // acceptanceStage.execute must report two failed packages on the first run,
  // then pass on the final validation. Drive this via the file's existing
  // acceptance-stage stub (set it to fail-with-two-packages once, then pass).
  const ctx = makeLoopCtx({
    acceptanceTestPaths: [
      { testPath: "/repo/apps/api/t.test.ts", packageDir: "/repo/apps/api" },
      { testPath: "/repo/apps/web/t.test.ts", packageDir: "/repo/apps/web" },
    ],
    failedPackages: [
      { testPath: "/repo/apps/api/t.test.ts", packageDir: "/repo/apps/api", output: "api boom", failedACs: ["AC-1"] },
      { testPath: "/repo/apps/web/t.test.ts", packageDir: "/repo/apps/web", output: "web boom", failedACs: ["AC-2"] },
    ],
  });

  await runAcceptanceLoop(ctx);

  expect(fixedPackages.sort()).toEqual(["/repo/apps/api", "/repo/apps/web"]);
});
```

> **Note:** The exact `makeLoopCtx` / acceptance-stage stub helper name is whatever this file already uses to drive `runAcceptanceLoop` (the file at lines ~138-264 already constructs loop contexts and stubs the stage — reuse that). If no helper drives the full loop yet, model the stub on `runAcceptanceTestsOnce`'s dependency: stub the dynamically-imported `acceptanceStage.execute` to set `ctx.acceptanceFailures` with the two `failedPackages` on first call and return `{ action: "continue" }` on the final validation call.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts --timeout=5000`
Expected: FAIL — `fixedPackages` contains only the first package (or only repo root).

- [ ] **Step 3: Replace the diagnosis + fix-cycle section of `runAcceptanceLoop`**

Replace lines 456-518 (from the `// Load test file content for diagnosis` comment through the final `return buildResult(...)` of the loop body) with the per-package fan-out:

```typescript
    // ── 4+5. Per-package fan-out: diagnose + fix each failed package ──────
    // #1277: one fix cycle per failed package, each scoped to its packageDir,
    // testPath, command, and sliced output. Budget is per-package (each gets
    // its own maxRetries). A final full validation pass catches cross-package
    // regressions before declaring success.
    const failedPkgs =
      failures.failedPackages && failures.failedPackages.length > 0
        ? failures.failedPackages
        : [{ testPath: "", packageDir: ctx.workdir, output: failures.testOutput, failedACs: failures.failedACs }];

    const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";
    const semanticVerdicts = ctx.featureDir ? await _acceptanceLoopDeps.loadSemanticVerdicts(ctx.featureDir) : [];
    const totalACs = prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;

    const testEntries = ctx.acceptanceTestPaths
      ? await loadAcceptanceTestContentModule(ctx.acceptanceTestPaths.map((p) => p.testPath))
      : [];

    const remainingFindings: Finding[] = [];
    for (const pkg of failedPkgs) {
      const { acceptanceTestPath, testCommand } = resolveAcceptanceFixTarget(ctx.acceptanceTestPaths, pkg, ctx.config);
      const effectivePath = acceptanceTestPath || pkg.testPath || testEntries[0]?.testPath || "";
      const testFileContent =
        testEntries.find((entry) => entry.testPath === effectivePath)?.content ?? testEntries[0]?.content ?? "";

      const pkgFailures = { failedACs: pkg.failedACs, testOutput: pkg.output };
      const diagnosis = await resolveAcceptanceDiagnosis({
        ctx,
        failures: pkgFailures,
        totalACs,
        strategy,
        semanticVerdicts,
        diagnosisOpts: {
          testOutput: pkg.output,
          testFileContent,
          acceptanceTestPath: effectivePath,
          workdir: pkg.packageDir,
          storyId: firstStory?.id,
        },
      });

      logger?.info("acceptance.diagnosis", "Diagnosis resolved", {
        storyId: firstStory?.id,
        packageDir: pkg.packageDir,
        verdict: diagnosis.verdict,
        confidence: diagnosis.confidence,
        attempt: acceptanceRetries,
      });

      const cycleResult = await runAcceptanceFixCycle(ctx, prd, pkgFailures, diagnosis, effectivePath, testCommand, {
        packageDir: pkg.packageDir,
        testPath: effectivePath,
      });
      totalCost += cycleResult.costUsd ?? 0;
      const pkgResolved = cycleResult.exitReason === "resolved" || cycleResult.finalFindings.length === 0;
      if (!pkgResolved) remainingFindings.push(...cycleResult.finalFindings);
    }

    // ── Final full validation pass (all packages) — catches cross-package
    //    regressions one isolated cycle could miss. ───────────────────────
    const finalCheck = await runAcceptanceTestsOnce(ctx, prd);
    const success = finalCheck.passed && remainingFindings.length === 0;
    return buildResult(
      success,
      prd,
      totalCost,
      iterations,
      storiesCompleted,
      prdDirty,
      success ? undefined : (finalCheck.failedACs.length > 0 ? finalCheck.failedACs : remainingFindings.map((f) => f.message)),
      acceptanceRetries,
    );
```

> **Note:** Delete the now-dead `const { acceptanceTestPath, testCommand } = resolveAcceptanceFixTarget(...)` block and the standalone single diagnosis call that previously sat at lines 457-500 — the replacement above subsumes them. Keep the runtime-null guard (lines 442-454) above this block intact.

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts --timeout=5000`
Expected: PASS — a cycle runs for each of `/repo/apps/api` and `/repo/apps/web`.

- [ ] **Step 5: Run the full acceptance-loop test set**

Run: `timeout 60 bun test test/unit/execution/lifecycle/ --timeout=5000`
Expected: PASS. Fix any test that asserted the old single-cycle / single-diagnosis behavior — update it to the per-package contract (the diagnosis is now called once per failed package, scoped to that package's output).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/execution/lifecycle/acceptance-loop.ts test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts
git commit -m "feat(acceptance): fan out fix cycle per failed package with final full validation (#1277)"
```

---

## Task 5: Document the per-package budget decision + full gate

Record the budget semantics (per-package `maxRetries`) where config is documented, and run the full quality gate.

**Files:**
- Modify: `src/execution/lifecycle/acceptance-loop.ts` (doc comment on `runAcceptanceLoop`, ~line 314-325)

**Interfaces:**
- Consumes: Task 4 behavior. Produces: nothing — docs + verification only.

- [ ] **Step 1: Update the `runAcceptanceLoop` doc comment**

Replace the JSDoc block at lines 314-325 with an accurate description:

```typescript
/**
 * Run the acceptance retry loop.
 *
 * Each outer iteration:
 *   1. Run acceptance tests → PASS → done / FAIL → collect per-package failures
 *   2. Stub guard (with stubRegenCount cap) → regen + continue
 *   3. Per-package fan-out (#1277): for each failed package, diagnose over that
 *      package's sliced output and run a fix cycle scoped to its packageDir,
 *      testPath, and command. Budget is PER-PACKAGE — each failed package gets
 *      its own maxRetries via runFixCycle's maxAttemptsTotal.
 *   4. Final full validation pass (all packages) → success only if it passes
 *      and no package-level findings remain.
 *
 * The outer loop owns the stub guard and the package fan-out. runFixCycle owns
 * per-package fix retry logic.
 */
```

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: pass (Biome + file-size + alias checks).

- [ ] **Step 3: Full test suite**

Run: `bun run test:bail`
Expected: pass. If a failure surfaces in a test that encoded the old single-package fix behavior, update it to the per-package contract and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/execution/lifecycle/acceptance-loop.ts
git commit -m "docs(acceptance): document per-package fix budget semantics (#1277)"
```

---

## Self-Review

**1. Spec coverage (issue #1277 "Proposed fix" + "Considerations"):**
- "Fan out per failed package, each scoped to packageDir/testPath/testCommand/output slice" → Tasks 1–4. ✓
- "Diagnosis may need to be per-package" → Task 4 calls `resolveAcceptanceDiagnosis` per package over `pkg.output`. ✓
- "testOutput should be sliced per package" → Task 1 retains `pkg.output`; Task 4 feeds it per cycle. ✓
- "Respect maxRetries semantics (per-package vs global — decide and document)" → Task 4 uses per-package budget (each cycle gets `maxAttemptsTotal`); Task 5 documents it. ✓
- Cross-package interaction safety → Task 4 final full validation pass. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — each code step shows full code. Two `> Note` blocks point the implementer to existing test harness helpers (`makeCtx` spawn stub, loop-driving stub) rather than restating them, because those helpers already exist in the target files and must be reused verbatim, not re-invented.

**3. Type consistency:**
- `failedPackages[]` entry fields `output: string` + `failedACs: string[]` — defined identically in Task 1 (types.ts + acceptance.ts) and consumed in Tasks 3–4. ✓
- `resolveAcceptanceFixTarget(paths, failedPackage, config)` — single-entry signature in Task 2, called with a single `pkg` in Task 4. ✓
- `buildFixCycleCtx(ctx, runtime, storyId, packageDir)` — 4-arg in Task 3, used in Task 3's `runAcceptanceFixCycle`. ✓
- `runAcceptanceFixCycle(..., fixTarget?)` — optional 7th arg in Task 3, passed in Task 4. ✓
- `runAcceptanceTestsOnce(ctx, prd, packageFilter?)` — optional filter in Task 3, used in Task 3 validate + Task 4 final pass. ✓
