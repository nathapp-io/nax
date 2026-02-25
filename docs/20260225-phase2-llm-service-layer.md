# Phase 2: LLM Service Layer — Merged Architecture Design

*Date: 2026-02-25*
*Status: Proposed (pending decision)*
*Supersedes: Original issue #3 design + 2026-02-25 architecture analysis*

---

## Problem

nax v0.10.0 has two coupling issues:

1. **All LLM calls go through Claude Code CLI** — routing, review, acceptance stages spawn `claude -p` just for text reasoning. Wasteful.
2. **All coding goes through CLI subprocess** — ~350MB RAM each, blocks parallelism.

## Solution: Unified LLM Service Layer + Lightweight Agent Loop

Two execution paths, one provider abstraction:

```
LlmProvider (interface — normalized across providers)
  ├── AnthropicProvider        (Messages API)
  ├── GoogleProvider           (GenerateContent API)
  └── OpenAiCompatProvider     (Chat Completions — covers OpenAI, Moonshot, DeepSeek, OpenRouter, Groq, etc.)

Used by:
  ├── LLM Mode (text in → text out) — routing, analyze, review, acceptance
  │     └── llm/client.ts → callLlm(prompt, tier, config)
  │
  └── Agent Mode (text + tools) — coding, TDD
        ├── DirectApiAdapter — LlmProvider + tool loop (~5MB per session)
        └── ClaudeCodeAdapter — CLI subprocess (~350MB, for TDD/interactive)
```

## Architecture

```
src/
├── llm/                      # LLM Service Layer (shared by both modes)
│   ├── types.ts              # LlmProvider interface, Message, ToolCall types
│   ├── client.ts             # callLlm() with fallback chain logic
│   ├── registry.ts           # Create provider from config
│   └── providers/
│       ├── anthropic.ts      # Anthropic Messages API
│       ├── openai-compat.ts  # OpenAI-compatible (configurable baseUrl)
│       └── google.ts         # Google Gemini API
│
├── llm/tools/                # Minimal tool set for Direct API coding
│   ├── types.ts              # ToolDefinition, ToolResult
│   ├── read-file.ts          # Read file contents
│   ├── write-file.ts         # Write/create file
│   ├── list-files.ts         # List directory
│   ├── search-files.ts       # Grep/ripgrep
│   └── run-command.ts        # Shell exec (tests, git)
│
├── llm/agent-loop.ts         # Tool use cycle: prompt → chat() → execute tools → loop
│
├── agents/                   # Agent adapters (implement AgentAdapter interface)
│   ├── types.ts              # AgentAdapter, AgentResult (unchanged)
│   ├── claude.ts             # ClaudeCodeAdapter (current — subprocess)
│   ├── direct-api.ts         # DirectApiAdapter (new — wraps llm/ + tools)
│   ├── registry.ts           # Resolve backend config → adapter instance
│   └── cost.ts               # Cost estimation (unchanged for CLI, exact for API)
│
├── pipeline/stages/          # Each stage declares its execution mode
│   ├── routing.ts            # LLM Mode → llm/client.ts
│   ├── analyze.ts            # LLM Mode → llm/client.ts
│   ├── coding.ts             # Agent Mode → agents/registry.ts
│   ├── tdd.ts                # Agent Mode → agents/registry.ts
│   ├── review.ts             # LLM Mode → llm/client.ts
│   └── acceptance.ts         # LLM Mode → llm/client.ts
│
└── config/schema.ts          # Extended with providers, routing, pipeline overrides
```

## LlmProvider Interface

```typescript
interface LlmProvider {
  readonly name: string;

  chat(options: {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];   // Optional — omit for LLM Mode (reasoning only)
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<LlmResponse>;
}

interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];         // Normalized regardless of provider format
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}
```

Single interface serves both modes:
- **LLM Mode** (routing, review): `chat()` without `tools` → text response
- **Agent Mode** (coding): `chat()` with `tools` → tool calls → agent loop iterates

## Provider Implementations

| Implementation | Covers | API Format | Tool Use Format |
|:---------------|:-------|:-----------|:---------------|
| `AnthropicProvider` | Anthropic (Claude) | Messages API | `tool_use` content blocks |
| `OpenAiCompatProvider` | OpenAI, Moonshot, DeepSeek, OpenRouter, Groq, Together | Chat Completions | `tool_calls` in message |
| `GoogleProvider` | Google Gemini | GenerateContent | `functionCall` in parts |

`OpenAiCompatProvider` takes `baseUrl` + `apiKey` — any OpenAI-compatible provider works with zero code.

## Tier-Based Fallback Chains

Each tier is an ordered list of providers. On 429/error, try next in chain:

```
Stage needs "balanced" tier
  → Try anthropic/sonnet
  → Rate limited (429)? → Try openai/gpt-5
  → Also limited? → Try next in list
  → All exhausted? → Stage fails with clear error
```

Both LLM Mode and Agent Mode use the same fallback logic via `llm/client.ts`:

```
config.models["balanced"]  →  [anthropic/sonnet, openai/gpt-5]
                                    │
                  ┌─────────────────┴──────────────────┐
                  │                                     │
            LLM Mode stages                      Agent Mode stages
            (routing, review)                    (coding, TDD)
                  │                                     │
          llm/client.ts                         DirectApiAdapter
          tries providers                       tries providers
          in order                              in order (with tools)
```

Single `ModelDef` (not array) is treated as array of one — backward compatible, no fallback.

## Backend Routing

Three-level resolution:

### 1. Per-Stage Pipeline Override (most specific)

```json
{
  "pipeline": {
    "routing": {
      "primary": { "provider": "google", "model": "gemini-flash", "via": "api" },
      "fallback": [
        { "provider": "anthropic", "model": "haiku", "via": "api" },
        { "via": "keyword" }
      ]
    },
    "implementation": {
      "primary": { "provider": "anthropic", "model": "sonnet", "via": "api" },
      "fallback": [
        { "via": "claude-cli" }
      ]
    }
  }
}
```

The `via` field determines execution path:
- `"api"` → Direct API (LLM Mode or DirectApiAdapter depending on stage)
- `"claude-cli"` → Claude Code CLI subprocess
- `"keyword"` → built-in keyword strategy (routing only)

### 2. Strategy Override (tdd/interactive → force backend)

```json
{
  "agents": {
    "overrides": {
      "tdd": "claude-cli",
      "interactive": "claude-cli"
    }
  }
}
```

### 3. Tier Routing (default)

```json
{
  "agents": {
    "routing": {
      "fast": { "provider": "gemini", "model": "gemini-2.5-flash" },
      "balanced": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
      "powerful": { "provider": "anthropic", "model": "claude-opus-4" }
    }
  }
}
```

### Resolution Logic

```typescript
function resolveBackend(
  tier: ModelTier,
  stage: string,
  context: { tdd: boolean; interactive: boolean }
): BackendConfig {
  const config = loadConfig();

  // 1. Per-stage pipeline override
  if (config.pipeline?.[stage]?.primary) return config.pipeline[stage];

  // 2. Strategy override
  if (context.tdd && config.agents?.overrides?.tdd) return config.agents.overrides.tdd;
  if (context.interactive && config.agents?.overrides?.interactive) return config.agents.overrides.interactive;

  // 3. Tier routing
  return config.agents?.routing?.[tier] ?? "claude-cli";
}
```

## Full Config Example

```json
{
  "agents": {
    "providers": {
      "anthropic": {
        "type": "anthropic",
        "apiKey": "${ANTHROPIC_API_KEY}"
      },
      "openai": {
        "type": "openai-compat",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "${OPENAI_API_KEY}"
      },
      "gemini": {
        "type": "google",
        "apiKey": "${GOOGLE_API_KEY}"
      },
      "moonshot": {
        "type": "openai-compat",
        "baseUrl": "https://api.moonshot.cn/v1",
        "apiKey": "${MOONSHOT_API_KEY}"
      },
      "deepseek": {
        "type": "openai-compat",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "${DEEPSEEK_API_KEY}"
      }
    },
    "routing": {
      "fast": { "provider": "gemini", "model": "gemini-2.5-flash" },
      "balanced": [
        { "provider": "anthropic", "model": "claude-sonnet-4-5" },
        { "provider": "openai", "model": "gpt-5" }
      ],
      "powerful": { "provider": "anthropic", "model": "claude-opus-4" }
    },
    "overrides": {
      "tdd": "claude-cli",
      "interactive": "claude-cli"
    }
  },
  "pipeline": {
    "routing": {
      "primary": { "provider": "gemini", "model": "gemini-flash", "via": "api" },
      "fallback": [{ "via": "keyword" }]
    }
  }
}
```

## Minimal Tool Set (for DirectApiAdapter)

| Tool | What | Lines |
|:-----|:-----|:------|
| `read_file` | Read file contents (with line range) | ~15 |
| `write_file` | Write/create file (with mkdir -p) | ~15 |
| `list_files` | List directory (recursive option) | ~15 |
| `search_files` | Grep/ripgrep pattern search | ~20 |
| `run_command` | Shell exec with timeout + cwd | ~30 |

~95 lines total. Each tool is sandboxed to the project workdir.

## Agent Loop

```typescript
async function agentLoop(
  provider: LlmProvider,
  model: string,
  prompt: string,
  workdir: string,
  maxIterations: number = 50,
): Promise<AgentResult> {
  const tools = getToolDefinitions();
  let messages: Message[] = [{ role: "user", content: prompt }];
  let totalCost = { input: 0, output: 0 };

  for (let i = 0; i < maxIterations; i++) {
    const response = await provider.chat({ model, messages, tools });
    totalCost.input += response.usage.inputTokens;
    totalCost.output += response.usage.outputTokens;

    if (response.stopReason === "end_turn") {
      return { success: true, output: response.content, cost: totalCost };
    }

    // Execute tool calls
    const toolResults = await Promise.all(
      response.toolCalls.map(tc => executeTool(tc, workdir))
    );

    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
    messages.push({ role: "tool", results: toolResults });
  }

  return { success: false, output: "Max iterations reached", cost: totalCost };
}
```

~150 lines with error handling, logging, and token budget checks.

## Comparison: CLI vs Direct API

| Factor | Claude Code CLI | Direct API |
|:-------|:---------------|:-----------|
| RAM per session | ~350MB | ~5MB |
| Parallel stories | OOMs at 3 | 10+ concurrent |
| Cost tracking | Estimated from duration | Exact token counts from API |
| Provider flexibility | Anthropic only | Any provider with tool_use |
| Tool access | ~50 tools (overkill) | 5 tools (minimal, sandboxed) |
| CLAUDE.md support | ✅ Auto-loaded | ❌ Must inject into prompt |
| TDD isolation | ✅ PTY-based session isolation | ⚠️ Possible but needs validation |
| Interactive/TUI | ✅ PTY handle | ❌ Not supported |
| Dependencies | `claude` binary installed | Just HTTP (fetch) |

## Backward Compatibility

- No `agents` section in config → everything uses `claude-cli` (current behavior)
- No `pipeline` section → stages inherit from tier routing
- Single ModelDef (not array) → treated as array of one, no fallback
- Zero breaking changes

## Component Breakdown

| Component | Est. Lines | What |
|:----------|:-----------|:-----|
| `llm/types.ts` | ~60 | LlmProvider, Message, ToolCall, LlmResponse |
| `llm/providers/anthropic.ts` | ~80 | Messages API + tool_use normalization |
| `llm/providers/openai-compat.ts` | ~80 | Chat Completions + configurable baseUrl |
| `llm/providers/google.ts` | ~100 | GenerateContent + functionCall normalization |
| `llm/registry.ts` | ~40 | Provider factory from config |
| `llm/client.ts` | ~80 | callLlm() with fallback chain + retry |
| `llm/tools/*.ts` (5 tools) | ~95 | read, write, list, search, exec |
| `llm/agent-loop.ts` | ~150 | Tool use cycle with iteration limit |
| `agents/direct-api.ts` | ~80 | DirectApiAdapter wrapping llm/ layer |
| `agents/registry.ts` (update) | ~30 | Resolve backend config → adapter |
| `config/schema.ts` (update) | ~100 | providers, routing, overrides, pipeline |
| **Total** | **~895** | |

## Implementation Phases

| Phase | Scope | Effort | Enables |
|:------|:------|:-------|:--------|
| P1 | LlmProvider interface + AnthropicProvider + callLlm() | Small | LLM Mode for routing/review |
| P2 | OpenAiCompatProvider + GoogleProvider | Small | Multi-provider support |
| P3 | Fallback chain logic in client.ts | Medium | Rate limit resilience |
| P4 | Tool definitions + agent loop + DirectApiAdapter | Medium | API-based coding |
| P5 | Per-stage pipeline config | Medium | Fine-grained stage control |
| P6 | Wire LLM Mode into routing, review, acceptance stages | Medium | Remove CLI dependency for reasoning |

P1-P2 can ship independently as a quick win (LLM Mode only). P4 is the big unlock for Phase 3 parallelism.

## Auth/Key Management

Provider keys flow from config with env var expansion:

```json
{
  "providers": {
    "anthropic": { "type": "anthropic", "apiKey": "${ANTHROPIC_API_KEY}" }
  }
}
```

Each provider reads `apiKey` from its config entry. Fallback to `process.env` for backward compat.
Per-model env overrides via `ModelDef.env` still work (existing behavior).

## Enables Phase 3 (Parallelism)

With DirectApiAdapter (~5MB each), Phase 3 becomes feasible:
- N stories execute concurrently via parallel HTTP calls
- Each story gets its own git worktree (from dev-orchestrator pattern)
- No OOM risk — 10 concurrent stories ≈ 50MB total vs 3.5GB with CLI
- Exact cost tracking per story from API token counts

---

*Decision pending. This doc captures the merged architecture for future implementation.*
