# SPEC: Suggested Criteria Hardening Pass

## Summary

After the main acceptance gate passes, run an optional hardening pass that tests debater-suggested acceptance criteria (`suggestedCriteria`) against the current implementation. Criteria that pass are promoted into the story's `acceptanceCriteria`; failures are logged and discarded. This captures the value of multi-agent debate (edge case discovery) without hallucinated ACs blocking the pipeline.

## Motivation

When plan debate is enabled with a synthesis resolver, the synthesizer sometimes invents acceptance criteria beyond the original spec (e.g. "throw on invalid status", "deep copy via JSON.stringify"). These hallucinated ACs enter `acceptanceCriteria` and drive the acceptance test pipeline, forcing implementations to match requirements the spec never stated.

The fix in `session-plan.ts` instructs the synthesizer to separate spec-anchored ACs (`acceptanceCriteria`) from debater-suggested ones (`suggestedCriteria`). But `suggestedCriteria` is currently dead data — never tested, never promoted. This spec gives it a purpose: a non-blocking post-acceptance hardening round.

## Design

### PRD Schema

Add optional `suggestedCriteria` to `UserStory`:

```typescript
export interface UserStory {
  // ... existing fields ...
  acceptanceCriteria: string[];
  /** Debater-suggested criteria beyond the spec — tested in hardening pass, never blocks pipeline. */
  suggestedCriteria?: string[];
}
```

Validation: when present, must be a non-empty `string[]`. Absent or `undefined` is valid (no suggestions).

### Test File Naming

Hardening tests are written to a **separate file** from main acceptance tests. The file name follows the same language-aware convention:

| Language | Main Acceptance | Hardening |
|----------|----------------|-----------|
| TypeScript (default) | `.nax-acceptance.test.ts` | `.nax-suggested.test.ts` |
| Go | `.nax-acceptance_test.go` | `.nax-suggested_test.go` |
| Python | `.nax-acceptance.test.py` | `.nax-suggested.test.py` |
| Rust | `.nax-acceptance.rs` | `.nax-suggested.rs` |

The config override `acceptance.suggestedTestPath` controls the hardening filename, mirroring `acceptance.testPath` for main acceptance:

```typescript
interface AcceptanceConfig {
  // ... existing fields ...
  testPath: string;              // Main acceptance file (existing)
  suggestedTestPath?: string;    // Hardening file — overrides language default
}
```

Path construction reuses `resolveAcceptancePackageFeatureTestPath()` with the suggested filename, so monorepo per-package scoping works identically.

### `test-path.ts` Changes

Add a parallel function for suggested test filenames:

```typescript
export function suggestedTestFilename(language?: string): string {
  switch (language?.toLowerCase()) {
    case "go":
      return ".nax-suggested_test.go";
    case "python":
      return ".nax-suggested.test.py";
    case "rust":
      return ".nax-suggested.rs";
    default:
      return ".nax-suggested.test.ts";
  }
}

export function resolveSuggestedTestFile(language?: string, testPathConfig?: string): string {
  return testPathConfig ?? suggestedTestFilename(language);
}

export function resolveSuggestedPackageFeatureTestPath(
  packageDir: string,
  featureName: string,
  testPathConfig?: string,
  language?: string,
): string {
  return path.join(packageDir, ".nax", "features", featureName, resolveSuggestedTestFile(language, testPathConfig));
}
```

### Hardening Runner

New module: `src/acceptance/hardening.ts`

```typescript
export interface HardeningResult {
  /** Suggested ACs that passed — safe to promote */
  promoted: string[];
  /** Suggested ACs that failed — discarded */
  discarded: string[];
  /** Total cost of the hardening pass */
  costUsd: number;
  /** Test output for audit */
  testOutput: string;
}

export async function runHardeningPass(options: {
  prd: PRD;
  featureName: string;
  featureDir: string;
  workdir: string;
  config: NaxConfig;
  agentGetFn?: (name: string) => AgentAdapter | undefined;
}): Promise<HardeningResult>
```

**Flow:**

1. **Collect** — Gather `suggestedCriteria` from all stories in the PRD. Skip if none exist.
2. **Refine** — Call `refineAcceptanceCriteria()` on the collected criteria (reuse existing refinement).
3. **Generate** — Call `generateFromPRD()` with the refined suggested criteria, writing to `.nax-suggested.test.ts` (or language equivalent). Pass `implementationContext` from the current implementation (the code already exists post-acceptance).
4. **Run** — Execute the suggested test file using `buildAcceptanceRunCommand()`. Parse results with `parseTestFailures()`.
5. **Promote** — For each story, move passing ACs from `suggestedCriteria` to `acceptanceCriteria` in `prd.json`. Remove promoted ACs from `suggestedCriteria`. If `suggestedCriteria` becomes empty, remove the field.
6. **Log** — Record promoted and discarded counts. No diagnosis, no source-fix.

### Integration Point

The hardening pass runs in `src/pipeline/stages/acceptance.ts` (the post-run acceptance stage), **after** the main acceptance gate passes:

```
Main acceptance → PASS → suggestedCriteria exists? → Yes → hardening pass
                → FAIL → diagnosis/fix loop (existing)
```

If the main acceptance fails, the hardening pass is skipped entirely. This ensures suggested criteria never interfere with the primary acceptance pipeline.

### Config

```json
{
  "acceptance": {
    "hardening": {
      "enabled": true,
      "promote": true
    },
    "suggestedTestPath": ".nax-suggested.test.ts"
  }
}
```

- `hardening.enabled` (default: `true` when `debate.enabled` is true, `false` otherwise) — run the hardening pass
- `hardening.promote` (default: `true`) — auto-promote passing ACs to `acceptanceCriteria`
- `suggestedTestPath` (default: language-aware filename) — override hardening test filename

When `hardening.enabled` is false but `suggestedCriteria` exists in the PRD, the field is preserved but ignored.

## Stories

### US-001: UserStory schema — add suggestedCriteria

Add `suggestedCriteria?: string[]` to `UserStory` interface in `src/prd/types.ts` and validation in `src/prd/schema.ts`.

**Acceptance Criteria:**
- `suggestedCriteria` is an optional field on `UserStory`
- When present, must be a non-empty `string[]`
- When absent or `undefined`, validation passes
- `suggestedCriteria: []` is treated as absent (stripped to `undefined`)
- Existing PRDs without `suggestedCriteria` parse and validate without changes

### US-002: Suggested test path helpers

Add `suggestedTestFilename()`, `resolveSuggestedTestFile()`, and `resolveSuggestedPackageFeatureTestPath()` to `src/acceptance/test-path.ts`.

**Acceptance Criteria:**
- `suggestedTestFilename()` returns `.nax-suggested.test.ts` for TypeScript, `.nax-suggested_test.go` for Go, `.nax-suggested.test.py` for Python, `.nax-suggested.rs` for Rust
- `resolveSuggestedTestFile()` uses config override when provided, language default otherwise
- `resolveSuggestedPackageFeatureTestPath()` returns `<packageDir>/.nax/features/<feature>/<filename>` — same structure as main acceptance
- Config schema accepts `acceptance.suggestedTestPath` as optional string

### US-003: Hardening runner

Implement `runHardeningPass()` in `src/acceptance/hardening.ts`.

**Acceptance Criteria:**
- Returns `{ promoted: [], discarded: [], costUsd: 0 }` when no stories have `suggestedCriteria`
- Refines suggested criteria using `refineAcceptanceCriteria()` (reuse, not duplicate)
- Generates test file at suggested test path using `generateFromPRD()` (reuse, not duplicate)
- Runs the test file and parses results using `parseTestFailures()`
- Passing ACs are listed in `promoted`, failing ACs in `discarded`
- When `promote: true`, updates `prd.json` — moves promoted ACs to `acceptanceCriteria`, removes from `suggestedCriteria`
- When `promote: false`, returns results but does not modify `prd.json`
- Never triggers diagnosis or source-fix — failures are expected and non-blocking

### US-004: Wire hardening into acceptance stage

Call `runHardeningPass()` from `src/pipeline/stages/acceptance.ts` after the main acceptance gate passes.

**Acceptance Criteria:**
- Hardening pass runs only when main acceptance passes AND `suggestedCriteria` exists in any story
- Hardening pass is skipped when main acceptance fails
- Hardening pass is skipped when `config.acceptance.hardening.enabled` is false
- Hardening failure does not change the pipeline outcome — stage still returns `continue`
- Promoted/discarded counts are logged
- Hardening cost is included in the stage's cost tracking
