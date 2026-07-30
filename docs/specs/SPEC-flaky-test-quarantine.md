# SPEC: Flaky-Test Detection & Quarantine

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Add run-scoped flaky-test detection and quarantine to the verification pipeline. When a **pre-existing** test (one the story's diff did not touch and does not cover) fails at the per-story full-suite gate or the end-of-run regression gate, nax probes it by re-running it in isolation; if it passes at least once, the failure is relabeled `category: "flaky-test"` and excluded from rectification, story attribution, and gate-blocking for the remainder of the run. Every quarantine decision is logged and surfaced. Nothing is persisted across runs.

## Motivation

A flaky pre-existing test in the target repo currently burns real money and time: nax attributes the intermittent failure to the agent's change, dispatches rectification fix cycles, escalates model tiers, and can fail the regression gate — all for a failure the story did not cause. No re-run-the-failing-test logic exists anywhere in the codebase today; every existing re-run (rectification loop, regression gate, acceptance loop) re-runs a whole scope after an attempted edit, never "run this same failing test again unchanged to see if it flips."

Scope decisions (from brainstorm, 2026-07-04 — see `docs/specs/flaky-test-quarantine-design.md`):

- **In scope:** pre-existing repo tests only; detection at full-suite gate + regression gate; run-scoped quarantine with reporting.
- **Out of scope:** agent-written and acceptance tests (stay strict); persistent flaky-history store across runs; auto-fixing the flaky test; scoped-verify stage.

## Design

### Approach

**Classification, not fixing** (brainstorm "Approach B"): a flake-triage step runs between findings extraction and the fix cycle at the two integration sites. The verification layer (`runVerificationCore`, `VerificationResult`) and the FixCycle machinery are unchanged. Detection = two signals that must both agree:

1. **Baseline check (cheap, first):** the failing test is pre-existing and untouched — its test file is not in the story's diff and is not mapped from changed sources.
2. **Isolation probe (expensive, second):** the test passes at least once when re-run alone `probeRuns` times.

Fail closed everywhere: unprobeable or ambiguous outcomes keep the finding blocking.

### Integration

Verified symbols (codebase @ `feat/flaky-test-quarantine`, grounded 2026-07-04):

- `TestFailure { file, testName, error, stackTrace }` and `TestSummary` — `src/test-runners/types.ts`. Per-framework parsing already yields per-test failure identity (`src/test-runners/parser.ts`). Known caveat: `file` can be `"unknown"` for Bun/Go parse paths → unprobeable.
- `Framework = "bun" | "jest" | "vitest" | "pytest" | "go" | "unknown"` and `detectFramework(output: string)` — `src/test-runners/detector.ts`. The probe derives the framework from the failed run's raw output.
- `executeWithTimeout(command, timeoutSeconds, env?, options?: { shell?, gracePeriodMs?, drainTimeoutMs?, cwd? })` — `src/verification/executor.ts` (has `_executorDeps.spawn` DI seam). The probe executes through this.
- `gatherRectificationFindings(...)` / `runRectification(...)` — `src/execution/story-orchestrator/rectification.ts`. Triage runs on gate findings before they reach the fix cycle.
- `gateFailureKeys(gateOutput)` and `describeGateRegression(...)` — `src/execution/story-orchestrator/phase-eval.ts`. Key shape `${file}::${rule}` where `rule` is the testName; both must skip `flaky-test` findings. (The boolean wrapper `gateRegressedAfterRectification` named here at spec time was folded into `describeGateRegression` by #1382/#1383.)
- `runDeferredRegression(options: DeferredRegressionOptions)` + internal `buildRegressionFindings(...)`, `findResponsibleStoryByTransition(...)`, `_regressionDeps` DI object — `src/execution/lifecycle/run-regression.ts`.
- `testFailureToFinding` / `testSummaryToFindings` — `src/findings/adapters/test-failure.ts`; produces `Finding { source: "test-runner", category: "failed-test", file, rule: testName, ... }`. `Finding.category` is an open vocabulary — `"flaky-test"` is a new value, no schema change.
- Existing precedent for the philosophy: `shouldSkipPhaseForRectification()` (same file as `gatherRectificationFindings`) already treats a failing gate with a passing verifier as an unrelated pre-existing regression.
- Smart-runner source→test mapping helpers (`mapSourceToTests`, import-grep fallback) — `src/verification/smart-runner.ts` — reused by the baseline check.
- Test-file classification for the baseline check goes through `resolveTestFilePatterns(config, workdir, packageDir)` (`src/test-runners/resolver.ts`) per ADR-009 — no inline patterns.

Patterns to follow: `_deps` injection for spawn/exec (like `_executorDeps`, `_regressionDeps`); config via Zod schema defaults + selector (`src/config/schemas*.ts`, `src/config/selectors.ts`); `NaxError` with `stage` context; structured logging with `storyId` first; barrel exports from `src/verification/index.ts`.

### New modules

**`src/verification/flake-probe.ts`** — the re-run mechanic. Input: a `TestFailure`, the detected `Framework`, the package's base test command (from `config.quality.commands.test`, per-package resolved — never hardcoded), a working directory, and probe config. Builds an isolation command by combining the base command with a framework-specific filter:

| Framework | Filter shape (appended to / derived from base command) |
|---|---|
| bun | `<base> <file> -t <escaped name>` |
| jest / vitest | `<base> <file> -t <escaped name>` |
| pytest | `<base> <file>::<name>` |
| go | `<base> -run '^<escaped name>$'` scoped to the failing package |

Test names are escaped for `-t`/`-run` regex metacharacters. Executes via `executeWithTimeout` with `probeTimeoutSeconds` and the package `cwd`. Returns a discriminated verdict:

- `{ verdict: "flaky", probeRuns, probePasses }` — passed at least once
- `{ verdict: "consistent-failure", probeRuns }` — failed every probe
- `{ verdict: "unprobeable", reason }` — `file === "unknown"`, `framework === "unknown"`, or no filter command can be constructed

A probe run counts as a pass only on a clean pass; crash, environmental-failure classification, or timeout counts as a failed probe.

**`src/verification/flake-triage.ts`** — the classifier and sole decision-maker. Input: `failed-test` findings + story context (diff, config, workdir/packageDir, run-scoped quarantine memo). Per finding: baseline check → probe → relabel. Output: the same findings array with confirmed flakes relabeled to `category: "flaky-test"` and `meta: { probeRuns, probePasses }`, plus a quarantine report (keys, reasons) for logging/events. Per `src/findings/types.ts`, `meta` is forensic-only — all downstream branching (fix-strategy `appliesTo`, `gateFailureKeys` exclusion, attribution) discriminates on `category`, never on `meta` fields. Maintains a run-scoped in-memory memo keyed `${file}::${testName}` so the regression gate does not re-probe tests already judged flaky earlier in the run. Skips probing entirely (all findings stay blocking, reason logged) when distinct failed pre-existing tests at one gate exceed `maxProbesPerGate`.

### Config

New block under `execution` in the Zod schema (`src/config/schemas-execution.ts`; defaults live in the schema via `.default()` per config-patterns):

```json
"execution": {
  "flakeDetection": {
    "enabled": true,
    "probeRuns": 2,
    "maxProbesPerGate": 5,
    "probeTimeoutSeconds": 60
  }
}
```

Per-package overridable via `.nax/mono/<pkg>/config.json` (design rule A in monorepo-awareness). Note: `mergePackageConfig()` in `src/config/merge.ts` shallow-spreads `packageOverride.execution` and deep-merges only known subtrees — US-001 must add a `flakeDetection` sub-merge (mirroring `regressionGate`) so a partial package override preserves the root block's other keys.

### Failure Handling

- Fail closed: `unprobeable`, probe crash, timeout, environmental failure → finding stays `failed-test` (blocking).
- `enabled: false` → triage is a no-op passthrough; pipeline behaves exactly as today.
- `maxProbesPerGate` exceeded → no probing at that gate, everything blocking, structured log explains why.
- Errors inside triage itself must never fail the gate spuriously: a thrown probe/triage error is caught, logged (`logger.warn`), and treated as "not flaky" (finding stays blocking).

## Stories

Repo is single-package (no `Workdir` fields). No removal keywords → no terminal-cleanup story.

### US-001 — Flake probe module + config schema

Builds the isolation re-run mechanic and its config surface.

- **Context Files:** `src/verification/executor.ts`, `src/test-runners/detector.ts`, `src/test-runners/types.ts`, `src/config/schemas-execution.ts` (owns the `execution` block), `src/config/selectors.ts`
- **Creates:** `src/verification/flake-probe.ts` (+ barrel export from `src/verification/index.ts`; schema/selector edits are modifications, not creations)
- **Depends on:** —

### US-002 — Flake triage classifier

Baseline check + probe orchestration + relabeling + run-scoped memo + probe-budget guard.

- **Context Files:** `src/verification/flake-probe.ts` — created by US-001, integrated here; `src/verification/smart-runner.ts`, `src/test-runners/resolver.ts`, `src/findings/types.ts`, `src/findings/adapters/test-failure.ts`
- **Creates:** `src/verification/flake-triage.ts` (+ barrel export)
- **Depends on:** US-001

### US-003 — Story-orchestrator full-suite-gate integration

Wire triage into per-story rectification; gate pass-with-warnings; phase-eval exclusions.

- **Context Files:** `src/execution/story-orchestrator/rectification.ts`, `src/execution/story-orchestrator/phase-eval.ts`, `src/verification/flake-triage.ts` — created by US-002, integrated here
- **Depends on:** US-002

### US-004 — Regression-gate integration

Wire triage into the deferred regression gate; exclude flakes from story attribution; success-with-warnings; shared memo.

- **Context Files:** `src/execution/lifecycle/run-regression.ts`, `src/verification/flake-triage.ts` — created by US-002, integrated here; `src/metrics/types.ts` (StorySnapshot shape for attribution)
- **Depends on:** US-002

### Seams

- **US-001 → US-002:** `runFlakeProbe` (new export from `src/verification`) is called by triage — US-002 carries a seam AC stubbing the probe and asserting invocation with the failing test's identity and config.
- **US-002 → US-003:** the triage entry point (new export) is called from story-orchestrator rectification — US-003 carries a seam AC stubbing triage and asserting it receives the gate's `failed-test` findings before the fix cycle sees them.
- **US-002 → US-004:** same triage entry point called from `runDeferredRegression` — US-004 carries a seam AC stubbing triage and asserting invocation on regression failures with the shared run-scoped memo.

## Acceptance Criteria

### US-001 — Flake probe module + config schema

1. `[unit]` Constructing the nax config with `flakeDetection` unset yields resolved defaults `execution.flakeDetection.enabled == true`, `probeRuns == 2`, `maxProbesPerGate == 5`, `probeTimeoutSeconds == 60`.
2. `[unit]` `runFlakeProbe` is importable from the `src/verification` barrel and is callable as a function.
3. `[unit]` For framework `bun` (and `jest`/`vitest`), given a base test command and a failing test `{ file, testName }`, the probe constructs an isolation command that starts from the provided base command and includes both the test file path and a name filter for the test.
4. `[unit]` For framework `pytest`, the constructed isolation command addresses the single test as `<file>::<testName>`.
5. `[unit]` For framework `go`, the constructed isolation command uses an anchored run filter (`^…$`) for the test name.
6. `[unit]` A test name containing regex metacharacters (e.g. `handles (edge) case?`) produces a filter in which those characters are escaped, so the filter selects the test name literally.
7. `[unit]` With the executor dependency stubbed so the first probe run fails and the second passes, `runFlakeProbe` returns verdict `flaky` with `probeRuns == 2` and `probePasses == 1`.
8. `[unit]` With the executor stubbed so every probe run fails, `runFlakeProbe` returns verdict `consistent-failure`.
9. `[unit]` For a failing test whose `file` is `"unknown"`, or when the detected framework is `unknown`, `runFlakeProbe` returns verdict `unprobeable` and the executor dependency is never invoked.
10. `[unit]` A probe run whose execution result is a timeout or an environmental failure counts as a failed probe run: with one such run and one clean pass across two probes, the verdict is `flaky` with `probePasses == 1`; with only such runs, the verdict is `consistent-failure`.

### US-002 — Flake triage classifier

1. `[unit]` The triage entry point (`triageFlakyFindings`) is importable from the `src/verification` barrel; given an empty findings array it returns an empty findings array and an empty quarantine report.
2. `[unit]` **(Seam: US-001)** With `runFlakeProbe` stubbed, a `failed-test` finding for a pre-existing test that is absent from the story diff and unmapped from changed sources causes the stub to be invoked exactly once with that test's file, test name, and the resolved `flakeDetection` config.
3. `[unit]` A finding whose test file appears in the story's changed files is never probed (probe stub not invoked) and keeps `category: "failed-test"`.
4. `[unit]` A finding whose test file is mapped from a changed source file (source→test mapping reports coverage) is never probed and keeps `category: "failed-test"`.
5. `[unit]` A probed finding with verdict `flaky` is returned with `category: "flaky-test"` and `meta.probeRuns` / `meta.probePasses` populated; a probed finding with verdict `consistent-failure` keeps `category: "failed-test"`.
6. `[unit]` A finding whose `${file}::${testName}` key is already in the run-scoped quarantine memo is relabeled `flaky-test` without invoking the probe stub again.
7. `[unit]` When the number of distinct probe candidates at one gate exceeds `maxProbesPerGate`, the probe stub is never invoked, every finding keeps `category: "failed-test"`, and the quarantine report records the skip reason.
8. `[unit]` With `execution.flakeDetection.enabled == false`, triage returns findings unchanged and the probe stub is never invoked.
9. `[unit]` When the probe dependency throws, triage does not propagate the exception; the affected finding keeps `category: "failed-test"`.

### US-003 — Story-orchestrator full-suite-gate integration

1. `[unit]` **(Seam: US-002)** With the triage dependency stubbed, a full-suite-gate failure produces exactly one triage invocation whose input includes the gate's `failed-test` findings, before rectification findings are gathered.
2. `[unit]` When triage relabels every gate failure to `flaky-test`, no fix cycle is dispatched for the gate and the story proceeds as if the gate passed, with a warning recorded for each quarantined test.
3. `[unit]` When triage returns a mix of `flaky-test` and `failed-test` findings, the rectification fix cycle receives only the `failed-test` findings.
4. `[unit]` `gateFailureKeys` returns a key set that excludes findings with `category: "flaky-test"`.
5. `[unit]` `describeGateRegression` does not report a regression when the only difference between baseline and final gate findings is in `flaky-test` findings. (Covered by the `AC5:` describe block; renamed from `gateRegressedAfterRectification` by #1383.)
6. `[unit]` Each quarantine decision at the gate emits a structured log entry that includes the story id and the quarantined test's `${file}::${testName}` key.

### US-004 — Regression-gate integration

1. `[unit]` **(Seam: US-002)** With the triage dependency stubbed into the regression module's DI seam, a failing deferred regression suite produces a triage invocation whose input includes the regression run's `failed-test` findings.
2. `[unit]` When every regression failure is relabeled `flaky-test`, the deferred regression result reports success, and its report lists each quarantined test key as a warning.
3. `[unit]` A test relabeled `flaky-test` is excluded from responsible-story attribution: no story is attributed, and no fix cycle is dispatched, on the basis of a quarantined test alone.
4. `[unit]` With a mix of one genuine failure and one quarantined flake, exactly one per-story fix cycle is dispatched — for the story attributed to the genuine failure.
5. `[unit]` A test quarantined earlier in the same run (present in the shared run-scoped memo) is relabeled at the regression gate without a new probe invocation.
6. `[unit]` The deferred regression result includes the quarantine report (quarantined keys and reasons) when any test was quarantined.
