/**
 * Opt-in memory instrumentation for `nax chat` (#2846).
 *
 * A long chat session once reached 16 GB RSS with nothing on disk to say whether the JS heap
 * or native memory grew, nor when. With `NAX_CHAT_MEMLOG` set, this sampler appends one JSONL
 * line per interval carrying `process.memoryUsage()` and the JSC heap's own numbers
 * (`bun:jsc` `heapStats()`), so a reader can tell the two apart: `rss` climbing while
 * `jsc.heapSize` stays flat is native or allocator memory; both climbing is a JS retention.
 *
 * While it runs, SIGUSR2 writes a V8-format heap snapshot beside the log for Chrome
 * DevTools, so two snapshots taken apart can name what is retained. Generating one is
 * synchronous: the chat freezes while it is built and the snapshot string costs memory on
 * the order of the heap itself, so a heap above `MEMLOG_SNAPSHOT_MAX_HEAP_BYTES` is refused
 * (a `snapshot-skipped` line) and a `snapshot-begin` line is written first, so a chat that
 * dies building one says why. Snapshots hold prompts, file contents and credentials: the
 * directory is created 0700 and every file 0600.
 *
 * Off by default: nothing is armed and no signal handler is installed. The sampler never
 * throws into the chat and never writes to the terminal, which the chat screen owns: a
 * failure is queued once per kind and handed back by `stop()` for the caller to print after
 * the screen is gone.
 */

import { heapStats } from "bun:jsc";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";

export const MEMLOG_ENV = "NAX_CHAT_MEMLOG";
export const DEFAULT_MEMLOG_INTERVAL_SECONDS = 60;
/** Below this, `heapStats()` walking the whole heap starts to cost the chat itself. */
export const MIN_MEMLOG_INTERVAL_SECONDS = 5;
/** One day. A timer delay past 2^31-1 ms is clamped to 1 ms, which would sample continuously. */
export const MAX_MEMLOG_INTERVAL_SECONDS = 86_400;
/** How many of the heap's most numerous object types a sample records. */
export const MEMLOG_TOP_TYPES = 15;
/** Above this JS heap size a snapshot is refused: the string alone could exhaust memory. */
export const MEMLOG_SNAPSHOT_MAX_HEAP_BYTES = 4 * 1024 ** 3;
export const MEMLOG_DIR = "chat-diagnostics";

const ENABLE_VALUES = new Set(["1", "on", "true"]);
const DISABLE_VALUES = new Set(["", "0", "off", "false"]);
const WHOLE_SECONDS = /^\d+$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

type SampleKind = "start" | "sample" | "snapshot-begin" | "snapshot" | "snapshot-skipped" | "stop";
type WarningKind = "log" | "snapshot";
type TimerHandle = ReturnType<typeof setTimeout> | object;

export const _chatMemorySamplerDeps = {
  memoryUsage: (): NodeJS.MemoryUsage => process.memoryUsage(),
  heapStats: (): ReturnType<typeof heapStats> => heapStats(),
  uptime: (): number => process.uptime(),
  heapSnapshot: (): string => Bun.generateHeapSnapshot("v8"),
  // node:fs, not Bun.write: one small line must land in order, synchronously, from a timer
  // callback or a signal handler, and Bun has no append primitive.
  mkdir: (dir: string): void => {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  },
  appendLine: (path: string, line: string): void => {
    appendFileSync(path, line, { mode: PRIVATE_FILE_MODE });
  },
  writePrivateFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
    chmodSync(path, PRIVATE_FILE_MODE);
  },
  // setTimeout, not setInterval or Bun.sleep: the pending sample is cancelled by stop().
  setTimeout: (callback: () => void, ms: number): TimerHandle => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle: TimerHandle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  onSnapshotSignal: (handler: () => void): (() => void) => {
    process.on("SIGUSR2", handler);
    return () => {
      process.off("SIGUSR2", handler);
    };
  },
};

/**
 * The interval in seconds `NAX_CHAT_MEMLOG` asks for, or `undefined` when it leaves the
 * sampler off. `1`/`on`/`true` mean the default interval; any other value must be a whole
 * number of seconds between the floor and the ceiling.
 */
export function parseMemlogInterval(value: string | undefined): number | undefined {
  const raw = value?.trim().toLowerCase() ?? "";
  if (DISABLE_VALUES.has(raw)) return undefined;
  if (ENABLE_VALUES.has(raw)) return DEFAULT_MEMLOG_INTERVAL_SECONDS;
  const seconds = WHOLE_SECONDS.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= MIN_MEMLOG_INTERVAL_SECONDS && seconds <= MAX_MEMLOG_INTERVAL_SECONDS)) {
    throw new NaxError(
      `${MEMLOG_ENV}="${value}" must be 1, on, or whole seconds from ${MIN_MEMLOG_INTERVAL_SECONDS} to ${MAX_MEMLOG_INTERVAL_SECONDS}`,
      "CHAT_MEMLOG_INVALID",
      { stage: "chat", value },
    );
  }
  return seconds;
}

export interface ChatMemorySamplerOptions {
  readonly dir: string;
  readonly pid: number;
  readonly intervalSeconds: number;
  readonly now: () => Date;
}

export interface ChatMemorySampler {
  readonly logPath: string;
  /** Resolves once any heap snapshot in progress has been written. */
  idle(): Promise<void>;
  /**
   * Write a final sample and disarm; answers the failures queued during the session, at most
   * one per kind, for the caller to print once the screen is gone. A second call does nothing.
   */
  stop(): Promise<readonly string[]>;
}

function topTypes(counts: Record<string, number>): readonly (readonly [string, number])[] {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MEMLOG_TOP_TYPES);
}

function sampleRecord(kind: SampleKind, options: ChatMemorySamplerOptions): Record<string, unknown> {
  const memory = _chatMemorySamplerDeps.memoryUsage();
  const heap = _chatMemorySamplerDeps.heapStats();
  return {
    kind,
    ts: options.now().toISOString(),
    pid: options.pid,
    intervalSeconds: options.intervalSeconds,
    uptimeSec: _chatMemorySamplerDeps.uptime(),
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    jsc: {
      heapSize: heap.heapSize,
      heapCapacity: heap.heapCapacity,
      extraMemorySize: heap.extraMemorySize,
      objectCount: heap.objectCount,
      protectedObjectCount: heap.protectedObjectCount,
      topTypes: topTypes(heap.objectTypeCounts),
    },
  };
}

class Sampler implements ChatMemorySampler {
  readonly logPath: string;
  private timer?: TimerHandle;
  private removeSignal?: () => void;
  private snapshotting: Promise<void> = Promise.resolve();
  private snapshotBusy = false;
  private readonly warnings = new Map<WarningKind, string>();
  private stopped = false;

  constructor(private readonly options: ChatMemorySamplerOptions) {
    this.logPath = join(options.dir, `memory-${options.pid}.jsonl`);
  }

  begin(): void {
    this.guard("log", () => _chatMemorySamplerDeps.mkdir(this.options.dir));
    this.record("start");
    this.removeSignal = _chatMemorySamplerDeps.onSnapshotSignal(() => this.snapshot());
    this.arm();
  }

  idle(): Promise<void> {
    return this.snapshotting;
  }

  async stop(): Promise<readonly string[]> {
    if (this.stopped) return [];
    this.stopped = true;
    if (this.timer !== undefined) _chatMemorySamplerDeps.clearTimeout(this.timer);
    this.timer = undefined;
    this.removeSignal?.();
    await this.snapshotting;
    this.record("stop");
    return [...this.warnings.values()];
  }

  private arm(): void {
    this.timer = _chatMemorySamplerDeps.setTimeout(() => {
      if (this.stopped) return;
      this.record("sample");
      this.arm();
    }, this.options.intervalSeconds * 1000);
  }

  private snapshot(): void {
    if (this.stopped || this.snapshotBusy) return;
    const heapSize = _chatMemorySamplerDeps.heapStats().heapSize;
    if (heapSize > MEMLOG_SNAPSHOT_MAX_HEAP_BYTES) {
      this.record("snapshot-skipped", { reason: "heap too large", limitBytes: MEMLOG_SNAPSHOT_MAX_HEAP_BYTES });
      return;
    }
    this.snapshotBusy = true;
    const stamp = this.options.now().toISOString().replace(/[:.]/g, "-");
    const path = join(this.options.dir, `heap-${this.options.pid}-${stamp}.heapsnapshot`);
    this.record("snapshot-begin", { path });
    this.snapshotting = (async () => {
      try {
        await _chatMemorySamplerDeps.writePrivateFile(path, _chatMemorySamplerDeps.heapSnapshot());
        this.record("snapshot", { path });
      } catch (cause) {
        this.warn("snapshot", `heap snapshot failed (${path}): ${errorMessage(cause)}`);
      } finally {
        this.snapshotBusy = false;
      }
    })();
  }

  private record(kind: SampleKind, extra: Record<string, unknown> = {}): void {
    this.guard("log", () => {
      const line = `${JSON.stringify({ ...sampleRecord(kind, this.options), ...extra })}\n`;
      _chatMemorySamplerDeps.appendLine(this.logPath, line);
    });
  }

  private guard(kind: WarningKind, action: () => void): void {
    try {
      action();
    } catch (cause) {
      this.warn(kind, `memory log write failed (${this.logPath}): ${errorMessage(cause)}`);
    }
  }

  private warn(kind: WarningKind, message: string): void {
    if (!this.warnings.has(kind)) this.warnings.set(kind, message);
  }
}

/** Start sampling now: one `start` line at once, then one `sample` line per interval. */
export function startChatMemorySampler(options: ChatMemorySamplerOptions): ChatMemorySampler {
  const sampler = new Sampler(options);
  sampler.begin();
  return sampler;
}
