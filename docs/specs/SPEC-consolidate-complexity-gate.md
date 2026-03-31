# SPEC: Consolidate Decomposer + StorySizeGate into Single Complexity Gate

## Summary

Remove the runtime story decomposer (`src/decompose/`) and replace it with two complementary mechanisms: (1) an upgraded precheck `storySizeGate` that can block oversized stories, and (2) a new `nax plan --decompose <storyId>` command that produces plan-quality sub-stories. When `nax run --plan` hits the gate, it loops back to `plan --decompose` automatically (up to 3 attempts). Standalone `nax run` simply stops.

## Motivation

Two separate systems check story size at different points:

| Component | When | Signal | Action |
|:----------|:-----|:-------|:-------|
| `precheck.storySizeGate` | Before run | AC count, desc length, bullets | Warning only (non-blocking) |
| `decompose` (routing stage) | During run | AC count + complexity | Auto-decompose or confirm |

Both use AC count as their primary signal. The storySizeGate warns but doesn't block, so users ignore it. The decomposer then fires with low-quality output — no `contextFiles`, no `routing`, minimal descriptions. This wastes agent time and produces worse results than `nax plan`.

### Consolidation approach

```
nax plan --decompose <storyId>   ← core primitive (plan-quality split)
    ↑
nax run --plan                   ← replan loop calls it when storySizeGate blocks (max 3)
nax run (no --plan)              ← just stops, tells user to run plan --decompose
```

`plan --decompose` is the shared primitive — reusable from CLI and from the `run --plan` replan loop. The runtime decomposer (`src/decompose/`, ~845 LOC) is deleted entirely.

## Design

### US-001: Upgrade StorySizeGate with configurable action

**New config field** on `StorySizeGateConfig`:

```typescript
// In src/config/runtime-types.ts
interface StorySizeGateConfig {
  enabled: boolean;                    // default: true
  action: "block" | "warn" | "skip";  // NEW — default: "block"
  maxAcCount: number;                  // default: 10
  maxDescriptionLength: number;        // default: 3000
  maxBulletPoints: number;             // default: 12
}
```

**Behavior by action:**
- `"block"` — `checkStorySizeGate()` returns `tier: "blocker"`, `passed: false`. Precheck stops the run with: `"Story US-001 has 12 ACs (max 10). Run 'nax plan --decompose US-001' to split it, or set precheck.storySizeGate.action to 'warn'."`
- `"warn"` — current behavior, non-blocking warning
- `"skip"` — gate disabled (replaces `enabled: false`)

**Integration in `src/precheck/index.ts`:** When `action === "block"`, the story-size-gate result is placed in the Tier 1 blockers section (fail-fast). When `action === "warn"`, it stays in Tier 2 warnings (current behavior).

**`checkStorySizeGate()` return type change:** Add `flaggedStoryIds: string[]` to `StorySizeGateResult` for easy consumption by the replan loop (US-003).

### US-002: `nax plan --decompose <storyId>` command

New subcommand on `nax plan` that takes a single oversized story from an existing PRD and splits it into smaller sub-stories using plan-quality prompts.

**CLI interface:**
```bash
nax plan --decompose US-003 -f my-feature
```

**Requires:** existing `prd.json` at `.nax/features/<feature>/prd.json`

**Implementation in `src/cli/plan.ts`:**

```typescript
// New exported function — called by CLI and by replan loop
export async function planDecomposeCommand(
  workdir: string,
  config: NaxConfig,
  options: PlanDecomposeOptions,
): Promise<string> { ... }

interface PlanDecomposeOptions {
  feature: string;       // -f feature name
  storyId: string;       // --decompose <storyId>
}
```

**Flow:**
1. Load existing PRD from `.nax/features/<feature>/prd.json`
2. Find the target story by `storyId` — error if not found or already decomposed
3. Build a decompose prompt via `buildDecomposePrompt()` — includes codebase scan, sibling stories, shared prompt fragments
4. **If `debate.stages.decompose?.enabled`:** create `DebateSession({ stage: "decompose", stageConfig })`, run debate, fall back to single agent if all debaters fail (same pattern as plan debate)
5. **Otherwise:** call `adapter.complete()` one-shot with `jsonMode: true` — no ACP session needed (decompose is a bounded, non-interactive task — no user Q&A, no file writing)
6. Parse the LLM response — expect JSON with `analysis` and `subStories` array
7. Validate: each sub-story has `contextFiles`, `routing`, behavioral ACs, ≤ `maxAcCount` ACs
8. Replace the original story in the PRD: mark original as `"decomposed"`, insert sub-stories after it with `parentStoryId` set, dependencies pointing to the original's dependencies
9. Write updated PRD back to `prd.json`

**Prompt structure — mirrors `buildPlanningPrompt()` quality:**

The decompose prompt reuses the same shared fragments from `src/config/test-strategy.ts` (`GROUPING_RULES`, `AC_QUALITY_RULES`/`getAcQualityRules()`, `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`) and the same `buildCodebaseContext()` from `src/cli/plan.ts`. New function: `buildDecomposePrompt()` in `src/cli/plan.ts`.

```
You are a senior software architect splitting an oversized user story into smaller, independently testable stories.

## Step 1: Understand the Target Story

Read the target story and its acceptance criteria. Understand what it delivers and why it is too large.

## Target Story

[full story JSON — id, title, description, acceptanceCriteria, tags, contextFiles, routing]

Reason for split: {acCount} acceptance criteria exceeds maximum of {maxAcCount}.

## Sibling Stories (context — do NOT duplicate or overlap)

[other stories in the PRD, summarized: id, title, tags, status]

## Step 2: Analyze

Examine the codebase context below. Identify:
- Which files from the target story's contextFiles need modification
- Natural seams for splitting (separate modules, types vs implementation vs integration)
- Dependencies between the resulting sub-stories
- What tests cover the affected code

Record your analysis in the "analysis" field of the output JSON — all implementation agents will receive it.

## Codebase Context

{buildCodebaseContext(scan)}  ← same as plan: file tree, dependencies, test patterns

{monorepoHint if applicable}

## Step 3: Split into Sub-Stories

{GROUPING_RULES}

{getAcQualityRules(projectProfile)}

For each sub-story, set "contextFiles" to the key source files the agent should read (max 5). Use your Step 2 analysis. Every sub-story MUST have contextFiles — never leave empty.

{COMPLEXITY_GUIDE}

{TEST_STRATEGY_GUIDE}

## Output Schema

Generate a JSON object with this exact structure (no markdown, no explanation — JSON only):

{
  "analysis": "string — your Step 2 analysis: splitting rationale, file groupings, dependency order, risks",
  "subStories": [
    {
      "id": "string — e.g. US-003-1, US-003-2 (parent ID + suffix)",
      "title": "string — concise story title",
      "description": "string — detailed description",
      "acceptanceCriteria": ["string — behavioral, testable. One assertion per AC. Never quality gates."],
      "contextFiles": ["string — key source files (max 5, relative paths). REQUIRED — never empty."],
      "tags": ["string — routing tags"],
      "dependencies": ["string — story IDs (sibling sub-stories or parent's original dependencies)"],
      {workdirField if monorepo}
      "status": "pending",
      "passes": false,
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "noTestJustification": "string — REQUIRED when testStrategy is no-test",
        "reasoning": "string — brief classification rationale"
      },
      "escalations": [],
      "attempts": 0
    }
  ]
}

Constraints:
- Each sub-story MUST have ≤ {maxAcCount} acceptance criteria
- Sub-stories MUST NOT overlap with sibling stories listed above
- Total AC coverage must equal or exceed the original story's ACs (no dropped requirements)

{outputInstruction — write to file (ACP) or output JSON only (CLI)}
```

**Key difference from old decomposer:** uses the same prompt quality, shared fragments, and codebase context as `nax plan` — producing sub-stories with `contextFiles`, `routing`, detailed descriptions, and an `analysis` field. The old decomposer had none of these.

**Debate support (optional, default disabled):**

Decompose respects `debate.stages.decompose` config — same pattern as plan debate:

```typescript
const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.decompose?.enabled;
if (debateEnabled) {
  const stageConfig = config.debate.stages.decompose;
  const session = new DebateSession({ storyId, stage: "decompose", stageConfig });
  const result = await session.run(prompt);
  if (result.outcome !== "failed" && result.output) {
    rawResponse = result.output;
  } else {
    // fallback to single agent
    rawResponse = await adapter.complete(prompt, { jsonMode: true, ... });
  }
} else {
  rawResponse = await adapter.complete(prompt, { jsonMode: true, ... });
}
```

`debate.stages.decompose` follows the existing `DebateStageConfig` type — no new types needed. Default: not present (disabled).

**CLI registration in `bin/nax.ts`:** Add `--decompose <storyId>` option to the `plan` command. When present, route to `planDecomposeCommand()` instead of `planCommand()`.

### US-003: Replan loop in `nax run --plan`

When `nax run --plan --from <spec>` generates a PRD and the storySizeGate blocks, automatically call `planDecomposeCommand()` for each flagged story, then re-run precheck. Repeat up to `maxReplanAttempts` (default: 3).

**New config field:**

```typescript
// In src/config/runtime-types.ts — PrecheckConfig or StorySizeGateConfig
interface StorySizeGateConfig {
  // ... existing fields ...
  maxReplanAttempts: number;  // default: 3
}
```

**Integration point in `bin/nax.ts`** (inside the `if (options.plan && options.from)` block):

After `planCommand()` generates the PRD and before the confirmation gate:

```typescript
// Replan loop: if storySizeGate blocks, decompose flagged stories and retry
let replanAttempt = 0;
const maxReplan = config.precheck?.storySizeGate?.maxReplanAttempts ?? 3;

while (replanAttempt < maxReplan) {
  const precheckResult = await runPrecheck(config, prd, { workdir, silent: true });
  
  if (!precheckResult.flaggedStories?.length) break; // no oversized stories
  if (precheckResult.output.passed) break;           // gate is "warn" mode, not blocking
  
  replanAttempt++;
  console.log(`[Replan ${replanAttempt}/${maxReplan}] Decomposing ${precheckResult.flaggedStories.length} oversized stories...`);
  
  for (const flagged of precheckResult.flaggedStories) {
    await planDecomposeCommand(workdir, config, {
      feature: options.feature,
      storyId: flagged.storyId,
    });
  }
  
  // Reload PRD for next iteration
  prd = await loadPRD(prdPath);
}

// If still blocked after max attempts, exit with error
const finalCheck = await runPrecheck(config, prd, { workdir });
if (!finalCheck.output.passed) {
  console.error("Stories still oversized after max replan attempts. Please split manually.");
  process.exit(1);
}
```

**For standalone `nax run` (no `--plan`):** no change — precheck runs as normal. If `action === "block"` and stories are flagged, precheck exits with `EXIT_CODES.BLOCKER` and the existing error message tells the user what to do.

### US-004: Remove runtime decomposer + delete `src/decompose/`

**Files deleted (entire `src/decompose/` module — 14 files, ~845 LOC):**
```
src/decompose/index.ts
src/decompose/types.ts
src/decompose/builder.ts
src/decompose/apply.ts
src/decompose/validators/index.ts
src/decompose/validators/complexity.ts
src/decompose/validators/coverage.ts
src/decompose/validators/dependency.ts
src/decompose/validators/overlap.ts
src/decompose/sections/index.ts
src/decompose/sections/constraints.ts
src/decompose/sections/target-story.ts
src/decompose/sections/sibling-stories.ts
src/decompose/sections/codebase.ts
```

**Test files deleted:**
```
test/unit/decompose/apply.test.ts
test/unit/decompose/cli-decompose.test.ts
test/unit/decompose/builder.test.ts
test/unit/decompose/validators.test.ts
test/unit/decompose/sections/constraints.test.ts
test/unit/decompose/sections/target-story.test.ts
test/unit/decompose/sections/sibling-stories.test.ts
test/unit/pipeline/stages/routing-decompose.test.ts
test/unit/interaction/story-oversized-trigger.test.ts
```

**Routing stage cleanup (`src/pipeline/stages/routing.ts`):**
- Remove `runDecompose()` function
- Remove SD-004 decompose block from `routeStory()`
- Remove `_routingDeps.runDecompose`, `_routingDeps.applyDecomposition`, `_routingDeps.checkStoryOversized`
- Remove imports from `../../decompose/`

**Event bus cleanup:**
- `src/pipeline/event-bus.ts` — remove `story:decomposed` event type
- `src/pipeline/subscribers/events-writer.ts` — remove `story:decomposed` handler
- `src/pipeline/subscribers/hooks.ts` — remove `story:decomposed` handler
- `src/pipeline/types.ts` — remove `"decomposed"` from `RoutingDecision.action`

**Interaction trigger cleanup:**
- `src/interaction/triggers.ts` — remove `checkStoryOversized()` function
- `src/interaction/types.ts` — remove `"story-oversized"` from trigger type union (if present)

**Config cleanup:**
- `src/config/runtime-types.ts` — delete `DecomposeConfig` interface, remove `decompose?` from `NaxConfig`
- `src/config/schemas.ts` — delete `DecomposeConfigSchema`, remove from main schema
- `src/config/defaults.ts` — delete `decompose` block from `DEFAULT_CONFIG`
- `src/cli/config-descriptions.ts` — remove all `decompose.*` entries

**PRD types note:** `UserStory.status` still supports `"decomposed"` for backward compat — existing PRDs may have this status. nax no longer produces it at runtime.

### Failure handling

- `action: "block"` is fail-closed: oversized stories block the run
- `action: "warn"` is fail-open: oversized stories produce warning, proceed
- Replan loop: capped at `maxReplanAttempts` (default 3), exits with error if still oversized
- `plan --decompose` validation failure: error message, PRD unchanged

## Stories

### US-001: Upgrade StorySizeGate with configurable action
Add `action: "block" | "warn" | "skip"` and `maxReplanAttempts` to `StorySizeGateConfig`. Update `checkStorySizeGate()` to return `tier: "blocker"` when `action === "block"`. Update `runPrecheck()` tier placement. Add `flaggedStoryIds` to result.

**Context Files:**
- `src/precheck/story-size-gate.ts` — gate implementation to modify
- `src/precheck/index.ts` — precheck orchestrator, tier placement logic
- `src/config/runtime-types.ts` — `StorySizeGateConfig` type
- `src/config/schemas.ts` — Zod schema for storySizeGate
- `src/config/defaults.ts` — default config values
- `src/cli/config-descriptions.ts` — CLI help text
- `test/unit/precheck/precheck-story-size-gate.test.ts` — existing tests to extend

**Dependencies:** none

### US-002: `nax plan --decompose <storyId>` command
New `planDecomposeCommand()` and `buildDecomposePrompt()` in `src/cli/plan.ts`. Loads existing PRD, builds plan-quality decompose prompt (reusing shared fragments), optionally runs debate (`debate.stages.decompose`), otherwise one-shot `adapter.complete()`. Validates sub-stories, replaces original in PRD. Register `--decompose <storyId>` option in `bin/nax.ts`.

**Context Files:**
- `src/cli/plan.ts` — plan command, `buildPlanningPrompt()` pattern to follow, debate integration pattern
- `bin/nax.ts` — CLI registration, plan command options
- `src/prd/types.ts` — `UserStory` interface for sub-story shape
- `src/prd/schema.ts` — PRD validation
- `src/config/test-strategy.ts` — `GROUPING_RULES`, `getAcQualityRules()`, `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`
- `src/debate/types.ts` — `DebateStageConfig`, `DebateSessionOptions`

**Dependencies:** none (parallel with US-001)

### US-003: Replan loop in `nax run --plan`
After `planCommand()` generates PRD, run precheck. If storySizeGate blocks, call `planDecomposeCommand()` for each flagged story, reload PRD, re-run precheck. Repeat up to `maxReplanAttempts`. Exit with error if still oversized after max attempts.

**Context Files:**
- `bin/nax.ts` — `nax run --plan` flow (lines ~360-430)
- `src/cli/plan.ts` — `planDecomposeCommand()` from US-002
- `src/precheck/index.ts` — `runPrecheck()` return type
- `src/precheck/story-size-gate.ts` — `StorySizeGateResult` for flagged story IDs

**Dependencies:** US-001, US-002

### US-004: Remove runtime decomposer + delete `src/decompose/`
Delete `src/decompose/` (14 files), remove decompose logic from routing stage, remove `story:decomposed` event, remove `checkStoryOversized` trigger, delete `DecomposeConfig` from config. Delete 9 test files.

**Context Files:**
- `src/decompose/` — entire directory to delete
- `src/pipeline/stages/routing.ts` — decompose logic to remove
- `src/pipeline/event-bus.ts` — `story:decomposed` event
- `src/pipeline/subscribers/events-writer.ts` — decomposed handler
- `src/pipeline/subscribers/hooks.ts` — decomposed handler
- `src/pipeline/types.ts` — `RoutingDecision` action union
- `src/interaction/triggers.ts` — `checkStoryOversized()`
- `src/config/runtime-types.ts` — `DecomposeConfig`
- `src/config/schemas.ts` — `DecomposeConfigSchema`
- `src/config/defaults.ts` — decompose defaults
- `src/cli/config-descriptions.ts` — decompose entries

**Dependencies:** US-002 (routing must stop importing decompose before deletion)

## Acceptance Criteria

### US-001: Upgrade StorySizeGate with configurable action
1. `StorySizeGateConfig` in `src/config/runtime-types.ts` includes `action: "block" | "warn" | "skip"` field
2. `StorySizeGateConfig` in `src/config/runtime-types.ts` includes `maxReplanAttempts: number` field
3. Zod schema validates `action` as enum with default `"block"` and `maxReplanAttempts` as number with default `3`
4. `DEFAULT_CONFIG.precheck.storySizeGate` has `action: "block"`, `maxReplanAttempts: 3`, `maxAcCount: 10`, `maxDescriptionLength: 3000`, `maxBulletPoints: 12`
5. `checkStorySizeGate()` returns `tier: "blocker"` and `passed: false` when `action === "block"` and stories exceed thresholds
6. `checkStorySizeGate()` returns `tier: "warning"` and `passed: false` when `action === "warn"` and stories exceed thresholds
7. `checkStorySizeGate()` returns `passed: true` when `action === "skip"` regardless of story size
8. `StorySizeGateResult` includes `flaggedStoryIds: string[]` populated from flagged stories
9. `runPrecheck()` places story-size-gate in Tier 1 blockers when `action === "block"` — exits with `EXIT_CODES.BLOCKER`
10. `runPrecheck()` places story-size-gate in Tier 2 warnings when `action === "warn"`
11. CLI config description for `precheck.storySizeGate.action` and `precheck.storySizeGate.maxReplanAttempts` present

### US-002: `nax plan --decompose <storyId>` command
1. `planDecomposeCommand()` exported from `src/cli/plan.ts` accepts `{ feature, storyId }` options
2. `planDecomposeCommand()` throws error if PRD file does not exist at `.nax/features/<feature>/prd.json`
3. `planDecomposeCommand()` throws error if `storyId` is not found in PRD or already has status `"decomposed"`
4. `planDecomposeCommand()` calls agent with prompt containing target story, sibling stories, and codebase context
5. `planDecomposeCommand()` validates each sub-story has non-empty `contextFiles` array
6. `planDecomposeCommand()` validates each sub-story has `routing` with `complexity`, `testStrategy`, and `modelTier`
7. `planDecomposeCommand()` validates each sub-story has ≤ `maxAcCount` acceptance criteria
8. After successful decompose, original story in PRD has `status: "decomposed"` and sub-stories are inserted after it with `parentStoryId` set
9. Updated PRD is written back to `.nax/features/<feature>/prd.json`
10. `bin/nax.ts` registers `--decompose <storyId>` option on the `plan` command and routes to `planDecomposeCommand()`
11. When `debate.enabled && debate.stages.decompose?.enabled`, `planDecomposeCommand()` creates a `DebateSession` with `stage: "decompose"` and uses its output
12. When debate result has `outcome === "failed"`, `planDecomposeCommand()` falls back to single-agent `adapter.complete()`
13. When `debate.stages.decompose` is not configured (default), `planDecomposeCommand()` uses single-agent `adapter.complete()` directly

### US-003: Replan loop in `nax run --plan`
1. When `nax run --plan --from <spec>` generates a PRD and storySizeGate blocks, `planDecomposeCommand()` is called for each flagged story
2. After decomposing, PRD is reloaded and precheck re-runs
3. Replan loop repeats up to `config.precheck.storySizeGate.maxReplanAttempts` times (default 3)
4. If precheck passes after replan, execution continues to the confirmation gate
5. If precheck still blocks after max attempts, process exits with error message and code 1
6. When `action === "warn"`, no replan loop fires (warnings are non-blocking)

### US-004: Remove runtime decomposer + delete `src/decompose/`
1. `src/decompose/` directory does not exist
2. `routeStory()` in `src/pipeline/stages/routing.ts` does not import from `../../decompose/`
3. `routeStory()` does not check `decomposeConfig` or call `runDecompose`/`applyDecomposition`
4. `RoutingDecision.action` in `src/pipeline/types.ts` does not include `"decomposed"`
5. `story:decomposed` event type is removed from `src/pipeline/event-bus.ts`
6. `events-writer.ts` and `hooks.ts` do not subscribe to `story:decomposed`
7. `checkStoryOversized()` is removed from `src/interaction/triggers.ts`
8. `DecomposeConfig` interface is removed from `src/config/runtime-types.ts`
9. `decompose` field is removed from `NaxConfig` in `src/config/runtime-types.ts`
10. `DecomposeConfigSchema` and its reference in the main schema are removed from `src/config/schemas.ts`
11. `decompose` defaults are removed from `src/config/defaults.ts`
12. All `decompose.*` entries are removed from `src/cli/config-descriptions.ts`
13. All decompose test files in `test/unit/decompose/` are deleted
14. `test/unit/pipeline/stages/routing-decompose.test.ts` is deleted
15. `test/unit/interaction/story-oversized-trigger.test.ts` is deleted
