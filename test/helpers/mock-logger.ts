import { mock } from "bun:test";

export type LogCall = { level: "error" | "warn" | "info" | "debug"; stage: string; message: string; data?: Record<string, unknown> };

export interface MockLogger {
  error: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  calls: LogCall[];
  reset(): void;
}

/**
 * Creates a logger mock compatible with src/logger Logger API.
 * Captures all calls into `calls[]` for assertions.
 */
export function makeLogger(): MockLogger {
  const calls: LogCall[] = [];
  const make = (level: LogCall["level"]) =>
    mock((stage: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ level, stage, message, data });
    });

  const logger: MockLogger = {
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    debug: make("debug"),
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
  return logger;
}
