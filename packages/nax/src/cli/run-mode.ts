/**
 * Headless-vs-TUI mode resolution for `nax run` (BUG-23).
 *
 * Extracted as a pure function so the decision is unit-testable — it
 * previously lived inline in bin/nax.ts, an untested CLI entry point.
 */

export interface RunModeInput {
  /** process.stdout.isTTY */
  isTTY: boolean;
  /** --headless flag */
  headlessFlag: boolean;
  /** NAX_HEADLESS=1 env var */
  headlessEnv: boolean;
  /** Resolved formatter mode from CLI flags (--json/--verbose/--quiet/--silent) */
  formatterMode: "quiet" | "normal" | "verbose" | "json";
}

/**
 * TUI mounts only when stdout is a TTY, none of --headless/NAX_HEADLESS
 * force headless, and --json was not requested. --json output is
 * machine-consumed; mounting the TUI over stdout on a TTY silently
 * discarded --json's request for structured output (BUG-23).
 */
export function resolveUseHeadless(input: RunModeInput): boolean {
  return !input.isTTY || input.headlessFlag || input.headlessEnv || input.formatterMode === "json";
}
