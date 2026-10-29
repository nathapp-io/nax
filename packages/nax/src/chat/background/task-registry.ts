// Host-owned command records and bounded, machine-local logs; no session dependency.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BackgroundCommandEnd,
  BackgroundCommandHandle,
  BackgroundCommandSink,
  ForegroundCommand,
} from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";
import { buildBackgroundTaskNotice } from "@/prompts";
import { type BackgroundTask, type BackgroundTaskState, type ChatBackgroundTasks, TASK_ID_PATTERN } from "./task-types";

export const TASK_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const TASK_OUTPUT_MAX_LINES = 500;
const TASK_OUTPUT_DEFAULT_LINES = 40;
const RANDOM_HEX_LENGTH = 8;
const ID_ATTEMPTS = 16;
const LOG_LIMIT_LINE = "[nax] log limit reached; further output dropped";
const encoder = new TextEncoder();
const NEWLINE_BYTE = 10;

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
  readLog: (path: string): Promise<string> => Bun.file(path).text(),
};

interface TaskEntry {
  record: BackgroundTask;
  readonly handle: BackgroundCommandHandle;
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

class BackgroundTasks implements ChatBackgroundTasks {
  private readonly entries = new Map<string, TaskEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly foregroundCalls = new Map<symbol, ForegroundCommand>();
  private readonly completions = new Set<Promise<void>>();
  private readonly unnoticed = new Map<string, BackgroundTask>();
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

  stop(id: string): BackgroundTask {
    const entry = this.entries.get(id);
    if (entry?.record.state !== "running") {
      throw new NaxError(`[chat] task ${id} is not running`, "CHAT_TASK_NOT_RUNNING", { stage: "chat", id });
    }
    entry.record = { ...entry.record, state: "stopped" };
    entry.handle.stop();
    return { ...entry.record };
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const task of this.running()) this.stop(task.id);
    // Recheck after each batch: handles adopted during shutdown join the drain.
    while (this.completions.size > 0) await Promise.all([...this.completions]);
  }

  private newId(): string {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const id = `bash-${_backgroundTaskDeps.randomHex()}`;
      if (TASK_ID_PATTERN.test(id) && !this.entries.has(id)) return id;
    }
    throw new NaxError("[chat] could not allocate a background task id", "CHAT_TASK_ID_FAILED", { stage: "chat" });
  }

  adopt(handle: BackgroundCommandHandle): BackgroundCommandSink {
    const id = this.newId();
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
      handle,
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
    this.append(entry, encoder.encode(`${entry.endsWithNewline ? "" : "\n"}${line}\n`));
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
  async output(id: string, lines = TASK_OUTPUT_DEFAULT_LINES): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry || !Number.isFinite(lines) || lines < 1) return "";
    await entry.pending;
    try {
      const text = await _backgroundTaskDeps.readLog(entry.record.logPath);
      return text
        .replace(/\r?\n$/, "")
        .split(/\r?\n/)
        .slice(-Math.min(Math.floor(lines), TASK_OUTPUT_MAX_LINES))
        .join("\n");
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return "";
      throw new NaxError(`[chat] could not read background task ${id} log`, "CHAT_TASK_READ_FAILED", {
        stage: "chat",
        id,
        cause,
      });
    }
  }
}

export function createBackgroundTasks(options: BackgroundTaskOptions): ChatBackgroundTasks {
  return new BackgroundTasks(options);
}
