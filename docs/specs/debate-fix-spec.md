# Spec: Fix Multi-Agent Debate Wiring

**Issues:** #172, #173, #174  
**Branch:** `fix/debate-wiring`  
**Scope:** `src/debate/session.ts`, `src/cli/plan.ts`, `src/review/semantic.ts`, benchmark configs

---

## Background

Three bugs in the debate system discovered during benchmark testing:

1. **#172 — Plan debate dead code for ACP:** Debate check is inside `else` (CLI-only branch). Since `agent.protocol: "acp"` is default, plan never debates.
2. **#173 — Wrong model in debate:** `runOneShot` and `runStateful` pass `debater.model` (e.g. `"haiku"`) raw as `--model haiku`. For MiniMax/custom API overrides, `"haiku"` is not a valid model name. Should resolve through `config.models` mapping.
3. **#174 — No debate logs:** `DebateSession` emits no structured JSONL events — debate lifecycle is invisible in run logs.

---

## Change 1 — `src/debate/session.ts`

### 1a. Accept `NaxConfig` in `DebateSessionOptions`

```typescript
import type { NaxConfig } from "../config";

export interface DebateSessionOptions {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config?: NaxConfig;  // ← add
}
```

Store as `private readonly config?: NaxConfig` in `DebateSession`.

### 1b. Add `resolveDebaterModel()` helper (module-level, not exported)

```typescript
const MODEL_TIERS = ["fast", "balanced", "powerful"] as const;
type ModelTier = typeof MODEL_TIERS[number];

function resolveDebaterModel(debater: Debater, config?: NaxConfig): string | undefined {
  if (!debater.model) return undefined;
  if ((MODEL_TIERS as readonly string[]).includes(debater.model)) {
    const tier = debater.model as ModelTier;
    const agentModels = (config?.models as Record<string, Record<string, string>> | undefined)?.[debater.agent];
    return agentModels?.[tier] ?? debater.model;
  }
  // Direct model name (e.g. "MiniMax-M2.7", "claude-sonnet-4-5") — use as-is
  return debater.model;
}
```

### 1c. Use `resolveDebaterModel()` in `runOneShot`

```typescript
// BEFORE:
adapter.complete(prompt, { model: debater.model })

// AFTER:
adapter.complete(prompt, { model: resolveDebaterModel(debater, this.config) })
```

### 1d. Use `resolveDebaterModel()` in `runStateful`

```typescript
// BEFORE:
const cmdStr = `acpx --model ${debater.model} ${debater.agent}`;

// AFTER:
const resolvedModel = resolveDebaterModel(debater, this.config);
const cmdStr = resolvedModel
  ? `acpx --model ${resolvedModel} ${debater.agent}`
  : `acpx ${debater.agent}`;
```

### 1e. Add structured JSONL log events

Use `logger?.info()` at these points in both `runOneShot` and `runStateful`:

**`debate:start`** — before first round:
```typescript
logger?.info("debate", "debate:start", {
  stage: this.stage,
  storyId: this.storyId,
  debaters: config.debaters?.map(d => d.agent) ?? [],
  rounds: config.rounds,
  sessionMode: config.sessionMode ?? "one-shot",
});
```

**`debate:proposal`** — after each debater responds (trim to first 200 chars for log brevity):
```typescript
logger?.info("debate", "debate:proposal", {
  stage: this.stage,
  storyId: this.storyId,
  debater: debater.agent,
  model: resolvedModel,
  outputPreview: output.slice(0, 200),
});
```

**`debate:result`** — after resolve():
```typescript
logger?.info("debate", "debate:result", {
  stage: this.stage,
  storyId: this.storyId,
  outcome,
  resolverType: config.resolver.type,
  totalCostUsd,
  debaterCount: successful.length,
});
```

**`debate:fallback`** — when fewer than 2 debaters succeed (single-agent fallback):
```typescript
logger?.warn("debate", "debate:fallback", {
  stage: this.stage,
  storyId: this.storyId,
  reason: "fewer than 2 debaters succeeded",
  available: resolved.length,
  succeeded: successful.length,
});
```

---

## Change 2 — `src/cli/plan.ts`

### Hoist debate check outside the `isAcp` / `else` gate

**Current (broken) structure:**
```typescript
if (isAcp) {
  await adapter.plan({...});           // ← no debate here
  rawResponse = ...;
} else {
  const debateEnabled = ...;
  if (debateEnabled) { /* debate */ }  // ← dead code for ACP (default)
  else { rawResponse = await adapter.complete(...); }
}
```

**Target structure:**
```typescript
const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.plan?.enabled;

if (debateEnabled) {
  const planStageConfig = config.debate!.stages.plan as DebateStageConfig;
  const debateSession = _planDeps.createDebateSession({
    storyId: options.feature,
    stage: "plan",
    stageConfig: planStageConfig,
    config,                             // ← pass config for model resolution
  });
  const debateResult = await debateSession.run(prompt);
  if (debateResult.outcome !== "failed" && debateResult.output) {
    rawResponse = debateResult.output;
    // If ACP, agent wrote to file — overwrite with debate winner
    await _planDeps.writeFile(outputPath, rawResponse);
  } else {
    logger?.warn("debate", "Plan debate failed — falling back to single agent", {
      feature: options.feature,
    });
    rawResponse = await runSingleAgentPlan(isAcp, adapter, prompt, outputPath, autoModel, options, config, timeoutSeconds, resolvePermissions, pidRegistry);
  }
} else {
  rawResponse = await runSingleAgentPlan(isAcp, adapter, prompt, outputPath, autoModel, options, config, timeoutSeconds, resolvePermissions, pidRegistry);
}
```

Extract the existing ACP + CLI paths into a private `runSingleAgentPlan()` helper to avoid code duplication. This helper contains the current `if (isAcp) { ... } else { ... }` block unchanged.

**Note:** The existing debate code in the `else` branch must be removed after the hoist.

---

## Change 3 — `src/review/semantic.ts`

Pass `naxConfig` when constructing `DebateSession`:

```typescript
// BEFORE:
const debateSession = _semanticDeps.createDebateSession({
  storyId: story.id,
  stage: "review",
  stageConfig: reviewStageConfig,
});

// AFTER:
const debateSession = _semanticDeps.createDebateSession({
  storyId: story.id,
  stage: "review",
  stageConfig: reviewStageConfig,
  config: naxConfig,    // ← add
});
```

---

## Change 4 — Benchmark configs

Update debater `model` from direct alias to tier name so `resolveDebaterModel()` routes through `config.models`:

**`benchmark/configs/debate-haiku-haiku.json`**  
**`benchmark/configs/debate-haiku-haiku-minimax-override.json`**

```json
// BEFORE:
"debaters": [
  { "agent": "claude", "model": "haiku" },
  { "agent": "claude", "model": "haiku" }
]

// AFTER:
"debaters": [
  { "agent": "claude", "model": "fast" },
  { "agent": "claude", "model": "fast" }
]
```

Both configs already have `"models": { "claude": { "fast": "..." } }` — the tier resolves correctly in each environment.

Also update resolver sections (same pattern):
```json
// BEFORE: "resolver": { "type": "synthesis", "agent": "claude" }
// (no model field on resolver — resolver uses adapter default, no change needed)
```

---

## Tests Required

### Unit: `test/unit/debate/session.test.ts`

- `resolveDebaterModel` resolves tier `"fast"` → `config.models.claude.fast`
- `resolveDebaterModel` passes direct model name `"MiniMax-M2.7"` as-is
- `resolveDebaterModel` returns `undefined` when `debater.model` is absent
- `resolveDebaterModel` falls back to tier name when config has no models entry
- `runOneShot` calls `adapter.complete` with resolved model (mock adapter)
- `runStateful` builds acpx cmd with resolved model (mock `createSpawnAcpClient`)
- JSONL events: verify `debate:start`, `debate:result`, `debate:fallback` are emitted (mock logger)

### Unit: `test/unit/plan.test.ts` (additions)

- When `debate.enabled: true` and `agent.protocol: "acp"`, `createDebateSession` is called (not skipped)
- When debate returns `outcome: "failed"`, falls back to `adapter.plan()`
- When debate returns `outcome: "passed"` with output, `adapter.plan()` is NOT called

---

## Quality Gates

After ALL changes:

```bash
bun run typecheck   # must pass with 0 errors
bun run lint        # must pass with 0 errors
NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000 --bail   # must pass
```

Commit message: `fix(debate): wire ACP plan path, resolve model via config, add JSONL events`

Closes #172, #173, #174
