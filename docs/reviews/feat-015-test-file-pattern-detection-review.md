# Review: FEAT-015 Test File Pattern Detection

Branch reviewed: `feat/461-unify-test-file-patterns`
Diff base: `main...HEAD`
Spec: `docs/specs/feat-015-test-file-pattern-detection.md`
Review date: 2026-04-15

## Findings

### 1. High: `nax detect --apply` can overwrite an unreadable existing config with a partial file

Files:
- `src/commands/detect.ts:62`
- `src/commands/detect.ts:109`

`loadRawConfig()` catches all read and parse failures and returns `{}`. `applyToConfig()` then deep-sets `execution.smartTestRunner.testFilePatterns` and writes that object back to disk.

That means if `.nax/config.json` or `.nax/mono/<pkg>/config.json` is malformed, truncated, or temporarily unreadable, `nax detect --apply` does not fail safely. Instead, it treats the file as empty and overwrites it with a small replacement object containing only the detected test patterns.

This is a destructive behavior regression for a command that is intended to be additive and low-risk.

### 2. Medium: optional `smartTestRunner.testFilePatterns` can crash `ScopedStrategy` on import-grep fallback

Files:
- `src/verification/strategies/scoped.ts:92`
- `src/verification/smart-runner.ts:127`

The schema now allows `execution.smartTestRunner.testFilePatterns` to be omitted, which is required for resolver-based fallback behavior.

However, `ScopedStrategy` still passes `smartCfg.testFilePatterns` directly into `importGrepFallback()`. That function expects a real array and immediately reads `.length`.

So a valid config like:

```json
{
  "execution": {
    "smartTestRunner": {
      "enabled": true,
      "fallback": "import-grep"
    }
  }
}
```

can now throw at runtime in the scoped verification strategy. The main verify stage already guards this path with a fallback array, but `ScopedStrategy` does not.

### 3. Medium: review test-inventory pairing still hardcodes `.test/.spec/_test.go` suffixes

Files:
- `src/review/diff-utils.ts:163`
- `src/review/diff-utils.ts:168`

`computeTestInventory()` now classifies test files with `isTestFile(f, testFilePatterns)`, so custom and detected patterns can enter `addedTestFiles`.

But the next step still strips only these suffixes from test basenames:

- `.(test|spec).(ts|js|tsx|jsx)`
- `_test.go`

For custom patterns like `**/*.integration.ts`, or any future detected convention outside that hardcoded list, the file is recognized as a test during classification but is not normalized back to the corresponding source basename during pairing.

The result is false positives in `newSourceFilesWithoutTests`, which reintroduces the SSOT drift this feature is intended to eliminate.

## Assumptions

- `ScopedStrategy` is still live code via `src/verification/orchestrator.ts`, so the runtime risk is real rather than dead code.
