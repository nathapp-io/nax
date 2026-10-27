/** Repo-scoped detached jobs. Records and log paths are machine-local. */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { buildJobNotice } from "@/prompts";
import { readRunProgress, resolveJobOutcome } from "./job-outcome";
import { jobLogPath, jobsDir, newJobId, readJobRecords, writeJobRecord } from "./job-store";
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
  /** A launched child remains managed on record-write failure; the returned note warns not to retry. */
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
  // nax-git-env-allow: launches the nax CLI, not git; Git subprocesses harden their own environment.
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
  readLog: (path: string): Promise<string> => Bun.file(path).text(),
};

class DetachedJobs implements ChatJobs {
  private readonly records = new Map<string, ChatJob>();
  private readonly ownedIds = new Set<string>();
  private readonly notices: string[] = [];
  private readonly listeners = new Set<() => void>();
  private attachment?: Promise<void>;
  private pollTimer?: ReturnType<typeof setTimeout> | number;
  private polling = false;
  private disposed = false;

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
  // nax-git-env-allow: helper declaration for detached nax CLI launches, not a Git invocation.
  private spawn(request: StartJobRequest, logPath: string): OwnedChild {
    _jobRunnerDeps.mkdir(jobsDir(this.options.outputDir), { recursive: true });
    const fd = _jobRunnerDeps.openLog(logPath);
    try {
      // nax-git-env-allow: request.argv invokes nax plan/run/bot, not git.
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
    const id = newJobId(request.kind);
    const logPath = jobLogPath(this.options.outputDir, id);
    let child: OwnedChild;
    try {
      // nax-git-env-allow: forwards a nax CLI job to the detached-launch helper, not git.
      child = this.spawn(request, logPath);
    } catch (cause) {
      throw new NaxError(
        `[chat] could not start nax ${request.kind}: ${errorMessage(cause)}`,
        "CHAT_JOB_SPAWN_FAILED",
        { stage: "chat", cause },
      );
    }
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
    this.syncPoll();
    child.unref();
    // Failure to save does not undo a launch or detach its exit observer.
    const saved: Promise<ChatJob> = this.persistRunning(job);
    void Promise.all([saved, child.exited])
      .then(([, code]) => this.finalize(job, code))
      .catch((cause) => this.warn(cause));
    const tracked = await saved;
    this.emit();
    return structuredClone(tracked);
  }
  private async persistRunning(job: ChatJob): Promise<ChatJob> {
    try {
      await writeJobRecord(this.options.outputDir, job);
      return job;
    } catch (cause) {
      const note = `job ${job.id} started (pid ${job.pid}), but its running record could not be saved; do not retry; keep this chat open to track it`;
      const tracked: ChatJob = { ...job, note };
      this.records.set(job.id, tracked);
      getLogger()?.warn("chat", note, { id: job.id, pid: job.pid, error: errorMessage(cause) });
      return tracked;
    }
  }
  private async finalize(job: ChatJob, exitCode: number): Promise<void> {
    const current = this.records.get(job.id) ?? job;
    const outcome = await resolveJobOutcome(current, { exitCode }, this.options.repoRoot);
    const terminal: ChatJob = { ...current, ...outcome, exitCode, endedAt: this.options.now().toISOString() };
    await writeJobRecord(this.options.outputDir, terminal);
    this.records.set(job.id, terminal);
    this.ownedIds.delete(job.id);
    this.syncPoll();
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
  attach(): Promise<void> {
    this.attachment ??= this.loadRecords();
    return this.attachment;
  }
  private async loadRecords(): Promise<void> {
    const records = await readJobRecords(this.options.outputDir);
    for (const job of records) {
      if (job.cwd !== this.options.repoRoot || this.records.has(job.id)) continue;
      this.records.set(job.id, job);
      if (job.state === "running" && !_jobRunnerDeps.isProcessAlive(job.pid)) {
        await this.finalizeAttached(job, false);
      }
    }
    this.syncPoll();
    this.emit();
  }
  private async finalizeAttached(job: ChatJob, notify: boolean): Promise<void> {
    const disk = (await readJobRecords(this.options.outputDir)).find(
      (record) => record.id === job.id && record.cwd === this.options.repoRoot,
    );
    if (disk && disk.state !== "running") {
      this.records.set(job.id, disk);
    } else {
      const outcome = await resolveJobOutcome(job, {}, this.options.repoRoot);
      const terminal: ChatJob = { ...job, ...outcome, endedAt: this.options.now().toISOString() };
      await writeJobRecord(this.options.outputDir, terminal);
      this.records.set(job.id, terminal);
      if (notify) this.notices.push(buildJobNotice(terminal));
    }
    this.emit();
  }
  private syncPoll(): void {
    if (this.disposed || this.running().length === 0) {
      if (this.pollTimer !== undefined) _jobRunnerDeps.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      return;
    }
    if (this.pollTimer !== undefined || this.polling) return;
    // Cancellable UI cadence: dispose and the last terminal transition clear this handle.
    this.pollTimer = _jobRunnerDeps.setTimeout(() => {
      this.pollTimer = undefined;
      this.polling = true;
      void this.poll()
        .finally(() => {
          this.polling = false;
          this.syncPoll();
        })
        .catch((cause) => this.warn(cause));
    }, JOB_POLL_MS);
  }
  private async poll(): Promise<void> {
    for (const job of this.running()) {
      if (this.disposed) break;
      try {
        if (!this.ownedIds.has(job.id) && !_jobRunnerDeps.isProcessAlive(job.pid)) {
          await this.finalizeAttached(job, true);
        } else if (job.kind === "run") {
          await this.refreshProgress(job);
        }
      } catch (cause) {
        this.warn(cause);
      }
    }
  }
  private async refreshProgress(job: ChatJob): Promise<void> {
    const metrics = await readRunProgress(job, this.options.repoRoot);
    const current = this.records.get(job.id);
    if (this.disposed || current?.state !== "running" || !metrics) return;
    if (
      current.cost === metrics.cost &&
      current.progress?.passed === metrics.progress.passed &&
      current.progress?.total === metrics.progress.total
    )
      return;
    this.records.set(job.id, { ...current, ...metrics });
    this.emit();
  }
  async logTail(id: string, lines = JOB_LOG_TAIL_LINES): Promise<string> {
    const job = this.records.get(id);
    if (!job || !Number.isFinite(lines) || lines < 1) return "";
    try {
      const text = await _jobRunnerDeps.readLog(job.logPath);
      return text
        .replace(/\r?\n$/, "")
        .split(/\r?\n/)
        .slice(-Math.floor(lines))
        .join("\n");
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return "";
      throw cause;
    }
  }
  dispose(): void {
    this.disposed = true;
    this.syncPoll();
  }
}

export function createJobRunner(options: JobRunnerOptions): ChatJobs {
  return new DetachedJobs(options);
}
