/**
 * The logger slot (spec R2). nax-agent logs through whatever logger the host
 * installs; nax installs its own from `initLogger` and clears it in
 * `resetLogger`.
 *
 * Unset semantics match nax's logger exactly: `getSafeLogger()` gives `null`
 * (callers use `?.`), and `getLogger()` gives a silent no-op rather than
 * throwing. nax's `getLogger()` returns a sink-less silent logger when
 * uninitialised, so neither form has ever produced output before init.
 */
export interface AgentLogger {
  error(stage: string, message: string, data?: Record<string, unknown>): void;
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
  info(stage: string, message: string, data?: Record<string, unknown>): void;
  debug(stage: string, message: string, data?: Record<string, unknown>): void;
}

const noopLogger: AgentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

let installed: AgentLogger | null = null;

/** Install (or, with `null`, clear) the process-wide logger. */
export function setAgentLogger(logger: AgentLogger | null): void {
  installed = logger;
}

/** The installed logger, or `null` when none is installed. */
export function getSafeLogger(): AgentLogger | null {
  return installed;
}

/** The installed logger, or a silent no-op when none is installed. Never throws. */
export function getLogger(): AgentLogger {
  return installed ?? noopLogger;
}
