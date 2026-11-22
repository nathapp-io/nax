// Host-owned command records and bounded, machine-local logs; no session dependency.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BackgroundCommandEnd,
  BackgroundCommandHandle,
  BackgroundCommandSink,
  ForegroundCommand,
  SessionEvent,
} from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";
import { buildBackgroundTaskNotice } from "@/prompts";
import {
  createTaskEventLog,
  TASK_EVENTS_TOTAL_MAX_BYTES,
  TASK_EVENTS_TOTAL_MAX_ENTRIES,
  type TaskEventLog,
} from "./task-events";
import {
  type BackgroundAgentEnd,
  type BackgroundAgentHandle,
  type BackgroundAgentRun,
  type BackgroundAgentSink,
  type BackgroundTask,
  type BackgroundTaskState,
  type ChatBackgroundTasks,
  TASK_ID_PATTERN,
  type TaskOutputOptions,
} from "./task-types";

export const TASK_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const TASK_LOG_TAIL_BYTES = 2 * 1024 * 1024;
export const TASK_OUTPUT_MAX_LINES = 500;
const TASK_OUTPUT_DEFAULT_LINES = 40;
const RANDOM_HEX_LENGTH = 8;
const ID_ATTEMPTS = 16;
const LOG_LIMIT_LINE = "[nax] log limit reached; further output dropped";
/** The task's own first line is all a command, a notice and a footer row can show. */
const TASK_COMMAND_TASK_LIMIT = 80;
/** A task's line breaks: a `\r\n` first line must not leave a stray `\r` in a record or a log line. */
const TASK_LINE_BREAK = /\r\n|\n/;
const encoder = new TextEncoder();
const NEWLINE_BYTE = 10;

/** The first line of a subagent task; a task written on one line keeps all of it. */
function taskFirstLine(task: string): string {
  return task.split(TASK_LINE_BREAK)[0] ?? "";
}

function truncateTaskLine(line: string): string {
  return line.length > TASK_COMMAND_TASK_LIMIT ? line.slice(0, TASK_COMMAND_TASK_LIMIT) : line;
}

async function readLogTail(path: string): Promise<string> {
  const file = Bun.file(path);
  if (file.size <= TASK_LOG_TAIL_BYTES) return file.text();
  const start = file.size - TASK_LOG_TAIL_BYTES;
  const previous = new Uint8Array(await file.slice(start - 1, start).arrayBuffer());
  let tail = new Uint8Array(await file.slice(start).arrayBuffer());
  if (previous[0] !== NEWLINE_BYTE) {
    const newline = tail.indexOf(NEWLINE_BYTE);
    if (newline !== -1) tail = tail.slice(newline + 1);
  }
  return new TextDecoder().decode(tail);
}

export const _backgroundTaskDeps = {
  randomHex: (): string => crypto.randomUUID().slice(0, RANDOM_HEX_LENGTH),
  mkdir: (path: string): void => {
    mkdirSync(path, { recursive: true });
  },
  // Bun.write truncates and Bun has no O_APPEND API. A short-lived append fd
  // avoids retaining a FileSink for every ended task (same carve-out as runtime auditors).
  appendLog: async (path: string, chunk: Uint8Array): Promise<void> => {
    appendFileSync(path, chunk);
  },
  readLog: readLogTail,
  /** The limits on events retained across all agent tasks; a seam so a test need not record thousands. */
  eventLimits: { entries: TASK_EVENTS_TOTAL_MAX_ENTRIES, bytes: TASK_EVENTS_TOTAL_MAX_BYTES },
};

/** What only an agent task keeps beyond its record: the view's inputs. */
interface AgentDetail {
  readonly agent: string;
  readonly model?: string;
  readonly prompt: string;
  readonly events: TaskEventLog;
}

interface TaskEntry {
  record: BackgroundTask;
  /** Set for an agent task; its event log goes with the entry when the entry does. */
  readonly detail?: AgentDetail;
  /** Both a command's and an agent run's handle expose only this to the registry. */
  readonly stop: () => void;
  pending: Promise<void>;
  bytes: number;
  endsWithNewline: boolean;
  capped: boolean;
  logFailed: boolean;
}
interface BackgroundTaskOptions {
  readonly outputDir: string;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

function terminalState(end: BackgroundCommandEnd): BackgroundTaskState {
  if (end.aborted) return "stopped";
  if (end.launchError !== undefined) return "failed";
  return end.exitCode === 0 && !end.timedOut ? "succeeded" : "failed";
}

/** A log reaped before it was read is an empty output, not a read failure. */
function isMissingLog(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

class BackgroundTasks implements ChatBackgroundTasks {
  private readonly entries = new Map<string, TaskEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(id: string) => void>();
  private readonly foregroundCalls = new Map<symbol, ForegroundCommand>();
  private readonly completions = new Set<Promise<void>>();
  private readonly unnoticed = new Map<string, BackgroundTask>();
  /** Entries and estimated bytes held by every agent log that has not been evicted. */
  private retained = { entries: 0, bytes: 0 };
  /** Finished agent tasks whose log is still held, in the order they finished: the eviction queue. */
  private readonly finishedLogs: TaskEntry[] = [];
  private notice?: { ids: readonly string[]; text: string };
  private shuttingDown = false;
  constructor(private readonly options: BackgroundTaskOptions) {}

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (cause) {
        this.options.logger.warn("chat", "Background task lifecycle callback failed", { error: errorMessage(cause) });
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onAgentEvents(listener: (id: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  agentRun(id: string): BackgroundAgentRun | undefined {
    const entry = this.entries.get(id);
    const detail = entry?.detail;
    if (entry === undefined || detail === undefined) return undefined;
    return {
      id,
      agent: detail.agent,
      ...(detail.model !== undefined ? { model: detail.model } : {}),
      prompt: detail.prompt,
      state: entry.record.state,
      logRetained: !detail.events.evicted(),
      events: detail.events.snapshot(),
    };
  }

  /**
   * Keep the events retained across every agent task under the total limits: while over, drop
   * the log of the oldest FINISHED task that still has one. Its record and state stay; only its
   * conversation goes. A running task is never evicted, so a chat of running tasks is bounded by
   * the per-task caps alone.
   */
  private enforceEventLimits(): void {
    const { entries: maxEntries, bytes: maxBytes } = _backgroundTaskDeps.eventLimits;
    while (this.retained.entries > maxEntries || this.retained.bytes > maxBytes) {
      const oldest = this.finishedLogs.shift();
      if (oldest === undefined) return;
      this.evictLog(oldest);
    }
  }

  /** Drop one finished task's log, keep the running totals exact and tell the listeners. */
  private evictLog(entry: TaskEntry): void {
    const events = entry.detail?.events;
    if (events === undefined || events.evicted()) return;
    this.addRetained(events.size(), -1);
    events.evict();
    this.notifyEvents(entry.record.id);
  }

  private addRetained(size: { readonly entries: number; readonly bytes: number }, sign: 1 | -1): void {
    this.retained = {
      entries: this.retained.entries + sign * size.entries,
      bytes: this.retained.bytes + sign * size.bytes,
    };
  }

  private notifyEvents(id: string): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(id);
      } catch (cause) {
        this.options.logger.warn("chat", "Background task event callback failed", { error: errorMessage(cause) });
      }
    }
  }

  private recordEvent(entry: TaskEntry, event: SessionEvent): void {
    if (entry.record.state !== "running" || entry.detail === undefined) return;
    const log = entry.detail.events;
    const before = log.size();
    log.append(event);
    // The totals move by this log's size change alone, so an event costs O(1), not a recount.
    const after = log.size();
    this.addRetained({ entries: after.entries - before.entries, bytes: after.bytes - before.bytes }, 1);
    this.enforceEventLimits();
    this.notifyEvents(entry.record.id);
  }

  foreground(call: ForegroundCommand): () => void {
    const key = Symbol();
    this.foregroundCalls.set(key, call);
    this.emit();
    return () => {
      if (this.foregroundCalls.delete(key)) this.emit();
    };
  }

  hasForeground(): boolean {
    return this.foregroundCalls.size > 0;
  }

  moveForeground(): boolean {
    const call = [...this.foregroundCalls.values()].at(-1);
    if (!call) return false;
    call.moveToBackground();
    return true;
  }

  peekNotice(): string | undefined {
    if (!this.notice && this.unnoticed.size > 0) {
      this.notice = {
        ids: [...this.unnoticed.keys()],
        text: buildBackgroundTaskNotice([...this.unnoticed.values()]),
      };
    }
    return this.notice?.text;
  }

  takeNotice(): string | undefined {
    const text = this.peekNotice();
    for (const id of this.notice?.ids ?? []) this.unnoticed.delete(id);
    this.notice = undefined;
    return text;
  }

  releaseNotice(): void {
    this.notice = undefined;
  }

  stop(id: string): BackgroundTask {
    const entry = this.entries.get(id);
    if (entry?.record.state !== "running") {
      throw new NaxError(`[chat] task ${id} is not running`, "CHAT_TASK_NOT_RUNNING", { stage: "chat", id });
    }
    entry.record = { ...entry.record, state: "stopped" };
    entry.stop();
    return { ...entry.record };
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const task of this.running()) this.stop(task.id);
    // Recheck after each batch: handles adopted during shutdown join the drain.
    while (this.completions.size > 0) await Promise.all([...this.completions]);
  }

  private newId(prefix: "bash" | "agent"): string {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const id = `${prefix}-${_backgroundTaskDeps.randomHex()}`;
      if (TASK_ID_PATTERN.test(id) && !this.entries.has(id)) return id;
    }
    throw new NaxError("[chat] could not allocate a background task id", "CHAT_TASK_ID_FAILED", { stage: "chat" });
  }

  adopt(handle: BackgroundCommandHandle): BackgroundCommandSink {
    const id = this.newId("bash");
    const entry: TaskEntry = {
      record: {
        id,
        command: handle.command,
        description: handle.description,
        origin: handle.origin,
        startedAt: this.options.now().toISOString(),
        state: "running",
        logPath: join(this.options.outputDir, "chat-tasks", `${id}.log`),
      },
      stop: () => handle.stop(),
      pending: Promise.resolve(),
      bytes: 0,
      endsWithNewline: true,
      capped: false,
      logFailed: false,
    };
    this.entries.set(id, entry);
    this.enqueue(entry, () => _backgroundTaskDeps.mkdir(join(this.options.outputDir, "chat-tasks")));
    const completion = handle.ended.then((end) => {
      this.finalize(entry, end);
      this.completions.delete(completion);
    });
    this.completions.add(completion);
    if (this.shuttingDown) this.stop(id);
    this.emit();
    return {
      id,
      append: (_stream, chunk) => {
        if (entry.record.state === "running") this.append(entry, chunk);
      },
    };
  }

  adoptAgent(handle: BackgroundAgentHandle): BackgroundAgentSink {
    const id = this.newId("agent");
    const first = taskFirstLine(handle.task);
    const entry: TaskEntry = {
      detail: {
        agent: handle.agent,
        ...(handle.model !== undefined ? { model: handle.model } : {}),
        prompt: handle.task,
        events: createTaskEventLog(),
      },
      record: {
        id,
        kind: "agent",
        command: `${handle.agent}: ${truncateTaskLine(first)}`,
        origin: "agent",
        startedAt: this.options.now().toISOString(),
        state: "running",
        logPath: join(this.options.outputDir, "chat-tasks", `${id}.log`),
      },
      stop: () => handle.stop(),
      pending: Promise.resolve(),
      bytes: 0,
      endsWithNewline: true,
      capped: false,
      logFailed: false,
    };
    this.entries.set(id, entry);
    this.enqueue(entry, () => _backgroundTaskDeps.mkdir(join(this.options.outputDir, "chat-tasks")));
    this.appendLine(entry, `[nax] agent ${handle.agent}: ${first}`);
    const completion = handle.ended.then((end) => {
      this.finalizeAgent(entry, end);
      this.completions.delete(completion);
    });
    this.completions.add(completion);
    if (this.shuttingDown) this.stop(id);
    this.emit();
    return {
      id,
      appendLine: (line) => {
        if (entry.record.state === "running") this.appendLine(entry, line);
      },
      record: (event) => this.recordEvent(entry, event),
    };
  }

  private enqueue(entry: TaskEntry, action: () => void | Promise<void>): void {
    entry.pending = entry.pending
      .then(async () => {
        if (!entry.logFailed) await action();
      })
      .catch((cause: unknown) => {
        if (entry.logFailed) return;
        entry.logFailed = true;
        this.options.logger.warn("chat", "Background task logging failed; further output dropped", {
          id: entry.record.id,
          logPath: entry.record.logPath,
          error: errorMessage(cause),
        });
      });
  }

  private append(entry: TaskEntry, chunk: Uint8Array): void {
    if (entry.logFailed || entry.capped || chunk.byteLength === 0) return;
    // Reserve and copy only admitted bytes synchronously: queued writes cannot
    // bypass the cap, nor retain unbounded chunks while the disk is slow.
    const bytes = chunk.slice(0, TASK_LOG_MAX_BYTES - entry.bytes);
    entry.bytes += bytes.byteLength;
    entry.endsWithNewline = bytes[bytes.byteLength - 1] === NEWLINE_BYTE;
    this.enqueue(entry, () => _backgroundTaskDeps.appendLog(entry.record.logPath, bytes));
    if (entry.bytes === TASK_LOG_MAX_BYTES) {
      entry.capped = true;
      const marker = encoder.encode(`${entry.endsWithNewline ? "" : "\n"}${LOG_LIMIT_LINE}\n`);
      this.enqueue(entry, () => _backgroundTaskDeps.appendLog(entry.record.logPath, marker));
    }
  }

  /** One whole log line, separating it from a previous write that did not end in a newline. */
  private appendLine(entry: TaskEntry, line: string): void {
    this.append(entry, encoder.encode(`${entry.endsWithNewline ? "" : "\n"}${line}\n`));
  }

  private finalize(entry: TaskEntry, end: BackgroundCommandEnd): void {
    entry.record = {
      ...entry.record,
      state: entry.record.state === "stopped" ? "stopped" : terminalState(end),
      endedAt: this.options.now().toISOString(),
      exitCode: end.exitCode,
      ...(end.launchError !== undefined ? { note: end.launchError } : {}),
    };
    const line =
      end.launchError !== undefined ? `[nax] launch failed: ${end.launchError}` : `[nax] exit code ${end.exitCode}`;
    this.appendLine(entry, line);
    if (entry.record.state === "succeeded" || entry.record.state === "failed") {
      this.unnoticed.set(entry.record.id, entry.record);
    }
    this.emit();
  }

  /** A subagent run has an outcome and its text, never an exit code. */
  private finalizeAgent(entry: TaskEntry, end: BackgroundAgentEnd): void {
    entry.record = {
      ...entry.record,
      state: entry.record.state === "stopped" ? "stopped" : end.outcome,
      endedAt: this.options.now().toISOString(),
    };
    if (end.text.trimEnd() !== "") this.appendLine(entry, end.text.trimEnd());
    this.appendLine(entry, `[nax] agent ended: ${end.outcome}`);
    // This task just became evictable, behind every task that finished before it.
    this.finishedLogs.push(entry);
    this.enforceEventLimits();
    if (entry.record.state === "succeeded" || entry.record.state === "failed") {
      this.unnoticed.set(entry.record.id, entry.record);
    }
    this.emit();
  }

  list(): readonly BackgroundTask[] {
    // Reverse insertion order also makes equal-timestamp adoptions newest first.
    return [...this.entries.values()].reverse().map(({ record }) => ({ ...record }));
  }
  get(id: string): BackgroundTask | undefined {
    const record = this.entries.get(id)?.record;
    return record ? { ...record } : undefined;
  }
  running(): readonly BackgroundTask[] {
    return this.list().filter((task) => task.state === "running");
  }
  async output(id: string, lines = TASK_OUTPUT_DEFAULT_LINES, options?: TaskOutputOptions): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry || !Number.isFinite(lines) || lines < 1) return "";
    // Sampled before the first await: a read reports the state the caller was served.
    const endedBeforeRead = entry.record.state === "succeeded" || entry.record.state === "failed";
    await entry.pending;
    try {
      const text = await _backgroundTaskDeps.readLog(entry.record.logPath);
      this.markSeen(id, endedBeforeRead, options);
      return text
        .replace(/\r?\n$/, "")
        .split(/\r?\n/)
        .slice(-Math.min(Math.floor(lines), TASK_OUTPUT_MAX_LINES))
        .join("\n");
    } catch (cause) {
      if (isMissingLog(cause)) {
        this.markSeen(id, endedBeforeRead, options);
        return "";
      }
      throw new NaxError(`[chat] could not read background task ${id} log`, "CHAT_TASK_READ_FAILED", {
        stage: "chat",
        id,
        cause,
      });
    }
  }

  /** A read of a task that had already ended satisfies the notice that was queued for it. */
  private markSeen(id: string, endedBeforeRead: boolean, options?: TaskOutputOptions): void {
    if (options?.markSeen !== true || !endedBeforeRead) return;
    // A task in the snapshot is the notice a delivery or an accepted steer is holding right
    // now; every other peek releases it, so only a notice that was really taken is protected.
    if (this.notice?.ids.includes(id)) return;
    this.unnoticed.delete(id);
  }
}

export function createBackgroundTasks(options: BackgroundTaskOptions): ChatBackgroundTasks {
  return new BackgroundTasks(options);
}
