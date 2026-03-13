/**
 * ACP Agent Adapter — implements AgentAdapter interface via AcpClient
 *
 * Provides uniform interface for running agents through the ACP protocol,
 * supporting one-shot completions and full run sessions.
 */

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  DecomposeOptions,
  DecomposeResult,
  PlanOptions,
  PlanResult,
} from "../types";
import { CompleteError } from "../types";
import type { AcpAdapterConfig, AcpClient, AcpSession, AcpSessionResponse, AgentRegistryEntry } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Agent registry — maps agent names to their ACP commands and metadata
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_REGISTRY: Record<string, AgentRegistryEntry> = {
  claude: {
    binary: "claude",
    displayName: "Claude Code (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
  },
  codex: {
    binary: "codex",
    displayName: "OpenAI Codex (ACP)",
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 128_000,
  },
  gemini: {
    binary: "gemini",
    displayName: "Gemini CLI (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 1_000_000,
  },
};

const DEFAULT_ENTRY: AgentRegistryEntry = {
  binary: "claude",
  displayName: "ACP Agent",
  supportedTiers: ["balanced"],
  maxContextTokens: 128_000,
};

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;
const PERMISSION_MODE = "approve-all";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies — follows the _deps pattern
// ─────────────────────────────────────────────────────────────────────────────

export const _acpAdapterDeps = {
  createClient(_cmd: string): AcpClient {
    // Default implementation — replaced in tests via _acpAdapterDeps.createClient = mock(...)
    throw new Error("[acp-adapter] createClient not configured — inject a real AcpClient factory");
  },

  which(name: string): string | null {
    return Bun.which(name);
  },

  async sleep(ms: number): Promise<void> {
    await Bun.sleep(ms);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveRegistryEntry(agentName: string): AgentRegistryEntry {
  return AGENT_REGISTRY[agentName] ?? DEFAULT_ENTRY;
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("429");
}

function extractAssistantText(response: AcpSessionResponse): string {
  const messages = response.messages ?? [];
  const assistantMessages = messages.filter((m) => m.role === "assistant").map((m) => m.content);
  return assistantMessages.join("\n").trim();
}

function mapStopReasonToSuccess(stopReason: string): boolean {
  return stopReason === "end_turn";
}

function estimateCostFromUsage(usage?: {
  input_tokens: number;
  output_tokens: number;
}): number {
  if (!usage) return 0;
  // Conservative estimate: ~$3/1M input, ~$15/1M output (Sonnet-class)
  const INPUT_RATE = 3 / 1_000_000;
  const OUTPUT_RATE = 15 / 1_000_000;
  return usage.input_tokens * INPUT_RATE + usage.output_tokens * OUTPUT_RATE;
}

// ─────────────────────────────────────────────────────────────────────────────
// AcpAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class AcpAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly binary: string;
  readonly capabilities: AgentCapabilities;

  private readonly config: AcpAdapterConfig;

  constructor(agentName: string) {
    const entry = resolveRegistryEntry(agentName);
    this.name = agentName;
    this.displayName = entry.displayName;
    this.binary = entry.binary;
    this.capabilities = {
      supportedTiers: entry.supportedTiers,
      maxContextTokens: entry.maxContextTokens,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "review", "refactor"]),
    };
    this.config = {
      agentName,
      permissionMode: PERMISSION_MODE,
    };
  }

  async isInstalled(): Promise<boolean> {
    const path = _acpAdapterDeps.which(this.binary);
    return path !== null;
  }

  buildCommand(options: AgentRunOptions): string[] {
    return [this.binary, "--permission-mode", this.config.permissionMode, "--model", options.modelDef.model];
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      if (attempt > 0) {
        await _acpAdapterDeps.sleep(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      try {
        const result = await this._runOnce(options, startTime);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        if (!isRateLimitError(error)) break;
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      success: false,
      exitCode: 1,
      output: lastError?.message ?? "Run failed",
      rateLimited: isRateLimitError(lastError),
      durationMs,
      estimatedCost: 0,
    };
  }

  private async _runOnce(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
    const cmd = this.buildCommand(options).join(" ");
    const client = _acpAdapterDeps.createClient(cmd);

    await client.start();
    let session: AcpSession | undefined;

    try {
      session = await client.createSession({
        agentName: this.config.agentName,
        permissionMode: this.config.permissionMode,
      });

      const response = await session.prompt(options.prompt);
      const durationMs = Date.now() - startTime;

      return {
        success: mapStopReasonToSuccess(response.stopReason),
        exitCode: mapStopReasonToSuccess(response.stopReason) ? 0 : 1,
        output: extractAssistantText(response),
        rateLimited: false,
        durationMs,
        estimatedCost: estimateCostFromUsage(response.cumulative_token_usage),
      };
    } finally {
      if (session) {
        await session.close().catch(() => {});
      }
      await client.close().catch(() => {});
    }
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
    const cmd = this.buildCommand({
      workdir: "",
      prompt,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: _options?.model ?? this.binary, env: {} },
      timeoutSeconds: 60,
    }).join(" ");

    const client = _acpAdapterDeps.createClient(cmd);
    await client.start();
    let session: AcpSession | undefined;

    try {
      session = await client.createSession({
        agentName: this.config.agentName,
        permissionMode: this.config.permissionMode,
      });

      const response = await session.prompt(prompt);

      if (response.stopReason === "error") {
        throw new CompleteError("[acp-adapter] complete() failed: agent returned stopReason=error");
      }

      const text = extractAssistantText(response);

      if (!text) {
        throw new CompleteError("[acp-adapter] complete() returned empty output");
      }

      return text;
    } finally {
      if (session) {
        await session.close().catch(() => {});
      }
    }
  }

  async plan(_options: PlanOptions): Promise<PlanResult> {
    throw new Error("[acp-adapter] AcpAgentAdapter.plan() not implemented");
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    throw new Error("[acp-adapter] AcpAgentAdapter.decompose() not implemented");
  }
}
