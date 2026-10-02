/**
 * Logger doubles for nax-agent's own tests. nax-agent logs through the logger
 * slot (`setAgentLogger` / `getSafeLogger`), so these install there.
 *
 * Same names and shapes as nax's `test/helpers/mock-logger.ts` and
 * `test/helpers/warn-spy.ts`, so a test that moves from nax changes only its
 * import specifier (S2-1).
 */
import { type Mock, mock } from "bun:test";
import { type AgentLogger, getSafeLogger, setAgentLogger } from "#src/infra/index";

type Level = keyof AgentLogger;
type LogFn = AgentLogger["warn"];
type LogSpy = Mock<LogFn>;

export type LogCall = {
  level: Level;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
};

export type MockLogger = { [L in Level]: LogSpy } & {
  /** Every call made through this logger, in order. */
  calls: LogCall[];
  reset(): void;
};

export function makeLogger(): MockLogger {
  const calls: LogCall[] = [];
  const make = (level: Level): LogSpy =>
    mock<LogFn>((stage, message, data) => {
      calls.push({ level, stage, message, data });
    });
  return {
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    debug: make("debug"),
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
}

const noop = (): void => {};

/**
 * Install a logger whose `level` method is a spy, run `fn`, then put back
 * whatever was installed before, even when `fn` throws. The spy keeps its
 * calls after `fn` resolves (callers may assert on it afterwards).
 */
async function withLogSpy<T>(level: "warn" | "info" | "debug", fn: (spy: LogSpy) => Promise<T>): Promise<T> {
  const previous = getSafeLogger();
  const spy: LogSpy = mock<LogFn>(noop);
  setAgentLogger({ error: noop, warn: noop, info: noop, debug: noop, [level]: spy });
  try {
    return await fn(spy);
  } finally {
    setAgentLogger(previous);
  }
}

export async function withWarnSpy<T>(fn: (warnSpy: LogSpy) => Promise<T>): Promise<T> {
  return withLogSpy("warn", fn);
}

export async function withInfoSpy<T>(fn: (infoSpy: LogSpy) => Promise<T>): Promise<T> {
  return withLogSpy("info", fn);
}

export async function withDebugSpy<T>(fn: (debugSpy: LogSpy) => Promise<T>): Promise<T> {
  return withLogSpy("debug", fn);
}
