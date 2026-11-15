/**
 * The chat session's own compaction policy (US-006).
 *
 * The native chat compacts when `execution.compaction` says so, which is a percentage of the
 * model's window. On the largest windows that percentage is hundreds of thousands of tokens, so
 * a chat that runs for hours reaches it far later than an operator wants. `chat.compaction`
 * holds the chat-specific policy: an absolute token cap for the native chat session's history and
 * the idle delay before a background compact.
 *
 * Only the native chat session (`open-chat-session.ts`) takes the cap. Story sessions and chat
 * subagents keep `execution.compaction` exactly as configured — the chat cap is chat policy, and
 * `0` turns it off rather than falling back.
 */
import { DEFAULT_CHAT_COMPACT_AT_TOKENS, DEFAULT_IDLE_COMPACT_AFTER_MINUTES, type NaxConfig } from "@/config";

const MS_PER_MINUTE = 60_000;

/** The absolute trigger the native chat session compacts at; 0 when the operator turned it off. */
export function chatCompactAtTokens(config: NaxConfig): number {
  return config.chat?.compaction?.compactAtTokens ?? DEFAULT_CHAT_COMPACT_AT_TOKENS;
}

/** How long the chat may sit idle before an idle compaction; 0 when the operator turned it off. */
export function idleCompactAfterMs(config: NaxConfig): number {
  return (config.chat?.compaction?.idleCompactAfterMinutes ?? DEFAULT_IDLE_COMPACT_AFTER_MINUTES) * MS_PER_MINUTE;
}

/** A chat below this much context has nothing worth condensing while a job runs (US-007). */
export const IDLE_COMPACT_MIN_TOKENS = 20_000;

/** What the screen tells the compactor about the chat as it stands now. */
export interface IdleCompactState {
  /** True while no turn is running: nothing else may take the turn slot. */
  readonly idle: boolean;
  /** The first job `host.jobs.running()` reports; absent when no job is running. */
  readonly runningJobId?: string;
  /** The footer's context reading; absent when no usage event has reported one yet. */
  readonly contextTokens?: number;
  /** True when the chat runs on an `acp:` model, which owns its own context. */
  readonly acp: boolean;
}

/**
 * An armed timer's handle: the runtime's own, or the fake clock's number.
 *
 * Three libraries declare the global `setTimeout` (Bun returns `Timer`, @types/node returns
 * `Timeout`, lib.dom returns `number`), so its type is one overload set returning all three and
 * no single implementation can satisfy it — a seam typed `typeof setTimeout` cannot be faked.
 * This is the shape the chat's other armed timers already use (`ask-fallback.ts`,
 * `ask-controller.ts`, `job-runner.ts`, `_jobPanelsDeps`), and why `fakeTimers()` exists.
 */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * The two timer calls the compactor makes, in the call shape of the runtime's own: injectable so
 * a test drives the delay from a fake clock instead of waiting 55 real minutes.
 */
export interface IdleCompactTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The screen's one idle compactor: told what the chat looks like on every render. */
export interface IdleCompactor {
  update(state: IdleCompactState): void;
  dispose(): void;
}

/** The reason the compactor reports, in whole minutes, so the notice reads as the delay. */
function idleReason(delayMs: number, jobId: string): string {
  return `${Math.round(delayMs / MS_PER_MINUTE)}m idle while job ${jobId} runs`;
}

/**
 * Compact the native chat's history once per job, after the chat has been idle for `delayMs`
 * while that job runs (US-007).
 *
 * One timer, armed by the first qualifying `update` for a job and left alone by later ones,
 * so its origin is the later of the turn ending and the job starting. A qualifying update
 * that names a different job re-arms for that job; anything else clears it. The fired job ids
 * are kept for the compactor's whole life, so a job that was already compacted for — whatever
 * that compaction's outcome — is never compacted for again. The timer is a `setTimeout`, never
 * an interval, because it must be cancellable mid-flight (`clearTimeout`, `dispose`).
 */
export function createIdleCompactor(options: {
  readonly delayMs: number;
  readonly onDue: (reason: string) => void;
  readonly timers?: IdleCompactTimers;
}): IdleCompactor {
  const { delayMs, onDue } = options;
  const timers: IdleCompactTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const fired = new Set<string>();
  /** The job the armed timer was set for; absent when no timer is armed. */
  let armedJobId: string | undefined;
  let handle: TimerHandle | undefined;

  function clears(): void {
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
    armedJobId = undefined;
  }

  function qualifies(state: IdleCompactState): boolean {
    return (
      state.idle &&
      state.runningJobId !== undefined &&
      !state.acp &&
      state.contextTokens !== undefined &&
      state.contextTokens >= IDLE_COMPACT_MIN_TOKENS &&
      delayMs > 0 &&
      !fired.has(state.runningJobId)
    );
  }

  function arm(jobId: string): void {
    armedJobId = jobId;
    const reason = idleReason(delayMs, jobId);
    // setTimeout, not setInterval: the timer is cancelled mid-flight by `clearTimeout`.
    handle = timers.setTimeout(() => {
      handle = undefined;
      armedJobId = undefined;
      fired.add(jobId);
      onDue(reason);
    }, delayMs);
  }

  return {
    update(state: IdleCompactState): void {
      if (!qualifies(state)) {
        clears();
        return;
      }
      const jobId = state.runningJobId;
      // The timer of a re-render's identical state is already counting from the right origin.
      if (jobId === undefined || jobId === armedJobId) return;
      clears();
      arm(jobId);
    },
    dispose(): void {
      clears();
    },
  };
}
