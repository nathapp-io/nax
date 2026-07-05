# Mutation Spot-Check Gate — Design

**Date:** 2026-07-05
**Feature:** `mutation-spot-check`
**Repo:** `repos/nax` (branch `feat/mutation-spot-check`)
**Origin:** `projects/nax/nax-feature-suggestions-2026-07-04.md` §2.6 (Tier-2 #4), next arc after `nax replay` (PR #1304) shipped. Suggested build order: flaky-quarantine ✅ → pytest/go parsers ✅ → bake-off ✅ → replay ✅ → **mutation spot-checks**.

---

## 1. Purpose

nax's premise is TDD discipline: the test-writer authors tests first, and the RED gate (`greenfield-gate`) proves tests *exist* before implementation. But nothing verifies the tests can **fail meaningfully**. A vacuous or over-mocked agent-written test passes GREEN while catching no real bug.

The mutation spot-check gate closes that hole. After a story reaches GREEN (its tests pass), nax deterministically mutates a small number of lines **within the story's changed source diff**, re-runs the story's **targeted** tests against each mutant, and classifies the outcome. A **surviving mutant** (tests cleanly pass despite an injected bug) yields an **advisory warning** — it never blocks the run.

**Design ethos:** smallest blast radius, deterministic, zero added LLM/token cost — consistent with `greenfield-gate` (a `DeterministicOperation`) and the flaky-quarantine / replay arcs.

### Explicit non-goals (deferred to follow-up arcs)

- **Soft gate → rectification.** This arc is advisory only. Feeding a surviving mutant back to the implementer as a finding ("strengthen your tests") is a later arc, gated behind the false-alarm rate we observe from the advisory signal.
- **Python / Go mutation operators.** The polyglot adapter seam ships now, but only the TS/JS operator table is populated. `python` and `go` tables are stubbed empty — the gate is a clean no-op for those languages until a fast-follow arc fills them.
- **Coverage-guided mutant selection.** We prefer mutating lines within the story's changed diff (a cheap reachability heuristic) rather than collecting per-story coverage data.
- **Exhaustive mutation testing.** This is a *spot-check* — a bounded sample of mutants, not full mutation-score computation.

---

## 2. Key Decisions (locked in brainstorming)

| # | Decision | Choice |
|:--|:---------|:-------|
| Q1 | Enforcement on a surviving mutant | **Advisory** — warning only, never blocks. Soft gate deferred. |
| Q2 | Language scope | **Polyglot adapter seam, TS/JS first**, Python/Go stubbed. |
| Q3 | Tests run against a mutant | **Targeted** — the story's own tests only (via `selectScopedTests`). |
| Q4 | Mutants per story | **Fixed default 3**, config-overridable (`mutationCheck.maxMutants`). |
| — | Mutation generation | **Deterministic operator table** (approach A) — no LLM. |
| — | Integration point | **Phase** in `CANONICAL_ORDER` after `full-suite-gate` (replay visibility); always returns `success: true`. |
| — | Default `enabled` | **`false` (opt-in)** — the gate adds ≤3 targeted test runs per story. |

---

## 3. Architecture & Components

New module `src/verification/mutation/` (barrel `index.ts`), each unit single-purpose:

### `operators.ts` — mutation-operator tables (per language)

```typescript
interface MutationOperator {
  id: string;            // e.g. "comparison-gt-to-lt"
  match: RegExp;         // matches the token on a source line
  replace: string;      // replacement token
}
```

- **TS/JS table (populated):** comparison flips (`>` ↔ `<`, `>=` ↔ `<=`, `===` ↔ `!==`), boolean-literal negation (`true` ↔ `false`), arithmetic swaps (`+` ↔ `-`, `*` ↔ `/`), conditional / return-value inversion.
- **`python` / `go` tables (stubbed empty)** — adapter seam present, no operators yet.

Language-neutrality (rule B): operators are gated behind `detectLanguage(packageDir)`; unknown languages resolve to an empty table.

### `mutator.ts` — `generateMutants(changedLines, language, max)`

Selects candidate lines from the story's changed source diff, applies operators, returns up to `max` concrete mutants:

```typescript
interface Mutant {
  file: string;          // absolute path
  line: number;          // 1-indexed
  before: string;        // original line content
  after: string;         // mutated line content
  operatorId: string;
}
```

Returns `[]` for unsupported languages (clean no-op) and when no line matches any operator.

### `apply.ts` — apply / revert a single mutant

`applyMutant(mutant)` writes the mutated file via `Bun.write`; `revertMutant(mutant)` restores the original content. **Revert always runs** — in a `finally`, even when the test run throws — so the working tree is never left mutated.

### `classify.ts` — `classifyMutant(result): MutantOutcome`

Maps a re-run `VerificationResult` to one of:

- **`killed`** — at least one test *failed* → tests are meaningful. Good.
- **`survived`** — all tests cleanly *passed* despite the mutation → the advisory warning we emit.
- **`errored`** — the mutant broke compilation, or the runner errored rather than a test failing → **inconclusive; discarded** (never counted as `survived`). This is the primary false-alarm guard (approach A's 3-outcome rule).

### `src/operations/mutation-check.ts` — `mutationCheckOp`

A `DeterministicOperation` (`stage: "verify"`), shaped like `greenfieldGateOp` but *executing* tests like `verifyScopedOp`. It orchestrates the flow in §4. Because the gate is advisory, it **always returns `success: true`**; surviving mutants are attached as `warnings` on the operation output. Config slice via a named selector on `execution` (mirrors `greenfield-gate`).

### Integration into the story orchestrator

- New `PhaseKind: "mutation-check"` in `src/execution/story-orchestrator/types.ts` `CANONICAL_ORDER`, inserted **immediately after `full-suite-gate`** and before `verifier`. (Also after `verify-scoped` on the non-TDD path.)
- `PHASE_KIND_TO_STATE_KEY` + `InternalBuildState` field added. **Not** added to `STRICT_VERDICT_PHASE_NAMES` — it is advisory, not a strict pass/fail gate.
- `addMutationCheck()` builder method (mirrors `addFullSuiteGate`), wired in `src/execution/build-plan-for-strategy.ts`; input assembled in `src/execution/plan-inputs.ts` (carries `storyGitRef`, `packageDir`, `resolvedTestPatterns`, `repoRoot`, `mutationCheck` config slice).

Because the phase loop already short-circuits on the first failing phase, GREEN (`full-suite-gate`) is guaranteed to have passed before `mutation-check` runs. Because `mutation-check` always passes, it never short-circuits `verifier` / reviews downstream. Its visible slot in the story timeline is surfaced for free by `nax replay`.

---

## 4. Data Flow

```
full-suite-gate PASSES (GREEN)
  → mutationCheckOp.execute(input)
       input: { storyGitRef, workdir, packageDir, resolvedTestPatterns, config.mutationCheck }
  → if !config.mutationCheck.enabled  → return { success: true }        // opt-in
  → language = detectLanguage(packageDir)
  → changed = getChangedNonTestFiles(workdir, storyGitRef, …)           // story's changed source
  → mutants = generateMutants(changedLines(changed), language, maxMutants)   // ≤ 3
  → if mutants.length === 0  → return { success: true }                 // no-op (unsupported lang / no match)
  → survivors = []
    for (const mutant of mutants) {
       applyMutant(mutant)
       try {
         scoped = selectScopedTests({ changedFiles: [mutant.file], … })
         result = await regression(scoped)                              // targeted re-run
         outcome = classifyMutant(result)
         if (outcome === "survived") survivors.push(mutant)
         // "errored" → discarded; "killed" → good
       } finally {
         revertMutant(mutant)                                           // always
       }
    }
  → for each survivor: logger.warn("mutation-check", …, { storyId, file, line, operatorId })
  → return { success: true, warnings: survivors.map(describe) }
```

Per-mutant test runs are capped by `mutationCheck.timeoutSeconds` (passed to `regression`'s executor).

---

## 5. Config

New `MutationCheckConfigSchema` in `src/config/schemas-execution.ts`, mounted on `ExecutionConfigSchema` via `.default({...})`; merge-spread in `src/config/merge.ts` (alongside `flakeDetection`); named selector in `src/config/selectors.ts`. Defaults live in the Zod schema per `config-patterns.md`.

```typescript
mutationCheck: {
  enabled: boolean;        // default: false   (opt-in — adds ≤ maxMutants targeted test runs per story)
  maxMutants: number;      // default: 3        (spot-check bound)
  timeoutSeconds: number;  // per-mutant test-run cap; default falls back to the story test timeout when unset
}
```

Per-package overridable via `.nax/mono/<packageDir>/config.json` (design rule A), resolved through the standard layering.

---

## 6. Testing

Deterministic operators make this highly unit-testable — no LLM, no flakiness:

- **`operators` / `mutator`** — table-driven (`test.each`): given a source line + language, assert the exact mutants produced; assert `[]` for `python` / `go` / unknown languages and for lines matching no operator.
- **`classify`** — `killed` / `survived` / `errored` mapping from synthetic `VerificationResult`s (test failure → killed; clean pass → survived; compile error / runner error → errored).
- **`apply`** — round-trip `applyMutant` → `revertMutant` leaves the file byte-identical; revert runs even when the interleaved test call throws.
- **`mutationCheckOp`** — integration with injected `_deps` fakes for `getChangedNonTestFiles` / `selectScopedTests` / `regression`:
  - a surviving mutant → one warning + `success: true`;
  - an all-killed story → no warnings + `success: true`;
  - `enabled: false` → immediate no-op, no test runs;
  - unsupported language / no candidate lines → clean no-op;
  - an `errored` mutant is never reported as a survivor.

All test files follow `test-architecture.md` (directory mirroring, `_deps` injection, no `mock.module`).

---

## 7. Files Touched (summary)

**New:**
- `src/verification/mutation/{index,operators,mutator,apply,classify,types}.ts`
- `src/operations/mutation-check.ts`
- `test/unit/verification/mutation/*.test.ts`, `test/unit/operations/mutation-check.test.ts`

**Modified:**
- `src/execution/story-orchestrator/types.ts` — `PhaseKind`, `CANONICAL_ORDER`, `PHASE_KIND_TO_STATE_KEY`, `InternalBuildState`
- `src/execution/story-orchestrator/builder.ts` — `addMutationCheck()`
- `src/execution/build-plan-for-strategy.ts`, `src/execution/plan-inputs.ts` — plan wiring
- `src/config/schemas-execution.ts`, `src/config/merge.ts`, `src/config/selectors.ts` — config
- `src/operations/index.ts`, `src/verification/index.ts` — barrels
