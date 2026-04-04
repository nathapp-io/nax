# SPEC: Token Usage Metrics

## Summary

Store per-story and aggregate token usage in `metrics.json`, including input tokens, output tokens, and Anthropic cache token breakdowns.

## Motivation

`metrics.json` currently records `cost` (estimated USD) per story but not the underlying token counts. Token breakdowns enable:
- **Cost attribution** — understand which stories consume the most tokens
- **Cache efficiency** — `cache_read_input_tokens` vs `cache_creation_input_tokens` reveals cache hit rates
- **Budget planning** — predict costs from token volume patterns
- **Debugging** — compare input/output ratios across stories and models

The ACP adapter already accumulates token usage from `cumulative_token_usage` in acpx responses (`src/agents/acp/adapter.ts` lines 739-773). This data is computed but never persisted to metrics.

## Design

### `TokenUsage` type

New type in `src/metrics/types.ts`:

```typescript
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
```

### Extend `StoryMetrics`

Add optional `tokens` field:

```typescript
export interface StoryMetrics {
  // ... existing fields ...
  /** Token usage breakdown (when available from agent adapter) */
  tokens?: TokenUsage;
}
```

### Extend `RunMetrics`

Add optional aggregate `totalTokens` field:

```typescript
export interface RunMetrics {
  // ... existing fields ...
  /** Aggregate token usage across all stories */
  totalTokens?: TokenUsage;
}
```

### Thread token usage from ACP adapter → StoryMetrics

The ACP adapter's `run()` method already computes `totalTokenUsage` (lines 739-773 in `adapter.ts`). It returns `estimatedCost` but discards the token breakdown. The fix:

1. Add `tokenUsage?: TokenUsage` to `AgentRunResult` (or equivalent return shape from `adapter.run()`)
2. In the ACP adapter's `run()` method, include `totalTokenUsage` in the returned result alongside `estimatedCost`
3. In `collectStoryMetrics()` (`src/metrics/tracker.ts`), read `ctx.agentResult.tokenUsage` and set `storyMetrics.tokens`

### Aggregate in `saveRunMetrics()`

When writing `RunMetrics`, sum all `story.tokens` into `totalTokens`:

```typescript
const totalTokens: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
for (const story of stories) {
  if (story.tokens) {
    totalTokens.input_tokens += story.tokens.input_tokens;
    totalTokens.output_tokens += story.tokens.output_tokens;
    totalTokens.cache_read_input_tokens! += story.tokens.cache_read_input_tokens ?? 0;
    totalTokens.cache_creation_input_tokens! += story.tokens.cache_creation_input_tokens ?? 0;
  }
}
```

Omit `totalTokens` from output if all values are 0 (no token data available — e.g. CLI adapter).

### Failure handling

- CLI adapter does not provide token usage → `tokens` field absent from `StoryMetrics` (optional field, backward compat)
- Zero cache tokens → omit `cache_read_input_tokens` and `cache_creation_input_tokens` from output
- Existing `metrics.json` without `tokens`/`totalTokens` → loads without error (all new fields optional)

## Stories

### US-001: `TokenUsage` type and `StoryMetrics.tokens` field

**Depends on:** none

Add `TokenUsage` interface to `src/metrics/types.ts`. Add optional `tokens?: TokenUsage` to `StoryMetrics`. Add optional `totalTokens?: TokenUsage` to `RunMetrics`.

**Acceptance Criteria:**
1. `TokenUsage` interface exported from `src/metrics/types.ts` with `input_tokens: number`, `output_tokens: number`, `cache_read_input_tokens?: number`, `cache_creation_input_tokens?: number`
2. `StoryMetrics.tokens` is optional `TokenUsage`
3. `RunMetrics.totalTokens` is optional `TokenUsage`
4. Existing code compiles without changes (all fields optional)
5. `TokenUsage` re-exported from `src/metrics/index.ts`

### US-002: Thread token usage from ACP adapter through to metrics

**Depends on:** US-001

Return `totalTokenUsage` from the ACP adapter's `run()` method in the agent result. In `collectStoryMetrics()`, read token usage from the agent result and populate `storyMetrics.tokens`.

**Acceptance Criteria:**
1. ACP adapter `run()` return includes `tokenUsage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` from accumulated session data
2. `collectStoryMetrics()` reads `ctx.agentResult.tokenUsage` and sets `storyMetrics.tokens` when present
3. When `ctx.agentResult.tokenUsage` is absent (CLI adapter), `storyMetrics.tokens` is undefined
4. When `cache_read_input_tokens` and `cache_creation_input_tokens` are both 0, they are omitted from the `tokens` object

### US-003: Aggregate `totalTokens` in `saveRunMetrics()`

**Depends on:** US-002

Sum all `story.tokens` into `RunMetrics.totalTokens` before writing to disk. Omit `totalTokens` when no stories have token data.

**Acceptance Criteria:**
1. `saveRunMetrics()` computes `totalTokens` by summing all `story.tokens` fields
2. `totalTokens.input_tokens` equals sum of all `story.tokens.input_tokens`
3. `totalTokens.cache_read_input_tokens` equals sum of all `story.tokens.cache_read_input_tokens` (treating undefined as 0)
4. When no stories have `tokens` data, `totalTokens` is absent from written `RunMetrics`
5. Existing `metrics.json` without `totalTokens` loads without error via `loadRunMetrics()`

### Context Files
- `src/metrics/types.ts` — `StoryMetrics`, `RunMetrics` interfaces
- `src/metrics/tracker.ts` — `collectStoryMetrics()`, `saveRunMetrics()`
- `src/metrics/index.ts` — barrel exports
- `src/agents/acp/adapter.ts` — `run()` method, `totalTokenUsage` accumulation (lines 739-773)
- `src/pipeline/types.ts` — `AgentRunResult` or equivalent return type
