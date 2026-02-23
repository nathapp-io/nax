# Fix Plan: nax prompts CLI + Scoped Test Coverage
**Date:** 2026-02-23
**Branch:** master (direct, v0.9.3)

## Phase 1: `nax prompts` CLI Command (US-001)

### Fix 1: Add CLI command handler
**File:** `src/cli/prompts.ts` (new)
**Change:** New CLI command that:
- Accepts `-f <feature>` (required), `--out <dir>` (optional, default stdout), `--story <id>` (optional filter)
- Loads PRD from feature dir
- Loads config
- For each story (or filtered story):
  - Runs routing (classify complexity)
  - Runs context building (buildContext + formatContextAsMarkdown)
  - Loads constitution (if configured)
  - Assembles prompt via buildSingleSessionPrompt / buildBatchPrompt
  - For three-session-tdd stories: also builds test-writer/implementer/verifier prompts
  - Outputs to stdout or writes files with YAML frontmatter

### Fix 2: Register CLI command
**File:** `src/cli/index.ts`
**Change:** Add `prompts` subcommand to the CLI parser. Wire to handler.

### Fix 3: Add tests
**File:** `test/prompts-cli.test.ts` (new)
**Change:** Test that:
- `nax prompts` loads PRD and produces prompt files
- Frontmatter includes storyId, testStrategy, contextTokens
- `--story` flag filters to single story
- Three-session-tdd stories produce separate session prompts
- Output dir is created if it doesn't exist

## Phase 2: Scoped Test Coverage Scanner (US-003)

### Fix 4: Add story scoping to test scanner
**File:** `src/context/test-scanner.ts`
**Change:**
- Accept optional `scopeFiles?: string[]` parameter
- When scopeFiles provided, derive test file patterns (e.g., `src/health.service.ts` → `**/health.service.{spec,test}.ts`)
- Filter scan results to only matching test files
- Fall back to full scan when scopeFiles is empty/undefined

### Fix 5: Wire scoping in context builder
**File:** `src/context/builder.ts`
**Change:** Pass `currentStory.contextFiles` to generateTestCoverageSummary as scopeFiles.

### Fix 6: Add config option
**File:** `src/config/schema.ts`
**Change:** Add `context.testCoverage.scopeToStory` boolean (default: true) to config schema.

### Fix 7: Add tests for scoped scanning
**File:** `test/context.test.ts` or `test/test-scanner.test.ts`
**Change:** Test that test coverage scan respects scopeFiles filter.

## Test Strategy
- Mode: test-after
- Run: `bun test` after each phase

## Commits
- Phase 1: `feat: add nax prompts CLI command for prompt inspection`
- Phase 2: `feat: scope test coverage scanner to story-relevant files`
