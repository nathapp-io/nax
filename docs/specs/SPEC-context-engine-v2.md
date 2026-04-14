# SPEC: Context Engine v2 (CONTEXT-002)

> **Status:** Draft for discussion. Supersedes the architecture of [SPEC-feature-context-engine.md](./SPEC-feature-context-engine.md) (v1) while keeping v1's file-based `context.md` as the reference implementation of one provider. No code has been written against this spec yet.

## Summary

A **stage-aware, session-aware, pluggable context engine** that orchestrates multiple context sources (feature files, session scratch, RAG indexes, code graphs, knowledge bases) and feeds each pipeline stage the right slice of context via a **hybrid push/pull** model.

v1 answered *"how do we remember what prior stories learned in this feature?"* with a single file and a single injection point. v2 answers five harder questions:

1. **Session lifecycle** — how does context survive session resume, crashes, and handoffs between agent sessions within one story?
2. **Stage granularity** — decompose, plan, test-writer, implementer, reviewer, rectifier all want *different* context; injecting the same blob everywhere wastes budget and introduces noise.
3. **Beyond files** — retrieval-augmented generation, symbol graphs, and external knowledge bases are now table stakes; the engine must host them as first-class providers, not bolt them on.
4. **Push vs pull** — some knowledge the agent won't know to ask for (push); some is too large to pre-inject (pull). Different roles need different mixes.
5. **Agent portability and availability fallback** — when a Claude session fails due to **availability** (quota exhausted, rate limit, service outage, auth error), the runner needs to switch to Codex / Gemini / local and continue the story. This is different from tier escalation (which is quality-driven, same agent). The context engine owns two things this unlocks: (a) it is the **canonical source of rules and conventions** so the new agent reads the same project guidance the prior agent did — no per-agent `CLAUDE.md`/`AGENTS.md` sync problem, because those files become optional shims; and (b) it carries forward the portable substrate (session scratch, feature context, prior-stage digest) so the new agent doesn't restart from zero.

v2 keeps v1's goals (feature-scoped working memory, role-filtered injection, append-and-summarize) and reframes them as one provider among several, all orchestrated behind a shared interface.

## Motivation

### What v1 got right

- Feature-scoped > global. Confirmed by Phase 0 manual dogfooding.
- Role-filtered injection. Reduced implementer prompt noise ~18% in the prompt-refactor feature.
- Append-and-summarize with parallel-safe fragments. Correct concurrency model.
- Human-in-the-loop promotion gate. Right call — auto-promotion caused sprawl in prior attempts.

### What v1 missed

1. **Context is delivered as one monolithic block** at prompt-build time, regardless of pipeline stage. A rectifier retrying a lint failure gets the same context as the initial implementer writing greenfield code. These are different tasks with different context needs.

2. **Context is delivered at story scope**, but a story has many internal sessions: plan → test-writer → implementer → verifier → reviewer → rectifier → autofix. Learning during the test-writer session (e.g., "this file's existing test uses a fixture named `tempDir`") never reaches the implementer session, even within the same story.

3. **`context.md` is the only source.** External knowledge — company wiki, design docs, ADR database, similar-code-from-other-repos — can't be layered in without forking the provider.

4. **Pull is impossible.** An agent can't ask "show me all usages of `resolveFeatureId`" mid-task. The only options are "put it in the prompt ahead of time" or "don't have it." Long-running roles (implementer) pay the cost of bad prompt-time guesses.

5. **No budget orchestration.** v1 has one budget (`context.featureEngine.budgetTokens: 2048`) enforced by tail-truncation. When multiple providers exist, there's no knapsack logic to decide which provider's chunks are most relevant for the current stage.

6. **No auditability.** When a review finds the agent made the wrong call, we can't tell *which context chunk led to the wrong call* because there's no manifest of what was injected.

7. **Agent-locked and availability-fragile.** v1 assumes Claude (`CLAUDE.md`, `.claude/rules/`, Claude system-prompt conventions, Claude tool format). When Claude is unavailable (quota exhausted, rate-limited, service outage, auth error), today's runner either fails the story or — if configured for a different agent — hands the new agent a prompt shaped for Claude, referencing files like `.claude/rules/project-conventions.md` that Codex/Gemini won't read on their own. The real failure mode here is *availability*, not *quality*: the agent worked fine until the vendor limit was hit. The fix is two things the context engine is uniquely positioned to own:
    - **Canonical rules delivery.** Rules and conventions are authored *once* in the engine's canonical store and rendered into every prompt regardless of agent. Per-agent rule files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) become optional operator-facing shims, not the source of truth. No translation, no drift, no per-agent rewriting.
    - **Availability fallback with preserved substrate.** When the adapter reports an availability failure, the orchestrator swaps agent target and re-renders the in-flight bundle for the new agent — carrying forward session scratch, feature context, and prior-stage digest — so the story continues from where the prior agent stopped, not from scratch.

   Tier escalation (quality-driven, same agent) remains a separate axis, handled by `src/execution/escalation/` as today. Availability fallback is orthogonal.

## Non-Goals

- **Not replacing v1's storage layout.** `.nax/features/<id>/context.md` stays as the `FeatureContextProvider`'s storage. v1's extractor, summarizer, and promotion gate remain valid and reused.
- **Not shipping all providers at once.** Initial rollout ships the orchestrator + v1 feature provider + session scratch provider. RAG/graph/KB providers are separate follow-up specs that depend on this foundation.
- **Not a general-purpose RAG framework.** Third-party providers are plugged in through `IContextProvider`; we are not building a vector database, an embedding pipeline, or an indexing daemon as part of this spec.
- **Not changing the existing prompt builders' external API.** Builders still receive a `context` string via `.context(md)`; the orchestrator produces that string. Role filtering moves from the builder into the orchestrator.
- **Not auto-enabling pull tools.** Tools are opt-in per role and capped by a tool-call budget. An agent that doesn't know how to use a tool simply doesn't get worse than push-only.
- **Not a cross-feature retrieval system.** v1's "archived contexts stay archived unless manually seeded" rule is preserved. A RAG provider *could* be configured to index archives, but that is a config choice, not a default.

## Design

### Architecture at a glance

```
┌──────────────────────── Pipeline stage (e.g. tdd-implementer) ──────────────────────┐
│                                                                                      │
│  ContextOrchestrator.assemble(ContextRequest) → ContextBundle                       │
│    │                                                                                 │
│    ├─→ push path  (runs BEFORE agent call)                                          │
│    │    ├─ FeatureContextProvider       (feature/context.md, role-filtered)        │
│    │    ├─ SessionScratchProvider       (this session's running notes)             │
│    │    ├─ GitHistoryProvider           (recent diffs in touched files)            │
│    │    ├─ CodeNeighborProvider         (files imported by / importing touched)    │
│    │    ├─ RagProvider            [opt] (embedding search)                         │
│    │    ├─ GraphProvider          [opt] (symbol/call graph)                        │
│    │    ├─ KbProvider             [opt] (external wiki/ADR)                        │
│    │    │                                                                            │
│    │    → score + dedupe + knapsack-pack into stage budget                          │
│    │    → render as Markdown section, attach provenance IDs                         │
│    │                                                                                 │
│    └─→ pull path  (runs DURING agent call, if role allows tools)                    │
│         ├─ query_context(q, scope)      — unified query across push-eligible        │
│         ├─ query_rag(q, k)              — embedding search                          │
│         ├─ query_graph(symbol, depth)   — symbol graph walk                         │
│         ├─ query_kb(q)                  — knowledge base                            │
│         └─ query_feature_context(tag)   — filtered v1 context access                │
│                                                                                      │
│  Emits context-manifest.json  (per story per stage)                                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Four pieces:

1. **ContextRequest** — what the stage is asking for.
2. **Providers** — a pluggable interface; each knows how to answer a request from its data source.
3. **ContextOrchestrator** — a singleton that runs providers in parallel, scores and packs their output into the stage budget, and optionally registers pull tools with the agent session.
4. **ContextBundle + manifest** — what the orchestrator returns, plus a reproducible audit log.

### Core types

```typescript
// src/context/core/types.ts

export type Stage =
  | "decompose" | "plan" | "route"
  | "tdd-test-writer" | "tdd-implementer" | "tdd-verifier"
  | "single-session" | "tdd-simple" | "no-test" | "batch"
  | "verify" | "rectify" | "autofix"
  | "review-semantic" | "review-adversarial" | "review-dialogue"
  | "debate" | "context-extract" | "context-summarize";

export type Role =
  | "implementer" | "test-writer" | "verifier"
  | "reviewer-semantic" | "reviewer-adversarial"
  | "rectifier" | "autofixer"
  | "planner" | "decomposer" | "router" | "auto-approver"
  | "context-extractor" | "context-summarizer" | "context-promoter"
  | "debater" | "judge";

export interface ContextRequest {
  stage: Stage;
  role: Role;
  story: UserStory;
  featureId: string | null;
  sessionId: string;                          // ACP session or "cli:<uuid>"
  workdir: string;
  config: NaxConfig;
  /** Target agent for this assembly. Providers render output in this agent's conventions. */
  agent: AgentTarget;
  /** Stage-specific free-form hints. Example: rectifier passes the failing test output. */
  hints?: {
    diff?: string;
    failureOutput?: string;
    touchedFiles?: string[];
    reviewFindings?: ReviewFinding[];
    priorStageDigest?: string;                // carried forward from earlier stage (see §Progressive)
    priorAgent?: AgentTarget;                 // set on fallback rebuilds — see §Availability fallback
    priorAttempt?: {
      agent: AgentTarget;
      outcome:
        | "fail-quota"          // vendor quota / rate-limit / billing
        | "fail-service-down"   // 5xx, connection refused, DNS
        | "fail-auth"           // credentials rotated / expired
        | "fail-timeout"        // wall-clock exceeded
        | "fail-adapter-error"  // spawn / protocol / crash
        | "fail-quality";       // review/verify rejected output (opt-in trigger only)
      category: "availability" | "quality";
      summary: string;                        // terse failure summary (≤500 tokens)
    };
  };
  /** Explicit query, only used by providers that support retrieval. */
  query?: string;
}

export interface AgentTarget {
  /** Agent family id: "claude" | "codex" | "gemini" | "cursor" | "local" | string */
  id: string;
  /** Protocol surface: which adapter owns the session. */
  protocol: "acp" | "cli";
  /** Model tier as resolved by routing. */
  tier: "fast" | "balanced" | "powerful";
  /** Concrete model string (e.g. "claude-opus-4-6", "gpt-5-codex"). */
  model: string;
  /** Capability flags, resolved from the agent profile registry. */
  caps: AgentCapabilities;
}

export interface AgentCapabilities {
  maxContextTokens: number;                   // hard context limit
  preferredPromptTokens: number;              // soft target
  supportsToolCalls: boolean;                 // false → pull tools are skipped
  supportsSystemPrompt: boolean;              // some agents only accept a user prompt
  supportsMarkdown: boolean;                  // some prefer plain text
  systemPromptStyle: "xml-tagged" | "markdown-sections" | "plain";
  toolSchemaDialect: "anthropic" | "openai" | "mcp" | "none";
}

/**
 * The orchestrator is the canonical source of rules; the engine does NOT read
 * or translate per-agent rule files (CLAUDE.md, AGENTS.md, GEMINI.md). Those
 * files, if present, are optional operator-facing shims generated or maintained
 * by the operator — see §Canonical rules delivery.
 */

export interface ContextChunk {
  id: string;                                 // stable hash of (providerId + source + content)
  providerId: string;
  source: string;                             // file path, symbol, URL, story ID, etc.
  content: string;                            // Markdown-renderable
  tokens: number;                             // estimated
  score: number;                              // 0..1 relevance, set by provider
  audience: AudienceTag[];                    // carried from v1 if sourced from context.md
  kind: "decision" | "constraint" | "pattern" | "gotcha"
      | "neighbor" | "diff" | "symbol" | "doc" | "scratch" | "other";
  freshness: "live" | "this-session" | "this-feature" | "historical";
}

export interface ContextBundle {
  stage: Stage;
  role: Role;
  pushMarkdown: string;                       // what goes into the prompt
  pulledTools: ToolDescriptor[];              // tools the agent may invoke
  manifest: ContextManifest;                  // audit trail
  budgetUsed: number;
  budgetTotal: number;
  digest: string;                             // short summary (2-4 bullets) for downstream stages
}

export interface ContextManifest {
  storyId: string;
  stage: Stage;
  role: Role;
  sessionId: string;
  generatedAt: string;                        // ISO
  chunks: Array<{
    id: string;
    providerId: string;
    kind: ContextChunk["kind"];
    source: string;
    tokens: number;
    score: number;
    kept: boolean;                            // true if in pushMarkdown; false if dropped by packing
    reason?: string;                          // drop reason
  }>;
  pullCalls: Array<{
    tool: string;
    query: string;
    at: string;
    tokensReturned: number;
    chunkIds: string[];
  }>;
}
```

### Provider interface

```typescript
// src/context/core/provider.ts

export interface IContextProvider {
  readonly id: string;                        // unique stable id
  readonly kind:
    | "static"                                // project rules / constitution — always push
    | "feature"                               // v1 feature context file
    | "session"                               // ephemeral per-session scratch
    | "history"                               // git / diff / prior story
    | "neighbor"                              // code-graph-lite via filesystem + imports
    | "rag"                                   // embedding search
    | "graph"                                 // static analysis symbol graph
    | "kb";                                   // external knowledge base

  readonly supports: Array<"push" | "pull">;  // which modes this provider participates in

  /**
   * Return candidate chunks for this request. Called in parallel with other providers.
   * Providers MUST respect the soft budget (return approximately that many tokens
   * of content) and MUST NOT block longer than the configured timeout.
   */
  fetch(req: ContextRequest, softBudgetTokens: number): Promise<ContextChunk[]>;

  /**
   * Describe any tools this provider exposes when role supports pull.
   * The orchestrator registers these with the agent session and routes invocations back.
   */
  tools?(req: ContextRequest): ToolDescriptor[];

  /**
   * Invoked when the agent calls one of this provider's tools. Returns chunks
   * (which the orchestrator repackages into the agent's tool-response).
   */
  onTool?(toolName: string, input: unknown, req: ContextRequest): Promise<ContextChunk[]>;
}

export interface ToolDescriptor {
  name: string;                               // e.g. "query_rag"
  description: string;                        // agent-visible
  inputSchema: JSONSchema;
  maxCallsPerSession: number;                 // per-session ceiling
  maxTokensPerCall: number;
}
```

Two critical design decisions:

- **Providers are stateless w.r.t. the orchestrator.** Caching, indexes, connections are the provider's responsibility, hidden behind `fetch()`. This keeps the orchestrator trivial to test and lets providers fail independently.
- **`supports` is a declaration.** A provider that cannot answer ad-hoc queries (e.g. the v1 feature context file) declares `supports: ["push"]`. A provider like RAG may declare `supports: ["push", "pull"]` — it pre-pushes the top-K most relevant chunks AND exposes a `query_rag` tool. Pull-only is also valid (e.g. an expensive KB that's only worth querying on demand).

### The Orchestrator

```typescript
// src/context/core/orchestrator.ts

export class ContextOrchestrator {
  constructor(private readonly providers: IContextProvider[], private readonly _deps = defaultDeps) {}

  async assemble(req: ContextRequest): Promise<ContextBundle> {
    const stageConfig = req.config.context?.stages?.[req.stage] ?? DEFAULT_STAGE_CONFIG;
    const budget = stageConfig.budgetTokens;

    // 1. Filter providers enabled for this stage+role
    const eligible = this.providers.filter((p) =>
      isProviderEnabled(p, req, stageConfig) && p.supports.includes("push"),
    );

    // 2. Fetch in parallel with per-provider soft budget and timeout
    const softBudget = Math.ceil(budget / Math.max(eligible.length, 1));
    const results = await Promise.allSettled(
      eligible.map((p) => withTimeout(
        p.fetch(req, softBudget),
        stageConfig.providerTimeoutMs,
      )),
    );

    const candidates: ContextChunk[] = results.flatMap((r) =>
      r.status === "fulfilled" ? r.value : [],
    );

    // 3. Score adjustments (stage- and role-specific weights)
    const adjusted = reweightForStage(candidates, req);

    // 4. Dedupe by chunk id, prefer higher-scored duplicates, union audiences
    const deduped = dedupe(adjusted);

    // 5. Role-filter by audience (v1 logic, moved here)
    const roleFiltered = filterByRole(deduped, req.role);

    // 6. Knapsack pack into stage budget
    const packed = knapsack(roleFiltered, budget);

    // 7. Render Markdown + build manifest
    const pushMarkdown = renderMarkdown(packed.kept, req);
    const digest = summariseForDownstream(packed.kept);
    const manifest = buildManifest(req, packed, pushMarkdown);

    // 8. Collect pull tools from providers that support them, if role allows
    const pulledTools = this.collectTools(req, stageConfig);

    return {
      stage: req.stage, role: req.role,
      pushMarkdown, pulledTools, manifest,
      budgetUsed: packed.usedTokens, budgetTotal: budget,
      digest,
    };
  }

  /** Invoked by the agent adapter when the agent calls a context tool. */
  async handleToolCall(
    toolName: string, input: unknown, req: ContextRequest,
  ): Promise<ContextChunk[]> {
    const provider = this.providers.find((p) =>
      p.tools?.(req).some((t) => t.name === toolName),
    );
    if (!provider?.onTool) throw new NaxError(
      `Unknown context tool: ${toolName}`,
      "CONTEXT_TOOL_UNKNOWN",
      { stage: req.stage, toolName },
    );
    const chunks = await provider.onTool(toolName, input, req);
    // Record in manifest for audit.
    return chunks;
  }
}
```

### Session model

v1 had two scopes: **project** (CLAUDE.md) and **feature** (`context.md`). v2 adds two more:

| Scope | Lifetime | Storage | Example |
|:------|:---------|:--------|:--------|
| project | repo lifetime | `CLAUDE.md`, `.claude/rules/*.md`, constitution | "use Bun APIs" |
| feature | feature build → archive | `.nax/features/<id>/context.md` (v1) | "barrel imports avoid a cycle between semantic.ts and review-builder.ts" |
| story | story lifetime | `.nax/features/<id>/stories/<storyId>/context.md` | "this story touches the acceptance pipeline stages; the existing fixtures are in `test/helpers/acceptance.ts`" |
| **session** | ACP session lifetime (or crash → resume) | `.nax/features/<id>/sessions/<sessionId>/scratch.jsonl` | "current test run failed in `autofix.test.ts` line 42; retried twice" |

**Session scratch** is the new scope. It's a JSONL append-only log of observations the pipeline makes during a session — failure outputs, intermediate diffs, rectifier attempts, tool call results. It is:

- **Read by later stages within the same session.** A rectifier seeing the verifier's failure output doesn't need the verifier to pass it explicitly; it's in the scratch.
- **Read by the same session on resume.** When ACP detects a crash-orphaned session (see recent fix in commit 2c0adbb2) and the session is resumed, scratch is the memory. Without it, the resumed session re-runs work.
- **Never committed.** Always gitignored. Secrets may appear here (command output, etc.).
- **Archived with the story on completion**, then garbage-collected by a TTL (default 7 days).

`SessionScratchProvider` reads the JSONL, keeps the most recent N entries within budget, and surfaces them as `kind: "scratch"`, `freshness: "this-session"` chunks.

Writers into scratch are *not* the orchestrator's job — they're individual pipeline stages (e.g., `verify` appends its test output, `rectify` appends its attempt summary). The orchestrator only reads.

### Agents, canonical rules, and availability fallback

The orchestrator treats the **target agent** as a first-class input alongside stage and role. Two orthogonal concerns live in this section:

- **Escalation** — quality-driven, same agent, different tier (fast → balanced → powerful). Owned by `src/execution/escalation/`. *No change in v2.*
- **Availability fallback** — availability-driven, different agent at the equivalent tier. Triggered when the adapter reports a hard availability failure (quota, rate limit, service down, auth). Owned by the runner, with the context engine re-rendering the in-flight bundle for the new agent target.

The two axes compose but never interleave: fallback does not climb tiers, and escalation does not switch agents.

#### Canonical rules delivery

**The context engine is the source of truth for project rules.** Rules are authored once in a neutral canonical store and injected into every prompt by `StaticRulesProvider`. The engine does **not** read, translate, or sync per-agent rule files.

**Canonical store layout:**

```
.nax/rules/
├── index.md                 # optional top-level overview
├── coding-style.md
├── project-conventions.md
├── forbidden-patterns.md
├── testing.md
├── error-handling.md
└── config-patterns.md
```

Content is authored in **neutral prose** — no references to specific tool names (`the Grep tool`), no agent-specific tags (`<system-reminder>`), no claude/codex/gemini-specific phrasing. When a rule needs to reference a capability that agents surface differently, it describes the *capability* (`search files for a pattern`), not the tool.

Existing `CLAUDE.md`, `.claude/rules/*.md`, and any `AGENTS.md` / `GEMINI.md` files become **optional shims**:

- The operator may keep them for third-party agents running *outside* nax (e.g., a human invoking Claude Code directly in the same repo).
- A helper command `nax rules export --agent=<id>` generates these shims from the canonical store when desired. Generation is one-way (canonical → shim); manual edits to shims are not read back.
- Inside nax sessions, only the canonical store is read. The per-agent files are invisible to the engine.

This eliminates: (a) drift between CLAUDE.md and AGENTS.md, (b) the translation layer entirely, (c) the risk of an agent following a stale rule file, and (d) the "which file is the source of truth" question.

#### Agent profile registry

A static registry in `src/context/core/agent-profiles.ts` maps agent id → capabilities + a renderer:

```typescript
export const AGENT_PROFILES: Record<string, AgentProfile> = {
  claude: {
    caps: {
      maxContextTokens: 200_000,
      preferredPromptTokens: 16_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "markdown-sections",
      toolSchemaDialect: "anthropic",
    },
    render: claudeRenderer,
  },
  codex: {
    caps: {
      maxContextTokens: 128_000,
      preferredPromptTokens: 12_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "xml-tagged",
      toolSchemaDialect: "openai",
    },
    render: codexRenderer,
  },
  gemini: { /* ... */ },
  cursor: { /* ... */ },
  local:  { /* conservative defaults */ },
};
```

The renderer's responsibilities are narrow — rules content is already neutral, so the renderer only:

- Wraps the push block in the agent's preferred framing (`markdown-sections`, `xml-tagged`, or `plain`).
- Serializes pull tools into the agent's native schema dialect.
- Enforces `preferredPromptTokens` as the budget ceiling (per-stage budget is `min(stageConfig.budgetTokens, agent.caps.preferredPromptTokens / expectedStages)`).
- Drops Markdown formatting when `supportsMarkdown: false`.

No rule rewriting, no path translation, no citation mangling. Adding a new agent means adding a profile with ~20 lines of code and ~20 lines of renderer logic.

#### Availability fallback

The adapter layer (`src/agents/acp/` and `src/agents/claude/`) reports failures with a **category**:

```typescript
interface AdapterFailure {
  category: "availability" | "quality";
  outcome: "fail-quota" | "fail-service-down" | "fail-auth"
         | "fail-timeout" | "fail-adapter-error" | "fail-quality";
  message: string;
  retriable: boolean;
}
```

- `availability` failures (`fail-quota`, `fail-service-down`, `fail-auth`, and usually `fail-timeout`) → **fallback candidate**. The runner looks up the fallback map and switches agent.
- `quality` failures (review/verify rejected output) → **escalation candidate** (same agent, higher tier) by default. Fallback on quality is opt-in (`context.fallback.onQualityFailure: true`) for operators who explicitly want a different agent to take a second pass.

**Fallback map** in config:

```json
{
  "context": {
    "fallback": {
      "enabled": true,
      "onQualityFailure": false,
      "maxHopsPerStory": 2,
      "map": {
        "claude": ["codex", "gemini"],
        "codex":  ["claude", "gemini"],
        "gemini": ["claude", "codex"]
      }
    }
  }
}
```

When the adapter returns an `availability` failure, the runner:

1. Looks up the first fallback candidate from the map.
2. Verifies the candidate is configured (credentials present) and not already exhausted in this story.
3. Calls `orchestrator.rebuildForAgent(priorBundle, newAgent, adapterFailure)`.
4. Starts a new session against the candidate agent with the rebuilt bundle at the **same tier** as the failed attempt (tier is quality-driven, independent of agent).
5. If the candidate also hits an availability failure, tries the next entry. Hop count is bounded by `maxHopsPerStory`.

If all candidates are exhausted, the story is marked failed with outcome `all-agents-unavailable` and queued for human review. Tier escalation does not run on availability failures — retrying at a higher tier against an unavailable vendor doesn't help.

#### Rebuild mechanics (`rebuildForAgent`)

```typescript
async rebuildForAgent(
  prior: ContextBundle,
  newAgent: AgentTarget,
  failure: AdapterFailure,
): Promise<ContextBundle> {
  // 1. Preserve portable state: feature context, session scratch, digest from completed stages
  // 2. Synthesize a failure-note chunk describing what the prior agent attempted
  //    (deterministic string build — NO LLM call on the hot path)
  // 3. Call assemble() with:
  //      - req.agent = newAgent
  //      - req.hints.priorAgent = prior's agent
  //      - req.hints.priorAttempt = failure summary + category
  // 4. Re-render under new agent's profile
  // 5. Write rebuild-manifest.json correlating old chunk IDs to new
}
```

**Portable substrate (carries forward):**

- Feature context (`.nax/features/<id>/context.md`) — neutral Markdown, unchanged.
- Session scratch — same session directory; the new agent reads the prior agent's observations.
- Prior-stage digests — if plan ran under Claude before Claude quota exhausted, the implementer rerun under Codex inherits plan's digest.
- Story state, diffs, touched files.
- RAG / graph chunk IDs (content-addressed, agent-independent).

**Non-portable (dropped on rebuild):**

- Raw agent reasoning traces.
- Agent-specific tool-call logs (but results already written to scratch carry).
- Prior prompt framing — regenerated from the new profile.

**Failure-note chunk.** One synthesized chunk is injected so the new agent knows why the swap happened. For availability failures, the note is short and terse — there is no "why this approach failed," because the approach didn't fail, the vendor did:

```markdown
## Agent swap (availability fallback)

Prior agent: claude (powerful tier) became unavailable.
Reason: fail-quota — daily token quota exhausted at 14:22 UTC.

Work completed by prior agent before swap:
- Plan stage: touched src/review/semantic.ts + builders; isolated types to review/types.ts.
- Test-writer stage: added test/unit/review/semantic-v2.test.ts using _deps pattern.

Resume point: implementer stage. Continue from the test-writer's digest below.
```

For quality failures (opt-in fallback), the note includes the review findings and the prior attempt's diff summary. Always deterministic assembly — no LLM call on the fallback path.

#### Stage config per-agent overrides

```typescript
stages: {
  "tdd-implementer": {
    budgetTokens: 4096,
    agents: {
      codex: { budgetTokens: 3072, pull: { enabled: false } }
    }
  }
}
```

Resolved as `merge(defaultStage, stage, stage.agents[agent.id])`.

### Progressive / stage-aware injection

Stages run in order; each later stage inherits a **digest** from earlier stages via `ctx.priorStageDigest`. The digest is a terse summary (≤250 tokens) produced by the orchestrator at the end of each stage. It answers: *"What did the previous stage learn that the next stage needs?"*

Example flow for a TDD story:

```
plan       : digest = "Touching src/review/semantic.ts and builders. Suspect
                      circular import via review-builder. Will isolate types."
tdd-test-writer : hints.priorStageDigest = plan.digest
                  push = patterns[test-writer] + existing tests for semantic.ts
                  digest = "New test file test/unit/review/semantic-v2.test.ts.
                            Uses _deps pattern. Fixture: tempWorkdir."
tdd-implementer : hints.priorStageDigest = test-writer.digest
                  push = constraints + gotchas + neighbors + plan.digest as context
                  digest = "Implementation in src/review/semantic.ts + moved types
                            to src/review/types.ts. Barrel updated."
verify          : hints.priorStageDigest = implementer.digest
                  push = test commands, prior failure patterns
                  digest = "Tests pass; coverage 87%."
review-semantic : hints.priorStageDigest = verify.digest
                  push = reviewer-tagged entries + diff + prior review findings
                  digest = "One finding: missing null check in filterByRole."
rectify         : hints.priorStageDigest = review-semantic.digest
                  push = failure→fix pairs from same feature, the exact finding
```

The digest is part of the push block at each stage, clearly labeled. It costs tokens (up to ~250 × stages) but dramatically reduces the "did the earlier session know X?" class of bugs.

Digest is produced deterministically (truncation + templating), **not** via an LLM call, to keep it cheap and reproducible. Providers that produced chunks tag which chunks should appear in the digest (`chunk.kind === "decision"` or `"constraint"` by default).

### Stage context map (default)

| Stage | Push sources (in order) | Pull tools | Budget (default) |
|:------|:------------------------|:-----------|:-----------------|
| `decompose` | static (rules only), prior feature digest | — | 1024 |
| `plan` | static, feature, story, git-history | — | 3072 |
| `route` | static (tier rules), story | — | 512 |
| `tdd-test-writer` | static, feature[test-writer], story, session scratch, neighbor (existing tests) | query_neighbor | 3072 |
| `tdd-implementer` | static, feature[implementer], story, session scratch, neighbor, prior-stage digest | query_rag, query_graph, query_neighbor, query_feature_context | 4096 |
| `tdd-verifier` | static, feature[verifier], failure output from scratch | — | 1024 |
| `single-session`, `tdd-simple`, `batch`, `no-test` | as tdd-implementer but role-filter covers both implementer+test-writer | query_rag, query_graph, query_neighbor | 4096 |
| `verify` | static, scratch | — | 512 |
| `rectify` | feature[implementer], failure output, prior fix pairs, scratch, prior-stage digest | query_neighbor | 2048 |
| `autofix` | feature[implementer], exact failing check, scratch | — | 1024 |
| `review-semantic` | static, feature[reviewer-semantic], diff, prior review findings, kb (if enabled) | query_feature_context, query_kb | 3072 |
| `review-adversarial` | static, feature[reviewer-adversarial], diff, abandonment heuristics | query_feature_context | 3072 |
| `review-dialogue` | prior review findings, reviewer-implementer transcripts | — | 2048 |
| `debate` | static, feature, story, opposing position digest | — | 2048 |
| `context-extract` | story diff, findings, existing context.md | — | infinite (bounded by input) |
| `context-summarize` | existing context.md | — | as input |

All defaults live in `src/context/core/stage-config.ts` and are overridable per project.

### Scoring, dedup, and knapsack packing

**Scoring.** Each provider sets a self-assessed score `[0..1]`. The orchestrator adjusts:

```
final_score = provider_score
            × role_weight(chunk, role)        // 1.2 if audience matches exactly, 0.8 for "all"
            × freshness_weight(chunk.freshness) // 1.3 "this-session" ... 0.6 "historical"
            × kind_weight(chunk.kind, stage)  // per stage preferences
```

Kind weights per stage are in config; e.g., `rectify` weights `gotcha` and `constraint` higher than `pattern`.

**Dedup.** Chunks with the same `id` or whose content's normalized form (whitespace-collapsed, lowercased, first 200 chars) matches ≥0.9 are merged. Merged chunks take the union of audiences and the max score.

**Knapsack packing.** Standard 0/1 knapsack, weight = tokens, value = score, capacity = stage budget. For small candidate sets (≤50) this is trivial. Implementation uses a dynamic programming solver with a 50ms timeout; if exceeded, falls back to greedy-by-value-per-token. Dropped chunks go into the manifest with a reason.

**Budget floor.** Every stage reserves a minimum slice for `static` + `feature` providers even if other providers score higher. This prevents, e.g., RAG results with high scores from crowding out core project rules.

### Push/pull hybrid model

**Push (default for all stages):** seed context built before the agent call.

**Pull (opted in per role via stage map):** tools registered with the agent session. The adapter (`src/agents/acp/` and `src/agents/claude/`) wires these tools into the agent's tool-call interface:

- ACP protocol: tools are declared in the session `initialize` call; tool invocations round-trip through `handleToolCall`.
- Claude CLI protocol: tools are declared via the MCP interface if available; otherwise pull is skipped for that adapter.

Every pull tool is capped:

- **Per-call ceiling** (`maxTokensPerCall`, default 2048): the response is truncated to this budget.
- **Per-session ceiling** (`maxCallsPerSession`, default 5): after exhaustion the tool errors with `"context tool budget exhausted"`.
- **Per-run ceiling** (`config.context.pull.maxCallsPerRun`, default 50): hard cap across all sessions in a run.

Tool call results are appended to session scratch AND to the manifest. This means:

- A future stage in the same session sees (via scratch) that the agent already queried for X.
- The manifest shows whether pull was actually used (cost accountability).

**Graceful degradation.** If the agent adapter doesn't support tool calls, the orchestrator increases each push-eligible provider's soft budget proportionally and skips tool registration. Behavior is "push-only with larger budget."

### Manifest & auditability

Every `assemble()` call writes `.nax/features/<id>/stories/<storyId>/context-manifest-<stage>.json`. This is the reproducibility ledger:

- Which chunks were considered.
- Which were kept / dropped and why.
- Which pull tools fired and what they returned.
- Provider version + content hashes.

Post-run, `nax context inspect <storyId>` renders the manifests as a tree so operators can answer *"why did the agent have / not have X in its context at stage Y?"* without replaying the run.

Manifests are git-ignored by default (they reference internal chunk content) but can be preserved under `.nax/features/_archive/` on feature archival.

### Determinism

- Push is deterministic for fixed inputs + provider versions. Providers that rely on live data (git log, filesystem) are deterministic given a fixed working tree.
- RAG/graph providers introduce non-determinism via model version + index state. Config requires a pinned model+index version; running with an unpinned version emits a warning.
- Pull is non-deterministic by construction (agent decides when to call). Determinism is restored at the *manifest* level — two runs with the same pull calls produce the same downstream behavior.

## Built-in providers (ship with v2)

### `FeatureContextProvider` (v1, repurposed)

Reads `.nax/features/<id>/context.md`. Supports push only. Role filtering moves *out* of this provider (orchestrator does it). Extractor / summarizer / promotion gates from v1 continue to run unchanged; they are v1 subsystems that write into this provider's storage.

### `SessionScratchProvider` (new)

Reads `.nax/features/<id>/sessions/<sessionId>/scratch.jsonl`. Returns the most recent observations that fit the soft budget. Pull tool `query_scratch(since?)` is available for long-running roles.

### `GitHistoryProvider` (new)

For touched files (from `ctx.hints.touchedFiles` or the story's PRD), returns the last N commit messages and diff summaries. Push only. Scoped to the current branch.

### `CodeNeighborProvider` (new)

Cheap "code graph lite" using grep over import statements. For each touched file, returns:
- Files that import it (reverse deps).
- Files it imports (forward deps) within the project.
- Sibling test file if missing (the v1 "missing sibling test" gap).

Supports push and pull (`query_neighbor(filePath, depth)`).

### `StaticRulesProvider` (new)

Wraps the existing `CLAUDE.md`, `.claude/rules/`, constitution, and tech-stack auto-detect outputs. Always pushed, cannot be dropped by packing (uses the budget floor). This replaces the current hardcoded prompt-builder calls to these files; builders stop reading them directly, and receive them via the orchestrator.

## Plugin providers (separate follow-up specs)

These three are *not* shipped in this spec. They are listed to prove the interface is sufficient:

- **`RagProvider`** — embedding search over the repo and archived feature contexts. Pull tool `query_rag(q, k)`. Pinned to a specific embedding model + index snapshot. Separate spec.
- **`GraphProvider`** — TS/AST-based symbol/call graph. Tools: `query_graph(symbol, depth)`, `find_references(symbol)`. Separate spec.
- **`KbProvider`** — integrates external docs (Confluence, Notion, ADR folders). Pull-only usually. Separate spec.

The plugin loading mechanism reuses the existing 7-extension-point plugin system (see `src/plugins/`). A new extension point `IContextProvider` is added.

## Relationship to v1

| Concern | v1 | v2 |
|:--------|:---|:---|
| Storage | `.nax/features/<id>/context.md` | Same (via `FeatureContextProvider`) |
| Extractor | Capture stage calls LLM, writes fragments | Unchanged |
| Summarizer | Phase boundary / run completion | Unchanged |
| Promotion gate | Feature archival | Unchanged |
| Role filtering | In prompt builders | In orchestrator |
| Injection point | Prompt builder adds one block | Orchestrator assembles per stage |
| Budget | One number | Per-stage + floor |
| Multiple sources | No | Yes, via `IContextProvider` |
| Session scope | No | Yes, `SessionScratchProvider` |
| Pull tools | No | Yes, opt-in per stage/role |
| Manifest | No | Yes, per stage |
| Retrieval | No | Provider-pluggable |
| Agent portability | Claude-only | Multi-agent via profile registry |
| Agent fallback rebuild | Not possible | `rebuildForAgent()` — LLM-free, preserves portable state |

**Migration path:** v1 ships, v2 ships as a reorganization. The `FeatureContextProvider` inside v2 reads the same files v1 wrote; no data migration. Once v2 is GA, the v1 prompt-builder `.context()` callsite flips to receive the orchestrator's output, and the v1 builder-level role filter is deleted.

## Config

```typescript
// src/config/schemas.ts additions

const ProviderConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  options: z.record(z.unknown()).default({}),
});

const StageContextConfigSchema = z.object({
  budgetTokens: z.number().int().min(256).default(2048),
  providerTimeoutMs: z.number().int().min(1000).default(5000),
  enabledProviders: z.array(z.string()).optional(),   // undefined = all
  kindWeights: z.record(z.number()).default({}),
  pull: z.object({
    enabled: z.boolean().default(false),
    allowedTools: z.array(z.string()).default([]),
    maxCallsPerSession: z.number().int().min(0).default(5),
  }).default({}),
});

const ContextEngineV2ConfigSchema = z.object({
  enabled: z.boolean().default(false),                 // master switch
  providers: z.array(ProviderConfigSchema).default([]),
  stages: z.record(StageContextConfigSchema).default({}),
  defaultStage: StageContextConfigSchema.default({}),
  pull: z.object({
    maxCallsPerRun: z.number().int().min(0).default(50),
  }).default({}),
  manifest: z.object({
    enabled: z.boolean().default(true),
    archiveOnFeatureArchive: z.boolean().default(true),
  }).default({}),
  sessionScratch: z.object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().min(1).default(7),
  }).default({}),
  // v1 settings preserved under a sub-key
  featureEngine: FeatureContextEngineConfigSchema.optional(),
});
```

Example project config enabling v2 with default providers:

```json
{
  "context": {
    "enabled": true,
    "providers": [
      { "id": "static-rules", "priority": 10 },
      { "id": "feature-context", "priority": 20 },
      { "id": "session-scratch", "priority": 30 },
      { "id": "git-history", "priority": 40 },
      { "id": "code-neighbor", "priority": 50 }
    ],
    "stages": {
      "tdd-implementer": { "budgetTokens": 4096, "pull": { "enabled": true, "allowedTools": ["query_neighbor"] } }
    }
  }
}
```

## File surface

### New

- `src/context/core/types.ts` — `ContextRequest`, `ContextChunk`, `ContextBundle`, `ContextManifest`.
- `src/context/core/provider.ts` — `IContextProvider` interface.
- `src/context/core/orchestrator.ts` — `ContextOrchestrator`.
- `src/context/core/scoring.ts` — role / freshness / kind weights.
- `src/context/core/dedupe.ts` — chunk deduplication.
- `src/context/core/knapsack.ts` — packing algorithm.
- `src/context/core/render.ts` — Markdown rendering of the push block.
- `src/context/core/digest.ts` — deterministic digest builder for downstream stages.
- `src/context/core/stage-config.ts` — default stage context map.
- `src/context/core/agent-profiles.ts` — registry of `AgentProfile` per agent id (claude, codex, gemini, cursor, local).
- `src/context/core/agent-renderer.ts` — per-profile rendering hooks (wrapper framing, tool schema dialect, token budget ceiling). No rule translation.
- `src/context/core/rebuild.ts` — `ContextOrchestrator.rebuildForAgent()` and deterministic failure-note chunk builder.
- `.nax/rules/` — **canonical rules store** (neutral prose, no agent-specific phrasing). New source-of-truth location authored by the project.
- `src/context/rules/canonical-loader.ts` — reads `.nax/rules/*.md`, validated against a neutrality linter (no `<system-reminder>`, no "the X tool", etc.).
- `src/cli/rules-export.ts` — `nax rules export --agent=<id>` command that generates one-way `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` shims from the canonical store for third-party tools running outside nax.
- `src/context/core/role-filter.ts` — moved from v1's `feature-context-filter.ts`, generalized.
- `src/context/core/manifest.ts` — manifest writer.
- `src/context/providers/static-rules-provider.ts`
- `src/context/providers/feature-context-provider.ts` (adapter over v1 files)
- `src/context/providers/session-scratch-provider.ts`
- `src/context/providers/git-history-provider.ts`
- `src/context/providers/code-neighbor-provider.ts`
- `src/context/scratch/writer.ts` — session scratch append helper used by pipeline stages.
- `src/cli/context-inspect.ts` — `nax context inspect <storyId>` command.
- `test/unit/context/core/*.test.ts` — per-module.
- `test/unit/context/providers/*.test.ts` — per-provider with `_deps` mocking.
- `test/integration/context/end-to-end-stage-progression.test.ts` — multi-stage digest flow.
- `test/integration/context/pull-tool-budget.test.ts` — tool budget enforcement.

### Modified

- `src/config/schemas.ts` — add `ContextEngineV2ConfigSchema`.
- `src/config/types.ts` — re-export.
- `src/prompts/builders/tdd-builder.ts` — accept `ContextBundle` instead of raw markdown; builders stop calling role filters directly.
- `src/prompts/builders/review-builder.ts` — same.
- `src/prompts/builders/rectifier-builder.ts` — same.
- `src/prompts/builders/acceptance-builder.ts` — same.
- `src/prompts/builders/debate-builder.ts` — same.
- `src/prompts/builders/one-shot-builder.ts` — same.
- `src/pipeline/stages/context.ts` — call the orchestrator, attach `ContextBundle` to `ctx`.
- `src/pipeline/stages/tdd.ts` — pass bundle into builders; write scratch entries.
- `src/pipeline/stages/verify.ts` — write failure output to scratch.
- `src/pipeline/stages/rectify.ts` — read scratch via bundle.
- `src/pipeline/stages/review.ts` — pass bundle; record pull calls.
- `src/pipeline/stages/autofix.ts` — pass bundle.
- `src/pipeline/stages/capture.ts` (v1) — unchanged semantically; its writes go through the feature provider's storage.
- `src/agents/acp/*.ts` — register pull tools from `bundle.pulledTools`; route tool calls to orchestrator.
- `src/agents/claude/*.ts` — same via MCP where available; push-only fallback otherwise.
- `src/execution/lifecycle/run-completion.ts` — rotate scratch, archive manifests.
- `src/execution/escalation/*.ts` — extend tier escalation to support cross-agent fallback; on agent-boundary crossing, call `orchestrator.rebuildForAgent()` before issuing the next attempt.
- `CLAUDE.md` — document stages, provider model, and pull tool conventions.

## Migration from v1

### Step 0 — landing before anything else

Ship the `ContextOrchestrator` with only `StaticRulesProvider` + `FeatureContextProvider` registered. Role filtering moves from builders into the orchestrator. Behavior is byte-for-byte identical to v1 at this point. Tests verify equivalence.

### Step 1 — session scratch

Introduce `SessionScratchProvider` and wire scratch writes from `verify` and `rectify` stages. No behavior change at other stages.

### Step 2 — progressive digest

Add the digest mechanism. Verify via tests that, e.g., `tdd-implementer` now sees `tdd-test-writer`'s digest.

### Step 3 — new providers

`GitHistoryProvider`, `CodeNeighborProvider`, `StaticRulesProvider` expansion (absorbing current prompt-builder direct reads).

### Step 4 — pull tools

Enable push+pull for `tdd-implementer` first. Measure tool usage, cost, correctness. Roll to `rectifier` and reviewers.

### Step 5 — plugin providers (separate specs)

RAG, Graph, KB are each gated on their own spec + rollout.

### Rollback

Master switch `context.enabled: false` makes v2 a no-op; pipeline stages fall back to v1 behavior (direct prompt-builder context reads remain as the fallback path through Phase 1 of v2). Once v2 is GA, the fallback can be removed.

## Rollout plan

| Phase | Ships | Default | Exit gate |
|:------|:------|:--------|:----------|
| 0 | Orchestrator + static + feature providers, behavior parity | off | Parity tests pass; no regression in adversarial/semantic review pass rates |
| 1 | Session scratch | off | Fewer re-runs after session resume (metric) |
| 2 | Digest | off | Reduction in cross-stage "I didn't know X" review findings |
| 3 | Git-history + neighbor providers | off | Lower rate of missing-sibling-test findings |
| 4 | Pull tools (implementer) | off | Tool call budget respected, cost within envelope |
| 5 | Pull tools (reviewer, rectifier) | off | Review finding noise decreases |
| 5.1 | Canonical rules store (`.nax/rules/` + neutrality linter + `nax rules migrate` + `nax rules export`) | `allowLegacyClaudeMd: true` for one version | Migration tool produces a clean `.nax/rules/` from existing `CLAUDE.md`; linter passes |
| 5.5 | Agent profiles + `rebuildForAgent()` + availability fallback integration (claude ↔ codex) | off (fallback map empty) | A story whose Claude session hits `fail-quota` continues under Codex with session scratch + digest preserved; rebuild manifest shows the swap |
| 6 | Default-on for opted-in projects | selective on | One feature built end-to-end on v2 without intervention, with at least one availability fallback surviving |
| 7 | Plugin providers (RAG/graph/KB) | per follow-up spec | — |
| 8 | Additional agent profiles (gemini, cursor, local) | per-agent opt-in | One real feature completed using each new profile |

## Risks

### Orchestrator becomes a god-object

The orchestrator does scoring, dedup, packing, rendering, and tool routing. It's the central nervous system and a tempting place to add features. **Mitigation:** strict separation of concerns into `core/scoring.ts`, `core/dedupe.ts`, etc.; 400-line limit per file; orchestrator itself is a coordinator, not a logic module.

### Latency regression

Parallel provider fetch + knapsack + Markdown rendering adds wall-clock to every stage. **Mitigation:** per-provider timeout (default 5s); if a provider exceeds the stage budget slice, it's dropped without failing the stage; metrics track provider wall-clock so slow providers are visible.

### Manifest size explosion

One manifest per stage per story per run. For a 20-story feature with 8 stages each, that's 160 manifests per run. **Mitigation:** manifests are small (few KB); gitignored; archived only for merged features; TTL cleanup command.

### Pull tool budget gaming

An agent, especially a larger model, may discover it can burn tool calls to explore. Cost escalates. **Mitigation:** per-session, per-run ceilings; cost metrics; tool description includes the budget the agent has remaining.

### Provider ordering dependence

If providers aren't isolated, chunk scoring can be influenced by ordering (e.g., feature provider runs last and steals the floor). **Mitigation:** parallel fetch (no ordering during fetch); floor is enforced by provider *kind*, not priority; dedupe is order-independent.

### Session scratch leaks secrets

Scratch captures command output, which can include secrets. **Mitigation:** scratch is gitignored; regex-based redaction pass on write (AWS keys, tokens, env values matching `.env`); scratch is discarded at feature archive by default.

### Non-determinism from plugin providers

Third-party providers are outside nax control. A bad RAG provider returns different chunks each call, making debugging hard. **Mitigation:** manifest records chunk IDs + content hashes; providers must declare a version string; re-running with a pinned manifest is supported (replay mode, future).

### v1 regressions

Moving role-filtering into the orchestrator risks a subtle semantic change. **Mitigation:** Phase 0 parity tests — identical input produces byte-identical prompts.

### Canonical rules store migration

Existing projects have invested in `CLAUDE.md` and `.claude/rules/*.md`. Moving to `.nax/rules/` is a substantial authoring migration. If content copied verbatim contains Claude-specific phrasing, the promise of neutrality is compromised from day one. **Mitigations:**

- Ship a **neutrality linter** (`src/context/rules/canonical-loader.ts`) that rejects obvious tells: `<system-reminder>`, `CLAUDE.md`, `.claude/`, `the <X> tool` phrasing, `use the Grep tool`, `IMPORTANT:` shouts, and emoji. Linter failures block the rules from loading; operator must fix.
- Provide a `nax rules migrate` command that takes `CLAUDE.md` + `.claude/rules/*.md` and writes a `.nax/rules/` draft with neutralization applied; operator reviews the diff before committing.
- Keep `CLAUDE.md` as an auto-generated shim via `nax rules export` so humans invoking Claude Code directly (outside nax) still see rules. One-way generation — no read-back.
- During migration period, allow a config flag `context.rules.allowLegacyClaudeMd: true` that falls back to reading `CLAUDE.md` when `.nax/rules/` is absent, with a deprecation warning. Removed after one minor version.

### Fallback rebuild is too slow to be useful

If rebuilding context for the new agent takes seconds, fallback becomes painful for interactive loops. **Mitigations:**

- `rebuildForAgent()` is LLM-free; it reuses already-fetched chunks and only re-renders. Target wall-clock: ≤100ms.
- The synthesized failure-note chunk is deterministic string assembly.
- Async enrichment (LLM-written richer post-mortem for quality-failure opt-in) happens *after* fallback starts, written to scratch for later stages.

### Availability fallback hides a degraded service

If Claude quota resets every day, falling back to Codex every afternoon without surfacing the quota issue means the operator never notices billing / plan problems. **Mitigations:**

- Every fallback emits a structured metric event (`context.fallback.triggered`) with `{ priorAgent, newAgent, outcome, hop }`.
- Run summary flags when fallback fired, with the failure category.
- Repeated availability fallbacks for the same agent within a window surface as a warning on `nax status`.
- Fallback is opt-in at the config level; a project that didn't configure `fallback.map` gets hard-failure on quota exhaustion, forcing the operator to confront it.

### All fallback candidates are exhausted

Quota exhaustion can hit multiple vendors simultaneously during a product launch or outage. **Mitigations:**

- `maxHopsPerStory` bounds cost.
- When all mapped candidates fail, story is marked `all-agents-unavailable` with the full failure chain in the manifest — the operator sees each vendor's failure mode.
- Retry-with-delay is supported per candidate (`context.fallback.retryDelayMs`) for transient rate limits.

### Quality fallback masks a real defect

If `onQualityFailure: true`, a bad implementation by Claude hands off to Codex, which may fix the specific failing test while missing the structural issue. **Mitigations:**

- `onQualityFailure` is off by default and documented as experimental.
- When enabled, the failure-note chunk includes full review findings so the new agent sees the defect, not just the symptom.
- Tier escalation within Claude remains the preferred first response to quality failures; fallback is only for cases where the operator believes agent diversity helps.

### Session scratch has agent-specific artifacts

An agent may write observations to scratch that reference its own tool framing. When a different agent reads scratch on fallback, those artifacts are confusing. **Mitigations:**

- Scratch writers (pipeline stages, not the agent itself) use neutral phrasing — same principle as canonical rules.
- Agent-originated content written to scratch is tagged with `writtenByAgent: <id>`; the renderer strips or neutralizes agent-specific phrases for a different target agent.

### Agents ignore pull tools

Evidence from prior experiments: smaller models rarely call tools even when helpful. Shipping pull expecting adoption may mis-invest. **Mitigation:** tool descriptions are terse and action-oriented; default behavior is push-rich (pull is additive, not replacement); Phase 4 measures actual usage; if usage is low, don't expand.

## Open questions

1. **Pull tool surface.** Do we standardize one tool (`query_context(q, scope)`) that dispatches to providers internally, or expose per-provider tools (`query_rag`, `query_graph`)? Per-provider is more discoverable; dispatched is cleaner. **Default assumption:** per-provider, because agents read the tool description to decide which to call and a generic tool dilutes that signal.

2. **Ordering of push block in the final prompt.** v1 placed feature context between project and story. In v2 with multiple providers, is each kind rendered separately (Project / Feature / Session / Retrieval sections), or merged into one "Context" block with subheadings? Tentative: separate sections by scope (project → feature → story → session → retrieval), matching the scope table.

3. **Manifest privacy.** If manifests are archived, they record content hashes that may be sensitive. Archive behavior should be opt-in per project.

4. **Static rules integration.** Currently `StaticRulesProvider` duplicates what `src/context/` auto-detect already does. Should v2 absorb `src/context/` or layer over it? Tentative: absorb — `src/context/` becomes `StaticRulesProvider` internally.

5. **Builder API change size.** Switching every prompt builder from `.context(string)` to `.bundle(ContextBundle)` is a large mechanical change. Is an adapter (`.context(bundle.pushMarkdown)`) acceptable as Phase 0, with full bundle passing deferred? Probably yes — minimizes Phase 0 blast radius.

6. **Where does the digest live?** `ContextBundle.digest` is returned per stage and the orchestrator needs to fetch it on the *next* stage call. It's passed via `ctx.priorStageDigest`. Should we persist digest to scratch for resume? Tentative: yes, write to scratch; resumed session re-reads.

7. **Cost attribution.** RAG/graph providers may call LLMs or external services with variable cost. Does the orchestrator attribute this cost back to the story's metrics bucket? How does it interact with `StoryMetrics.contextEngine` from v1? Tentative: unified `metrics.context.providers[providerId].cost`.

8. **Cross-feature retrieval.** A RAG provider could be configured to index archived features. Allowed by default, or requires opt-in? Tentative: archived features are opt-in (matches v1 "no cross-feature auto-load" rule).

9. **Tool-call failures.** When a pull tool errors (network, timeout), does the agent see the error and retry, or does the orchestrator swallow and return empty? Tentative: return a structured error to the agent with budget-consumed info, so the agent decides whether to try another tool.

10. **Determinism modes.** Should there be a `context.deterministic: true` flag that disables all non-deterministic providers (RAG with floating indexes, KB with live data)? Useful for CI reproducibility. Tentative: yes, simple flag; providers declare `deterministic: boolean`.

11. *(Resolved.)* ~~Fallback escalation ordering.~~ Fallback and escalation are **orthogonal**. Escalation (tier climbing) is quality-driven within one agent. Fallback is availability-driven across agents at the same tier. They never interleave. Decided.

12. **Who owns the agent profile registry?** Is it hardcoded in `agent-profiles.ts`, read from `.nax/agent-profiles.json`, or pluggable like providers? Tentative: hardcoded for built-in agents (claude, codex, gemini, cursor, local); external agents plug in via the plugin system.

13. *(Resolved.)* ~~Do we fall back on quality failures?~~ Hard availability failures only by default (`fail-quota`, `fail-service-down`, `fail-auth`, `fail-timeout`, `fail-adapter-error`). Quality-failure fallback is configurable via `context.fallback.onQualityFailure: true` but off by default and marked experimental. Decided.

14. *(Resolved.)* ~~Rules-in-a-neutral-form as follow-up.~~ Neutral rules in `.nax/rules/` are the design, not a follow-up. `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` become one-way shims generated by `nax rules export`. Decided.

15. **Legacy-CLAUDE.md fallback duration.** During migration, how long does `context.rules.allowLegacyClaudeMd: true` remain supported? Tentative: one minor version with a loud deprecation warning, then removed.

16. **Who authors `.nax/rules/` initially?** The `nax rules migrate` command produces a draft, but some phrases won't neutralize cleanly (e.g., Claude-specific tool-use instructions). This is an authoring-time cost paid once per project. Worth a short style guide in `docs/authoring-neutral-rules.md`.

17. **Fallback credential discovery.** How does the runner know Codex is "configured"? Credentials in env vars? A config field? Tentative: presence of `CODEX_API_KEY` (or equivalent) plus an explicit entry in the fallback map. If mapped but unconfigured, skipped with a warning at run start so the operator knows their map has a hole.

18. **Cross-agent RAG index.** If a RAG provider is indexed once and served to multiple agents, do we worry about content chunks that embed Claude-specific phrasing (e.g., from archived feature contexts)? Likely yes, but the neutralization rules apply to indexed content too. Track under the RAG provider spec.

## Acceptance criteria

1. **Orchestrator contract.** `ContextOrchestrator.assemble(req)` returns a `ContextBundle` with `pushMarkdown` (≤ `budgetTotal` tokens), `pulledTools` (possibly empty), `manifest`, and `digest`. Bundle is deterministic for fixed provider outputs.

2. **Parity with v1 (Phase 0).** With only `StaticRulesProvider` and `FeatureContextProvider` registered, the rendered push block for every TDD stage is byte-identical to v1's injected context (after role filter) for a representative fixture set of stories.

3. **Provider interface.** Any module exporting an object matching `IContextProvider` can be registered; registration does not require orchestrator changes.

4. **Parallel fetch.** Providers run concurrently; total fetch wall-clock ≤ slowest provider + O(10ms) overhead.

5. **Per-provider timeout.** A provider that exceeds `providerTimeoutMs` is dropped; the orchestrator logs a warning but does not fail the stage.

6. **Budget enforcement.** `pushMarkdown` token count ≤ `budgetTokens` for the stage; `static` and `feature` provider chunks occupy at least their configured floor unless their combined size exceeds the budget (in which case all of them are kept and other providers are dropped).

7. **Knapsack correctness.** For candidate sets ≤ 50 chunks, the packed set maximizes total score subject to the budget constraint (verified by a property test comparing against brute-force for small inputs).

8. **Role filtering.** Entries tagged `[implementer]` are present in bundles for roles in `{ implementer, single-session, tdd-simple, no-test, batch }` and absent for `{ test-writer, verifier, reviewer-*, rectifier, autofixer }` unless also tagged `[all]` or the matching role.

9. **Dedup.** Two chunks with identical content produce one entry in `pushMarkdown`; the kept chunk has the union of both audiences.

10. **Digest propagation.** A later stage's `ContextRequest.hints.priorStageDigest` is the previous stage's `ContextBundle.digest`. Verified end-to-end across TDD's six stages.

11. **Session scratch.** An entry written by `verify` is readable by `rectify` within the same session. Scratch survives a simulated session resume (orphaned-session test).

12. **Manifest writing.** Each `assemble()` call writes a manifest file at `.nax/features/<id>/stories/<storyId>/context-manifest-<stage>.json` containing every candidate chunk with `kept` status and drop reason.

13. **Pull tool registration.** When a stage's `pull.enabled: true` and a provider exports tools, those tools appear in `ContextBundle.pulledTools` with correct `maxCallsPerSession`. The adapter registers them with the agent session.

14. **Pull tool budget.** Calling a pull tool beyond `maxCallsPerSession` returns a structured error without invoking the provider.

15. **Graceful degradation.** When the agent adapter does not support tool calls, `pulledTools` is empty and push-eligible providers receive proportionally larger soft budgets; no error is raised.

16. **Config validation.** `context.providers` with an unknown `id` fails validation with a clear error message listing available providers.

17. **No-op when disabled.** `context.enabled: false` means `assemble()` returns a bundle with empty `pushMarkdown`, no tools, no manifest. Prompt builders fall back to their v1 direct-read path until that path is removed.

18. **Metrics.** `StoryMetrics.context.providers[providerId]` is populated with `tokensProduced`, `chunksProduced`, `chunksKept`, `wallClockMs`, `timedOut`, `failed`. `StoryMetrics.context.pullCalls` tracks invocations.

19. **Manifest inspection command.** `nax context inspect <storyId>` renders all manifests for a story in a readable form showing kept/dropped chunks per stage, per provider.

20. **Session scratch retention.** Scratch older than `sessionScratch.retentionDays` is purged on run completion. Feature archival moves scratch to `_archive/` only if `manifest.archiveOnFeatureArchive: true`.

21. **v1 features preserved.** v1's extractor, summarizer, promotion gate, and archival all continue to function against the feature provider's storage. v1 config under `context.featureEngine.*` remains valid.

22. **Builder migration.** Phase 0 uses `.context(bundle.pushMarkdown)` adapter; by the end of Phase 5 all prompt builders consume `ContextBundle` directly, and `.context(string)` is deprecated.

23. **Plugin provider integration.** A test plugin provider registered via the plugin system is loaded, called during `assemble()`, and its chunks appear in the manifest.

24. **Determinism mode.** With `context.deterministic: true`, providers declaring `deterministic: false` are excluded; two runs with identical inputs produce identical push blocks.

25. **Cost accounting.** A provider reporting `costUsd` on a chunk contributes that amount to `StoryMetrics.context.providers[providerId].cost`. Run total is visible in run summary.

26. **Self-dogfooding.** The v2 engine is developed using v1, and by Phase 2 switches to dogfooding itself on a feature-by-feature basis.

27. **Agent profile registry.** Every built-in agent id (`claude`, `codex`, `gemini`, `cursor`, `local`) resolves to an `AgentProfile` with fully populated `AgentCapabilities`. Requesting an unknown agent id falls back to a conservative default profile and emits a manifest warning.

28. **Canonical rules delivery.** `StaticRulesProvider` reads rules exclusively from `.nax/rules/*.md`. The engine does not read `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`, or any other per-agent rule file at assembly time. Verified by removing `CLAUDE.md` from a test fixture and confirming the push block is unchanged.

29. **Neutrality linter.** `canonical-loader.ts` rejects `.nax/rules/` content containing banned markers (e.g., `<system-reminder>`, `CLAUDE.md`, `.claude/`, `the Grep tool`, emoji) with a clear error identifying the offending file and line. Linter violations block the rules from loading; no silent pass-through.

30. **Rules export.** `nax rules export --agent=claude` generates `CLAUDE.md` from `.nax/rules/`, and `--agent=codex` generates `AGENTS.md`. Generation is one-way; manual edits to exported files are not read back by the engine. A second export overwrites the shim.

31. **Legacy compatibility flag.** With `context.rules.allowLegacyClaudeMd: true` and no `.nax/rules/` present, the engine reads `CLAUDE.md` + `.claude/rules/` and emits a deprecation warning on every run. With the flag off (default) and no `.nax/rules/`, the engine loads zero rules and logs a warning.

32. **Agent-dimension budget resolution.** The effective stage budget is `min(stageConfig.budgetTokens, agent.caps.preferredPromptTokens / expectedStages)`, overridable by `stages[stage].agents[agent.id].budgetTokens`. Verified by swapping agents and checking the resolved budget.

33. **Tool registration gated on agent capability.** When `agent.caps.supportsToolCalls: false`, `ContextBundle.pulledTools` is empty regardless of stage config, and push-eligible providers receive proportionally larger soft budgets.

34. **Fallback trigger categories.** Adapter failures carry `category: "availability" | "quality"`. Availability failures (`fail-quota`, `fail-service-down`, `fail-auth`, `fail-timeout`, `fail-adapter-error`) trigger fallback. Quality failures (`fail-quality`) trigger escalation by default; fallback is invoked only when `context.fallback.onQualityFailure: true`.

35. **Fallback map resolution.** Given `fallback.map.claude = ["codex", "gemini"]`, an availability failure on Claude switches to Codex if Codex credentials are configured; if not, to Gemini; if neither, the story fails with `all-agents-unavailable`. An unconfigured candidate in the map emits a warning at run start, not at fallback time.

36. **Fallback same tier.** Fallback preserves the tier of the failed attempt (e.g., Claude powerful → Codex powerful). Tier escalation does not run on availability failures.

37. **Rebuild portable state.** `rebuildForAgent(priorBundle, newAgent, failure)` returns a bundle where feature-context chunks, session-scratch chunks, and prior-stage digests are preserved with their original content hashes; a failure-note chunk is present as `kind: "other"`, `freshness: "this-session"`; rendering reflects the new agent's profile.

38. **Rebuild latency.** `rebuildForAgent()` completes in ≤100ms p95 for typical bundles (≤50 chunks) with no LLM calls on the hot path.

39. **Rebuild manifest.** The rebuild writes a `rebuild-manifest.json` correlating old chunk IDs to new chunk IDs, noting any chunks dropped due to agent incompatibility.

40. **Fallback hop bound.** `context.fallback.maxHopsPerStory` (default 2) caps agent switches per story. Exceeding it marks the story failed with `all-agents-unavailable`; the manifest records every attempted vendor and its failure reason.

41. **Fallback observability.** Every fallback emits a structured metric event `context.fallback.triggered` with `{ storyId, priorAgent, newAgent, outcome, category, hop }`. Run summary surfaces whether fallback fired.

42. **Cross-agent scratch neutralization.** Scratch entries tagged `writtenByAgent: <id>` are neutralized in rendering when read for a different target agent; agent-originated tool-name references are stripped or generalized.

43. **Failure-note determinism.** The failure-note chunk is produced by deterministic string assembly — running `rebuildForAgent()` twice with identical inputs produces byte-identical output.
