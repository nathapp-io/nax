/**
 * One host's serialization point for the session metadata's read-modify-write.
 *
 * `costUsd` is only ever written by reading the stored metadata, adding what was spent and
 * writing it back, and the store has no atomic update. Two steps that both read before
 * either writes therefore start from the same base, and the second write erases the first
 * one's spend. The facade does not close that window: its claim is released when the turn or
 * the summarizer settles, which is before the host has written anything.
 *
 * So the host owns exactly one queue, and every step that touches the metadata's spend runs
 * through it: a turn's `runChatTurn` (whose write lands after `turn_end`) and a compaction's
 * accounting. A step never begins before the one queued ahead of it has finished.
 */
export interface HostQueue {
  /** Run `task` after every task queued before it, whatever those settled to. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createHostQueue(): HostQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      // The queue continues whether the task resolved or rejected: one failed write must not
      // strand the accounting of every turn and compaction after it.
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
