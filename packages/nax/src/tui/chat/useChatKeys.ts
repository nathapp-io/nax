import { useApp, useInput } from "ink";
import { type RefObject, useRef, useState } from "react";
import { type ChatHost, type ChatMode, nextChatMode } from "@/chat";

const DOUBLE_INTERRUPT_MS = 2_000;
export const _chatKeyDeps = { now: () => Date.now() };

interface ChatKeysOptions {
  host: ChatHost;
  running: RefObject<boolean>;
  refresh(): void;
  onError(error: unknown): void;
}

export function useChatKeys({ host, running, refresh, onError }: ChatKeysOptions): {
  locked: boolean;
  finishTurn(): Promise<void>;
} {
  const { exit } = useApp();
  const queued = useRef<ChatMode | undefined>(undefined);
  const interruptedAt = useRef<number | undefined>(undefined);
  const switching = useRef<Promise<void> | undefined>(undefined);
  const closing = useRef(false);
  const [locked, setLocked] = useState(false);

  async function switchMode(mode: ChatMode): Promise<void> {
    setLocked(true);
    try {
      const task = host.switchTo({ mode });
      switching.current = task;
      await task;
      refresh();
    } catch (error) {
      onError(error);
    } finally {
      switching.current = undefined;
      setLocked(closing.current);
    }
  }
  async function close(): Promise<void> {
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
        host.cancel();
      }
    } else if (key.shift && key.tab && !key.ctrl && !key.meta && !switching.current) {
      const mode = nextChatMode(queued.current ?? host.current().mode);
      if (running.current) queued.current = mode;
      else void switchMode(mode);
    }
  });
  return {
    locked,
    async finishTurn() {
      interruptedAt.current = undefined;
      const mode = queued.current;
      queued.current = undefined;
      if (mode !== undefined && !closing.current) await switchMode(mode);
    },
  };
}
