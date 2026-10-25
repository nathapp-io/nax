import { type AnswerReply, approvalMemoryApplies, approvalMemoryKey, type SessionEvent } from "@nathapp/nax-agent";
import type { ChatMode } from "./chat-mode";

export type AskChoice = "allow_once" | "allow_session" | "deny";
export type ChatApproval = Extract<SessionEvent, { type: "approval_requested" }>;
export type ChatPendingAsk = Extract<SessionEvent, { type: "approval_requested" | "question" }>;

export interface ChatAskControllerOptions {
  readonly mode: ChatMode;
  /** The host supplies a closure targeting its current session, not a bound old session. */
  readonly answer: (requestId: string, reply: AnswerReply) => void;
}

export interface ChatAskController {
  handle(event: SessionEvent): void;
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

  handle(event: SessionEvent): void {
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
    return !event.unsandboxed && event.tool !== "Delete" && approvalMemoryKey(event) !== undefined;
  }

  resolve(requestId: string, choice: AskChoice): void {
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
