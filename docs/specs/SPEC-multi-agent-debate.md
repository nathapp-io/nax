# SPEC: Multi-Agent Debate Sessions

## Summary

Add a debate session primitive that spawns 2-3 agents (potentially different agents — e.g., 2× Claude + 1× Codex) to deliberate on judgment tasks. Mixed-agent debates leverage genuinely different model perspectives, producing higher-quality output than any single model. Configurable per-stage: agent roster, session mode (one-shot or stateful), resolver strategy, and round count. Graceful degradation when agents fail.

## Motivation

Several nax stages rely on a single LLM call for critical judgment:

| Stage | Current | Problem |
|:------|:--------|:--------|
| **Plan** (`nax plan`) | Single `complete()` call | Mediocre story decomposition, routing misclassification |
| **Semantic review** | Single `complete()` in `runSemanticReview()` | Fail-open bias (#129), single-perspective blind spots |
| **Acceptance** | Part of semantic review check | False-pass when implementation "looks right" but misses edge cases |
| **Rectification** | Agent prompted with test failures | Fixates on symptom, not root cause — wastes retries |
| **Escalation** | Tier progression only (no LLM judgment) | No LLM involvement today — candidate for "should we retry or give up?" |

A single model — even an expensive one — has inherent blind spots. Different agents (Claude, Codex, Gemini) have genuinely different training data, reasoning patterns, and failure modes. The AI alignment research on "debate" and mixture-of-agents (MoA) patterns shows that multiple agents critiquing each other reliably outperform a single agent on structured judgment tasks.

**Cost:** 3× cheap model rounds ≈ $0.003 vs single opus call ≈ $0.15 (50x cheaper).

**Why mixed agents matter:** Same-model debate is just rerolling — you get variance but not diversity. Cross-model debate (e.g., Claude spots logical gaps, Codex catches implementation feasibility issues) produces genuinely complementary perspectives.

## Design

### Core Primitive: `DebateSession`

```
src/debate/
  session.ts       — DebateSession orchestrator
  resolvers.ts     — Majority, synthesis, judge resolver implementations
  prompts.ts       — Prompt templates for propose/critique/synthesize rounds
  types.ts         — DebateConfig, DebateResult, Debater, ResolverType, SessionMode
  index.ts         — Barrel exports
```

### Data Flow

```
caller (plan / review / rectification)
  │
  ├─ builds task prompt (same prompt as today)
  │
  └─ DebateSession.run(taskPrompt, stageConfig)
       │
       ├─ Round 1: PROPOSE (parallel)
       │    debater[0] (claude, haiku)  ──┐
       │    debater[1] (claude, sonnet) ──┼─→ proposals[]
       │    debater[2] (codex, default) ──┘
       │
       ├─ Round 2..N: CRITIQUE (parallel, optional)
       │    debater[0].critique(proposals) ──┐
       │    debater[1].critique(proposals) ──┼─→ critiques[]
       │    debater[2].critique(proposals) ──┘
       │
       └─ RESOLVE
            resolver.resolve(proposals, critiques) ─→ finalResult: string
```

### Debater Definition

Each debater is an `{ agent, model }` pair. This leverages nax's existing ACP agent registry (claude, codex, gemini) + model override.

```typescript
interface Debater {
  agent: string;   // "claude" | "codex" | "gemini" — matches ACP agent registry
  model?: string;  // model override, e.g. "claude-haiku-4-5", "o3-mini". Falls back to stage model tier.
}
```

**Config examples:**

```jsonc
// Homogeneous: 3 cheap Claude instances (same model, variance only)
"debaters": [
  { "agent": "claude", "model": "claude-haiku-4-5" },
  { "agent": "claude", "model": "claude-haiku-4-5" },
  { "agent": "claude", "model": "claude-haiku-4-5" }
]

// Mixed-model: same agent, different tiers (cost-quality tradeoff)
"debaters": [
  { "agent": "claude", "model": "claude-haiku-4-5" },
  { "agent": "claude", "model": "claude-sonnet-4-5" },
  { "agent": "claude", "model": "claude-haiku-4-5" }
]

// Mixed-agent: genuinely different perspectives
"debaters": [
  { "agent": "claude", "model": "claude-haiku-4-5" },
  { "agent": "claude", "model": "claude-haiku-4-5" },
  { "agent": "codex" }
]
```

**Defaults:** If `debaters` is omitted, nax auto-generates N debaters using the configured default agent (`config.autoMode.defaultAgent`, typically `"claude"`) at the `"fast"` model tier (`config.models.fast`). If `resolverAgent` is also omitted, the resolver uses the same default agent + fast model. This means `{ "debate": { "enabled": true } }` gives you the cheapest possible debate — no additional config required.

```jsonc
// User sets only:
{ "debate": { "enabled": true } }

// Effective (resolved from config.autoMode.defaultAgent + config.models.fast):
{ "debaters": [
    { "agent": "claude", "model": "<fast tier model>" },
    { "agent": "claude", "model": "<fast tier model>" },
    { "agent": "claude", "model": "<fast tier model>" }
  ],
  "resolverAgent": { "agent": "claude", "model": "<fast tier model>" }
}
```

### Session Modes (Per-Stage)

Each stage independently chooses its session mode:

| Mode | How | When |
|:-----|:----|:-----|
| `"one-shot"` | Each round is a fresh `adapter.complete()` call. Prior proposals pasted into prompt. | Simple debates, cheap models, short outputs |
| `"stateful"` | Each debater gets a persistent ACP session (`createSession()`). Rounds are sequential `session.prompt()` calls. Agent retains conversation history. | Complex multi-round debates where context matters, large outputs |

### Per-Stage Defaults

Each stage has its own natural defaults for session mode, resolver strategy, and rounds — based on the nature of the task:

| Stage | Default `sessionMode` | Default `resolver` | Default `rounds` | Rationale |
|:------|:---------------------|:-------------------|:-----------------|:----------|
| **plan** | `"stateful"` | `"synthesis"` | 3 | Large PRD output, multi-round refinement benefits from memory. Synthesis merges best parts of each proposal. |
| **review** | `"one-shot"` | `"majority"` (fail-closed) | 2 | Small structured JSON output (pass/fail + findings). Majority vote is natural for binary decisions. |
| **acceptance** | `"one-shot"` | `"majority"` (fail-closed) | 1 | Simple pass/fail judgment. Single round sufficient — propose only, no critique needed. |
| **rectification** | `"one-shot"` | `"synthesis"` | 1 | Root cause diagnosis is open-ended text. Single round keeps latency low in retry loop. Synthesis merges diagnoses. |
| **escalation** | `"one-shot"` | `"majority"` (fail-closed) | 1 | Binary decision (retry vs give up). Conservative tie-break avoids premature escalation. |

These defaults apply when the user enables a stage but doesn't specify the field:

```jsonc
// User config — only enables debate + plan
{ "debate": { "enabled": true } }

// Effective plan config (all defaults applied):
// sessionMode: "stateful", resolver: { type: "synthesis" }, rounds: 3
```

**Why per-stage defaults matter:** A global `sessionMode: "one-shot"` default would be wrong for plan (which needs stateful), while a global `sessionMode: "stateful"` default would be wasteful for review (which is simple pass/fail). Same for resolver — synthesis makes no sense for binary acceptance judgments, and majority vote makes no sense for PRD generation.

### Resolver Strategies

| Resolver | Input | Output | Best For |
|:---------|:------|:-------|:---------|
| `"majority"` | N proposals (structured JSON with pass/fail or category) | Most common answer | Binary decisions: acceptance, escalation |
| `"synthesis"` | N proposals + N critiques | New `complete()` call with all proposals + critiques, asked to synthesize best parts | Open-ended output: plan/PRD, rectification diagnosis |
| `"judge"` | N proposals | New `complete()` call with a designated judge agent/model that picks or merges the winner | When quality gap between proposals may be large |

**Majority vote:** Parses structured JSON from each proposal (e.g., `{"passed": true/false}`) and returns the majority result. Tie-breaking: fail-closed (returns the more conservative answer).

**Synthesis:** Makes one additional `complete()` call with a synthesis prompt containing all proposals and critiques. The synthesizer produces the final merged output. Uses `resolverAgent` if set, otherwise default agent at fast tier.

**Judge:** Makes one additional `complete()` call with a designated judge. Uses `resolverAgent` if set, otherwise default agent at fast tier. To use a stronger judge model, explicitly set `resolverAgent`.

```jsonc
{
  "debate": {
    "stages": {
      "plan": {
        "resolver": {
          "type": "judge",
          "agent": { "agent": "claude", "model": "claude-sonnet-4-5" }
        }
      }
    }
  }
}
```

### TypeScript Interfaces

```typescript
// src/debate/types.ts

export type ResolverType = "majority" | "synthesis" | "judge";
export type SessionMode = "one-shot" | "stateful";

export interface Debater {
  /** ACP agent name — must be registered in agent registry */
  agent: string;
  /** Model override. Falls back to stage defaultModel or config.models[tier] */
  model?: string;
}

export interface ResolverConfig {
  type: ResolverType;
  /** Agent/model for synthesis or judge calls. Omit → default agent at fast tier. */
  agent?: Debater;
  /** For majority: tie-breaking strategy. Default: "fail-closed" (conservative). */
  tieBreaker?: "fail-closed" | "fail-open";
  /** For synthesis: max tokens for the synthesis prompt. Default: no limit. */
  maxPromptTokens?: number;
}

export interface DebateStageConfig {
  enabled: boolean;
  resolver: ResolverConfig;
  sessionMode: SessionMode;
  rounds: number;
  debaters?: Debater[];            // explicit roster — overrides agents count
}

export interface DebateConfig {
  enabled: boolean;
  /** Number of debaters when using shorthand (no explicit debaters array). Default: 3 */
  agents: number;
  // Note: no global rounds or sessionMode — each stage has its own defaults
  // (plan: stateful/3, review: one-shot/2, acceptance: one-shot/1, etc.)
  // Agent + model resolved at runtime from config.autoMode.defaultAgent + config.models.fast.
  stages: {
    plan?: Partial<DebateStageConfig>;
    review?: Partial<DebateStageConfig>;
    acceptance?: Partial<DebateStageConfig>;
    rectification?: Partial<DebateStageConfig>;
    escalation?: Partial<DebateStageConfig>;
  };
}

export interface DebateResult {
  /** Final resolved output */
  output: string;
  /** Individual proposals from each debater */
  proposals: Array<{
    debater: Debater;
    output: string;
    costUsd: number;
    durationMs: number;
  }>;
  /** Individual critiques (if rounds > 1) */
  critiques: Array<{
    debater: Debater;
    output: string;
    costUsd: number;
  }>;
  /** Resolver used */
  resolver: ResolverType;
  /** Total cost across all debaters and rounds */
  totalCostUsd: number;
  /** Total duration in ms (wall clock) */
  durationMs: number;
  /** Number of debaters that completed successfully */
  successfulDebaters: number;
  /** Number of debaters that failed */
  failedDebaters: number;
}
```

### Config Schema Addition

```jsonc
// Added to NaxConfig (src/config/schema.ts)
{
  "debate": {
    "enabled": false,               // opt-in — all stages below are only active when enabled=true
    "agents": 3,                    // shorthand debater count (when no explicit debaters[])
    // Agent + model resolved from config.autoMode.defaultAgent + config.models.fast
    "stages": {
      "plan": {
        "enabled": true,
        "resolver": { "type": "synthesis" },
        "sessionMode": "stateful",  // large PRD output, multi-round refinement
        "rounds": 3                 // propose → critique → refine
      },
      "review": {
        "enabled": true,
        "resolver": { "type": "majority", "tieBreaker": "fail-closed" },
        "sessionMode": "one-shot",  // small structured JSON (pass/fail)
        "rounds": 2                 // propose → critique
      },
      "acceptance": {
        "enabled": false,           // off by default — currently shares review stage; enable when split
        "resolver": { "type": "majority", "tieBreaker": "fail-closed" },
        "sessionMode": "one-shot",  // simple pass/fail
        "rounds": 1                 // propose only
      },
      "rectification": {
        "enabled": false,           // off by default — adds latency to retry loop
        "resolver": { "type": "synthesis" },
        "sessionMode": "one-shot",  // keep latency low
        "rounds": 1                 // single diagnosis round
      },
      "escalation": {
        "enabled": false,           // not yet an LLM stage — deferred
        "resolver": { "type": "majority", "tieBreaker": "fail-closed" },
        "sessionMode": "one-shot",  // binary retry/give-up decision
        "rounds": 1
      }
    }
  }
}
```

**Per-stage override example:**

```jsonc
{
  "debate": {
    "enabled": true,
    "stages": {
      "plan": {
        "enabled": true,
        "resolver": {
          "type": "judge",
          "agent": { "agent": "claude", "model": "claude-sonnet-4-5" }
        },
        "sessionMode": "stateful",
        "rounds": 3,
        "debaters": [
          { "agent": "claude", "model": "claude-haiku-4-5" },
          { "agent": "claude", "model": "claude-sonnet-4-5" },
          { "agent": "codex" }
        ]
      },
      "review": {
        "enabled": true,
        "resolver": {
          "type": "majority",
          "tieBreaker": "fail-closed"
        },
        "debaters": [
          { "agent": "claude", "model": "claude-haiku-4-5" },
          { "agent": "codex" }
        ]
      }
    }
  }
}
```

### Integration Points

#### 1. Plan (`src/cli/plan.ts`)

Current: single `adapter.complete(prompt)` or `adapter.plan()` call.
Change: when debate is enabled for plan, resolve the debater roster from config, instantiate adapters for each, and run `DebateSession.run()`.

```typescript
// Before:
rawResponse = await adapter.complete(prompt, { ... });

// After:
if (resolvedDebateConfig?.stages?.plan?.enabled) {
  const result = await debateSession.run(prompt, resolvedDebateConfig, "plan");
  rawResponse = result.output;
} else {
  rawResponse = await adapter.complete(prompt, { ... });
}
```

Each debater in the roster needs its own `AgentAdapter` instance. The existing `getAgent()` registry returns adapters by name — we call it once per unique agent in the roster, then configure model overrides per-debater.

#### 2. Semantic Review (`src/review/semantic.ts`)

Current: single `agent.complete(prompt)` at line ~315.
Change: when debate enabled for review, wrap the `complete()` call.

For review, the resolver is typically `"majority"` — each agent returns `{"passed": true/false, "findings": [...]}`. Majority vote determines the final result. Findings from all agents are merged (deduplicated by AC reference).

#### 3. Acceptance (`src/review/semantic.ts`)

Acceptance is currently part of semantic review (same `complete()` call). If we want separate debate for acceptance vs style review, we'd need to split the semantic review prompt. For v1, acceptance debate shares the review debate config unless explicitly overridden.

#### 4. Rectification Diagnosis (`src/verification/rectification-loop.ts`)

Current: rectification prompt built and sent to the agent.
Change: when enabled, a debate session diagnoses the root cause first. The diagnosis output is prepended to the rectification prompt as a `## Root Cause Analysis` section.

Off by default — adds latency to every retry loop iteration.

#### 5. Escalation Gate (future)

Not currently an LLM-based decision. Deferred — tracked but not implemented in this spec.

### Adapter Resolution for Debaters

Each debater `{ agent, model }` needs an `AgentAdapter`. Resolution:

1. Call `getAgent(debater.agent)` from the agent registry → returns adapter
2. Pass `model` as override in the `complete()` call options: `adapter.complete(prompt, { model: debater.model })`
3. For stateful mode: `createClient("acpx --model <debater.model> <debater.agent>")` → `createSession()`

**Edge case:** If a debater's agent is not installed (e.g., codex not available), skip that debater and log a warning. Debate continues with remaining debaters (minimum 2 required).

### Error Handling

| Failure | Behavior |
|:--------|:---------|
| 1 of N debaters fails (timeout, rate limit, agent not installed) | Continue with remaining debaters. If ≥2 succeed, resolve with available proposals. Log warning. |
| All debaters fail | Fall back to single-agent mode (call `complete()` once with the original prompt using the first debater's agent). Log error. |
| Resolver fails (synthesis/judge `complete()` errors) | Return the best individual proposal (longest / most structured). Log error. |
| Config invalid (< 2 debaters, rounds < 1) | Disable debate for that stage, log warning, proceed with single-agent. |

**Graceful degradation principle:** Debate is an enhancement, not a gate. If anything goes wrong, fall back to single-agent behavior (which is what we have today).

### Cost Tracking

Each `complete()` call in the debate returns `exactCostUsd`. The `DebateResult` aggregates:
- Per-debater cost (proposals + critiques)
- Resolver cost (synthesis/judge additional call)
- `totalCostUsd = sum of all calls`
- This rolls up into the story's total cost in the run metrics.

### Logging

All debate activity logs to the structured JSONL logger with `stage: "debate"`:

```
{ stage: "debate", event: "round-start", round: 1, debaters: ["claude:haiku", "claude:sonnet", "codex:default"], storyId: "US-001" }
{ stage: "debate", event: "proposal", debaterIndex: 0, agent: "claude", model: "haiku", durationMs: 1200, costUsd: 0.001 }
{ stage: "debate", event: "proposal", debaterIndex: 1, agent: "claude", model: "sonnet", durationMs: 980, costUsd: 0.003 }
{ stage: "debate", event: "proposal-failed", debaterIndex: 2, agent: "codex", error: "agent not installed" }
{ stage: "debate", event: "resolve", resolver: "synthesis", durationMs: 1500 }
{ stage: "debate", event: "complete", totalCostUsd: 0.006, successfulDebaters: 2, failedDebaters: 1 }
```

## Stories

### US-001: Debate Types, Config Schema, and Defaults

**No dependencies.**

Add the `DebateConfig`, `Debater`, and related types, Zod schema with validation, and defaults to the config system.

#### Context Files
- `src/config/schema.ts` — NaxConfig Zod schema, add `debate` section
- `src/config/schema-types.ts` — exported type aliases
- `src/config/defaults.ts` — DEFAULT_CONFIG
- `src/config/index.ts` — barrel exports
- `src/cli/config-descriptions.ts` — human-readable config descriptions for `nax config show`

#### Acceptance Criteria
- When `debate` key is absent from config JSON, `loadConfig()` returns `debate.enabled = false` with all per-stage defaults populated (plan: stateful/synthesis/3 rounds, review: one-shot/majority/2 rounds, acceptance: one-shot/majority/1 round, rectification: one-shot/synthesis/1 round disabled, escalation: one-shot/majority/1 round disabled)
- When no `debaters` or `resolver.agent` is specified, the runtime resolves agent from `config.autoMode.defaultAgent` and model from `config.models.fast` — no agent/model fields stored in debate config
- When a stage config has `debaters` array with fewer than 2 entries, `NaxConfigSchema.safeParse()` returns a validation error with message containing "debaters must have at least 2 entries"
- When a stage config has `debaters` array, the `agents` shorthand field is ignored for that stage
- When `debate.stages.plan.resolver` is set to `"invalid"`, `NaxConfigSchema.safeParse()` returns a validation error
- When `debate.stages.plan` is partially specified (e.g., only `resolver`), the remaining fields (`sessionMode`, `rounds`, `debaters`) fall back to the global `debate.*` defaults
- When a `debaters` entry has `agent` but no `model`, the debater inherits the stage's `defaultModel` (or global `debate.defaultModel`)
- When `nax config show` is called, the debate section appears with human-readable descriptions for all fields

### US-002: DebateSession Core — One-Shot Mode with Mixed Agents

**Depends on US-001.**

Implement the `DebateSession` orchestrator with one-shot mode, parallel proposal collection across mixed agents, and the three resolver strategies.

#### Context Files
- `src/debate/session.ts` — new file: DebateSession class
- `src/debate/resolvers.ts` — new file: majority, synthesis, judge implementations
- `src/debate/prompts.ts` — new file: prompt templates for critique and synthesis rounds
- `src/debate/types.ts` — from US-001
- `src/agents/types.ts` — AgentAdapter interface (complete() signature)
- `src/agents/acp/adapter.ts` — AcpAgentAdapter.complete() for reference
- `src/agents/registry.ts` — getAgent() for resolving debater agents

#### Acceptance Criteria
- `DebateSession.run()` resolves each debater's `AgentAdapter` via `getAgent(debater.agent)` and calls `adapter.complete()` with the debater's model override
- `DebateSession.run()` calls all debaters in parallel for the proposal round via `Promise.allSettled()`
- When a debater's agent is not installed (`getAgent()` returns null), that debater is skipped and a warning is logged
- When fewer than 2 debaters succeed in the proposal round, `DebateSession.run()` falls back to single-agent mode and returns the one successful proposal (or calls `complete()` fresh if all failed)
- When `rounds` is 2, the critique round sends each debater all other debaters' proposals in its prompt
- When `rounds` is 1 (propose only), the critique round is skipped and proposals go directly to the resolver
- `majorityResolver()` returns `"passed"` when 2 of 3 proposals contain `"passed": true` in their JSON output
- `majorityResolver()` returns the fail-closed answer (more conservative) on a tie
- `synthesisResolver()` calls `adapter.complete()` once with a synthesis prompt containing all proposals and critiques
- `judgeResolver()` calls `adapter.complete()` once with a judge prompt using the configured `resolver.agent` (or default agent at fast tier if unset)
- `DebateResult.totalCostUsd` equals the sum of all `complete()` call costs across all debaters and rounds
- `DebateResult.proposals` contains the debater identity (`agent`, `model`) alongside each proposal output

### US-003: Stateful Session Mode

**Depends on US-002.**

Add stateful session mode where each debater gets a persistent ACP session. Rounds use `session.prompt()` instead of `adapter.complete()`. Configurable per-stage.

#### Context Files
- `src/debate/session.ts` — extend with stateful mode branch
- `src/agents/acp/spawn-client.ts` — SpawnAcpSession, SpawnAcpClient, createSession
- `src/agents/acp/adapter.ts` — AcpSession interface, session lifecycle
- `src/debate/types.ts` — SessionMode type

#### Acceptance Criteria
- When a stage's `sessionMode` is `"stateful"`, `DebateSession.run()` creates a `SpawnAcpClient` per debater using `"acpx --model <debater.model> <debater.agent>"` and calls `client.createSession()`
- When `sessionMode` is `"stateful"`, the critique round does NOT paste all proposals into the prompt — instead it sends only the other debaters' proposals (the session retains its own history)
- When `sessionMode` is `"stateful"`, all sessions are closed via `session.close()` in the finally block — even if the debate fails mid-round
- When `sessionMode` is `"one-shot"`, `DebateSession.run()` uses `adapter.complete()` per debater (no persistent sessions)
- When a stateful session fails to create (acpx error), that debater is skipped and the debate continues with remaining debaters (minimum 2 required)
- When two stages in the same run have different `sessionMode` values (e.g., plan=stateful, review=one-shot), each stage uses its own mode independently

### US-004: Integration — Plan and Semantic Review

**Depends on US-002.**

Wire `DebateSession` into `nax plan` and `runSemanticReview()`. When debate is enabled for a stage, the existing single-agent call is replaced by the debate session.

#### Context Files
- `src/cli/plan.ts` — plan command, `complete()` call at line ~200, `adapter.plan()` call
- `src/review/semantic.ts` — `runSemanticReview()`, `complete()` call at line ~315
- `src/review/types.ts` — ReviewCheckResult, SemanticReviewConfig
- `src/debate/session.ts` — DebateSession
- `src/pipeline/stages/review.ts` — review stage wiring
- `src/agents/registry.ts` — getAgent()

#### Acceptance Criteria
- When `debate.enabled` is true and `debate.stages.plan.enabled` is true, `nax plan --auto` uses `DebateSession.run()` instead of a single `adapter.complete()` call
- When `debate.enabled` is false, `nax plan --auto` calls `adapter.complete()` exactly once (no behavior change from today)
- When `debate.enabled` is true and `debate.stages.review.enabled` is true, `runSemanticReview()` uses `DebateSession.run()` instead of a single `agent.complete()` call
- When review debate uses majority resolver, the final `ReviewCheckResult.success` reflects the majority vote of debater responses
- When review debate uses majority resolver, `ReviewCheckResult.findings` contains the merged (deduplicated by AC id) findings from all debaters
- When all debaters fail during plan, the system falls back to a single `adapter.complete()` call and logs a warning with `stage: "debate"` and `event: "fallback"`

### US-005: Integration — Rectification Diagnosis

**Depends on US-002.**

Add optional debate-based root cause diagnosis before the rectification prompt is sent to the execution agent.

#### Context Files
- `src/verification/rectification-loop.ts` — rectification loop, prompt construction
- `src/verification/rectification.ts` — shouldRetryRectification, formatFailureSummary
- `src/debate/session.ts` — DebateSession
- `src/debate/prompts.ts` — rectification diagnosis prompt template

#### Acceptance Criteria
- When `debate.stages.rectification.enabled` is true, the rectification loop runs a debate session to diagnose root cause BEFORE building the agent's rectification prompt
- The diagnosis output is prepended to the rectification prompt as a `## Root Cause Analysis` section
- When `debate.stages.rectification.enabled` is false (default), the rectification loop is unchanged from today
- When the diagnosis debate fails (all debaters error), the rectification prompt proceeds without the diagnosis section and logs `event: "fallback"`
- The debate cost is included in the story's total cost tracking

## Future Prerequisites (not in this spec)

These stages are disabled by default because they require prerequisite work before debate can be wired in:

| Stage | Prerequisite | What's Needed |
|:------|:------------|:--------------|
| **acceptance** | Split acceptance from semantic review | Currently `runSemanticReview()` does both AC validation and code review in a single `complete()` call. To debate acceptance separately, the prompt must be split into two: (1) AC pass/fail judgment, (2) code quality findings. Without this split, enabling acceptance debate would just duplicate the review debate. |
| **escalation** | Make escalation an LLM-based decision | Currently `escalateTier()` in `src/execution/escalation/escalation.ts` is purely structural — it walks a tier chain with no LLM involved. To debate "should we retry or give up?", we first need a new LLM-based escalation judgment call that considers: test output, number of attempts, failure pattern, and cost so far. Then debate can wrap that call. |

**Tracking:** These should be filed as separate enhancement issues when the debate feature is stable and proven on plan + review.

## Resolved Decisions

1. **Debate in interactive `nax plan`?** — **No** for v1. Interactive mode already has the human as critic. Revisit later if needed.

2. **Debate round history in JSONL?** — **Debug level only.** Proposals/critiques at `debug`, final result at `info`. No new flag needed.

3. **Review finding deduplication?** — **AC id matching.** Simple, deterministic. If two agents flag the same AC differently, keep both — richer findings for the user.

4. **Max proposal size for one-shot critique prompts?** — **Moot for plan** (stateful by default). For review/acceptance (small JSON), not a concern. Safety truncation at 50KB (same as semantic review diff cap) if ever needed.

5. **Pre-check agent availability?** — **No pre-check.** Rely on graceful degradation — skip unavailable debaters, continue with ≥2. Keeps startup fast.

6. **Per-stage `enabled` defaults?** — **plan + review on**, acceptance/rectification/escalation off. Plan has highest ROI; review addresses proven fail-open bias (#129). Acceptance is not yet split from review. Rectification adds retry latency. Escalation is not yet an LLM stage.
