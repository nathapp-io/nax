import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { NaxError } from "@/errors";
import { addSink, formatJsonl } from "@/logger";

export interface BotLog {
  readonly path?: string;
  close(): Promise<void>;
}

export const _botLogDeps = {
  addSink,
  async appendFile(path: string, text: string): Promise<void> {
    // The run directory is fresh; no graph-state write has created it yet.
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text);
  },
};

/** Machine-local run log. Entries arrive already redacted by the logger. */
export function openBotLog(path: string): BotLog {
  let pending = Promise.resolve();
  let unsubscribe: () => void;
  try {
    unsubscribe = _botLogDeps.addSink((entry) => {
      const line = `${formatJsonl(entry)}\n`;
      pending = pending
        .then(() => _botLogDeps.appendFile(path, line))
        .catch(() => {
          // Best-effort diagnostic output: never fail the bot or log recursively on disk errors.
        });
    });
  } catch (err) {
    if (!(err instanceof NaxError) || err.code !== "LOGGER_NOT_INITIALIZED") throw err;
    return { close: async () => {} };
  }
  return {
    path,
    async close() {
      unsubscribe();
      await pending;
    },
  };
}
