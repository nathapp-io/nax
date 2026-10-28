import { type AnswerReply, approvalMemoryApplies, approvalMemoryKey, type SessionEvent } from "@nathapp/nax-agent";
import type { ChatMode } from "./chat-mode";

export type AskChoice = "allow_once" | "allow_session" | "deny";
export type ChatApproval = Extract<SessionEvent, { type: "approval_requested" }>;
export type ChatPendingAsk = Extract<SessionEvent, { type: "approval_requested" | "question" }>;

export interface HostApprovalCard {
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  readonly reason: string;
  readonly signal?: AbortSignal;
}

export const DEFAULT_HOST_APPROVAL_TIMEOUT_MS = 600_000;
export const _askControllerDeps = {
  // Cancellable: the handle is cleared whenever the host ask resolves.
  setTimeout: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number): void => globalThis.clearTimeout(handle),
};
let nextHostRequestId = 0;

interface HostRequest {
  readonly settle: (decision: "allow" | "deny") => void;
  readonly cleanup: () => void;
}

export interface ChatAskControllerOptions {
  readonly mode: ChatMode;
  readonly approvalTimeoutMs?: number;
  readonly now?: () => Date;
  /** The host supplies a closure targeting its current session, not a bound old session. */
  readonly answer: (requestId: string, reply: AnswerReply) => void;
}

export interface ChatAskController {
  handle(event: SessionEvent): void;
  requestHostApproval(card: HostApprovalCard): Promise<"allow" | "deny">;
  pending(): readonly ChatPendingAsk[];
  resolve(requestId: string, choice: AskChoice): void;
  canRemember(event: ChatApproval): boolean;
  answerQuestion(requestId: string, text: string): void;
  setMode(mode: ChatMode): void;
  reset(): void;
  onChange(listener: () => void): () => void;
}

class AskController implements ChatAskController {
  private mode: ChatMode;
  private readonly open = new Map<string, ChatPendingAsk>();
  private readonly hosts = new Map<string, HostRequest>();
  private readonly memory = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ChatAskControllerOptions) {
    this.mode = options.mode;
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private remove(requestId: string): void {
    if (this.open.delete(requestId)) this.changed();
  }

  requestHostApproval(card: HostApprovalCard): Promise<"allow" | "deny"> {
    if (card.signal?.aborted) return Promise.resolve("deny");
    const requestId = `host-${++nextHostRequestId}`;
    const now = this.options.now?.() ?? new Date();
    const timeout = this.options.approvalTimeoutMs ?? DEFAULT_HOST_APPROVAL_TIMEOUT_MS;
    const waiting = Promise.withResolvers<"allow" | "deny">();
    const abort = () => this.resolve(requestId, "deny");
    const timer = _askControllerDeps.setTimeout(abort, timeout);
    this.hosts.set(requestId, {
      settle: waiting.resolve,
      cleanup: () => {
        _askControllerDeps.clearTimeout(timer);
        card.signal?.removeEventListener("abort", abort);
      },
    });
    this.open.set(requestId, {
      type: "approval_requested",
      requestId,
      sessionId: "host",
      turnId: "host",
      metadata: {},
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + timeout).toISOString(),
      tool: card.tool,
      summary: card.summary,
      command: card.command,
      reason: card.reason,
    });
    card.signal?.addEventListener("abort", abort, { once: true });
    this.changed();
    return waiting.promise;
  }

  handle(event: SessionEvent): void {
    // Host-owned ids are never answered or externally resolved by the session transport.
    if ("requestId" in event && event.requestId.startsWith("host-")) return;
    if (event.type === "approval_resolved") {
      this.remove(event.requestId);
      return;
    }
    if (event.type !== "approval_requested" && event.type !== "question") return;
    if (event.answerable === false) return;
    if (event.type === "approval_requested") {
      const key = approvalMemoryKey(event);
      const remembered = !event.unsandboxed && key !== undefined && this.memory.has(key);
      if (this.mode === "full" || (remembered && approvalMemoryApplies(event, "allow"))) {
        this.options.answer(event.requestId, { decision: "allow" });
        return;
      }
    }
    if (this.open.get(event.requestId) === event) return;
    this.open.set(event.requestId, event);
    this.changed();
  }

  pending(): readonly ChatPendingAsk[] {
    return [...this.open.values()];
  }

  canRemember(event: ChatApproval): boolean {
    return (
      !event.requestId.startsWith("host-") &&
      !event.unsandboxed &&
      event.tool !== "Delete" &&
      approvalMemoryKey(event) !== undefined
    );
  }

  resolve(requestId: string, choice: AskChoice): void {
    const host = this.hosts.get(requestId);
    if (host) {
      this.hosts.delete(requestId);
      host.cleanup();
      host.settle(choice === "deny" ? "deny" : "allow");
      this.remove(requestId);
      return;
    }
    const event = this.open.get(requestId);
    if (event?.type !== "approval_requested") return;
    const key = approvalMemoryKey(event);
    if (choice === "allow_session" && this.canRemember(event) && key !== undefined) this.memory.add(key);
    this.options.answer(requestId, { decision: choice === "deny" ? "deny" : "allow" });
    this.remove(requestId);
  }

  answerQuestion(requestId: string, text: string): void {
    if (this.open.get(requestId)?.type !== "question") return;
    this.options.answer(requestId, { text });
    this.remove(requestId);
  }

  setMode(mode: ChatMode): void {
    this.mode = mode;
  }

  reset(): void {
    for (const requestId of [...this.hosts.keys()]) this.resolve(requestId, "deny");
    this.memory.clear();
    if (this.open.size === 0) return;
    this.open.clear();
    this.changed();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Session-local asks and positive approval memory shared by terminal and fallback. */
export function createChatAskController(options: ChatAskControllerOptions): ChatAskController {
  return new AskController(options);
}
