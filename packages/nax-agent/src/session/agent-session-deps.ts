/**
 * Injectable clock, timers, ids and filesystem for the agent session facade.
 * Tests replace members (paired with withDepsRestore) to fire deadlines
 * without sleeping and to lower the control-event cap. Exported on ./internal.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Undelivered control events a turn may queue before it is cancelled as stalled (spec 4.4). */
export const MAX_UNDELIVERED_CONTROL_EVENTS = 1000;

export const _agentSessionDeps = {
  now: (): number => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  randomUUID: (): string => randomUUID(),
  isDirectory: async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  makeScratchRoot: (): Promise<string> => mkdtemp(join(tmpdir(), "nax-agent-session-")),
  removeScratchRoot: (dir: string): Promise<void> => rm(dir, { recursive: true, force: true }),
  controlEventCap: MAX_UNDELIVERED_CONTROL_EVENTS,
};
