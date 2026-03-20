# ENH-010: Hermetic Test Enforcement

**Status:** Implemented (v0.50.2 — moved to quality.testing for per-package support)  
**Component:** `src/prompts/sections/hermetic.ts`, `src/prompts/builder.ts`, `src/config/schemas.ts`  
**Found:** 2026-03-20

---

## Problem

nax's test-writer and implementer agents were not explicitly instructed to keep tests hermetic. This meant agents could inadvertently:

- Spawn real CLI tools (`claude`, `acpx`, `nax`, etc.) inside tests
- Connect to real external services (Redis, Postgres, gRPC endpoints, HTTP APIs)
- Send real network requests during automated test runs
- Create side effects (real data, spending real API credits, mutating remote state)

Without explicit guidance, hermetic violations are silent — tests pass locally but fail in CI or produce flaky results due to network conditions or external state changes.

---

## Fix

### New `testing` config section

Three new config fields in `nax/config.json`:

```json
{
  "testing": {
    "hermetic": true,
    "externalBoundaries": ["claude", "acpx", "redis", "grpc"],
    "mockGuidance": "Use injectable deps for CLI spawning, ioredis-mock for Redis"
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `hermetic` | `boolean` | `true` | Inject hermetic requirement into all code-writing prompts |
| `externalBoundaries` | `string[]` | — | Project-specific tools/clients to mock |
| `mockGuidance` | `string` | — | Project-specific mocking instructions (injected verbatim) |

### Prompt injection

When `hermetic: true`, the `PromptBuilder` injects a `# Hermetic Test Requirement` section (position 5.5 — after isolation rules, before context markdown) covering:

- HTTP/gRPC/WebSocket calls
- CLI tool spawning (`Bun.spawn`/`exec`/`execa`)
- Database and cache clients (Redis, Postgres, etc.)
- Message queues
- File operations outside the test working directory

**Roles that receive the section:** `test-writer`, `implementer`, `tdd-simple`, `batch`, `single-session`  
**Roles exempt:** `verifier` (read-only, writes no test code)

### Design rationale

- Default `hermetic: true` — all projects safe without configuration
- `externalBoundaries` tells the AI *what* to mock in the specific project (e.g. `claude`, `acpx`)
- `mockGuidance` tells the AI *how* to mock in the project's stack (e.g. library names)
- `hermetic: false` is the explicit opt-out for projects that legitimately need real integration calls
- Complements `context.md`: nax provides the rule, `context.md` provides project-specific knowledge

---

## Files Changed

| File | Change |
|:-----|:-------|
| `src/prompts/sections/hermetic.ts` | New — `buildHermeticSection()` |
| `src/prompts/sections/index.ts` | Export hermetic section |
| `src/prompts/builder.ts` | `.hermeticConfig()` method + section injection |
| `src/config/schemas.ts` | `TestingConfigSchema` + `NaxConfigSchema.testing` |
| `src/config/runtime-types.ts` | `TestingConfig` interface + `NaxConfig.testing?` |
| `src/config/types.ts` | Export `TestingConfig` |
| `src/config/defaults.ts` | `testing: { hermetic: true }` |
| `src/pipeline/stages/prompt.ts` | Pass `effectiveConfig.testing` |
| `src/tdd/session-runner.ts` | Pass `config.testing` for all 3 TDD roles |
| `src/cli/config-descriptions.ts` | `testing.*` descriptions |
| `test/unit/prompts/sections/hermetic.test.ts` | 24 tests |
| `README.md` | Hermetic Test Enforcement section |

---

## Tests

- 24 unit tests covering role filtering, base content, boundaries injection, mockGuidance, builder integration, and section ordering
- All pass: `bun test test/unit/prompts/sections/hermetic.test.ts`
