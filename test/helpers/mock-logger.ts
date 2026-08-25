import { mock } from "bun:test";
import { Logger } from "@/logger";

export type LogCall = {
  level: "error" | "warn" | "info" | "debug";
  stage: string;
  message: string;
  data?: Record<string, unknown>;
};

/**
 * A `Logger` the tests can assert against.
 *
 * `Logger` is a class, not an interface, so a four-method object can never
 * satisfy it structurally — it is missing ~16 members including private ones.
 * Rather than assert past that, this builds a **real** `Logger` (silent: no
 * `filePath`, so nothing is written; `suppressConsole`, so nothing is printed)
 * and overlays the four level methods with mocks. `Object.assign` returns
 * `Logger & { … }`, which is exactly `MockLogger`, so the factory needs no
 * type assertion and the result is assignable everywhere a `Logger` is wanted
 * while `calls` and `reset()` stay reachable.
 */
export type MockLogger = Logger & {
  error: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  /** Every call made through this logger, in order. */
  calls: LogCall[];
  reset(): void;
};

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

  return Object.assign(new Logger({ level: "error", suppressConsole: true }), {
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    debug: make("debug"),
    calls,
    reset: () => {
      calls.length = 0;
    },
  });
}
