# ENH-006: Plan prompt — structured analysis, contextFiles, eliminate wasteful stories

**Type:** Enhancement  
**Component:** `src/config/test-strategy.ts`, `src/cli/plan.ts`, `src/prd/types.ts`, `src/context/builder.ts`  
**Filed:** 2026-03-19  
**Status:** Spec ready — implementation pending  
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

---

## Problem

### 1. No analysis before story generation

The current plan prompt says "generate JSON" — the LLM jumps straight to story generation without analyzing the codebase. When analysis IS needed (e.g., refactoring), the LLM creates an analysis story instead of doing the analysis itself.

### 2. Wasteful story types

Koda run generated 4 wasteful stories out of 16 (~25%):

| Story | Type | Why wasteful |
|:------|:-----|:-------------|
| US-001 "Analyze JWT auth and plan migration" | Analysis | Should happen during planning, not as a story |
| US-002-5 "Write and update auth module tests" | Test-only | `testStrategy` already handles test creation |
| US-004-5 "Write tests for refactored modules" | Test-only | Same — each story writes its own tests |
| US-006 "Validate quality gates and regression" | Validation | Regression gate already runs full suite |

### 3. Empty contextFiles

Stories have no `contextFiles` despite the plan LLM having just analyzed the codebase. Agents fall back to keyword-based auto-detect (noisy) or full repo scan.

---

## Root Cause

The plan prompt is unstructured — "here's a spec and codebase, generate stories." The LLM has no explicit phase for analysis, no place to store findings, and no instruction to assign context files.

---

## Fix: 3-Step Structured Prompt

Restructure `buildPlanningPrompt()` to force analysis-before-generation. Single LLM call, no extra cost.

### New prompt structure

```
You are a senior software architect generating a PRD as JSON.

## Step 1: Understand the spec

Read the spec carefully. Identify:
- The goal and scope
- Constraints and requirements
- What "done" looks like

## Step 2: Analyze

If the codebase has existing code (refactoring, enhancement, bug fix):
- Which existing files need modification?
- Which files import from or depend on them?
- What tests cover the affected code?
- What are the risks (breaking changes, backward compatibility)?
- What is the migration path?

If this is a greenfield project (empty or minimal codebase):
- What is the target architecture?
- What are the key technical decisions (framework, patterns, conventions)?
- What should be built first (dependency order)?

Record ALL of your analysis in the "analysis" field of the output JSON.
This analysis will be provided to every implementation agent as context.

## Step 3: Generate implementation stories

Based on your Step 2 analysis, create stories that produce CODE CHANGES.

Rules:
- Every story must produce code changes verifiable by tests or review.
- NEVER create stories for analysis, planning, documentation, or migration plans.
  Your analysis belongs in the "analysis" field, not in a story.
- NEVER create stories whose primary purpose is writing tests, achieving coverage
  targets, or running validation/regression suites. Each story's testStrategy
  handles test creation as part of implementation. Testing is a built-in pipeline
  stage, not a user story. No exceptions.
- For each story, set contextFiles to the key source files the agent should read
  before implementing (max 5 per story). Use your Step 2 analysis to pick the
  most relevant files. For greenfield stories with no existing files, leave empty.
- Combine small, related tasks into a single "simple" or "medium" story.
  Do NOT create separate stories for every single file or function unless complex.
- Aim for coherent units of value. Maximum recommended stories: 10-15 per feature.

{COMPLEXITY_GUIDE}

{TEST_STRATEGY_GUIDE}

## Output Schema

{output schema with analysis field}
```

---

## Implementation

### Change 1: Restructure `buildPlanningPrompt()` — 3-step flow

```typescript
// src/cli/plan.ts — buildPlanningPrompt()

// Replace the flat prompt with the 3-step structure above.
// The output schema section adds the "analysis" field:

{
  "project": "string — project name",
  "feature": "string — feature name",
  "analysis": "string — your Step 2 analysis. Key files, impact areas, risks, architecture decisions, migration notes. This is provided to all implementation agents as context.",
  "branchName": "string — git branch (e.g. feat/my-feature)",
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp",
  "userStories": [
    {
      "id": "string — e.g. US-001",
      "title": "string — concise story title",
      "description": "string — detailed description",
      "acceptanceCriteria": ["string — each AC line"],
      "contextFiles": ["string — key source files the agent should read (max 5)"],
      "tags": ["string — routing tags"],
      "dependencies": ["string — story IDs this depends on"],
      ...
    }
  ]
}
```

**Note:** `contextFiles` is already in the `UserStory` type and already consumed by the context builder. It just needs to appear in the output schema so the LLM populates it.

### Change 2: Replace `GROUPING_RULES`

```typescript
// src/config/test-strategy.ts

export const GROUPING_RULES = `## Story Rules

- Every story must produce code changes verifiable by tests or review.
- NEVER create stories for analysis, planning, documentation, or migration plans.
  Your analysis belongs in the "analysis" field, not in a story.
- NEVER create stories whose primary purpose is writing tests, achieving coverage
  targets, or running validation/regression suites. Each story's testStrategy
  handles test creation as part of implementation. Testing is a built-in pipeline
  stage, not a user story. No exceptions.
- Combine small, related tasks into a single "simple" or "medium" story.
  Do NOT create separate stories for every single file or function unless complex.
- Aim for coherent units of value. Maximum recommended stories: 10-15 per feature.`;
```

### Change 3: Add `analysis` field to `PRD` type

```typescript
// src/prd/types.ts

export interface PRD {
  project: string;
  feature: string;
  /** Codebase analysis from planning phase — injected into all story contexts */
  analysis?: string;
  branchName: string;
  // ... rest unchanged
}
```

### Change 4: Inject `prd.analysis` into story context

```typescript
// src/context/builder.ts — in buildContextElements() or addPrdAnalysisElement()

async function addPrdAnalysisElement(
  elements: ContextElement[],
  storyContext: StoryContext,
): Promise<void> {
  const analysis = storyContext.prd?.analysis;
  if (!analysis) return;

  elements.push({
    type: "text",
    label: "Planning Analysis",
    content: `The following analysis was performed during the planning phase. Use it to understand the codebase and inform your implementation:\n\n${analysis}`,
    priority: 90,  // high priority — curated context from planning
  });
}
```

---

## Files to Change

| # | File | Change | Lines |
|:--|:-----|:-------|:------|
| 1 | `src/cli/plan.ts` | Restructure `buildPlanningPrompt()` to 3-step flow, add `analysis` + `contextFiles` to output schema | ~40 (rewrite prompt section) |
| 2 | `src/config/test-strategy.ts` | Replace `GROUPING_RULES` with hard bans | ~12 (replace existing) |
| 3 | `src/prd/types.ts` | Add `analysis?: string` to `PRD` interface | +3 |
| 4 | `src/context/builder.ts` | Add `addPrdAnalysisElement()`, call it in build flow | +15 |
| 5 | `test/unit/cli/plan.test.ts` | Test prompt structure: 3 steps present, analysis field in schema | +20 |
| 6 | `test/unit/config/test-strategy.test.ts` | Verify GROUPING_RULES hard bans | +10 |
| 7 | `test/unit/context/builder.test.ts` | Test analysis injection + no-analysis case | +20 |

**Total: 4 files modified, ~120 lines changed/added**

---

## What Koda Would Look Like After

### Before (actual koda run — 16 stories)

```
US-001  "Analyze JWT auth and plan migration"          ← WASTE (analysis)
US-002  "Refactor AuthModule"
  US-002-1..4  (implementation sub-stories)
  US-002-5  "Write auth module tests"                  ← WASTE (test-only)
US-003  "Replace auth guards"
US-004  "Refactor services and controllers"
  US-004-1..4  (implementation sub-stories)
  US-004-5  "Write tests for refactored modules"       ← WASTE (test-only)
US-005  "Remove deprecated auth code"
US-006  "Validate quality gates and regression"         ← WASTE (validation)
```

### After (projected — 12 stories, analysis in PRD)

```json
{
  "analysis": "Current auth uses @nestjs/jwt + @nestjs/passport with custom JwtStrategy. 14 files import from auth/. Key migration: PassportModule → NathappAuthModule.forRootAsync. Tests in auth.controller.spec.ts and auth.service.spec.ts cover login/register flows. Risk: guards used in 8 controllers.",
  "userStories": [
    {
      "id": "US-001",
      "title": "Refactor AuthModule to use @nathapp/nestjs-auth",
      "contextFiles": ["src/auth/auth.module.ts", "src/auth/strategies/jwt.strategy.ts"],
      ...
    }
  ]
}
```

**4 stories eliminated, every remaining story has contextFiles, all agents see the analysis.**

---

## Edge Cases

| Case | Behavior |
|:-----|:---------|
| Greenfield project (no code) | Analysis covers architecture decisions; contextFiles empty for first stories; ENH-005 chains outputs for later stories |
| Old PRDs without `analysis` | Backward compatible — `analysis` is optional; context builder skips injection |
| LLM ignores contextFiles instruction | Falls back to auto-detect (existing BUG-006 behavior) — no regression |
| LLM still creates analysis story despite ban | Prompt is stronger than before; can't guarantee 100% compliance but significantly reduces occurrence |
| Very large analysis (>2000 tokens) | Context builder already has priority-based truncation; analysis at priority 90 will be included unless context is extremely full |

---

## Interaction with Other ENH

| ENH | Relationship |
|:----|:-------------|
| ENH-005 (context chaining) | Complementary. ENH-006 provides planned context (analysis + contextFiles). ENH-005 provides runtime context (parent outputFiles). Together they eliminate the "no context" problem. |
| ENH-007 (reconciliation gate) | Independent. |
| ENH-008 (workdir scoping) | Independent. contextFiles are relative paths — workdir scoping applies at execution time. |

---

## Test Plan

| Test | Input | Expected |
|:-----|:------|:---------|
| Prompt has Step 1 | Call `buildPlanningPrompt()` | Output contains "Step 1: Understand the spec" |
| Prompt has Step 2 | Call `buildPlanningPrompt()` | Output contains "Step 2: Analyze" |
| Prompt has Step 3 | Call `buildPlanningPrompt()` | Output contains "Step 3: Generate implementation stories" |
| Prompt has greenfield guidance | Call `buildPlanningPrompt()` | Contains "greenfield project" |
| Schema includes analysis | Call `buildPlanningPrompt()` | Output schema has `"analysis"` field |
| Schema includes contextFiles | Call `buildPlanningPrompt()` | Story schema has `"contextFiles"` field |
| GROUPING_RULES bans test stories | Read constant | Contains "NEVER create stories whose primary purpose is writing tests" |
| GROUPING_RULES bans analysis stories | Read constant | Contains "NEVER create stories for analysis, planning, documentation" |
| Old exception removed | Read constant | Does NOT contain "Only create a dedicated test story" |
| PRD type accepts analysis | `{ analysis: "...", userStories: [] }` | Valid PRD |
| Context builder injects analysis | PRD with `analysis` | Context element "Planning Analysis" present |
| Context builder skips when no analysis | PRD without `analysis` | No "Planning Analysis" element |

---

## Acceptance Criteria

- [ ] Plan prompt restructured into 3 explicit steps (understand → analyze → generate)
- [ ] Step 2 handles both existing codebase and greenfield
- [ ] `analysis` field in PRD output schema and type
- [ ] `contextFiles` appears in story output schema (already in type)
- [ ] `GROUPING_RULES` hard-bans test-only, analysis-only, and validation stories
- [ ] Old "integration/E2E exception" removed
- [ ] `prd.analysis` injected into all story contexts at high priority
- [ ] Backward compatible — PRDs without `analysis` work unchanged
- [ ] All 12 test cases pass
