/**
 * The registry's table of shell output tails: one per background shell task and, from US-004, one
 * per running foreground call. Display only — nothing here reaches the model.
 *
 * A task's tail outlives the task so a view opened on a finished shell still shows its last
 * lines, and is dropped once every retained tail together exceeds the total budget: finished
 * tasks go oldest-ended first, because they are the least likely to be watched. A running task's
 * tail and a foreground call's are never dropped, so a chat full of running shells is bounded by
 * the per-tail caps alone.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Logger } from "@/logger";
import { createShellTail, type ShellTail } from "./shell-tail";
import type { ChatShellOutput } from "./task-types";

/** The most UTF-8 bytes of line text every retained tail may hold together. */
export const SHELL_TAIL_TOTAL_MAX_BYTES = 4 * 1024 * 1024;

export interface ShellTailsOptions {
  /** Told when a shell-output listener throws; the other listeners and the append still run. */
  readonly logger: Pick<Logger, "warn">;
  /** The budget shared by every retained tail; lowerable so a test need not write mebibytes. */
  readonly totalMaxBytes?: number;
}

/** One background shell task's tail and whether its task has already ended. */
interface TaskTail {
  readonly tail: ShellTail;
  ended: boolean;
}

/** What the registry drives; the read side is {@link ChatShellOutput}. */
export interface ShellTails extends ChatShellOutput {
  /** Start retaining the output of background shell task `id`. */
  addTask(id: string): void;
  /** Feed one chunk of task `id`'s output; ignored once it ended, or for an id with no tail. */
  appendTask(id: string, chunk: Uint8Array): void;
  /** The task ended: keep its tail for display, and consider eviction now that it is evictable. */
  endTask(id: string): void;
  /** Start retaining the output of the running foreground call `callId`; never evicted. */
  addForeground(callId: string): void;
  /** Feed one chunk of foreground call `callId`'s output; ignored for an id with no tail. */
  appendForeground(callId: string, chunk: Uint8Array): void;
  /** The call ended or moved: drop its tail and with it its share of the retained total. */
  endForeground(callId: string): void;
}

export function createShellTails(options: ShellTailsOptions): ShellTails {
  const totalMaxBytes = options.totalMaxBytes ?? SHELL_TAIL_TOTAL_MAX_BYTES;
  const tasks = new Map<string, TaskTail>();
  /** Tails of running foreground calls, keyed by call id; the registry registers and drops them. */
  const foregrounds = new Map<string, ShellTail>();
  /** Ids of finished tasks in the order they ended: the eviction queue. */
  const finished: string[] = [];
  const listeners = new Set<(id: string) => void>();

  function notify(id: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(id);
      } catch (cause) {
        options.logger.warn("chat", "Background shell output callback failed", { id, error: errorMessage(cause) });
      }
    }
  }

  /** The UTF-8 bytes every retained tail holds: what the total budget bounds. */
  function totalBytes(): number {
    let total = 0;
    for (const { tail } of tasks.values()) total += tail.bytes();
    for (const tail of foregrounds.values()) total += tail.bytes();
    return total;
  }

  /** Drop finished tasks' tails, oldest-ended first, until the retained total fits the budget. */
  function evict(): void {
    while (totalBytes() > totalMaxBytes) {
      const id = finished.shift();
      if (id === undefined) return;
      const task = tasks.get(id);
      if (task === undefined || !task.ended) continue;
      task.tail.evict();
      notify(id);
    }
  }

  return {
    taskTail(id) {
      return tasks.get(id)?.tail.view();
    },
    foregroundTail(callId) {
      return foregrounds.get(callId)?.view();
    },
    onShellOutput(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addTask(id) {
      tasks.set(id, { tail: createShellTail(), ended: false });
    },
    appendTask(id, chunk) {
      const task = tasks.get(id);
      if (task === undefined || task.ended || chunk.byteLength === 0) return;
      task.tail.append(chunk);
      notify(id);
      evict();
    },
    endTask(id) {
      const task = tasks.get(id);
      if (task === undefined || task.ended) return;
      task.ended = true;
      finished.push(id);
      evict();
    },
    addForeground(callId) {
      foregrounds.set(callId, createShellTail());
    },
    appendForeground(callId, chunk) {
      const tail = foregrounds.get(callId);
      if (tail === undefined || chunk.byteLength === 0) return;
      tail.append(chunk);
      notify(callId);
      // The foreground tail only ADDS to the retained total: a foreground tail is never evicted,
      // so this can only drop a finished task's tail.
      evict();
    },
    endForeground(callId) {
      foregrounds.delete(callId);
    },
  };
}
