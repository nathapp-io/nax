/**
 * AcpInteractionBridge — connects ACP sessionUpdate notifications to nax interaction chain
 *
 * Detects question patterns in agent messages and routes them to the interaction plugin,
 * enabling mid-session agent ↔ human communication.
 */

import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../../interaction/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionNotification {
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
}

export interface BridgeConfig {
  featureName: string;
  storyId: string;
  responseTimeoutMs: number;
  fallbackPrompt: string;
}

type BridgeEvent = "question-detected" | "response-received";
type BridgeEventHandler = (event: unknown) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Question pattern detection
// ─────────────────────────────────────────────────────────────────────────────

const QUESTION_PATTERNS = [/\?/, /\bwhich\b/i, /\bshould i\b/i, /\bunclear\b/i, /\bplease clarify\b/i];

function containsQuestionPattern(content: string): boolean {
  return QUESTION_PATTERNS.some((pattern) => pattern.test(content));
}

function generateRequestId(): string {
  return `ix-acp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AcpInteractionBridge
// ─────────────────────────────────────────────────────────────────────────────

export class AcpInteractionBridge {
  private readonly plugin: InteractionPlugin;
  private readonly config: BridgeConfig;
  private destroyed = false;
  private readonly listeners = new Map<BridgeEvent, BridgeEventHandler[]>();

  constructor(plugin: InteractionPlugin, config: BridgeConfig) {
    this.plugin = plugin;
    this.config = config;
  }

  isQuestion(notification: SessionNotification): boolean {
    if (notification.role !== "assistant") return false;
    return containsQuestionPattern(notification.content);
  }

  async onSessionUpdate(notification: SessionNotification): Promise<void> {
    if (this.destroyed) return;
    if (!this.isQuestion(notification)) return;

    const request: InteractionRequest = {
      id: generateRequestId(),
      type: "input",
      featureName: this.config.featureName,
      storyId: this.config.storyId,
      stage: "execution",
      summary: notification.content,
      fallback: "continue",
      createdAt: Date.now(),
    };

    this.emit("question-detected", { requestId: request.id, sessionId: notification.sessionId });

    await this.plugin.send(request);
  }

  async waitForResponse(requestId: string, timeout: number): Promise<InteractionResponse> {
    try {
      const response = await this.plugin.receive(requestId, timeout);
      this.emit("response-received", { requestId, respondedBy: response.respondedBy });
      return response;
    } catch {
      const fallback: InteractionResponse = {
        requestId,
        action: "input",
        value: "continue",
        respondedBy: "timeout",
        respondedAt: Date.now(),
      };
      this.emit("response-received", { requestId, respondedBy: "timeout" });
      return fallback;
    }
  }

  getFollowUpPrompt(response: InteractionResponse): string {
    if (!response.value) {
      return this.config.fallbackPrompt;
    }
    return response.value;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  on(event: BridgeEvent, handler: BridgeEventHandler): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  private emit(event: BridgeEvent, data: unknown): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler(data);
    }
  }
}
