import { errorMessage } from "@nathapp/nax-agent/internal";
import {
  type ChatAnswer,
  type ChatAskRecord,
  type ChatAskSecret,
  type ChatSettled,
  RUN_ASK_POLL_MS,
  readChatAnswer,
  readChatAsks,
  readChatSettled,
  removeChatHeartbeat,
  takeChatNotices,
  writeChatAnswer,
  writeChatHeartbeat,
} from "@/interaction";
import type { Logger } from "@/logger";
import { buildRunAskNotice } from "@/prompts";
import type { ChatAskController } from "../ask-controller";
import type { ChatChains } from "./chain-controller";
import type { ChatJobs } from "./job-runner";
import { jobAsksDir } from "./job-store";
import type { ChatJob } from "./job-types";
import { agentResponse } from "./run-ask-answer";
import { routeRunAsk } from "./run-ask-route";

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
  readonly jobs: Pick<ChatJobs, "running" | "get" | "onChange"> & Partial<Pick<ChatJobs, "askSecret">>;
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
  removeChatHeartbeat,
  takeChatNotices,
  readChatAnswer,
  writeChatHeartbeat,
  writeChatAnswer,
};
interface PendingAsk {
  readonly jobId: string;
  readonly dir: string;
  readonly secret: ChatAskSecret;
  readonly record: ChatAskRecord;
  readonly controller: AbortController;
}

class RunAsks implements ChatRunAsks {
  private agentStreak = 0;
  private readonly agentWaiting = new Set<string>();
  private readonly answering = new Set<string>();
  private readonly notices = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly settledSeen = new Set<string>();
  private readonly invalidFiles = new Set<string>();
  private readonly notes: string[] = [];
  private readonly lifetime = new AbortController();
  private readonly open = new Map<string, PendingAsk>();
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

  private note(line: string): void {
    if (this.disposed) return;
    this.notes.push(line);
    this.changed();
  }

  private readonly invalid = (path: string): void => {
    if (this.disposed || this.invalidFiles.has(path)) return;
    this.invalidFiles.add(path);
    this.options.logger.warn("chat", "[chat] Ignoring malformed run ask record", { path });
  };

  private recordSettlement(id: string, ask: ChatAskRecord, settled: ChatSettled): void {
    this.open.get(id)?.controller.abort();
    this.open.delete(id);
    this.removeAgent(id);
    this.seen.add(id);
    if (this.settledSeen.has(id)) return;
    this.settledSeen.add(id);
    if (["chat-user", "chat-agent", "cancelled"].includes(settled.by)) return;
    const jobId = id.slice(0, id.indexOf("/"));
    this.note(
      settled.by === "timeout"
        ? `[${jobId}] ask timed out: ${ask.request.summary}`
        : `[${jobId}] ask settled by ${settled.by}: ${settled.value ?? settled.action}`,
    );
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
      this.removeAgent(id);
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
    await _runAsksDeps.writeChatHeartbeat(dir, this.options.now(), this.lifetime.signal);
    if (!this.active(job.id)) return;
    const records = await _runAsksDeps.readChatAsks(dir, secret, this.invalid);
    if (!this.active(job.id)) return;
    const notices = await _runAsksDeps.takeChatNotices(dir, secret, this.invalid);
    if (!this.active(job.id)) return;
    for (const notice of notices) this.note(`[${job.id}] ${notice.request.summary}`);
    for (const record of records) {
      if (!this.active(job.id)) return;
      const id = `${job.id}/${record.key}`;
      const settled = await _runAsksDeps.readChatSettled(dir, record.key, secret, this.invalid);
      if (!this.active(job.id)) return;
      if (settled) {
        this.recordSettlement(id, record, settled);
        continue;
      }
      if (this.seen.has(id) || !this.active(job.id)) continue;
      if (await _runAsksDeps.readChatAnswer(dir, record.key, secret)) {
        this.seen.add(id);
        continue;
      }
      if (!this.active(job.id)) return;
      this.seen.add(id);
      const ask: PendingAsk = { jobId: job.id, dir, secret, record, controller: new AbortController() };
      this.open.set(id, ask);
      const route = routeRunAsk({
        job,
        request: record.request,
        chainActive: !!job.chainId && this.options.chains.isActive(job.chainId),
        agentStreak: this.agentStreak,
      });
      if (route === "human") this.launchHuman(id, ask);
      else {
        this.agentStreak++;
        this.agentWaiting.add(id);
        this.notices.set(id, buildRunAskNotice(id, record.request));
        this.changed();
      }
    }
  }

  private launchHuman(id: string, ask: PendingAsk): void {
    // Never await a human card inside the scan: other asks and heartbeats must keep moving.
    let failed = false;
    void this.showHuman(ask)
      .catch((cause) => {
        failed = true;
        this.warn(cause, ask.jobId);
      })
      .finally(() => {
        this.open.delete(id);
        // Retry transient host/delivery failures only while this ask is live.
        if (failed && this.active(ask.jobId) && !ask.controller.signal.aborted) this.seen.delete(id);
        this.changed();
      });
    this.changed();
  }

  private async showHuman(ask: PendingAsk): Promise<void> {
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

  private async deliver(ask: PendingAsk, answer: string): Promise<void> {
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
    try {
      await _runAsksDeps.writeChatAnswer(ask.dir, key, response, ask.secret, ask.controller.signal);
    } catch (cause) {
      this.note(`[${ask.jobId}] could not deliver your answer for ${ask.jobId}/${key}`);
      throw cause;
    }
  }

  private removeAgent(id: string): void {
    this.agentWaiting.delete(id);
    if (this.notices.delete(id)) this.changed();
  }

  peekNotice(): string | undefined {
    return this.notices.values().next().value;
  }
  takeNotice(): string | undefined {
    const head = this.notices.entries().next().value;
    if (!head) return undefined;
    this.notices.delete(head[0]);
    this.changed();
    return head[1];
  }
  takeNotes(): readonly string[] {
    return this.notes.splice(0);
  }
  async answer(askId: string, reply: RunAskReply): Promise<RunAskResult> {
    const unavailable: RunAskResult = { ok: false, message: `[chat] ask ${askId} is not waiting for the agent` };
    const ask = this.open.get(askId);
    if (!ask || !this.agentWaiting.has(askId) || this.answering.has(askId) || !this.active(ask.jobId))
      return unavailable;
    this.answering.add(askId);
    try {
      const settled = await _runAsksDeps.readChatSettled(ask.dir, ask.record.key, ask.secret);
      const answered = await _runAsksDeps.readChatAnswer(ask.dir, ask.record.key, ask.secret);
      if (settled) this.recordSettlement(askId, ask.record, settled);
      if (settled || answered || !this.active(ask.jobId) || !this.agentWaiting.has(askId)) {
        this.removeAgent(askId);
        return unavailable;
      }
      if (reply.answer === "escalate") {
        this.removeAgent(askId);
        this.launchHuman(askId, ask);
        return { ok: true };
      }
      const response = agentResponse(ask.record, reply, this.options.now());
      if (!response) return { ok: false, message: `[chat] invalid answer for ${askId}` };
      await _runAsksDeps.writeChatAnswer(ask.dir, ask.record.key, response, ask.secret, ask.controller.signal);
      if (!this.active(ask.jobId) || ask.controller.signal.aborted) return unavailable;
      this.removeAgent(askId);
      this.open.delete(askId);
      this.note(`[${ask.jobId}] agent answered ${reply.answer}: ${reply.reason}`);
      return { ok: true };
    } catch (cause) {
      this.warn(cause, ask.jobId);
      return { ok: false, message: `[chat] could not write the answer for ${askId}` };
    } finally {
      this.answering.delete(askId);
    }
  }
  noteUserTurn(): void {
    this.agentStreak = 0;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    for (const job of this.options.jobs.running()) {
      if (!this.options.jobs.askSecret?.(job.id)) continue;
      void _runAsksDeps
        .removeChatHeartbeat(jobAsksDir(this.options.outputDir, job.id))
        .catch((cause) => this.warn(cause, job.id));
    }
    this.unsubscribe();
    if (this.timer !== undefined) _runAsksDeps.clearTimeout(this.timer);
    this.timer = undefined;
    for (const ask of this.open.values()) ask.controller.abort();
    this.open.clear();
    this.agentWaiting.clear();
    this.notices.clear();
    this.listeners.clear();
  }
}

export function createRunAsks(options: RunAsksOptions): ChatRunAsks {
  return new RunAsks(options);
}
