---
paths:
  - "test/**/*.test.ts"
---

# Test Helpers — Shared Mock Factories

> New test files **must** use the shared helpers in `test/helpers/` instead of inlining mock objects. This is a hard rule — ADR-013 Phase 5 migrated ~100 test files that had duplicated inline mocks, and the fragility of that maintenance is why this rule exists.

## Available Helpers

Import from the barrel: `import { ... } from "../../helpers"` (adjust depth).

| Helper | Purpose | File |
|:---|:---|:---|
| `makeMockAgentManager(overrides?)` | `IAgentManager` mock with all methods stubbed | `test/helpers/mock-agent-manager.ts` |
| `makeAgentAdapter(overrides?)` | `AgentAdapter` mock with full capability surface | `test/helpers/mock-agent-adapter.ts` |
| `makeNaxConfig(overrides?)` | `NaxConfig` with `DEFAULT_CONFIG` + deep merge overrides | `test/helpers/mock-nax-config.ts` |
| `makeStory(overrides?)`, `makePRD(overrides?)` | `UserStory` / `PRD` factories | `test/helpers/mock-story.ts` |
| `makeLogger()` | Logger with captured calls for assertions | `test/helpers/mock-logger.ts` |
| `makeSessionManager(overrides?)` | `ISessionManager` mock | `test/helpers/mock-session-manager.ts` |

## Rule

Inline mock objects for the types listed above are **forbidden** in new or modified test files. If you need a variant the helper doesn't provide, pass `overrides` — do not copy-paste the helper's body.

### ❌ Wrong

```ts
const mockAgentManager = {
  getDefault: () => "claude",
  getAgent: () => ({} as any),
  run: async () => ({ success: false, exitCode: 1, output: "", ... }),
  complete: async () => ({ output: "", costUsd: 0 }),
  // ... 10 more methods
} as any;
```

### ✅ Correct

```ts
import { makeMockAgentManager } from "../../helpers";

const mockAgentManager = makeMockAgentManager({
  complete: async () => ({ output: "my-stub", costUsd: 0, source: "primary" }),
});
```

## Why

- **Interface churn is constant.** When `IAgentManager` or `AgentAdapter` gets a new method, you update one file instead of 100.
- **Consistent defaults.** Tests agree on what "success = true" looks like. No subtle divergence between files.
- **Readability.** The override block in a test is the *only* thing that matters — everything else is noise.

## Scope

Applies to `test/unit/**/*.test.ts` and `test/integration/**/*.test.ts`. The helpers themselves (`test/helpers/`) are exempt — they are the SSOT.

## Adding a New Helper

When you find yourself writing the same mock in 3+ test files, add it to `test/helpers/` with a `make*(overrides?)` signature and export it from `test/helpers/index.ts`. Then file an issue noting the new pattern.
