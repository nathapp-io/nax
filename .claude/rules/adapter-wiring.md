---
paths:
  - "src/agents/**/*.ts"
  - "src/pipeline/stages/execution.ts"
  - "src/execution/**/*.ts"
  - "src/tdd/**/*.ts"
  - "src/acceptance/**/*.ts"
---

# Adapter Wiring — run() vs complete(), Session Naming, Agent Resolution

> For agent protocol modes (ACP vs CLI), permission resolution, and adapter folder conventions, see `docs/architecture/agent-adapters.md` §14–§16 and `docs/architecture/design-patterns.md` §11.

## Rule 1: Method Selection

1. **`run()`** — long-running interactive session. Agent edits files, runs commands, multi-turn.
2. **`complete()`** — single-shot call. One prompt → one response, no tool use.
3. **`plan()`** — ignore (ACP-specific convenience, wraps `run()` internally).

Both `run()` and `complete()` create proper ACP sessions with `buildSessionName()` when protocol is ACP.

### run() Options Template

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
  storyId,          // must pass when in story context
  sessionRole,      // must pass for non-default sessions
});
```

### complete() Options Template

```typescript
adapter.complete(prompt, {
  model: resolvedModel,    // always resolved string, never a tier name
  config,
  jsonMode: true,          // when expecting JSON
  timeoutMs: number,       // default 120_000ms — override for long calls
  workdir,
  featureName,
  storyId,                 // must pass when in story context
  sessionRole: "<role>",
});
```

## Rule 2: Session Naming

Format: `nax-<hash8>-<feature>-<storyId>-<sessionRole>`

- `<hash8>` — first 8 chars of SHA-256 of `workdir`
- `<feature>` — sanitized feature name (optional)
- `<storyId>` — optional, but **must be passed whenever the call is within a story context**
- `<sessionRole>` — purpose suffix (optional)

### Session Role Registry

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
| `"reviewer-semantic"` | `run()` | Semantic review session — initial call `keepOpen: true` (retry needs history); `agent.closeSession()` called on all exit paths (ADR-008: session closes by end of `runReview`) |
| `"reviewer-adversarial"` | `run()` | Adversarial review session — initial call `keepOpen: true` (retry needs history); `agent.closeSession()` called on all exit paths (ADR-008: session closes by end of `runReview`) |

## Rule 3: Agent Resolution — CRITICAL (compiler-enforced since ADR-013 Phase 4)

**Never import from `src/agents/registry.ts` outside `src/agents/manager.ts`.**

`AgentRegistry` and `createAgentRegistry` are internal to `AgentManager` since Phase 4. The compiler prevents bypassing this boundary: `getAgent` and `createAgentRegistry` are not exported from `src/agents/index.ts`.

### Correct Patterns

**In pipeline stages** (have `ctx: PipelineContext`):
```typescript
// ctx.agentManager is threaded from runner.ts — use getDefault() for the configured default agent
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
const agent = (ctx.agentGetFn ?? _deps.getAgent)(defaultAgent);
```

**In standalone modules** (outside pipeline, have `config: NaxConfig`):
```typescript
import { AgentManager } from "../agents";
const agent = new AgentManager(config).getAgent(agentName);
```

### Forbidden Patterns

```typescript
// ❌ WRONG — bypasses AgentManager ownership (compiler error since Phase 4)
import { createAgentRegistry } from "../agents/registry";
const agent = createAgentRegistry(config).getAgent(agentName);

// ❌ WRONG — stub that always returns undefined (removed from barrel in Phase 4)
import { getAgent } from "../agents/registry";
const agent = getAgent(agentName);
```

The `_deps.getAgent` fallback in `ctx.agentGetFn ?? _deps.getAgent` defaults to `() => undefined` — it is a test injection point only. In production, `agentGetFn` is always set by `runner.ts`.
