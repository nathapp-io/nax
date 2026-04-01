# Rule 08: Adapter Wiring — run() vs complete() and Agent Resolution

## Method Selection

| Method | Use When | Session Type |
|:-------|:---------|:-------------|
| `run()` | Agent needs filesystem access — edit files, run commands, multi-turn implementation | Long-running interactive session |
| `complete()` | Single prompt → single response — JSON classification, refinement, code generation (no tool use) | One-shot ephemeral session |
| `plan()` | Planning stage only — ACP wraps `run()` internally, CLI falls back to `complete()` in caller | ACP-specific convenience |

Both `run()` and `complete()` create proper ACP sessions with `buildSessionName()` when protocol is ACP.

## Session Naming

Format: `nax-<hash8>-<feature>-<storyId>-<sessionRole>`

- `<hash8>` — first 8 chars of SHA-256 of `workdir`
- `<feature>` — sanitized feature name (optional)
- `<storyId>` — sanitized story ID (optional, but **must be passed when in story context**)
- `<sessionRole>` — purpose suffix (optional)

### Session Role Convention

| Role | Method | Used By |
|:-----|:-------|:--------|
| *(none)* | `run()` | Main implementation session (`execution.ts`) |
| `"implementer"` | `run()` | Rectification / autofix sessions |
| `"plan"` | `plan()` → `run()` | Planning stage |
| `"decompose"` | `complete()` | Story decomposition |
| `"acceptance-gen"` | `complete()` | Acceptance test generation |
| `"refine"` | `complete()` | AC criteria refinement |
| `"fix-gen"` | `complete()` | Fix story generation |
| `"auto"` | `complete()` | Auto-approve interaction |
| `"diagnose"` | `run()` | Acceptance failure diagnosis |
| `"source-fix"` | `run()` | Acceptance source fix |

## Agent Resolution — CRITICAL

**Never use bare `getAgent()` when `config` (NaxConfig) is available.**

Bare `getAgent()` from `src/agents/registry.ts` always returns CLI adapters from `ALL_AGENTS[]`. It ignores `config.agent.protocol` entirely. When protocol is `"acp"`, this silently spawns a CLI session instead of an ACP session.

### Correct Patterns

**In pipeline stages** (have `ctx: PipelineContext`):
```typescript
// ctx.agentGetFn is threaded from runner.ts via createAgentRegistry(config)
const agent = (ctx.agentGetFn ?? _deps.getAgent)(agentName);
```

**In standalone modules** (outside pipeline, have `config: NaxConfig`):
```typescript
import { createAgentRegistry } from "../agents/registry";
const agent = createAgentRegistry(config).getAgent(agentName);
```

### Forbidden Pattern

```typescript
// ❌ WRONG — ignores config.agent.protocol, always returns CLI adapter
import { getAgent } from "../agents/registry";
const agent = getAgent(agentName);  // even when config is in scope
```

The `_deps.getAgent` fallback in `?? _deps.getAgent` is acceptable ONLY as a test injection point. In production, `agentGetFn` is always set by `runner.ts`.

## run() Options Template

```typescript
agent.run({
  prompt,
  workdir,
  modelTier,
  modelDef: resolveModelForAgent(config.models, agentName, tier, defaultAgent),
  timeoutSeconds: config.execution.sessionTimeoutSeconds,
  dangerouslySkipPermissions: resolvePermissions(config, "<stage>").skipPermissions,
  pipelineStage: "<stage>",
  config,
  maxInteractionTurns: config.agent?.maxInteractionTurns,
  featureName,
  storyId,          // pass when in story context
  sessionRole,      // pass for non-default sessions
});
```

## complete() Options Template

```typescript
adapter.complete(prompt, {
  model: resolvedModel,    // always resolved string, never a tier name
  config,
  jsonMode: true,          // when expecting JSON
  timeoutMs: number,       // default 120_000ms — override for long calls
  workdir,
  featureName,
  storyId,                 // pass when in story context
  sessionRole: "<role>",
});
```
