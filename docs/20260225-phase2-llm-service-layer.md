# Phase 2: LLM Service Layer — Architecture Design

*Date: 2026-02-25*
*Status: Proposed (pending decision)*

---

## Problem

nax v0.10.0 is tightly coupled to Claude Code CLI (`Bun.spawn("claude -p")`). Every agent session spawns a subprocess consuming ~350MB RAM. This blocks:
- **Parallelism** (Phase 3) — 3 concurrent stories = 1GB+ RAM, OOMs on VPS
- **Provider flexibility** — locked to Anthropic via Claude Code
- **Cost optimization** — can't use cheaper models (Gemini Flash, DeepSeek) for simple stories
- **Exact cost tracking** — current approach estimates cost from duration, not actual token counts

## Solution: Multi-Provider Direct API + Agent Loop

Build a lightweight agent runtime inside nax that calls LLM provider APIs directly with tool use, replacing Claude Code CLI for non-interactive work.

### Architecture

```
nax story execution
  → router picks tier → resolves to backend config
  → if "claude-cli" → ClaudeCodeAdapter (Bun.spawn, current)
  → if { provider, model } → DirectApiAdapter
      → ProviderRegistry.get(provider) → LlmProvider
      → AgentLoop: prompt → provider.chat() → tool calls → execute tools → loop
      → return AgentResult
```

### Provider Abstraction

```typescript
interface LlmProvider {
  readonly name: string;
  
  chat(options: {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];
    maxTokens?: number;
  }): Promise<LlmResponse>;
}

interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];  // normalized regardless of provider
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}
```

### Provider Implementations

Only 3 implementations needed — most providers are OpenAI-compatible:

| Implementation | Covers | API Format |
|:---------------|:-------|:-----------|
| `AnthropicProvider` | Anthropic (Claude) | Messages API, `tool_use` content blocks |
| `OpenAiCompatProvider` | OpenAI, Moonshot, DeepSeek, OpenRouter, Groq, Together | Chat Completions, `tool_calls` in message |
| `GoogleProvider` | Google Gemini | GenerateContent, `functionCall` in parts |

`OpenAiCompatProvider` is configured with `baseUrl` + `apiKey`, so any OpenAI-compatible provider works with zero code.

### Minimal Tool Set

The agent loop only needs 5 tools (nax handles all orchestration externally):

| Tool | What | Complexity |
|:-----|:-----|:-----------|
| `read_file` | Read file contents | Trivial |
| `write_file` | Write/create file | Trivial |
| `list_files` | List directory | Trivial |
| `run_command` | Shell exec (tests, git) | Simple (child_process) |
| `search_files` | Grep/ripgrep | Simple |

### Backend Routing

Resolution order:
1. **Overrides** — strategy-specific (TDD, interactive) → forces a backend
2. **Tier routing** — fast/balanced/powerful → maps to backend config

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
      "balanced": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
      "powerful": { "provider": "anthropic", "model": "claude-opus-4" }
    },
    "overrides": {
      "tdd": "claude-cli",
      "interactive": "claude-cli"
    }
  }
}
```

Resolution logic (~15 lines):
```typescript
function resolveBackend(tier: ModelTier, context: { tdd: boolean; interactive: boolean }): BackendConfig {
  const config = loadConfig().agents;
  if (context.tdd && config.overrides?.tdd) return config.overrides.tdd;
  if (context.interactive && config.overrides?.interactive) return config.overrides.interactive;
  return config.routing[tier];
}
```

### Backward Compatibility

- No `agents` section in config → everything uses `claude-cli` (current behavior)
- Default routing maps all tiers to `"claude-cli"`
- Users opt into API adapters by adding `agents.providers` + updating `agents.routing`
- Zero breaking changes

### Why Not OpenClaw Gateway API?

OpenClaw does not expose a public API for this use case. The gateway HTTP endpoints (chat completions, tools invoke) are internal and disabled by default. Building our own lightweight agent loop is cleaner and has no external dependencies.

### Why Not Just Claude Code CLI?

| Factor | Claude Code CLI | Direct API |
|:-------|:---------------|:-----------|
| RAM per session | ~350MB | ~5MB |
| Parallel stories | OOMs at 3 | 10+ concurrent |
| Cost tracking | Estimated from duration | Exact token counts |
| Provider flexibility | Anthropic only | Any provider |
| Tool access | ~50 tools (overkill) | 5 tools (minimal) |
| Dependencies | `claude` binary installed | Just HTTP |

### Component Breakdown

| Component | Est. Lines | What |
|:----------|:-----------|:-----|
| `LlmProvider` interface + types | ~50 | Normalized request/response types |
| `AnthropicProvider` | ~80 | Messages API, tool_use blocks |
| `OpenAiCompatProvider` | ~80 | Chat completions, configurable baseUrl |
| `GoogleProvider` | ~100 | GenerateContent, functionCall parts |
| Provider registry + factory | ~40 | Create provider from config |
| Tool definitions (5 tools) | ~100 | read, write, list, search, exec |
| Agent loop (tool_use cycle) | ~150 | Prompt → tool calls → iterate |
| `DirectApiAdapter` | ~80 | Wraps provider + loop into AgentAdapter |
| Config schema additions | ~80 | providers, routing, overrides |
| **Total** | **~760** | |

### Enables Phase 3

With lightweight API adapters (~5MB each), Phase 3 parallelism becomes feasible:
- Spawn N stories in parallel via concurrent HTTP calls
- Each story gets its own git worktree (from dev-orchestrator pattern)
- No OOM risk — 10 concurrent stories ≈ 50MB total vs 3.5GB with CLI

---

*Decision pending. This doc captures the architecture analysis for future implementation.*
