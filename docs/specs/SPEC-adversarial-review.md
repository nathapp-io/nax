# SPEC: Adversarial Review Check (REVIEW-002)

## Summary

Add an LLM-based `adversarial` review check that runs alongside the existing `semantic` check as a second, independently-prompted review lens. Where semantic review asks *"does this satisfy the acceptance criteria?"*, adversarial review asks *"where does this break, and what did the implementer stop short of finishing?"* The two checks are complementary — semantic is constructive and intent-based; adversarial is destructive and risk-based. Both emit findings into the same `reviewFindings[]` pipeline context; the existing autofix/rectification loop consumes the union.

## Motivation

`logs/code-quality-gap.md` documented four blind spots that landed in PR 384/385 despite passing all existing checks (typecheck, lint, test, build, semantic):

1. A `_role` constructor parameter silently discarded — "fixed" by renaming to `_role` rather than using it
2. A missing `one-shot-builder.test.ts` sibling file — audit gap, not a visible failure
3. Dual import styles (barrel vs deep path) mixed in the same module
4. `_`-prefixed parameters used as a "done" signal rather than a correctness fix

None of these are caught by the existing stack:

- **Lint/typecheck/build** — all pass. These are not syntactic defects.
- **Semantic review** — its prompt (`src/prompts/builders/review-builder.ts:17-36`) explicitly scopes itself to AC verification and excludes anything "lint handles," which a reviewing LLM interprets as *"only flag AC violations."* An AC like *"builder produces a valid prompt"* is satisfied even when half the constructor arguments are discarded.
- **Debate (`debate.stages.review`)** — has adversarial personas (`src/debate/personas.ts:13-49`: `challenger`, `completionist`, `testability`) but is a heavier mechanism (multi-debater + synthesizer, 4–6 sessions per review) that runs only when explicitly enabled, not the default review path.

The common thread across the four gaps is **signals of incomplete implementation**: work that was started, got to compile, and was abandoned before being carried through. An AC-verifier cannot catch this because an AC can be satisfied by half-abandoned code. A reviewer with an explicit mandate to look for weakness catches all four as a single category.

### Why not just improve the semantic prompt

Explored and rejected. Folding adversarial responsibilities into the semantic prompt asks one LLM call to hold two conflicting cognitive stances simultaneously: confirmation ("does it work?") and skepticism ("where does it break?"). In practice, LLMs default to one stance and pay lip service to the other, diluting both. The two lenses are genuinely distinct and deserve distinct prompts.

### Why not a checklist of custom rules via `semantic.rules`

Explored and rejected. A custom rule list encodes today's known gaps and misses tomorrow's novel abandonment patterns. A separate reviewer with a mandate to *probe for weakness as a category* generalizes. Heuristics inside the adversarial prompt serve as illustrative anchors, not pattern matches.

## Non-Goals

- **No new human-gate primitive.** Nax is autonomous-first. Unresolved reviewer disagreements flow through the existing tier-escalation ladder (fast → balanced → powerful), not a new "pause for human review" state.
- **No replacement of semantic review.** Semantic review stays as-is. Adversarial is additive.
- **No merging with debate.** Debate remains a separate, heavier mechanism controlled via the top-level `debate` config. Adversarial is a lightweight single-call review, not a multi-agent proposal/synthesis flow.
- **No pre-detection of reviewer conflicts.** Regex-matching "add X" vs "remove X" in finding suggestions is too fragile. The rectifier's own LLM reasoning handles contradictions at fix time.
- **No default-on rollout.** Ships off by default; opt-in via `review.checks` array membership.

## Design

### Where It Fits

Adversarial review is a new **review check** — same level as `typecheck`, `lint`, `test`, `build`, `semantic`. It runs inside the existing review stage via `runReview()` (`src/review/runner.ts`), alongside semantic review.

```
Pipeline: execute → verify → rectify → review → autofix
                                          ↓
                              typecheck → lint → build → semantic → adversarial
                                                            ↓           ↓
                                                         findings[]  findings[]
                                                            ↓           ↓
                                                      ctx.reviewFindings (union)
```

### Config

Mirrors the existing `SemanticReviewConfigSchema` shape. Enablement is via membership in `review.checks`, not a separate `enabled` flag.

```json
{
  "review": {
    "checks": ["typecheck", "lint", "semantic", "adversarial"],
    "semantic": {
      "modelTier": "balanced",
      "rules": []
    },
    "adversarial": {
      "modelTier": "balanced",
      "rules": [],
      "timeoutMs": 180000,
      "excludePatterns": [],
      "parallel": false,
      "maxConcurrentSessions": 2,
      "maxRetries": 2
    }
  }
}
```

Schema additions in `src/config/schemas.ts`:

```typescript
// 1. Extend ReviewCheckName union
checks: z.array(z.enum([
  "typecheck", "lint", "test", "build",
  "semantic",
  "adversarial",   // new
]))

// 2. Add AdversarialReviewConfigSchema (mirrors SemanticReviewConfigSchema)
const AdversarialReviewConfigSchema = z.object({
  modelTier: ModelTierSchema.default("balanced"),
  rules: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(10_000).default(180_000),
  excludePatterns: z.array(z.string()).default([]),

  // New fields specific to adversarial
  parallel: z.boolean().default(false),
  maxConcurrentSessions: z.number().int().min(1).default(2),
  maxRetries: z.number().int().min(1).default(2),
});

// 3. Attach as optional sub-config on ReviewConfigSchema
adversarial: AdversarialReviewConfigSchema.optional(),
```

**Defaults justification:**
- `parallel: false` — conservative rollout. Users opt into parallelism once they have hardware headroom.
- `maxConcurrentSessions: 2` — caps effective concurrency when semantic+debate is combined with adversarial. See **Concurrency Guardrail** below.
- `maxRetries: 2` — prevents runaway rectifier ↔ reviewer loops. Two passes after autofix is enough to verify the fix landed without burning cost on oscillating opinions.
- `modelTier: "balanced"` — matches semantic default; adversarial quality is sensitive to model strength, don't default to cheap.

**Debate stays out of this config block.** If users want debate on adversarial review, they configure it under the top-level `debate.stages` namespace, same as today for semantic. No nesting.

### Execution Modes

Three modes driven by `review.adversarial.parallel` and `maxConcurrentSessions`:

| Mode | Trigger | Behavior | Peak sessions | Wall-clock |
|:---|:---|:---|:---|:---|
| **Disabled** | `"adversarial"` not in `checks` | No change from today | 1 (semantic) | 1x baseline |
| **Sequential** | `checks` includes both, `parallel: false` | `await semantic(); await adversarial();` | 1 at a time | ~2x |
| **Parallel** | `checks` includes both, `parallel: true`, effective concurrency ≤ cap | `Promise.all([semantic, adversarial])` | 2 | ~1x |
| **Forced sequential** | `parallel: true` but cap exceeded (e.g. semantic+debate) | Falls back to sequential | ≤ cap | ~2x |

**Concurrency guardrail.** Before scheduling, compute effective session count:

```typescript
const semSessions = isDebateEnabledFor("review") ? debateConfig.debaters.length + 1 : 1
const advSessions = 1   // adversarial itself; debate-on-adversarial is out of scope
const canParallelize =
  advConfig.parallel && (semSessions + advSessions) <= advConfig.maxConcurrentSessions
```

This prevents the blow-up case where semantic has 4 debaters + synthesizer running in parallel with adversarial, producing 5+ concurrent `agent.run()` sessions contending for memory, rate limits, and the logger JSONL file.

### LLM Prompt — Adversarial Role

New builder at `src/prompts/builders/adversarial-review-builder.ts`, parallel to `ReviewPromptBuilder`. Types imported from `src/review/types.ts` to avoid the same circular-dependency trap documented in `review-builder.ts:7-9`.

```typescript
const ADVERSARIAL_ROLE =
  "You are an adversarial code reviewer with access to the repository files. " +
  "Your job is NOT to confirm correctness — semantic review handles that. " +
  "Your job is to find what is wrong, what is missing, and what the implementer " +
  "stopped short of finishing.";

const ADVERSARIAL_INSTRUCTIONS = `## Instructions

Assume the implementer was optimistic and stopped as soon as the happy path
worked. Your mandate is to break that optimism by looking for signals of
incomplete implementation, fragile assumptions, and unhandled weakness.

**Before reporting any finding as "error", you MUST verify it using your tools:**
- READ the relevant file to confirm the code actually looks the way you think.
- GREP for wiring/callers before claiming something is unused or unreferenced.
- Do NOT flag something based solely on its absence from the diff — it may
  already exist in the codebase. Check the actual file first.
- If you cannot verify a claim even after checking, use "unverifiable" severity.

The questions you are answering:

1. **Input handling.** What inputs will this mishandle? (empty, null, unicode,
   very large, concurrent, malformed)
2. **Error paths.** What failure modes exist but are not exercised, propagated,
   or surfaced to the caller?
3. **Abandonment signals.** What did the implementer accept but not actually
   use — parameters silently discarded, arguments renamed with a \`_\` prefix
   to suppress linter warnings, options passed through and ignored, TODO/FIXME
   left on the hot path?
4. **Test audit gap.** What new exported unit (class, builder, handler, function)
   was added without a corresponding test file? Use the test-file inventory
   provided below.
5. **Convention breaks.** What pattern exists elsewhere in this module that
   this code doesn't follow? (import style, error wrapping, logger usage,
   naming)
6. **Load-bearing assumptions.** What assumption is critical but unchecked?
   (type narrowing, non-null, ordering, uniqueness)

These are **heuristics, not an exhaustive checklist** — apply judgment. The
underlying question you are answering is: "does this look like someone finished
the job, or like someone got it to compile and moved on?"

Severity:
- "error" — you are confident this will cause a real failure or regression
- "warn" — the code is fragile or incomplete but may ship
- "info" — a note worth considering but not actionable
- "unverifiable" — you suspect a problem but could not confirm it`;

const ADVERSARIAL_OUTPUT_SCHEMA = `Respond with JSON only:
{
  "passed": boolean,
  "findings": [
    {
      "severity": "error" | "warn" | "info" | "unverifiable",
      "category": "input" | "error-path" | "abandonment" | "test-gap" | "convention" | "assumption",
      "file": "path/to/file",
      "line": 42,
      "issue": "description of the weakness",
      "suggestion": "how to strengthen it"
    }
  ]
}

If the implementation looks complete and robust, respond with
{ "passed": true, "findings": [] }.`;
```

**Prompt structure differences from semantic:**

1. **Sees the full diff, not prod-only.** Test files must be visible so test-audit questions can be answered. See **Diff Sharing** below.
2. **Receives a test-file inventory block** — a mechanically computed list of new source files without a matching test file. Computed once, not LLM-generated:

    ```
    ## Test files in this changeset
    - test/unit/prompts/rectifier-builder.test.ts (added)
    - test/unit/prompts/acceptance-builder.test.ts (modified)

    ## New source files without a matching test file
    - src/prompts/builders/one-shot-builder.ts
    ```

3. **Has a `category` field** in findings, absent in semantic's output schema. Used for metrics attribution and log filtering, not for rectifier priority. Semantic's schema stays backward-compatible; adversarial's is a superset.

### Diff Sharing

Semantic currently receives a prod-only diff via `truncateDiff` (`src/review/semantic.ts`). Adversarial needs the full diff. To avoid computing the diff twice and risking drift:

1. `reviewStage` (or its caller) computes **one full diff and one prod-only diff** before dispatching either reviewer.
2. Both are cached on `PipelineContext`:

    ```typescript
    interface PipelineContext {
      // ...existing fields
      reviewDiffFull?: string       // all files, used by adversarial
      reviewDiffProdOnly?: string   // test files stripped, used by semantic
    }
    ```

3. Semantic continues to receive `reviewDiffProdOnly`; adversarial receives `reviewDiffFull` plus the pre-computed test inventory.
4. The test-file inventory is computed alongside the diff step:

    ```typescript
    interface ReviewDiffArtifacts {
      full: string
      prodOnly: string
      testInventory: {
        addedTestFiles: string[]
        modifiedTestFiles: string[]
        newSourceFilesWithoutTests: string[]
      }
    }
    ```

    The `newSourceFilesWithoutTests` computation is a simple sibling-path check: for each `src/foo/bar.ts` added in the diff, check whether `test/**/bar.test.ts` exists or was added. Pure file-system logic, no LLM involvement.

### Session Role

Nax already has a `sessionRole: string` field on `AgentRunOptions` and `CompleteOptions` (`src/agents/types.ts:84,158`), used by the ACP adapter to build sidecar keys (`src/agents/acp/adapter.ts:350,736`). This is the correct primitive.

New session role values:

- `"reviewer-semantic"` — semantic review session (migration of existing `"reviewer"` value used today, or a new value — see **Migration** below)
- `"reviewer-adversarial"` — adversarial review session

Passed at call sites:

```typescript
await agent.run({
  sessionRole: "reviewer-adversarial",
  prompt: adversarialPrompt,
  // ...
})
```

This gives sidecar-level session isolation for free: distinct ACP session names, independent sidecar directories, correct scoping in logs and metrics.

### Logger — Promote `sessionRole` to First-Class Field

**Problem.** Under parallel execution, semantic and adversarial review sessions emit log entries concurrently to the same JSONL file. The existing `storyId`-first-key convention (CLAUDE.md project rule) correlates entries to a story but cannot distinguish semantic's log line from adversarial's. The adapter passes `sessionRole` into the agent session but the logger does not capture it in `LogEntry` (`src/logger/logger.ts:85-92`).

**Solution.** Promote `sessionRole` to a first-class `LogEntry` field, mirroring the prior elevation of `storyId`.

```typescript
interface LogEntry {
  timestamp: string
  level: LogLevel
  stage: string
  message: string
  storyId?: string
  sessionRole?: string   // NEW — first-class
  data?: Record<string, unknown>
}
```

Logger write path accepts `sessionRole` as a structured argument alongside `storyId`:

```typescript
logger.info("review", "Starting adversarial pass", {
  storyId: ctx.story.id,
  sessionRole: "reviewer-adversarial",
})
```

**Migration strategy.** Non-breaking.

1. Add the field as optional on `LogEntry`.
2. Update review-stage log call sites first (smallest surface, highest payoff — parallel correlation is the whole point).
3. Allow other stages to migrate from `data.sessionRole` to the first-class field opportunistically. No forced big-bang rename.
4. Update CLAUDE.md rules: *"Review-stage log calls must include `sessionRole` in addition to `storyId`. Other stages may include it."*

**Why not thread `sessionRole` automatically from `agent.run()` into log entries?** The two systems are loosely coupled. The adapter that spawns a session is not the same object that emits pipeline-stage logs. Threading would require either a global AsyncLocalStorage-style context (heavy, new infrastructure) or passing `sessionRole` through every function on the call path (intrusive). Making the field explicit at log sites is the pragmatic compromise.

### Orchestration Flow

Change in `src/review/orchestrator.ts`:

```typescript
async function runReviewChecks(ctx: PipelineContext, config: ReviewConfig) {
  const checks = config.checks
  const hasSemantic    = checks.includes("semantic")
  const hasAdversarial = checks.includes("adversarial")

  // Run non-LLM checks (typecheck, lint, build, test) as today — unchanged
  const staticResults = await runStaticChecks(ctx, checks)

  // Compute diff artifacts once, cache on ctx
  if (hasSemantic || hasAdversarial) {
    const artifacts = await computeReviewDiffArtifacts(ctx)
    ctx.reviewDiffFull = artifacts.full
    ctx.reviewDiffProdOnly = artifacts.prodOnly
    ctx.reviewTestInventory = artifacts.testInventory
  }

  // Dispatch semantic + adversarial
  const llmResults = await runLlmReviewers(ctx, config, { hasSemantic, hasAdversarial })

  return mergeFindings(staticResults, llmResults)
}

async function runLlmReviewers(ctx, config, flags) {
  const advConfig = config.adversarial
  const canParallelize = flags.hasSemantic && flags.hasAdversarial
    && advConfig?.parallel === true
    && effectiveConcurrency(config) <= (advConfig?.maxConcurrentSessions ?? 2)

  if (canParallelize) {
    const [sem, adv] = await Promise.all([
      flags.hasSemantic    ? runSemanticReview(ctx, config)    : Promise.resolve(null),
      flags.hasAdversarial ? runAdversarialReview(ctx, config) : Promise.resolve(null),
    ])
    return combineFindings(sem, adv)
  }

  // Sequential fallback — also covers cap-exceeded case
  const sem = flags.hasSemantic    ? await runSemanticReview(ctx, config)    : null
  const adv = flags.hasAdversarial ? await runAdversarialReview(ctx, config) : null
  return combineFindings(sem, adv)
}
```

### Findings Handling

Both reviewers emit into `ctx.reviewFindings[]`. Findings are **not deduped** at the orchestrator level — two reviewers flagging overlapping concerns is valuable corroboration, and automated deduplication by `(file, line±N)` is fragile because LLMs report approximate line numbers and can wrongly merge unrelated findings.

Every finding gains a `source` field for attribution and metrics:

```typescript
interface ReviewFinding {
  severity: "error" | "warn" | "info" | "unverifiable"
  source: "semantic" | "adversarial"   // NEW
  category?: string                    // adversarial-only: "input" | "error-path" | ...
  file: string
  line?: number
  issue: string
  suggestion?: string
}
```

**`source` is metadata only.** The rectifier MUST NOT treat one source as higher-priority than the other. If there's a genuine conflict, the rectifier reasons from finding content, not origin. No "semantic always wins" rules anywhere in the fix path.

### Conflict Handling

Most apparent "conflicts" between semantic and adversarial are one of:

1. **Overlap** (same defect, two framings) — ~80%. Not a conflict. Let both flow through; the rectifier treats them as corroborating signal.
2. **Scope disagreement** (adversarial flags a test gap that semantic didn't touch) — ~15%. Not a conflict. Adversarial's mandate extends beyond AC; silence from semantic is not disagreement.
3. **True contradiction** (fix for one breaks the other) — ~5%. The only case requiring resolution logic.

**Resolution strategy for true contradictions: rectifier arbitration with escalation fallback.**

No pre-detection at the orchestrator. The rectifier prompt (`src/pipeline/stages/autofix.ts` fix-generation call) is augmented:

```
If two findings in this list contradict each other and you cannot satisfy
both, do not guess. Emit a fix for the defects you can resolve, and set
"unresolved": true with a short explanation of which findings conflicted
and why. A reviewer or a stronger model will decide.
```

On `unresolved: true`:

1. The story fails the review stage.
2. Existing tier escalation (`src/execution/escalation/`) moves the story to the next tier (e.g. `balanced → powerful`).
3. At the stronger tier, the adversarial + semantic reviewers re-run and the rectifier retries with fresher reasoning. Powerful models resolve ambiguity that `balanced` could not.
4. If escalation exhausts and the conflict persists, the story enters the normal failure-surfacing path — same as any other unresolvable review failure today. No new human-gate primitive.

**Why not a third "arbiter" LLM call.** Adds cost, adds a third fallible voice, and arbiters tend to be confidently wrong about trade-offs they can't test. The rectifier is already the entity that writes the fix — giving it the contradiction context is more honest than asking a bystander to rule on it.

### Rectifier Integration — No Schema Change

`autofixStage` (`src/pipeline/stages/autofix.ts:42-43`) already consumes `ctx.reviewFindings` without caring how many reviewers produced them. Adding `source` and `category` as optional fields is backward-compatible. The only fix-path change is the rectifier prompt augmentation for the `unresolved: true` escape hatch.

**Retry cap.** `review.adversarial.maxRetries` bounds how many times the review → autofix loop can cycle before the story fails. Default 2. This prevents runaway cost when the rectifier and reviewers disagree in an oscillating loop (fix introduces a new finding, reviewer flags it, fix reintroduces the original problem, etc.).

### Metrics

Split `StoryMetrics.review` into per-lens sub-buckets for cost attribution and effectiveness measurement:

```typescript
interface ReviewMetrics {
  // Existing top-level — sum of children
  totalCost: number
  totalTokens: number
  wallClockMs: number

  semantic: {
    cost: number
    tokens: number
    wallClockMs: number
    findingsCount: number
    findingsBySeverity: Record<Severity, number>
  }

  adversarial: {
    cost: number
    tokens: number
    wallClockMs: number
    findingsCount: number
    findingsBySeverity: Record<Severity, number>
    findingsByCategory: Record<AdversarialCategory, number>   // adversarial-only
  }
}
```

This is the evidence base for tuning the rollout: if `adversarial.findingsCount` trends to zero or adversarial never catches anything semantic missed, the feature isn't pulling its weight. If `findingsByCategory` concentrates in one category, that's a signal to specialize further or refine the prompt.

## File Surface

### New files

- `src/prompts/builders/adversarial-review-builder.ts` — prompt builder, mirrors `review-builder.ts`
- `src/review/adversarial.ts` — `runAdversarialReview()` entry point, mirrors `semantic.ts`
- `test/unit/prompts/adversarial-review-builder.test.ts` — builder unit tests
- `test/unit/review/adversarial.test.ts` — orchestration unit tests (with `_deps` mocking)
- `test/integration/review/adversarial-parallel.test.ts` — parallel vs sequential mode behavior
- `test/integration/review/adversarial-conflict.test.ts` — unresolved contradiction → escalation flow

### Modified files

- `src/config/schemas.ts` — extend `ReviewCheckName`, add `AdversarialReviewConfigSchema`
- `src/config/types.ts` — re-export new type
- `src/review/types.ts` — add `source` and `category` fields to `ReviewFinding`
- `src/review/orchestrator.ts` — dispatch logic for semantic + adversarial, cache diff artifacts
- `src/review/runner.ts` — wire `"adversarial"` check into the runner
- `src/review/diff.ts` (or wherever `truncateDiff` lives) — compute `ReviewDiffArtifacts` (full + prodOnly + testInventory) in one pass
- `src/pipeline/types.ts` — add `reviewDiffFull`, `reviewDiffProdOnly`, `reviewTestInventory` to `PipelineContext`
- `src/pipeline/stages/autofix.ts` — augment rectifier prompt with contradiction/unresolved instructions
- `src/logger/logger.ts` — promote `sessionRole` to first-class `LogEntry` field
- `src/logger/types.ts` — type update
- `src/metrics/story-metrics.ts` — split `review` bucket into `semantic` and `adversarial` sub-buckets
- `src/metrics/aggregator.ts` — aggregation for new sub-buckets
- `CLAUDE.md` project rules — note that review-stage log calls must include `sessionRole`
- `.claude/rules/project-conventions.md` — same rule

### Unchanged

- `src/prompts/builders/review-builder.ts` — semantic prompt stays as-is
- `src/debate/` — debate is orthogonal and not touched
- `src/agents/types.ts` — `sessionRole` already exists on `AgentRunOptions`

## Migration

### `sessionRole` value for semantic

The existing session role used for semantic review is either `"reviewer"` or an implicit default. Before adversarial ships, rename to `"reviewer-semantic"` at the semantic review call site for symmetry with `"reviewer-adversarial"`. This is a one-line change and has no external consumers (sidecar keys are internal).

If any existing sidecar files or ACP session names on disk reference `"reviewer"`, they'll be orphaned after the rename. This is tolerable — sidecar files are per-run ephemera, not persistent state.

### Logger `sessionRole` field

Non-breaking addition. Existing callers that stuff `sessionRole` into `data` continue to work; the first-class field is preferred for new code. Migrate opportunistically.

## Rollout Plan

1. **Phase 1 — Infrastructure (behind no flag).**
   - Add `ReviewFinding.source` and `ReviewFinding.category` fields (backward-compatible)
   - Promote `LogEntry.sessionRole` to first-class field
   - Extract `ReviewDiffArtifacts` computation into a shared helper
   - Split metrics buckets (write-only; no reader depends on the split yet)

2. **Phase 2 — Adversarial reviewer (default off).**
   - Add `"adversarial"` to `ReviewCheckName` enum
   - Add `AdversarialReviewConfigSchema`
   - Ship `AdversarialReviewPromptBuilder` + `runAdversarialReview()`
   - Wire into `ReviewOrchestrator` in sequential-only mode (`parallel: false`)
   - Default `review.checks` unchanged — adversarial is opt-in

3. **Phase 3 — Rectifier arbitration.**
   - Augment autofix prompt with the `unresolved: true` escape hatch
   - Verify escalation path handles unresolved contradictions correctly

4. **Phase 4 — Parallel mode.**
   - Enable `parallel: true` as a config option
   - Implement concurrency cap logic
   - Gate with integration tests that simulate semantic+debate vs adversarial contention

5. **Phase 5 — Measurement.**
   - Run adversarial opted-in on a representative set of stories for N weeks
   - Review `metrics.review.adversarial.findingsCount`, `findingsByCategory`, and overlap rate vs semantic
   - Decide whether to flip the default

6. **Phase 6 — Default-on (conditional on Phase 5 data).**
   - Only if adversarial catches real issues semantic misses at a meaningful rate
   - Default `review.checks` gets `"adversarial"` appended
   - `parallel` stays `false` by default regardless; users opt into speed

### Rollback

- Remove `"adversarial"` from `review.checks` — fully disables the feature, zero code surface executes.
- All infra changes in Phase 1 are backward-compatible and safe to leave in place even if Phases 2+ are reverted.

## Risks

### Cost blow-up with debate

If a user enables both semantic debate (`debate.stages.review: true`) and adversarial parallel, effective concurrency climbs to 5+ sessions per story. The `maxConcurrentSessions` cap catches this but only if users leave the default. **Mitigation:** emit a warning log at config load time when the combined configuration would exceed the cap, noting that adversarial will run sequentially. Document the interaction in `docs/guides/review-configuration.md`.

### Context window pressure

Adversarial sees the full diff (including tests). For large PRs, this can push close to model context limits, especially with `modelTier: "balanced"`. **Mitigation:** adversarial uses the same `truncateDiff` facility as semantic — just with the test-file include flag. Truncation logic is unchanged; it still bounds the prompt size.

### Rectifier loop oscillation

The rectifier may produce a fix that satisfies one reviewer but triggers a new finding from the other on the next pass, leading to a cycle. **Mitigation:** `maxRetries: 2` bounds the loop. If both reviewers keep finding issues after two autofix cycles, escalate tier rather than retry indefinitely.

### LLM "mode confusion" in the adversarial prompt

If the prompt is not sufficiently distinct from semantic's, the adversarial reviewer may drift toward AC-verification behavior and fail to add value. **Mitigation:** the prompt is explicit about *not* confirming correctness ("Your job is NOT to confirm correctness — semantic review handles that"). Monitor overlap rate in Phase 5 metrics; if adversarial findings are just restatements of semantic findings, the prompt needs sharpening.

### Reviewer false positives

An adversarial reviewer instructed to "find what's wrong" will produce more `warn` and `info` findings than semantic. High false-positive rates train the rectifier to ignore findings. **Mitigation:** the prompt requires READ/GREP verification before flagging as `error`, and reserves `unverifiable` for unconfirmed suspicions. Severity discipline is enforced at the prompt level.

### Log volume increase

Two review sessions per story double review-stage log output. **Mitigation:** log levels are unchanged; structured `sessionRole` field lets consumers filter by lens. JSONL file rotation policies (if any) may need revisiting, but this is out of scope for this SPEC.

## Open Questions

1. **Should adversarial's `source` field eventually influence rectifier priority?** Current SPEC says no — the rectifier reasons from content, not origin. If Phase 5 data shows that one lens is systematically more actionable than the other, revisit.

2. **Test-inventory computation scope.** Current design flags *new source files without matching tests*. Should it also flag *modified source files* where the change is substantive but the test file was not updated? Probably yes, but "substantive" is hard to define mechanically. Ship the simpler version first; extend in a follow-up.

3. **Should `debate.stages.adversarial` exist?** Not in this SPEC. Debate on adversarial would require wiring debate personas into a second review lens and is premature until we know whether single-call adversarial pays its way.

4. **Should `maxConcurrentSessions` be a top-level config rather than nested under `review.adversarial`?** Arguable — other parts of nax (debate, parallel story execution) also spawn concurrent sessions and could benefit from a global cap. Out of scope here; revisit during Phase 4.

## Acceptance Criteria

1. `"adversarial"` is a valid value in `review.checks`; configs without it continue to work unchanged.
2. `AdversarialReviewConfigSchema` validates the documented shape; defaults match the SPEC.
3. `AdversarialReviewPromptBuilder` produces prompts that include the story, ACs, full diff, test inventory, adversarial role, instructions, and JSON schema — verified by a snapshot test.
4. `runAdversarialReview()` calls the LLM via `getAgent(config.autoMode.defaultAgent)` with `sessionRole: "reviewer-adversarial"` and the configured `modelTier`.
5. Findings from adversarial review include `source: "adversarial"` and an appropriate `category`; findings from semantic review include `source: "semantic"`.
6. When both `"semantic"` and `"adversarial"` are in `checks` and `parallel: false`, semantic runs before adversarial; their combined findings appear in `ctx.reviewFindings`.
7. When `parallel: true` and concurrency cap is not exceeded, both reviewers run concurrently via `Promise.all`; combined findings appear in `ctx.reviewFindings`.
8. When `parallel: true` but effective concurrency exceeds `maxConcurrentSessions`, the orchestrator falls back to sequential execution and logs a warning.
9. Metrics under `StoryMetrics.review.adversarial` are populated with cost, tokens, wallClockMs, findingsCount, and findingsByCategory after a run that included adversarial review.
10. `LogEntry.sessionRole` is a first-class field; review-stage log entries include it alongside `storyId`.
11. `ReviewDiffArtifacts` is computed once per review stage; semantic receives `prodOnly`, adversarial receives `full` and `testInventory`.
12. Rectifier prompt includes the `unresolved: true` escape hatch; setting it in the rectifier output causes the story to fail the review stage and trigger tier escalation.
13. The review → autofix loop is bounded by `maxRetries`; exceeding it fails the story.
14. All new source files introduced by this feature have corresponding `*.test.ts` files — the feature eats its own dog food on the test-audit heuristic.
