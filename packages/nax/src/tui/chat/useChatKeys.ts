import { useApp, useInput } from "ink";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type ChatHost,
  type ChatMode,
  cycleEffort,
  EFFORT_LEVELS,
  modelEffort,
  nextChatMode,
  withEffort,
} from "@/chat";

type QueuedSwitch = { mode?: ChatMode; model?: string };

const DOUBLE_INTERRUPT_MS = 2_000;
export const _chatKeyDeps = { now: () => Date.now() };

/** A pending timer's handle, held in a ref so any render path can clear it. */
type TimerRef = { current: ReturnType<typeof setTimeout> | undefined };

/**
 * Clear a pending timer, if there is one. Every way an arm ends — `finishTurn`, unmount, a
 * re-arm — goes through here, so a cleared arm can never redraw the footer later.
 */
function clearTimer(handle: TimerRef): void {
  if (handle.current === undefined) return;
  clearTimeout(handle.current);
  handle.current = undefined;
}

interface ChatKeysOptions {
  host: ChatHost;
  running: RefObject<boolean>;
  refresh(): void;
  onError(error: unknown): void;
  onNotice?: (text: string) => void;
}

export function useChatKeys({ host, running, refresh, onError, onNotice }: ChatKeysOptions): {
  locked: boolean;
  /**
   * True while a ctrl-c that cancelled a turn is still within the double-interrupt window:
   * a second ctrl-c now quits, so the footer offers it. Read on the render the first ctrl-c's
   * `refresh()` schedules, and again on the one its expiry schedules.
   */
  quitArmed(): boolean;
  /**
   * The synchronous control guard `runControl` applies: false once close has begun and while
   * confirming a close or a control action is in flight. It reads refs, not state, so a key
   * handler can ask before acting — a `locked` render can lag a keypress by one, and a teardown must never be handed
   * a fresh `host.cancel()`: the host marks itself closed immediately, so the call would throw
   * `CHAT_HOST_CLOSED` in the middle of a normal exit.
   */
  canControl(): boolean;
  finishTurn(): Promise<void>;
  close(): Promise<void>;
  runControl(task: () => Promise<void>): Promise<boolean>;
} {
  const { exit } = useApp();
  const queued = useRef<QueuedSwitch | undefined>(undefined);
  const interruptedAt = useRef<number | undefined>(undefined);
  /** The armed quit's expiry — a `setTimeout` handle, because it is cleared mid-flight. */
  const quitExpiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const switching = useRef<Promise<void> | undefined>(undefined);
  const closing = useRef(false);
  const confirming = useRef(false);
  const [locked, setLocked] = useState(false);

  /**
   * Arm the quit for `DOUBLE_INTERRUPT_MS` and redraw when it lapses, so the footer's hint
   * disappears on its own — the window `quitArmed` reports is the one the ctrl-c handler
   * closes on. `setInterval` could not be stopped by a cleanup before its next tick, which
   * is why every timer in the chat screen is a `setTimeout` chain.
   */
  function armQuit(): void {
    clearTimer(quitExpiry);
    quitExpiry.current = setTimeout(() => {
      quitExpiry.current = undefined;
      refresh();
    }, DOUBLE_INTERRUPT_MS);
  }

  // A pending expiry must not outlive the screen.
  useEffect(() => () => clearTimer(quitExpiry), []);

  function quitArmed(): boolean {
    const armedAt = interruptedAt.current;
    return armedAt !== undefined && _chatKeyDeps.now() - armedAt < DOUBLE_INTERRUPT_MS;
  }

  /** The guard every control path shares; see the interface note on `canControl`. */
  function canControl(): boolean {
    return !closing.current && !confirming.current && switching.current === undefined;
  }

  async function switchMode(mode: ChatMode): Promise<void> {
    await runControl(() => host.switchTo({ mode }));
  }
  function cycleModelEffort(): void {
    const model = queued.current?.model ?? host.current().model;
    const levels = host.effortLevels?.(model) ?? EFFORT_LEVELS;
    const next = withEffort(model, cycleEffort(modelEffort(model), 1, levels));
    if (running.current) queued.current = { ...queued.current, model: next };
    else void runControl(() => host.switchTo({ model: next }));
  }
  async function runControl(action: () => Promise<void>): Promise<boolean> {
    if (!canControl()) return false;
    setLocked(true);
    try {
      const task = action();
      switching.current = task;
      await task;
      refresh();
      return !closing.current;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      switching.current = undefined;
      setLocked(closing.current);
    }
  }
  async function close(): Promise<void> {
    if (closing.current || confirming.current) return;
    if (host.confirmJobsBeforeClose) {
      confirming.current = true;
      try {
        // Keep the ask card answerable: closing/locked are only set after confirmation.
        await host.confirmJobsBeforeClose();
      } catch (error) {
        onError(error);
        return;
      } finally {
        confirming.current = false;
      }
    }
    closing.current = true;
    queued.current = undefined;
    setLocked(true);
    try {
      // A reopen must settle before close releases the resulting session's lock.
      // switchMode already surfaces a rejection; close still needs to run on rollback.
      await switching.current?.catch(() => {});
      await host.close();
      exit();
    } catch (error) {
      closing.current = false;
      setLocked(false);
      onError(error);
    }
  }
  useInput((input, key) => {
    if (closing.current) return;
    if (key.ctrl && input === "c") {
      const now = _chatKeyDeps.now();
      if (
        !running.current ||
        (interruptedAt.current !== undefined && now - interruptedAt.current <= DOUBLE_INTERRUPT_MS)
      ) {
        void close();
      } else {
        interruptedAt.current = now;
        armQuit();
        host.cancel();
        refresh();
      }
    } else if (key.ctrl && input === "b" && canControl()) {
      if (!host.tasks?.moveForeground()) onNotice?.("no running command to move to the background");
    } else if (key.ctrl && input === "t" && canControl()) {
      cycleModelEffort();
    } else if (key.shift && key.tab && !key.ctrl && !key.meta && canControl()) {
      const mode = nextChatMode(queued.current?.mode ?? host.current().mode);
      if (running.current) queued.current = { ...queued.current, mode };
      else void switchMode(mode);
    }
  });
  return {
    locked,
    close,
    quitArmed,
    canControl,
    runControl,
    async finishTurn() {
      interruptedAt.current = undefined;
      clearTimer(quitExpiry);
      const next = queued.current;
      queued.current = undefined;
      if (next !== undefined && !closing.current) await runControl(() => host.switchTo(next));
    },
  };
}
