import { errorMessage } from "@nathapp/nax-agent/internal";
import {
  type ChatAnswer,
  type ChatAskRecord,
  type ChatAskSecret,
  RUN_ASK_POLL_MS,
  readChatAnswer,
  readChatAsks,
  readChatSettled,
  writeChatAnswer,
  writeChatHeartbeat,
} from "@/interaction";
import type { Logger } from "@/logger";
import type { ChatAskController } from "../ask-controller";
import type { ChatChains } from "./chain-controller";
import type { ChatJobs } from "./job-runner";
import { jobAsksDir } from "./job-store";
import type { ChatJob } from "./job-types";

export interface RunAskReply {
  readonly answer: string;
  readonly reason: string;
}
export type RunAskResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
export interface ChatRunAsks {
  peekNotice(): string | undefined;
  takeNotice(): string | undefined;
  takeNotes(): readonly string[];
  answer(askId: string, reply: RunAskReply): Promise<RunAskResult>;
  noteUserTurn(): void;
  onChange(listener: () => void): () => void;
  dispose(): void;
}
export interface RunAsksOptions {
  readonly outputDir: string;
  readonly jobs: Pick<ChatJobs, "running" | "get" | "onChange" | "askSecret">;
  readonly chains: Pick<ChatChains, "isActive">;
  readonly asks: Pick<ChatAskController, "requestHostChoice" | "requestHostQuestion">;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;
export const _runAsksDeps = {
  // Cancellable polling: dispose must clear the pending tick.
  setTimeout: (callback: () => void | Promise<void>, ms: number): TimerHandle =>
    globalThis.setTimeout(() => {
      void callback();
    }, ms),
  clearTimeout: (handle: TimerHandle): void => globalThis.clearTimeout(handle),
  readChatAsks,
  readChatSettled,
  readChatAnswer,
  writeChatHeartbeat,
  writeChatAnswer,
};
interface HumanAsk {
  readonly jobId: string;
  readonly dir: string;
  readonly secret: ChatAskSecret;
  readonly record: ChatAskRecord;
  readonly controller: AbortController;
}

class RunAsks implements ChatRunAsks {
  private readonly seen = new Set<string>();
  private readonly open = new Map<string, HumanAsk>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private timer?: TimerHandle;
  private scanning = false;
  private disposed = false;

  constructor(private readonly options: RunAsksOptions) {
    this.unsubscribe = options.jobs.onChange(() => {
      this.closeEnded();
      this.schedule();
    });
    this.schedule();
  }

  private warn(cause: unknown, jobId?: string): void {
    this.options.logger.warn("chat", "[chat] Run ask processing failed", { jobId, error: errorMessage(cause) });
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (cause) {
        this.warn(cause);
      }
    }
  }

  private closeEnded(): void {
    for (const [id, ask] of this.open) {
      if (this.options.jobs.get(ask.jobId)?.state === "running") continue;
      ask.controller.abort();
      this.open.delete(id);
    }
  }

  private schedule(): void {
    if (this.disposed || this.scanning || this.timer !== undefined || !this.options.jobs.running().length) return;
    this.timer = _runAsksDeps.setTimeout(() => this.tick(), RUN_ASK_POLL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;
    this.scanning = true;
    try {
      this.closeEnded();
      for (const job of this.options.jobs.running()) {
        try {
          await this.scanJob(job);
        } catch (cause) {
          this.warn(cause, job.id);
        }
      }
    } finally {
      this.scanning = false;
      this.schedule();
    }
  }

  private active(jobId: string): boolean {
    return !this.disposed && this.options.jobs.get(jobId)?.state === "running";
  }

  private async scanJob(job: ChatJob): Promise<void> {
    const secret = this.options.jobs.askSecret?.(job.id);
    if (!secret || job.state !== "running" || !this.active(job.id)) return;
    const dir = jobAsksDir(this.options.outputDir, job.id);
    await _runAsksDeps.writeChatHeartbeat(dir, this.options.now());
    const records = await _runAsksDeps.readChatAsks(dir, secret);
    for (const record of records) {
      if (!this.active(job.id)) return;
      const id = `${job.id}/${record.key}`;
      const settled = await _runAsksDeps.readChatSettled(dir, record.key, secret);
      if (settled) {
        this.seen.add(id);
        this.open.get(id)?.controller.abort();
        this.open.delete(id);
        continue;
      }
      if (this.seen.has(id) || !this.active(job.id)) continue;
      if (await _runAsksDeps.readChatAnswer(dir, record.key, secret)) {
        this.seen.add(id);
        continue;
      }
      if (!this.active(job.id)) return;
      this.seen.add(id);
      const ask: HumanAsk = { jobId: job.id, dir, secret, record, controller: new AbortController() };
      this.open.set(id, ask);
      // Never await a human card inside the scan: other asks and heartbeats must keep moving.
      let failed = false;
      void this.showHuman(ask)
        .catch((cause) => {
          failed = true;
          this.warn(cause, job.id);
        })
        .finally(() => {
          this.open.delete(id);
          // A rejected host request (or failed delivery) may be transient. Closed
          // cards remain deduplicated; only failures of a still-live ask retry.
          if (failed && this.active(job.id) && !ask.controller.signal.aborted) this.seen.delete(id);
          this.changed();
        });
      this.changed();
    }
  }

  private async showHuman(ask: HumanAsk): Promise<void> {
    const { request } = ask.record;
    const signal = ask.controller.signal;
    const summary = `${ask.jobId}: ${request.summary}`;
    let answer: string | null;
    if (request.type === "input") {
      answer = await this.options.asks.requestHostQuestion({
        text: summary + (request.detail ? `\n${request.detail}` : ""),
        signal,
      });
    } else if (request.type === "confirm" || request.type === "choose") {
      answer = await this.options.asks.requestHostChoice({
        tool: "nax-run__ask",
        summary,
        reason: request.detail ?? request.summary,
        choices:
          request.type === "confirm"
            ? [
                { id: "approve", label: "Approve" },
                { id: "reject", label: "Deny" },
              ]
            : (request.options ?? []).map(({ key, label }) => ({ id: key, label })),
        fallback: "closed",
        signal,
      });
    } else {
      return;
    }
    if (answer === null || (request.type !== "input" && answer === "closed")) return;
    await this.deliver(ask, answer);
  }

  private async deliver(ask: HumanAsk, answer: string): Promise<void> {
    const { request, key } = ask.record;
    if (ask.controller.signal.aborted || !this.active(ask.jobId)) return;
    if (await _runAsksDeps.readChatSettled(ask.dir, key, ask.secret)) return;
    if (ask.controller.signal.aborted || !this.active(ask.jobId)) return;
    const response: ChatAnswer = {
      requestId: request.id,
      action: "input",
      value: answer,
      respondedBy: "chat-user",
      respondedAt: this.options.now().toISOString(),
    };
    if (request.type === "confirm") {
      if (answer !== "approve" && answer !== "reject") return;
      response.action = answer;
      delete response.value;
    } else if (request.type === "choose") {
      if (!request.options?.some((option) => option.key === answer)) return;
      response.action = "choose";
    }
    await _runAsksDeps.writeChatAnswer(ask.dir, key, response, ask.secret);
  }

  peekNotice(): undefined {
    return undefined;
  }
  takeNotice(): undefined {
    return undefined;
  }
  takeNotes(): readonly string[] {
    return [];
  }
  async answer(askId: string, _reply: RunAskReply): Promise<RunAskResult> {
    return { ok: false, message: `[chat] ask ${askId} is not waiting for the agent` };
  }
  noteUserTurn(): void {}
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.timer !== undefined) _runAsksDeps.clearTimeout(this.timer);
    this.timer = undefined;
    for (const ask of this.open.values()) ask.controller.abort();
    this.open.clear();
    this.listeners.clear();
  }
}

export function createRunAsks(options: RunAsksOptions): ChatRunAsks {
  return new RunAsks(options);
}
