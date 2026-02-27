# Test Coverage: US-005 Config-Driven Review Commands

## Story
Config-driven review commands replacing hardcoded lint

## Implementation Summary

### Files Modified
1. **src/config/schema.ts**
   - Added `lintCommand?: string | null` to `ExecutionConfig`
   - Added `typecheckCommand?: string | null` to `ExecutionConfig`
   - Updated `ExecutionConfigSchema` to validate these fields

2. **src/review/runner.ts**
   - Added `loadPackageJson()` - loads package.json from workdir
   - Added `hasScript()` - checks if package.json has a script
   - Added `resolveCommand()` - implements resolution strategy
   - Modified `runReview()` - accepts optional `executionConfig` parameter
   - Implements command resolution order:
     1. `executionConfig.lintCommand` / `executionConfig.typecheckCommand` (null = disabled)
     2. `config.review.commands[check]` (legacy, backwards compat)
     3. package.json scripts -> `bun run <script>`
     4. Not found -> skip with warning

3. **src/pipeline/stages/review.ts**
   - Updated `runReview()` call to pass `ctx.config.execution`

### Test Coverage

**New Tests: test/integration/review-config-commands.test.ts (12 tests)**
- ✅ uses explicit executionConfig.lintCommand when provided
- ✅ uses explicit executionConfig.typecheckCommand when provided
- ✅ skips check when executionConfig command is null (explicitly disabled)
- ✅ uses package.json script when no executionConfig override
- ✅ skips check when package.json script not found
- ✅ executionConfig takes precedence over package.json
- ✅ reviewConfig.commands takes precedence over package.json (backwards compat)
- ✅ executionConfig takes precedence over reviewConfig.commands
- ✅ handles missing package.json gracefully
- ✅ handles invalid package.json gracefully
- ✅ resolution order: executionConfig > reviewConfig > package.json
- ✅ test command ignores executionConfig (not affected by this story)

**Updated Tests: test/integration/review.test.ts**
- ✅ Modified "uses default commands when not specified" test to match new behavior

## Acceptance Criteria Coverage

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Review stage reads lintCommand from config.execution | ✅ | `test/integration/review-config-commands.test.ts:23-37` |
| Review stage reads typecheckCommand from config.execution | ✅ | `test/integration/review-config-commands.test.ts:39-53` |
| Resolution order: config -> package.json -> skip | ✅ | `test/integration/review-config-commands.test.ts:185-214` |
| Setting command to null/false explicitly disables it | ✅ | `test/integration/review-config-commands.test.ts:55-71` |
| Missing command logs warning instead of failing | ✅ | `src/review/runner.ts:140-143` + test output shows warnings |
| Config schema updated with lintCommand and typecheckCommand fields | ✅ | `src/config/schema.ts:113-114` |
| BUG-005 (hardcoded bun run lint) is resolved | ✅ | No hardcoded commands, all resolved via strategy |

## Behavior Changes

### Before
- Always used hardcoded defaults: `bun run lint`, `bun run typecheck`, `bun test`
- Commands from `config.review.commands` could override defaults
- No way to explicitly disable a check without removing it from `checks` array

### After
- Command resolution follows priority:
  1. `config.execution.lintCommand` / `typecheckCommand` (highest priority)
  2. `config.review.commands[check]` (legacy, for backwards compatibility)
  3. package.json scripts (auto-detected)
  4. Skip with warning (no command found)
- Setting `lintCommand: null` explicitly disables lint check
- Missing commands no longer fail - they skip with a warning

## Backwards Compatibility

✅ **Fully backwards compatible**
- Existing configs using `config.review.commands` continue to work
- Projects without explicit config fall back to package.json detection
- No breaking changes to existing APIs

## Notes

- `test` command intentionally NOT added to `ExecutionConfig` (not part of this story scope)
- Resolution order ensures maximum flexibility: explicit config > legacy config > auto-detect > skip
- Warning messages logged when commands are skipped for debugging visibility
