# SPEC: Per-Agent Model Map

## Summary

Restructure the `models` config from a flat tier→model map to a per-agent model map, making it the SSOT for resolving any `(agent, tier) → model` pair. Activate the existing dead-code `fallbackOrder` config as the rate-limit agent fallback chain. Add optional `routing.agent` field for manual per-story agent override.

## Motivation

The current `models` config is implicitly single-agent:

```json
"models": {
  "fast": { "provider": "anthropic", "model": "haiku" },
  "balanced": { "provider": "anthropic", "model": "sonnet" },
  "powerful": { "provider": "anthropic", "model": "sonnet" }
}
```

There's no way to express "codex fast = gpt-5" or "opencode balanced = gemini-2.5-pro". This blocks:

1. **Cross-agent escalation** — `tierOrder` can only vary model tier, not switch agents
2. **Debate agent resolution** (#150) — debaters need per-agent model lookups
3. **Rate-limit fallback** — `fallbackOrder` exists but is dead code; no per-agent models to resolve against
4. **PRD agent override** — no way for a story to force a specific agent

There are **22 callsites** using `config.models[tier]`, all following the same `resolveModel(config.models[modelTier])` pattern — a single refactor point.

## Design

### New `models` schema

```typescript
// Per-agent model map
interface AgentModelMap {
  [tier: string]: ModelEntry;  // "fast" | "balanced" | "powerful" | custom
}

// New models config: Record<agentName, AgentModelMap>
type ModelsConfig = Record<string, AgentModelMap>;
```

Config example:

```jsonc
{
  "models": {
    "claude": {
      "fast": "claude-haiku-4-5",
      "balanced": "claude-sonnet-4-5",
      "powerful": "claude-opus-4"
    },
    "codex": {
      "fast": "gpt-5",
      "balanced": "gpt-5",
      "powerful": "gpt-5"
    },
    "opencode": {
      "fast": "gemini-2.5-flash",
      "balanced": "gemini-2.5-pro",
      "powerful": "gemini-2.5-pro"
    }
  }
}
```

### `resolveModelForAgent()` — the new SSOT function

```typescript
// src/config/schema-types.ts
function resolveModelForAgent(
  models: ModelsConfig,
  agent: string,
  tier: ModelTier,
  defaultAgent: string,
): ModelDef {
  // 1. Try exact agent + tier
  const agentMap = models[agent];
  if (agentMap?.[tier]) return resolveModel(agentMap[tier]);

  // 2. Fallback to defaultAgent's tier
  const defaultMap = models[defaultAgent];
  if (defaultMap?.[tier]) return resolveModel(defaultMap[tier]);

  // 3. Throw — no model available
  throw new Error(`No model for agent="${agent}" tier="${tier}" (defaultAgent="${defaultAgent}")`);
}
```

All 22 callsites migrate from:
```typescript
resolveModel(config.models[modelTier])
```
to:
```typescript
resolveModelForAgent(config.models, agentName, modelTier, config.autoMode.defaultAgent)
```

Where `agentName` comes from:
- `ctx.routing.agent` (PRD override — new field, manual/expert-only)
- `config.autoMode.defaultAgent` (fallback — existing field)
- Escalation tier's agent (when `tierOrder` entries include `agent` field)

### Backward compatibility — legacy flat format auto-migration

At config load time, detect old shape and convert:

```typescript
// In loadConfig() / validateConfig()
function migrateModelsConfig(
  models: Record<string, unknown>,
  defaultAgent: string,
): ModelsConfig {
  // Detect old shape: models.fast is { provider, model } or string, not an agent map
  const firstValue = models[Object.keys(models)[0]];
  if (isModelEntry(firstValue)) {
    // Old flat format → wrap under defaultAgent
    return { [defaultAgent]: models as AgentModelMap };
  }
  // Already new format
  return models as ModelsConfig;
}
```

This means existing configs work unchanged — `{ fast: "haiku" }` becomes `{ claude: { fast: "haiku" } }` at load time.

### `routing.agent` — PRD per-story agent override

Add optional `agent` field to story routing:

```typescript
// In StoryRouting (src/config/runtime-types.ts or prd types)
interface StoryRouting {
  complexity: Complexity;
  testStrategy: TestStrategy;
  modelTier: ModelTier;
  agent?: string;    // NEW — manual/expert-only, nax plan does NOT generate
  reasoning?: string;
}
```

Resolution hierarchy:
1. `story.routing.agent` (highest — manual PRD override)
2. Current escalation tier's agent (from `tierOrder[n].agent`)
3. `config.autoMode.defaultAgent` (lowest — fallback)

### Extended `tierOrder` — optional `agent` per tier

```typescript
interface TierConfig {
  tier: string;
  attempts: number;
  agent?: string;   // NEW — optional, enables cross-agent escalation
}
```

Example:
```jsonc
"escalation": {
  "tierOrder": [
    { "tier": "fast", "agent": "claude", "attempts": 3 },
    { "tier": "balanced", "agent": "claude", "attempts": 2 },
    { "tier": "fast", "agent": "codex", "attempts": 2 },
    { "tier": "balanced", "agent": "opencode", "attempts": 1 }
  ]
}
```

When `agent` is omitted from a tier entry, `defaultAgent` is used (backward compat).

### Rate-limit fallback via `fallbackOrder`

`autoMode.fallbackOrder` already exists but is dead code. This spec activates it:

```
429 on claude/fast
  → walk fallbackOrder → try codex/fast (same tier, next agent)
  → codex also 429 → try opencode/fast
  → all 429 → wait min(Retry-After), retry from fallbackOrder[0]
```

**Rules:**
- Rate limit does NOT burn an attempt (transient, not capability failure)
- Each iteration tries the story's resolved agent first (rate limits are short-lived)
- Agent must exist in `models` with the required tier, otherwise skip
- Auth errors (401/403) → skip agent permanently for the run

Detection: parse adapter error output for 429/rate-limit signals. `AcpAgentAdapter.complete()` and `run()` must surface a structured error type:

```typescript
interface AgentError {
  type: "rate-limit" | "auth" | "timeout" | "crash" | "unknown";
  retryAfterSeconds?: number;  // From Retry-After header, if present
  message: string;
}
```

### Fallback implementation — inside ACP adapter

The fallback lives inside `AcpAgentAdapter`, not at the caller level. This means every `complete()` and `run()` call gets fallback for free — plan, review, acceptance, routing, rectification, autofix, TDD, analyze.

```typescript
// Inside AcpAgentAdapter.complete() / run()
async complete(prompt, options) {
  const fallbackOrder = this.config.autoMode.fallbackOrder;
  
  for (const agentName of fallbackOrder) {
    if (this._unavailableAgents.has(agentName)) continue;
    
    const model = resolveModelForAgent(this.config.models, agentName, tier, defaultAgent);
    try {
      return await this._executeAcpx(prompt, { ...options, model });
    } catch (err) {
      const agentErr = parseAgentError(err);
      if (agentErr.type === "auth") {
        this._unavailableAgents.add(agentName);  // permanent for this run
        continue;
      }
      if (agentErr.type === "rate-limit") {
        continue;  // try next agent
      }
      throw err;  // timeout/crash → normal escalation
    }
  }
  // All agents exhausted → wait and retry, or throw
}
```

CLI adapter is NOT modified — it only supports claude. Fallback is ACP-only.

### Error classification

| Signal | Type | Action | Burns attempt? |
|:-------|:-----|:-------|:---------------|
| 429, "rate limit" | `rate-limit` | Fallback to next agent | ❌ |
| 401, 403, "unauthorized", "forbidden" | `auth` | Fallback + mark unavailable | ❌ |
| Timeout, SIGKILL | `timeout` | Normal escalation | ✅ |
| Non-zero exit (other) | `crash` | Normal escalation | ✅ |
| Test failure | N/A (not adapter error) | Normal escalation | ✅ |

### Failure handling

- **Missing agent in models map**: fall through to `defaultAgent`. If `defaultAgent` also missing for the tier → throw config validation error at load time.
- **Rate limit on all agents**: wait `min(retryAfterSeconds)` across all agents, then retry. If no Retry-After header, default 30s wait.
- **Auth error on all agents**: throw `AllAgentsUnavailableError` → escalation-worthy structural failure.
- **Migration failure** (ambiguous old/new format): reject with clear validation error listing the ambiguous keys.

## Stories

### US-001: Per-agent model map types, schema, migration, and defaults

**Dependencies:** none

Restructure `ModelsConfig` type from `Record<ModelTier, ModelEntry>` to `Record<string, Record<ModelTier, ModelEntry>>`. Add `resolveModelForAgent()` function to `src/config/schema-types.ts`. Add legacy format detection and auto-migration in `src/config/schemas.ts` (Zod `.transform()`). Update `DEFAULT_CONFIG` in `src/config/defaults.ts` to new shape: `{ claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } }`. Update config descriptions in `src/cli/config-descriptions.ts`. Add `agent` optional field to `TierConfig` in `src/config/schema-types.ts`. Add `agent` optional field to story routing type.

#### Context Files
- `src/config/schema-types.ts` — `ModelEntry`, `ModelMap`, `TierConfig`, `resolveModel()`
- `src/config/schemas.ts` — Zod schemas, `AutoModeConfigSchema`, `ModelsSchema`
- `src/config/defaults.ts` — `DEFAULT_CONFIG`
- `src/config/runtime-types.ts` — `NaxConfig.models` type
- `src/config/types.ts` — re-exports
- `src/cli/config-descriptions.ts` — human-readable field descriptions

#### Acceptance Criteria
- `resolveModelForAgent(models, "claude", "fast", "claude")` returns `{ provider: "anthropic", model: "claude-haiku-4-5" }` when `models.claude.fast` is `"claude-haiku-4-5"`
- `resolveModelForAgent(models, "codex", "fast", "claude")` returns codex's fast model when `models.codex.fast` exists
- `resolveModelForAgent(models, "unknown-agent", "fast", "claude")` falls back to `models.claude.fast` (defaultAgent fallback)
- `resolveModelForAgent(models, "codex", "powerful", "claude")` falls back to `models.claude.powerful` when `models.codex` has no `powerful` tier
- When legacy flat config `{ fast: { provider: "anthropic", model: "haiku" } }` is loaded, `NaxConfigSchema.parse()` auto-migrates to `{ claude: { fast: { provider: "anthropic", model: "haiku" } } }` using `defaultAgent`
- When new per-agent config `{ claude: { fast: "haiku" }, codex: { fast: "gpt-5" } }` is loaded, `NaxConfigSchema.parse()` preserves it unchanged
- `TierConfig` accepts optional `agent` field — `{ tier: "fast", attempts: 3, agent: "codex" }` passes Zod validation
- `TierConfig` without `agent` field passes Zod validation (backward compat)
- `DEFAULT_CONFIG.models` is `{ claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } }` and `DEFAULT_CONFIG.autoMode.fallbackOrder` is `["claude"]`

### US-002: Migrate all 22 callsites to `resolveModelForAgent()`

**Dependencies:** US-001

Replace all `resolveModel(config.models[tier])` callsites with `resolveModelForAgent(config.models, agent, tier, config.autoMode.defaultAgent)`. The `agent` parameter at each callsite comes from: (a) `ctx.routing.agent` if set, (b) the current escalation tier's agent if set, (c) `config.autoMode.defaultAgent`. This is a mechanical migration — same behavior when only one agent is configured.

Callsite files:
- `src/pipeline/stages/execution.ts` (line ~249)
- `src/pipeline/stages/acceptance-setup.ts` (line ~279)
- `src/pipeline/stages/autofix.ts` (line ~242)
- `src/pipeline/stages/routing.ts` (line ~57)
- `src/verification/rectification-loop.ts` (lines ~100, ~214)
- `src/metrics/tracker.ts` (lines ~58-60, ~120-122)
- `src/cli/analyze-parser.ts` (line ~234)
- `src/cli/analyze.ts` (lines ~117, ~187)
- `src/agents/acp/adapter.ts` (lines ~752, ~870)
- `src/routing/strategies/llm.ts` (line ~86)
- `src/config/validate.ts` (line ~43)
- `src/execution/lifecycle/acceptance-loop.ts` (line ~116)
- `src/tdd/session-runner.ts` (line ~178)
- `src/tdd/rectification-gate.ts` (line ~181)
- `src/tdd/orchestrator.ts` (line ~92)
- `src/acceptance/refinement.ts` (line ~179)

#### Context Files
- `src/pipeline/stages/execution.ts` — primary execution callsite, has `ctx.routing`
- `src/agents/acp/adapter.ts` — adapter model resolution
- `src/verification/rectification-loop.ts` — rectification model resolution
- `src/metrics/tracker.ts` — metrics model tracking
- `src/config/schema-types.ts` — `resolveModelForAgent()` from US-001

#### Acceptance Criteria
- When `config.models` has only `claude` agent and `defaultAgent` is `"claude"`, all 22 callsites behave identically to the old flat `config.models[tier]` pattern
- When `ctx.routing.agent` is `"codex"` and `config.models.codex.fast` exists, `execution.ts` resolves to codex's fast model instead of claude's
- When `ctx.routing.agent` is unset, all callsites resolve using `config.autoMode.defaultAgent`
- `metrics/tracker.ts` records `agentUsed` (the resolved agent name) alongside `modelTier` and `modelUsed` in story metrics
- `config/validate.ts` validates that every agent in `fallbackOrder`, every `tierOrder[].agent`, and every PRD `routing.agent` exists as a key in `models`
- The old `resolveModel(config.models[tier])` pattern no longer appears in any source file under `src/`

### US-003: Rate-limit and auth error fallback inside ACP adapter

**Dependencies:** US-002

Implement fallback directly inside `AcpAgentAdapter.complete()` and `AcpAgentAdapter.run()` in `src/agents/acp/adapter.ts`. When acpx returns a 429/rate-limit or 401/403 auth error (detected by parsing stderr), the adapter walks `config.autoMode.fallbackOrder`, resolves the next agent's model via `resolveModelForAgent()`, and retries with `--model <fallback-model>` — all transparently to callers. This means ALL LLM calls (plan, review, acceptance, routing, rectification, autofix, TDD, analyze) get fallback for free without any caller changes.

Add `AgentError` structured type to `src/agents/types.ts` with `type: "rate-limit" | "auth" | "timeout" | "crash" | "unknown"` and optional `retryAfterSeconds`. Add error detection helpers to parse acpx stderr for known patterns (`"rate limit"`, `"429"`, `"401"`, `"403"`, `"unauthorized"`, `"forbidden"`).

Rate-limit fallback does NOT burn attempt count. Auth errors fallback to next agent AND mark the failing agent as unavailable for the rest of the run (avoid retrying every iteration). Track unavailable agents in adapter instance state (`this._unavailableAgents: Set<string>`).

When all agents in `fallbackOrder` are rate-limited, wait `min(retryAfterSeconds)` then retry from `fallbackOrder[0]`. When all agents are permanently unavailable (all auth errors), throw `AllAgentsUnavailableError`.

CLI adapter (`src/agents/cli/`) is NOT modified — it only supports claude and has no model switching. Fallback is ACP-only since acpx is the universal adapter that supports `--model` for any provider.

Use `_deps` injection pattern for testability (inject `_fallbackDeps = { parseAgentError, sleep }`).

#### Context Files
- `src/agents/types.ts` — agent interfaces, add AgentError type
- `src/agents/acp/adapter.ts` — `complete()` and `run()` methods, implement fallback loop
- `src/config/schema-types.ts` — `resolveModelForAgent()` from US-001
- `src/execution/escalation/escalation.ts` — existing escalation logic (don't conflict)

#### Acceptance Criteria
- When `adapter.complete()` receives a 429 response from acpx, it automatically retries with the next agent in `fallbackOrder` at the same tier — caller receives the successful response without knowing a fallback occurred
- When `adapter.run()` receives stderr containing "rate limit" or "429", it automatically retries with the next agent in `fallbackOrder`
- When `adapter.complete()` receives a 401/403 auth error, it retries with next agent in `fallbackOrder` AND marks the failing agent unavailable for subsequent calls (`this._unavailableAgents`)
- Fallback does NOT decrement the story's attempt count (rate-limit/auth are infrastructure errors, not capability failures)
- When all agents in `fallbackOrder` return rate-limit errors, adapter waits `min(retryAfterSeconds)` seconds then retries from `fallbackOrder[0]`
- When `fallbackOrder` has only one agent and it's rate-limited, adapter waits `retryAfterSeconds` (or 30s default) then retries the same agent
- When all agents are permanently unavailable (auth errors on every agent), adapter throws `AllAgentsUnavailableError`
- Fallback events are logged at info level with stage `"agent-fallback"` including: original agent, fallback agent, error type, retry count
- CLI adapter (`src/agents/cli/`) is unchanged — no fallback logic added

### US-004: Cross-agent escalation in `tierOrder`

**Dependencies:** US-002

Update `escalateTier()` in `src/execution/escalation/escalation.ts` to return both the next tier AND the next agent. Update `handlePreIterationEscalation()` in `src/execution/escalation/tier-escalation.ts` to set the resolved agent on the story context when escalating. Update the execution stage to use the escalation-provided agent instead of always using `defaultAgent`. When `tierOrder` entry has no `agent`, use `defaultAgent` (backward compat). This enables configs like: exhaust claude/fast (3 attempts) → escalate to claude/balanced (2 attempts) → escalate to codex/fast (2 attempts).

#### Context Files
- `src/execution/escalation/escalation.ts` — `escalateTier()`, `getTierConfig()`
- `src/execution/escalation/tier-escalation.ts` — `handlePreIterationEscalation()`
- `src/pipeline/stages/execution.ts` — uses escalation result
- `src/config/schema-types.ts` — `TierConfig` type (agent field from US-001)

#### Acceptance Criteria
- `escalateTier("fast", tierOrder)` returns `{ tier: "balanced", agent: "claude" }` when tierOrder is `[{ tier: "fast", agent: "claude", attempts: 3 }, { tier: "balanced", agent: "claude", attempts: 2 }]`
- `escalateTier("balanced", tierOrder)` returns `{ tier: "fast", agent: "codex" }` when next entry is `{ tier: "fast", agent: "codex", attempts: 2 }`
- `escalateTier("balanced", tierOrder)` returns `null` when at last tier entry
- When `tierOrder` entry has no `agent` field, `escalateTier()` returns `{ tier: nextTier, agent: undefined }` and caller uses `defaultAgent`
- `handlePreIterationEscalation()` sets `ctx.routing.agent` to the escalated tier's agent when present
- After escalation from `claude/balanced` to `codex/fast`, execution stage calls `resolveModelForAgent(models, "codex", "fast", defaultAgent)`

## Resolved Decisions

1. **Model strings are user-defined** — nax does not enforce format. Users put whatever string their provider accepts (e.g., `"haiku"`, `"claude-haiku-4-5"`, `"gpt-5"`). `resolveModel()` infers provider for cost tracking if it can, otherwise `"unknown"`. Both string shorthand and full `{ provider, model, pricing }` object are accepted (existing `ModelEntry` union).
2. **DEFAULT_CONFIG ships claude only** — `models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } }`. Users add codex/opencode manually.
3. **`fallbackOrder` is explicit** — users must list agents in order. No auto-derivation from `models` keys. Default: `["claude"]`.
4. **Cross-reference validation at load time** — every agent in `fallbackOrder`, `tierOrder[].agent`, and PRD `routing.agent` must exist as a key in `models`. Fail fast with clear error.
5. **Track `agentUsed` in metrics** — story metrics include which agent actually ran (may differ from defaultAgent after fallback). Logged alongside existing `modelTier` and `modelUsed`.
6. **No agent name mapping** — `models` keys are used directly as acpx agent identifiers. No translation layer.
7. **Pricing stays in `ModelDef` object form** — users who want cost tracking use full `{ provider, model, pricing }` objects. String shorthand = no pricing. No separate pricing table.

## Non-Goals

- Automatic agent selection by `nax plan` — `routing.agent` is manual/expert-only for now
- Per-story `fallbackOrder` override — global only
- Model pricing optimization (cheapest-agent-first) — future enhancement
- Debate integration — handled by #150, which will consume `resolveModelForAgent()` once available
- Auto-derive `fallbackOrder` from `models` keys — keep explicit for now
