# Test Coverage: US-003 - CLI nax precheck command

## Story: US-003
CLI nax precheck command with --json flag

## Test File
`test/integration/cli-precheck.test.ts` - 7 tests

## Coverage

### 1. Command Registration
✅ Command is registered as `nax precheck`
✅ Supports `-f, --feature <name>` flag
✅ Supports `-d, --dir <path>` flag
✅ Supports `--json` flag

### 2. Project Resolution
✅ Uses `resolveProject()` from common.ts (US-001)
✅ Resolves project directory with `-d` flag
✅ Resolves feature directory from `-f` flag or config.json
✅ Validates nax/ directory exists
✅ Validates prd.json exists

### 3. Output Formats
✅ Human-readable format (default) - emoji indicators (✓/✗/⚠)
✅ Machine-readable JSON format (--json flag)
✅ JSON includes: passed, blockers, warnings, summary, feature

### 4. Exit Codes
✅ Exit code 0 - All checks passed (or warnings only)
✅ Exit code 1 - Blocker detected
✅ Exit code 2 - Invalid PRD (missing prd.json or invalid structure)

### 5. Error Handling
✅ Missing feature flag with no config.json feature - exit 1
✅ Missing prd.json - exit 2
✅ Invalid PRD structure - exit 2
✅ Missing feature directory - proper error message

## Test Structure
- Uses temp directories for isolation
- Sets up minimal git repo to satisfy checks
- Mocks process.exit to capture exit codes
- Tests both human and JSON output formats

## Integration Points
- ✅ Uses resolveProject() from src/commands/common.ts
- ✅ Uses runPrecheck() from src/precheck/index.ts
- ✅ Uses loadConfig() from src/config
- ✅ Uses loadPRD() from src/prd
- ✅ Respects EXIT_CODES from src/precheck

## Verified Behavior
1. Command registered in bin/nax.ts
2. Exported from src/commands/index.ts
3. Uses same project resolution as `nax status` and `nax logs`
4. Fail-fast on Tier 1 blockers
5. Collects all Tier 2 warnings
6. Proper exit codes for automation/CI

## Manual Testing
```bash
# Human format (default)
nax precheck -f precheck
# Exit code: 0 (warnings only)

# JSON format
nax precheck -f precheck --json
# Output: {"passed":true,"feature":"precheck","summary":{...}}

# Explicit directory
nax precheck -f precheck -d /path/to/project

# Missing feature
nax precheck
# Error: No feature specified
```

## Coverage Summary
- 7 integration tests
- All acceptance criteria verified
- All flags tested
- All exit codes tested
- Error paths covered
