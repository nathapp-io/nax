/** Repo-scoped detached jobs. Records and log paths are machine-local. */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { buildJobNotice } from "@/prompts";
import { resolveJobOutcome } from "./job-outcome";
import { jobLogPath, jobsDir, newJobId, writeJobRecord } from "./job-store";
import type { ChatJob, ChatJobKind } from "./job-types";

export const JOB_POLL_MS = 2_000;
export const CANCEL_GRACE_MS = 10_000;
export const JOB_LOG_TAIL_LINES = 40;

export interface JobRunnerOptions {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly now: () => Date;
}
export interface StartJobRequest {
  readonly kind: ChatJobKind;
  readonly target: string;
  readonly argv: readonly string[];
  readonly sessionId: string;
  readonly approvedAt: string;
}
export interface ChatJobs {
  start(request: StartJobRequest): Promise<ChatJob>;
  /** Every job of this repo the runner knows, newest first. */
  list(): readonly ChatJob[];
  get(id: string): ChatJob | undefined;
  /** Jobs in state running, newest first. */
  running(): readonly ChatJob[];
  /** Running jobs this runner spawned (not re-attached ones). */
  owned(): readonly ChatJob[];
  /** Persists cancellation, sends SIGINT, then SIGTERM after CANCEL_GRACE_MS if still alive. */
  cancel(id: string): Promise<ChatJob>;
  /** Checks running state and owned or verified re-attached identity, without signalling. */
  canCancel(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** Loads this repo's records once; idempotent. */
  attach(): Promise<void>;
  logTail(id: string, lines?: number): Promise<string>;
  /** Oldest queued notice, left in the queue. */
  peekNotice(): string | undefined;
  /** Returns and removes the oldest queued notice. */
  takeNotice(): string | undefined;
  onChange(listener: () => void): () => void;
  /** Stops polling and timers; never kills a child. */
  dispose(): void;
}

interface OwnedChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  unref(): void;
}
interface SpawnOptions {
  cwd: string;
  detached: true;
  stdin: "ignore";
  stdout: number;
  stderr: number;
}
export const _jobRunnerDeps = {
  spawn: (argv: readonly string[], options: SpawnOptions): OwnedChild => Bun.spawn([...argv], options),
  kill: (pid: number, signal: NodeJS.Signals): boolean => process.kill(pid, signal),
  isProcessAlive: (pid: number): boolean => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    } // Dead or inaccessible PID.
  },
  // Cancellable timers for polling and cancellation escalation (US-006/007).
  setTimeout: (callback: () => void, ms: number): ReturnType<typeof setTimeout> | number =>
    globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number): void => globalThis.clearTimeout(handle),
  openLog: (path: string): number => openSync(path, "a"),
  closeLog: (fd: number): void => closeSync(fd),
  mkdir: mkdirSync,
};

class DetachedJobs implements ChatJobs {
  private readonly records = new Map<string, ChatJob>();
  private readonly ownedIds = new Set<string>();
  private readonly notices: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: JobRunnerOptions) {}

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (cause) {
        this.warn(cause);
      }
    }
  }
  private warn(cause: unknown): void {
    getLogger()?.warn("chat", "Job lifecycle callback failed", { error: errorMessage(cause) });
  }
  private spawn(request: StartJobRequest, logPath: string): OwnedChild {
    _jobRunnerDeps.mkdir(jobsDir(this.options.outputDir), { recursive: true });
    const fd = _jobRunnerDeps.openLog(logPath);
    try {
      return _jobRunnerDeps.spawn(request.argv, {
        cwd: this.options.repoRoot,
        detached: true,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
      });
    } finally {
      _jobRunnerDeps.closeLog(fd);
    }
  }
  async start(request: StartJobRequest): Promise<ChatJob> {
    try {
      const id = newJobId(request.kind);
      const logPath = jobLogPath(this.options.outputDir, id);
      const child = this.spawn(request, logPath);
      const job: ChatJob = {
        ...request,
        argv: [...request.argv],
        schemaVersion: 1,
        id,
        logPath,
        cwd: this.options.repoRoot,
        pid: child.pid,
        startedAt: this.options.now().toISOString(),
        state: "running",
      };
      this.records.set(id, job);
      this.ownedIds.add(id);
      child.unref();
      // Observe exits immediately, but serialize terminal persistence after the initial write.
      const saved: Promise<void> = writeJobRecord(this.options.outputDir, job);
      void Promise.all([saved, child.exited])
        .then(([, code]) => this.finalize(job, code))
        .catch((cause) => this.warn(cause));
      await saved;
      this.emit();
      return structuredClone(job);
    } catch (cause) {
      throw new NaxError(
        `[chat] could not start nax ${request.kind}: ${errorMessage(cause)}`,
        "CHAT_JOB_SPAWN_FAILED",
        { stage: "chat", cause },
      );
    }
  }
  private async finalize(job: ChatJob, exitCode: number): Promise<void> {
    const outcome = await resolveJobOutcome(job, { exitCode }, this.options.repoRoot);
    const terminal: ChatJob = { ...job, ...outcome, exitCode, endedAt: this.options.now().toISOString() };
    await writeJobRecord(this.options.outputDir, terminal);
    this.records.set(job.id, terminal);
    this.ownedIds.delete(job.id);
    this.notices.push(buildJobNotice(terminal));
    this.emit();
  }
  list(): readonly ChatJob[] {
    return [...this.records.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((job) => structuredClone(job));
  }
  get(id: string): ChatJob | undefined {
    return this.list().find((job) => job.id === id);
  }
  running(): readonly ChatJob[] {
    return this.list().filter((job) => job.state === "running");
  }
  owned(): readonly ChatJob[] {
    return this.running().filter((job) => this.ownedIds.has(job.id));
  }
  peekNotice(): string | undefined {
    return this.notices[0];
  }
  takeNotice(): string | undefined {
    return this.notices.shift();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async cancel(id: string): Promise<ChatJob> {
    throw new NaxError(`[chat] job ${id} is not running`, "CHAT_JOB_NOT_RUNNING", { stage: "chat" });
  }
  async canCancel(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    throw new NaxError(`[chat] job ${id} is not running`, "CHAT_JOB_NOT_RUNNING", { stage: "chat" });
  }
  // Implemented in US-006; intentionally no store reads, polling or shutdown work yet.
  async attach(): Promise<void> {}
  async logTail(_id: string, _lines = JOB_LOG_TAIL_LINES): Promise<string> {
    return "";
  }
  dispose(): void {}
}

export function createJobRunner(options: JobRunnerOptions): ChatJobs {
  return new DetachedJobs(options);
}
