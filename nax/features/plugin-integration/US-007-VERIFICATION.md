# US-007: Read plugin config entries from nax config.json

## Verification Report

**Date**: 2026-02-26
**Status**: ✅ COMPLETE (Already Implemented)
**Test Results**: 10/10 tests passing

---

## Implementation Summary

US-007 functionality was already fully implemented. This verification confirms all acceptance criteria are met with comprehensive test coverage.

### Architecture

The implementation follows this flow:

```
config.json (plugins[])
  → loadConfig() (src/config/loader.ts)
  → runner/CLI extracts config.plugins
  → loadPlugins(globalDir, projectDir, configPlugins, projectRoot)
  → resolveModulePath() for each plugin
  → loadAndValidatePlugin(resolvedPath, config)
  → plugin.setup(config)
```

---

## Acceptance Criteria Verification

### ✅ AC1: plugins[] from config.json passed to loadPlugins()

**Implementation:**
- `src/execution/runner.ts:201-202`
- `src/execution/run-lifecycle.ts:88-89`
- `src/cli/plugins.ts:22-23`

**Code:**
```typescript
const configPlugins = config.plugins || [];
const pluginRegistry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, workdir);
```

**Tests:** 2 tests in `config-resolution.test.ts`

---

### ✅ AC2: Relative module paths resolved relative to project root

**Implementation:** `src/plugins/loader.ts:173-186`

**Code:**
```typescript
function resolveModulePath(modulePath: string, projectRoot?: string): string {
  // Absolute paths and npm packages work as-is
  if (path.isAbsolute(modulePath) || (!modulePath.startsWith("./") && !modulePath.startsWith("../"))) {
    return modulePath;
  }

  // Relative paths resolved relative to project root
  if (projectRoot) {
    return path.resolve(projectRoot, modulePath);
  }

  return path.resolve(modulePath);
}
```

**Tests:** 2 tests in `config-resolution.test.ts`
- `./relative/path` resolution
- `../parent/path` resolution

---

### ✅ AC3: Absolute paths and npm package names work as-is

**Implementation:** `src/plugins/loader.ts:175-176`

**Logic:**
- Absolute paths: `path.isAbsolute(modulePath)` → return as-is
- npm packages: No `./` or `../` prefix → return as-is

**Tests:** 2 tests in `config-resolution.test.ts`
- Absolute path loading
- npm package name handling

---

### ✅ AC4: Clear error message when plugin module not found

**Implementation:** `src/plugins/loader.ts:230-235`

**Code:**
```typescript
if (errorMsg.includes("Cannot find module") || errorMsg.includes("ENOENT")) {
  console.error(`[nax] Failed to load plugin module '${displayPath}'`);
  console.error(`[nax] Attempted path: ${modulePath}`);
  console.error(
    "[nax] Ensure the module exists and the path is correct (relative paths are resolved from project root)",
  );
}
```

**Error Output Example:**
```
[nax] Failed to load plugin module './nonexistent/plugin.ts'
[nax] Attempted path: /project/root/nonexistent/plugin.ts
[nax] Ensure the module exists and the path is correct (relative paths are resolved from project root)
```

**Tests:** 2 tests in `config-resolution.test.ts`

---

### ✅ AC5: Plugin-specific config passed to setup() function

**Implementation:** `src/plugins/loader.ts:93, 215-221`

**Code:**
```typescript
// Extract config from entry
const validated = await loadAndValidatePlugin(resolvedModule, entry.config ?? {}, entry.module);

// Inside loadAndValidatePlugin:
if (validated.setup) {
  try {
    await validated.setup(config);
  } catch (error) {
    console.error(`[nax] Plugin '${validated.name}' setup failed:`, error);
    return null;
  }
}
```

**Tests:** 2 tests in `config-resolution.test.ts`
- Config passed correctly
- Empty config when undefined

---

## Test Coverage

### Unit Tests: `test/integration/plugins/config-resolution.test.ts`

```
✅ AC1: plugins[] from config.json passed to loadPlugins
  ✅ loads plugins from config array
  ✅ loads multiple plugins from config array

✅ AC2: Relative module paths resolved relative to project root
  ✅ resolves ./relative/path from project root
  ✅ resolves ../relative/path from project root

✅ AC3: Absolute paths and npm packages work as-is
  ✅ loads plugin with absolute path
  ✅ treats non-relative paths as npm packages (doesn't crash)

✅ AC4: Clear error message when plugin module not found
  ✅ logs helpful error for missing relative path
  ✅ logs helpful error for missing absolute path

✅ AC5: Plugin-specific config passed to setup()
  ✅ passes config object to plugin setup function
  ✅ passes empty config object when config is undefined

Total: 10 tests, 10 passing, 0 failing
```

### Integration Test: `test/integration/plugins/config-integration.test.ts`

```
✅ realistic scenario: project with relative plugin paths in config
  - Creates project with custom-plugins/ directory
  - Loads multiple plugins with relative paths
  - Verifies configs passed to each plugin's setup()

Total: 1 test, 1 passing, 0 failing
```

### Overall Plugin Test Suite

```
✅ 102 plugin-related tests pass
✅ 0 failures
✅ 177 expect() calls
```

---

## Example Usage

### Config Format

```json
{
  "version": 1,
  "plugins": [
    {
      "module": "./custom-plugins/my-plugin.ts",
      "config": {
        "apiKey": "key-123",
        "enabled": true
      }
    },
    {
      "module": "/absolute/path/to/plugin.js",
      "config": {
        "timeout": 5000
      }
    },
    {
      "module": "@org/nax-plugin-package"
    }
  ]
}
```

### Path Resolution Examples

| Config Path | Project Root | Resolved Path |
|------------|--------------|---------------|
| `./plugins/foo.ts` | `/home/user/project` | `/home/user/project/plugins/foo.ts` |
| `../shared/bar.ts` | `/home/user/project` | `/home/user/shared/bar.ts` |
| `/abs/path/baz.ts` | `/home/user/project` | `/abs/path/baz.ts` |
| `@org/plugin` | `/home/user/project` | `@org/plugin` |

---

## Files Involved

### Implementation
- `src/config/schema.ts` - PluginConfigEntry type definition
- `src/config/loader.ts` - Config loading with plugins[] array
- `src/plugins/loader.ts` - Plugin loading and path resolution
- `src/execution/runner.ts` - Runner integration
- `src/execution/run-lifecycle.ts` - Lifecycle integration
- `src/cli/plugins.ts` - CLI command integration

### Tests
- `test/integration/plugins/config-resolution.test.ts` - AC verification (10 tests)
- `test/integration/plugins/config-integration.test.ts` - E2E test (1 test)
- `test/integration/cli-plugins.test.ts` - CLI integration (9 tests)

---

## Conclusion

✅ **US-007 is fully implemented and verified**

All acceptance criteria are met with comprehensive test coverage. The implementation correctly:
1. Reads plugins[] from config.json
2. Resolves relative paths against project root
3. Handles absolute paths and npm packages
4. Provides clear error messages
5. Passes plugin-specific config to setup()

**No code changes required.** Implementation was completed in prior stories.
