# SPEC: Scope Test Threshold — Full Suite Fallback

## Summary

When the scoped test runner detects a large number of changed files (exceeding a configurable threshold), fall back to `quality.commands.test` (full suite) instead of running scoped tests, and log a warning.

## Motivation

The scoped test strategy (`src/verification/strategies/scoped.ts`) maps changed source files to test files via path convention and import-grep. This is efficient for small scopes (1-5 files). But when a story touches many files (e.g. >10), the scoped set approaches the full suite anyway — and may miss regressions in unchanged-but-affected files. Running the full suite is more reliable and often not slower in these cases.

Currently there is no threshold check. The scoped runner always builds a targeted command regardless of scope size.

## Design

### Config: `quality.scopeTestThreshold`

Add a new optional field to the quality config:

```typescript
// In QualityConfigSchema
scopeTestThreshold: z.number().int().min(1).default(10),
```

When the number of **changed source files** (from `getChangedSourceFiles()`) exceeds this threshold, the scoped strategy falls back to the full suite command.

### Fallback logic in `ScopedStrategy.verify()`

Insert the threshold check after `getChangedSourceFiles()` returns, before mapping to test files:

```typescript
const sourceFiles = await _scopedDeps.getChangedSourceFiles(ctx.workdir, ctx.storyGitRef);
const threshold = ctx.effectiveConfig?.quality?.scopeTestThreshold ?? 10;

if (sourceFiles.length > threshold) {
  logger.warn("verify[scoped]", `Scope contains ${sourceFiles.length} files (threshold: ${threshold}) — running full suite instead`, {
    storyId: ctx.storyId,
    fileCount: sourceFiles.length,
    threshold,
  });
  // Fall through to full suite execution using quality.commands.test
  const result = await _scopedDeps.regression({ ... quality.commands.test ... });
  return makeResult(ctx.storyId, "scoped", result, { scopeTestFallback: true });
}
```

### Story metric: `scopeTestFallback`

Add an optional boolean to `StoryMetrics`:

```typescript
// In StoryMetrics
scopeTestFallback?: boolean;  // true when scoped test fell back to full suite due to threshold
```

This is set by the scoped strategy when fallback occurs, propagated through the verify stage result metadata.

### Failure handling

- `getChangedSourceFiles()` returns empty array on error → threshold not triggered (0 ≤ threshold), proceeds to existing "no mapped tests" path
- Threshold of 1 effectively disables scoped testing (always full suite)
- Default threshold 10 preserves current behavior for typical stories

## Stories

### US-001: Config field + threshold check + warning log

**Depends on:** none

Add `quality.scopeTestThreshold` to `QualityConfigSchema` with default 10. In `ScopedStrategy.verify()`, after `getChangedSourceFiles()`, check source file count against threshold. When exceeded, log a warning with file count and threshold, then execute `quality.commands.test` (full suite) instead of building scoped command.

**Acceptance Criteria:**
1. `NaxConfigSchema.parse({}).quality.scopeTestThreshold === 10`
2. `NaxConfigSchema.parse({ quality: { scopeTestThreshold: 5 } }).quality.scopeTestThreshold === 5`
3. `ScopedStrategy.verify()` with 3 source files and threshold 10 proceeds to scoped test mapping (no fallback)
4. `ScopedStrategy.verify()` with 12 source files and threshold 10 executes `quality.commands.test` instead of scoped command
5. When fallback triggers, `logger.warn("verify[scoped]", ...)` is called with message containing file count and threshold
6. When fallback triggers, the test command used is `quality.commands.test` (not the scoped file list)

### US-002: Story metric `scopeTestFallback` flag

**Depends on:** US-001

When `ScopedStrategy.verify()` falls back to full suite due to threshold, set `scopeTestFallback: true` on the verify result metadata so it propagates to `StoryMetrics`.

**Acceptance Criteria:**
1. `StoryMetrics` interface includes optional `scopeTestFallback?: boolean`
2. When scoped strategy falls back due to threshold, the returned verify result includes `scopeTestFallback: true` in metadata
3. `collectStoryMetrics()` propagates `scopeTestFallback` from verify result to `StoryMetrics`
4. When scoped strategy runs normally (no fallback), `scopeTestFallback` is absent from `StoryMetrics`

### Context Files
- `src/verification/strategies/scoped.ts` — `ScopedStrategy.verify()`, threshold check insertion point
- `src/verification/smart-runner.ts` — `getChangedSourceFiles()`, `buildSmartTestCommand()`
- `src/config/schemas.ts` — `QualityConfigSchema`, add `scopeTestThreshold`
- `src/metrics/types.ts` — `StoryMetrics` interface
- `src/metrics/tracker.ts` — `collectStoryMetrics()`, propagate fallback flag
