# Agent Adapters — nax

> §14–§16: Permission resolution, test strategy, adapter conventions.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

---

## 14. Permission Resolution

> Introduced in v0.43.0 (PERM-001). Single source of truth for all agent permission decisions.

### Architecture

All permission decisions flow through one function: `resolvePermissions(config, stage)` in `src/config/permissions.ts`.

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ Config       │────▶│ resolvePermissions()  │────▶│ ResolvedPermissions │
│ • profile    │     │ src/config/           │     │ • mode              │
│ • legacy bool│     │ permissions.ts        │     │ • skipPermissions   │
│ • stage      │     └──────────────────────┘     │ • allowedTools?     │
└─────────────┘                                   └─────────────────────┘
                                                         │
                              ┌───────────────────────────┤
                              ▼                           ▼
                    ┌──────────────────┐        ┌──────────────────┐
                    │ ACP adapter      │        │ CLI adapter      │
                    │ reads .mode      │        │ reads             │
                    │ ("approve-all"   │        │ .skipPermissions  │
                    │  "approve-reads")│        │ (true/false)      │
                    └──────────────────┘        └──────────────────┘
```

### Permission Profiles

| Profile | ACP mode | CLI flag | When to use |
|:--------|:---------|:---------|:------------|
| `unrestricted` | `approve-all` | `--dangerously-skip-permissions` | Development, trusted environments |
| `safe` | `approve-reads` | *(no flag)* | Production, untrusted projects |
| `scoped` | Per-stage (Phase 2) | Per-stage (Phase 2) | Fine-grained control (future) |

### Config Precedence

```jsonc
// nax/config.json — execution block
{
  "execution": {
    // NEW — preferred (v0.43.0+)
    "permissionProfile": "unrestricted",

    // DEPRECATED — backward compat only, ignored when permissionProfile is set
    "dangerouslySkipPermissions": true
  }
}
```

Resolution order:
1. `execution.permissionProfile` → used if present
2. `execution.dangerouslySkipPermissions` → mapped: `true` → `"unrestricted"`, `false` → `"safe"`
3. Neither set → defaults to `"safe"` (approve-reads)

### Pipeline Stages

Every call to `resolvePermissions()` includes the pipeline stage:

| Stage | Used by | Typical profile |
|:------|:--------|:----------------|
| `plan` | `plan.ts`, `claude-plan.ts` | Same as config (plan writes prd.json) |
| `run` | `execution.ts`, `claude.ts`, `claude-execution.ts`, `session-runner.ts` | Primary execution — most permissive |
| `verify` | Verification strategies | Read-heavy — could be restricted in Phase 2 |
| `rectification` | `rectification-loop.ts`, `rectification-gate.ts` | Needs write access for fixes |
| `complete` | `claude-complete.ts`, `acp/adapter.ts` | One-shot LLM calls — varies by caller |
| `acceptance` | Acceptance generator | Write access for test files |
| `regression` | Regression gate | Read + test execution |
| `review` | Code review | Read-only in Phase 2 |

In Phase 1, all stages resolve to the same profile. Phase 2 (`scoped`) will enable per-stage overrides.

### Rules (Mandatory)

| Rule | Rationale |
|:-----|:----------|
| **Always call `resolvePermissions(config, stage)`** | Single source of truth — no local fallbacks |
| **Never hardcode permission booleans** | No `?? true`, `?? false`, or literal `"approve-all"` |
| **Never read `dangerouslySkipPermissions` directly** | Deprecated field — resolver handles backward compat |
| **Always pass `config` and `pipelineStage` to adapters** | Required for resolver to work — both fields are on `AgentRunOptions` and `CompleteOptions` |
| **New code must set `pipelineStage`** | Every `adapter.run()`, `.complete()`, `.plan()`, `.decompose()` call must specify the stage |

### Adding New Call Sites

When writing code that spawns an agent session or calls `complete()`:

```typescript
// ✅ Correct: use resolvePermissions with config and stage
import { resolvePermissions } from "../config/permissions";

const { skipPermissions, mode } = resolvePermissions(config, "run");

// For CLI adapter — pass skipPermissions
await adapter.run({
  ...options,
  config,
  pipelineStage: "run",
  dangerouslySkipPermissions: skipPermissions,
});

// For ACP adapter — pass mode
session.setPermissionMode(mode);
```

```typescript
// ❌ Wrong: local fallback
const skip = config?.execution?.dangerouslySkipPermissions ?? true;

// ❌ Wrong: hardcoded
const args = ["--dangerously-skip-permissions", ...rest];

// ❌ Wrong: no stage
const perms = resolvePermissions(config, undefined as any);
```

### Reference Files

- **Resolver:** `src/config/permissions.ts` — `resolvePermissions()`, types, profiles
- **Schema:** `src/config/schemas.ts` — `permissionProfile` field definition
- **CLI adapter:** `src/agents/claude/adapter.ts`, `claude/execution.ts`, `claude/plan.ts`, `claude/complete.ts`
- **ACP adapter:** `src/agents/acp/adapter.ts`
- **Call sites:** `execution.ts`, `session-runner.ts`, `rectification-loop.ts`, `rectification-gate.ts`, `plan.ts`
- **Spec:** `docs/specs/scoped-permissions.md` — PERM-001 + PERM-002 design

---

## §15 Test Strategy Resolution

### Single Source of Truth

`src/config/test-strategy.ts` defines all valid test strategies, shared prompt fragments,
and the `resolveTestStrategy()` normalizer. This module is the ONLY place where test
strategy values, descriptions, and classification rules are defined.

### Available Strategies

| Strategy | Complexity | Description |
|:---------|:-----------|:------------|
| `test-after` | simple | Write tests after implementation |
| `tdd-simple` | medium | Write key tests first, then implement |
| `three-session-tdd` | complex | 3 sessions: test-writer (strict, no src/ changes) → implementer (no test changes) → verifier |
| `three-session-tdd-lite` | expert | 3 sessions: test-writer (lite, may add src/ stubs) → implementer (lite, may expand coverage) → verifier |

### Rules

1. **resolveTestStrategy()** normalizes unknown/legacy values to valid strategies
2. **Security override**: Security-critical stories → minimum "medium" / "tdd-simple"
3. **No standalone test stories**: Testing is handled per-story via testStrategy
4. Both `plan.ts` and `claude-decompose.ts` import shared prompt fragments — never inline strategy definitions

### Consumers

| File | Uses |
|:-----|:-----|
| `src/cli/plan.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` |
| `src/agents/shared/decompose.ts` | Same prompt fragments |
| `src/pipeline/stages/routing.ts` | `resolveTestStrategy()` (via prd/schema.ts normalization) |
| `src/prd/schema.ts` | `resolveTestStrategy()` for PRD validation |

---

## §16 Agent Adapter Conventions

*Added: 2026-03-16 (MR !52 — agents folder restructure)*

### Folder Structure

Each agent adapter lives in its own subfolder under `src/agents/`. The depth matches the adapter's complexity:

| Adapter | Folder | Files |
|:--------|:-------|:------|
| Claude Code (CLI) | `claude/` | adapter, execution, complete, interactive, plan, cost, index |
| ACP protocol | `acp/` | adapter, spawn-client, parser, cost, interaction-bridge, parse-agent-error, types, index |
| Aider / Codex / Gemini / OpenCode | `aider/`, `codex/`, `gemini/`, `opencode/` | adapter only |
| Centralized cost | `cost/` | calculate, parse, pricing, types, index |

### Rules

1. **One subfolder per adapter** — never flat files at `src/agents/` root (only `index.ts`, `types.ts`, `registry.ts` live at root)
2. **Each multi-file adapter needs `index.ts`** — re-exports everything external callers need; internal modules import directly without going through the barrel
3. **Cross-adapter code goes in `shared/`** — if two different adapters import the same module, that module belongs in `shared/`, not inside either adapter's folder
4. **Adapter-specific cost stays with the adapter** — `claude/cost.ts` (tier-based) and `acp/cost.ts` (model-name-based) are separate; they have different pricing strategies and callers

### `shared/` Contents

| File | Purpose | Used by |
|:-----|:--------|:--------|
| `shared/decompose.ts` | PRD decomposition prompt + parser | `claude/adapter.ts`, `acp/adapter.ts` |
| `shared/decompose-prompt.ts` | Async decompose prompt builder (spec + plan modes) | `acp/adapter.ts` |
| `shared/env.ts` | Secure environment variable construction for spawned agents | All adapters via `buildAllowedEnv()` |
| `shared/model-resolution.ts` | Resolve ModelDef from config | `claude/plan.ts`, `claude/adapter.ts` |
| `shared/validation.ts` | Agent capability + tier validation | `registry.ts`, pipeline stages |
| `shared/version-detection.ts` | Binary version detection | `cli/agents.ts`, `precheck/checks-agents.ts` |
| `shared/types-extended.ts` | Plan/decompose/interactive types | `claude/plan.ts`, `acp/adapter.ts`, `types.ts` |

### ACP Session Error Retry Tiers

The ACP adapter uses tiered retry logic for session errors, configurable via `execution` config:

| Error type | Config key | Default | Example |
|:-----------|:-----------|:--------|:--------|
| Non-retryable (stale/locked session) | `sessionErrorMaxRetries` | 1 | Session state corruption |
| Retryable (queue disconnect) | `sessionErrorRetryableMaxRetries` | 3 | `QUEUE_DISCONNECTED_BEFORE_COMPLETION` |

The adapter detects retryable errors via the `retryable?: boolean` flag in the ACP response. Error logs include the first 500 chars of output for diagnostics.

### Async Decompose Prompts

`src/agents/shared/decompose-prompt.ts`:
- `buildDecomposePromptAsync()` — async decompose prompt builder using `OneShotPromptBuilder`
- Two modes: **spec decomposition** (spec → user stories) and **plan sub-story splitting** (single story → sub-stories)
- Includes `DECOMPOSE_SPEC_SCHEMA` and `DECOMPOSE_PLAN_SCHEMA` for structured JSON output

### ACP Cost Alignment

ACP sessions emit exact USD cost via `usage_update` (`cost.amount`). The adapter prefers this over token-based estimation:

```ts
// Prefer exact cost from acpx usage_update; fall back to token-based estimation
const estimatedCost =
  totalExactCostUsd ??
  (totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
    ? estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model)
    : 0);
```

Token fields from acpx are **camelCase** in the final JSON-RPC `result.usage`:
- `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`

The parser (`acp/parser.ts`) handles both the JSON-RPC envelope format (acpx v0.3+) and legacy flat NDJSON for backward compatibility.
