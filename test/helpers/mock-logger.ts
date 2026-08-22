import { mock } from "bun:test";
import type { Logger } from "@/logger";

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
 * Consumers therefore wrote `makeLogger() as unknown as Logger` (12 sites), or
 * passed the mock straight in and ate the TS2740 (15 more). Intersecting here
 * puts that one cast in the factory and makes the mock assignable everywhere a
 * Logger is wanted, while `calls` and `reset()` stay reachable.
 *
 * The alternative is extracting an `ILogger` interface in src/ and depending on
 * that; a real improvement, but a source change, so out of scope for the test
 * debt drain (#1514 phase 1b).
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

  const logger = {
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    debug: make("debug"),
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
  return logger as unknown as MockLogger;
}
