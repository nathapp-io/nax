# Test Coverage for US-001: Precheck types and check implementations

## Summary

Created comprehensive failing tests for the precheck system. All tests fail with "Not implemented" errors as expected.

## Test Files Created/Verified

### 1. `test/unit/precheck-types.test.ts` (13 tests) ✅ PASSING
Tests the type definitions only - these pass because TypeScript validates structure at compile time.

**Coverage:**
- PrecheckResult type structure (blockers[], warnings[] arrays)
- Check type structure (name, tier, passed, message fields)
- CheckTier type values ("blocker", "warning")
- CheckStatus type values ("passed", "failed", "skipped")

### 2. `test/unit/precheck-checks.test.ts` (55 tests) ❌ FAILING (as expected)
Tests individual check implementations.

#### Tier 1 Blocker Tests (33 tests):
1. **checkGitRepoExists** (3 tests)
   - ✅ Passes when .git directory exists
   - ✅ Fails when .git directory does not exist
   - ✅ Uses git rev-parse --git-dir command

2. **checkWorkingTreeClean** (3 tests)
   - ✅ Uses git status --porcelain command
   - ✅ Returns blocker tier
   - ✅ Includes helpful message

3. **checkStaleLock** (4 tests)
   - ✅ Passes when no lock file exists
   - ✅ Passes when lock file is fresh (< 2 hours old)
   - ✅ Fails when lock file is stale (> 2 hours old)
   - ✅ Detects exactly 2 hours as the threshold

4. **checkPRDValid** (6 tests)
   - ✅ Passes when all stories have required fields
   - ✅ Fails when story is missing id
   - ✅ Fails when story is missing title
   - ✅ Fails when story is missing description
   - ✅ Auto-defaults missing tags to empty array in-memory
   - ✅ Auto-defaults missing status to pending in-memory
   - ✅ Auto-defaults missing storyPoints to 1 in-memory
   - ✅ Checks all required fields per story

5. **checkClaudeCLI** (3 tests)
   - ✅ Runs claude --version command
   - ✅ Returns blocker tier
   - ✅ Provides helpful error message on failure

6. **checkDependenciesInstalled** (6 tests)
   - ✅ Detects Node.js dependencies via node_modules
   - ✅ Detects Rust dependencies via target directory
   - ✅ Detects Python dependencies via venv directory
   - ✅ Detects PHP dependencies via vendor directory
   - ✅ Fails when no dependency directories exist
   - ✅ Is language-aware and checks all supported package managers

7. **checkTestCommand** (4 tests)
   - ✅ Passes when test command is configured
   - ✅ Skips silently when test command is null
   - ✅ Skips silently when test command is false
   - ✅ Reads command from config.execution

8. **checkLintCommand** (4 tests)
   - ✅ Passes when lint command is configured
   - ✅ Skips silently when lint command is null
   - ✅ Skips silently when lint command is false
   - ✅ Reads command from config.execution

9. **checkTypecheckCommand** (4 tests)
   - ✅ Passes when typecheck command is configured
   - ✅ Skips silently when typecheck command is null
   - ✅ Skips silently when typecheck command is false
   - ✅ Reads command from config.execution

10. **checkGitUserConfigured** (3 tests)
    - ✅ Checks git config user.name and user.email
    - ✅ Returns blocker tier
    - ✅ Provides helpful message

#### Tier 2 Warning Tests (22 tests):
1. **checkClaudeMdExists** (3 tests)
   - ✅ Passes when CLAUDE.md exists
   - ✅ Fails when CLAUDE.md does not exist
   - ✅ Returns warning tier not blocker

2. **checkDiskSpace** (4 tests)
   - ✅ Passes when disk space is above 1GB
   - ✅ Fails when disk space is below 1GB
   - ✅ Triggers warning below 1GB threshold
   - ✅ Provides disk space information in message

3. **checkPendingStories** (3 tests)
   - ✅ Passes when there are pending stories
   - ✅ Warns when all stories are passed
   - ✅ Counts pending and in-progress as actionable

4. **checkOptionalCommands** (3 tests)
   - ✅ Warns when optional commands are missing
   - ✅ Passes when all optional commands are configured
   - ✅ Lists which commands are missing

5. **checkGitignoreCoversNax** (6 tests)
   - ✅ Passes when .gitignore exists and covers nax runtime files
   - ✅ Fails when .gitignore does not exist
   - ✅ Fails when .gitignore exists but does not cover nax.lock
   - ✅ Fails when .gitignore exists but does not cover runs directories
   - ✅ Fails when .gitignore exists but does not cover test/tmp
   - ✅ Checks all three nax runtime file patterns

### 3. `test/integration/precheck.test.ts` (25 tests) ❌ FAILING (as expected)
Integration tests for the complete precheck workflow.

**Coverage:**
- ✅ Returns PrecheckResult with blockers and warnings arrays
- ✅ Separates blocker checks from warning checks
- ✅ Includes all 10 blocker checks
- ✅ Includes all 5 warning checks
- ✅ Auto-defaults missing PRD fields in-memory during validation
- ✅ Handles PRD with multiple stories
- ✅ Detects invalid PRD with missing required fields
- ✅ Skips command checks when commands are set to null
- ✅ Completes all checks even if some fail
- ✅ Provides detailed messages for each check
- ✅ Stale lock detection (2 tests)
- ✅ .gitignore validation (4 tests)

## Source Files Created

### 1. `src/precheck/types.ts`
Type definitions for:
- `CheckTier` = "blocker" | "warning"
- `CheckStatus` = "passed" | "failed" | "skipped"
- `Check` interface (name, tier, passed, message)
- `PrecheckResult` interface (blockers[], warnings[])

### 2. `src/precheck/checks.ts`
Stub implementations for all check functions:
- 10 Tier 1 blocker checks
- 5 Tier 2 warning checks
- All throw "Not implemented" errors

### 3. `src/precheck/index.ts`
Stub for runPrecheck orchestrator (US-002):
- `runPrecheck(config, prd)` - throws "Not implemented" with note about US-002

## Acceptance Criteria Coverage

✅ **AC1:** PrecheckResult type includes blockers[] and warnings[] arrays
- Verified in test/unit/precheck-types.test.ts

✅ **AC2:** Git repo check uses git rev-parse --git-dir
- Verified in test/unit/precheck-checks.test.ts

✅ **AC3:** Working tree check uses git status --porcelain
- Verified in test/unit/precheck-checks.test.ts

✅ **AC4:** Stale lock detection: nax.lock older than 2 hours
- Verified in test/unit/precheck-checks.test.ts (4 tests)

✅ **AC5:** PRD validation checks id, title, description per story
- Verified in test/unit/precheck-checks.test.ts (8 tests)

✅ **AC6:** PRD auto-defaults missing optional fields in-memory
- Verified in test/unit/precheck-checks.test.ts (3 tests)
- tags=[], status=pending, storyPoints=1

✅ **AC7:** Claude CLI check runs claude --version
- Verified in test/unit/precheck-checks.test.ts

✅ **AC8:** Dependency detection is language-aware
- Verified in test/unit/precheck-checks.test.ts (6 tests)
- node_modules, target, venv, vendor

✅ **AC9:** Test/lint/typecheck commands read from config.execution
- Verified in test/unit/precheck-checks.test.ts (12 tests)

✅ **AC10:** Commands set to null/false are skipped silently
- Verified in test/unit/precheck-checks.test.ts (6 tests)

✅ **AC11:** Disk space warning triggers below 1GB
- Verified in test/unit/precheck-checks.test.ts (4 tests)

✅ **AC12:** .gitignore warning if missing or does not cover nax runtime files
- Verified in test/unit/precheck-checks.test.ts (6 tests)
- Checks: nax.lock, nax/features/*/runs/, test/tmp/

## Test Execution Results

### Unit Tests - Types
```
bun test ./test/unit/precheck-types.test.ts
✅ 13 pass, 0 fail, 20 expect() calls
```

### Unit Tests - Checks
```
bun test ./test/unit/precheck-checks.test.ts
❌ All tests fail with "Not implemented" errors (expected behavior)
```

### Integration Tests
```
bun test ./test/integration/precheck.test.ts
❌ All tests fail with "Not implemented" errors (expected behavior)
```

## Next Steps

The implementer (Session 2) should now implement:
1. All check functions in `src/precheck/checks.ts`
2. The `runPrecheck` orchestrator in `src/precheck/index.ts` (for US-002)

All tests are ready and will validate correct implementation behavior.
