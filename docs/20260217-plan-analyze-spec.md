# Plan + Analyze Commands Spec
**Date:** 2026-02-17
**Status:** Approved

## Commands

### `ngent plan "description"`
Interactive planning via coding agent's native plan mode.

**Flow:**
1. Spawn agent in plan mode (`claude --plan`, etc.)
2. Agent reads codebase (scanner output injected as context)
3. Agent asks clarifying questions until satisfied
4. Agent produces structured spec
5. ngent captures output → writes `ngent/spec.md`

**Options:**
- `ngent plan "Add URL shortener"` — interactive, agent takes over terminal
- `ngent plan --from brief.md` — non-interactive, agent reads existing doc

**Output:** `ngent/spec.md` with structured format:
```markdown
# Feature: [title]

## Problem
Why this is needed.

## Requirements
- REQ-1: ...
- REQ-2: ...

## Acceptance Criteria
- AC-1: ...

## Technical Notes
Architecture hints, constraints, dependencies.

## Out of Scope
What this does NOT include.
```

**Agent adapter changes:**
- Add `plan(prompt: string, options: PlanOptions): Promise<PlanResult>` to `AgentAdapter` interface
- `PlanOptions`: `{ interactive: boolean, codebaseContext?: string, inputFile?: string }`
- `PlanResult`: `{ specContent: string, conversationLog?: string }`
- Claude implementation: `claude --plan` flag
- Other agents: their equivalent plan mode

**Model:** sonnet (needs good reasoning for questions + synthesis)

### `ngent analyze`
Decompose spec into classified stories → prd.json.

**Flow:**
1. Read `ngent/spec.md`
2. Read codebase context (scanner: file tree, deps, test patterns)
3. Single LLM call (sonnet): decompose spec into stories + classify each
4. Output: `ngent/prd.json` with stories containing:
   - `id`, `title`, `description`
   - `complexity`: simple/medium/complex/expert
   - `relevantFiles`: string[]
   - `reasoning`: string (why this complexity)
   - `estimatedLOC`: number
   - `risks`: string[]
   - `dependencies`: string[] (other story IDs)
5. Falls back to existing keyword classification if LLM fails

**Options:**
- `ngent analyze` — reads spec.md, full decompose + classify
- `ngent analyze --from other-spec.md` — explicit spec path
- `ngent analyze --reclassify` — re-runs classification on existing prd.json (no decompose)

**Model:** sonnet (structural decomposition needs quality)

### Full workflow
```
ngent plan "Add URL shortener with analytics"
ngent analyze
ngent run
```

## Implementation Plan

### Phase 1: Agent plan mode
- Add `plan()` to `AgentAdapter` interface
- Implement for `ClaudeCodeAdapter` using `claude --plan`
- Add `ngent plan` CLI command
- Codebase scanner integration (reuse existing `src/analyze/scanner.ts`)
- Spec.md writer with structured template
- Tests

**Commit:** `feat(plan): add interactive planning via agent plan mode`

### Phase 2: Analyze refactor
- Refactor `ngent analyze` to read spec.md instead of tasks.md
- Combine decompose + classify into single LLM call
- Add `--from` and `--reclassify` flags
- Remove tasks.md dependency
- Update tests

**Commit:** `feat(analyze): decompose spec into classified stories`

## Config
```json
{
  "plan": {
    "model": "balanced",
    "outputPath": "spec.md"
  },
  "analyze": {
    "llmEnhanced": true,
    "model": "balanced",
    "fallbackToKeywords": true,
    "maxCodebaseSummaryTokens": 5000
  }
}
```
