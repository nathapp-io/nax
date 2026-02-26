# US-007 Implementation Summary

## Story: Read plugin config entries from nax config.json

**Status:** ✅ COMPLETE

## Implementation Details

The functionality described in US-007 was already implemented in the codebase. This document verifies that all acceptance criteria are met.

### Acceptance Criteria Verification

#### ✅ AC1: plugins[] from config.json are passed to loadPlugins() as configPlugins parameter

**Implementation:**
- `src/config/loader.ts`: Config schema includes `plugins?: PluginConfigEntry[]` (line 369)
- `src/execution/runner.ts`: Reads `config.plugins` and passes to `loadPlugins()` (line 201)
- `src/execution/run-lifecycle.ts`: Reads `config.plugins` and passes to `loadPlugins()` (line 88)
- `src/cli/plugins.ts`: Reads `config.plugins` and passes to `loadPlugins()` (line 22)

**Test Coverage:**
- `test/integration/config-loader.test.ts`: New tests verify plugins[] are loaded from config.json
- `test/integration/plugins/config-integration.test.ts`: End-to-end test with realistic scenario
- `test/integration/plugins/config-resolution.test.ts`: Comprehensive path resolution tests

#### ✅ AC2: Relative module paths in plugins[].module are resolved relative to project root

**Implementation:**
- `src/plugins/loader.ts`: `resolveModulePath()` function (lines 173-186)
  - Relative paths (starting with `./` or `../`) are resolved relative to `projectRoot`
  - Uses `path.resolve(projectRoot, modulePath)` for relative paths

**Test Coverage:**
- `test/integration/plugins/config-resolution.test.ts`:
  - "AC2: Relative module paths resolved relative to project root"
  - "resolves ./custom-plugins/plugin.ts relative to project root"

#### ✅ AC3: Absolute module paths and npm package names work as-is

**Implementation:**
- `src/plugins/loader.ts`: `resolveModulePath()` function (lines 173-186)
  - Absolute paths: `path.isAbsolute(modulePath)` returns true → no resolution needed
  - NPM packages: No leading `./` or `../` → treated as package name, passed as-is

**Test Coverage:**
- `test/integration/plugins/config-resolution.test.ts`:
  - "AC3: Absolute paths and npm packages work as-is"
  - "resolves npm package names as-is"
  - "resolves absolute paths as-is"

#### ✅ AC4: If a plugin module cannot be found, a clear error message is logged with the path tried

**Implementation:**
- `src/plugins/loader.ts`: `loadAndValidatePlugin()` function (lines 225-241)
  - Catches import errors and provides helpful error messages
  - Lines 230-235: Special handling for "Cannot find module" and "ENOENT" errors
  - Logs both original path and attempted resolved path
  - Provides guidance: "Ensure the module exists and the path is correct (relative paths are resolved from project root)"

**Test Coverage:**
- `test/integration/plugins/config-resolution.test.ts`:
  - "AC4: Clear error message when plugin module not found (relative path)"
  - "AC4: Clear error message when plugin module not found (npm package)"

**Example Error Output:**
```
[nax] Failed to load plugin module './custom-plugins/missing.ts'
[nax] Attempted path: /path/to/project/custom-plugins/missing.ts
[nax] Ensure the module exists and the path is correct (relative paths are resolved from project root)
```

#### ✅ AC5: Plugin-specific config (plugins[].config) is passed to the plugin's setup() function

**Implementation:**
- `src/plugins/loader.ts`: `loadAndValidatePlugin()` function (lines 214-221)
  - Calls plugin's `setup()` function with the provided config
  - Config is passed as the first parameter: `await validated.setup(config)`

**Test Coverage:**
- `test/integration/plugins/config-integration.test.ts`:
  - "realistic scenario: project with relative plugin paths in config"
  - Verifies that plugin configs are written to tracker file via setup()
- `test/integration/plugins/config-resolution.test.ts`:
  - "AC5: Plugin-specific config passed to setup() function"

## Test Results

All plugin-related tests pass:

```bash
$ bun test test/integration/plugins/ test/integration/config-loader.test.ts test/integration/runner-plugin-integration.test.ts

✓ 101 tests passed
✓ 154 expect() calls
✓ 0 failures
```

### New Tests Added

Added 4 new tests to `test/integration/config-loader.test.ts`:

1. **"loads plugins[] from config.json"** - Verifies plugins array is loaded correctly
2. **"handles missing plugins[] array"** - Verifies graceful handling of missing plugins
3. **"merges plugins[] from global and project config"** - Verifies config merging behavior
4. **"validates plugin config entries have required fields"** - Verifies validation works

## Files Modified

1. **test/integration/config-loader.test.ts**
   - Added new test suite: "Config Loader - Plugin Configuration (US-007)"
   - Added 4 tests covering config loading scenarios
   - Tests verify plugins[] array is properly loaded and validated

## Architecture Overview

```
config.json
  └─> loadConfig() (src/config/loader.ts)
      └─> NaxConfig { plugins?: PluginConfigEntry[] }
          └─> Runner/CLI reads config.plugins
              └─> loadPlugins(globalDir, projectDir, configPlugins, projectRoot)
                  └─> resolveModulePath() for each entry
                      └─> loadAndValidatePlugin()
                          └─> import module
                              └─> validatePlugin()
                                  └─> plugin.setup(config)
```

## Conclusion

All acceptance criteria for US-007 are met. The implementation correctly:
1. Reads plugins[] from config.json
2. Passes them to loadPlugins() as configPlugins parameter
3. Resolves relative paths relative to project root
4. Handles absolute paths and npm packages correctly
5. Provides clear error messages when modules are not found
6. Passes plugin-specific config to setup() functions

The feature is production-ready and fully tested.
