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
| `"reviewer-semantic"` | `run()` | Semantic review session — `keepSessionOpen: false` (stateless scorer, ADR-008) |
| `"reviewer-adversarial"` | `run()` | Adversarial review session — `keepSessionOpen: false` (stateless scorer, ADR-008) |

## Rule 3: Agent Resolution — CRITICAL

**Never use bare `getAgent()` when `config` (NaxConfig) is available.**

Bare `getAgent()` from `src/agents/registry.ts` always returns CLI adapters from `ALL_AGENTS[]`. It ignores `config.agent.protocol` entirely. When protocol is `"acp"`, this silently spawns a CLI session instead of an ACP session.

### Correct Patterns

**In pipeline stages** (have `ctx: PipelineContext`):
```typescript
// ctx.agentGetFn is threaded from runner.ts via createAgentRegistry(config)
const agent = (ctx.agentGetFn ?? _deps.getAgent)(ctx.config.autoMode.defaultAgent);
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
