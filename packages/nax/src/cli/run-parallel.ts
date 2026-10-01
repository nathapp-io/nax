/**
 * `nax run` `--parallel` flag handling (US-002).
 *
 * Extracted as a pure function so the parse is unit-testable — it previously
 * lived inline in bin/nax.ts after the TUI mount, an untested CLI entry point
 * (same rationale as run-mode.ts / BUG-23 and run-max-iterations.ts / US-001).
 */

export type ParallelFlag = { ok: true; value: number | undefined } | { ok: false; message: string };

/**
 * Parse the raw `--parallel` option. `undefined` means the flag was not passed
 * — sequential. `0`, negative and non-numeric values are rejected: concurrency
 * is never inferred from the CPU count, and `0` would silently run one story at
 * a time while being documented as "auto".
 */
export function parseParallelFlag(raw: string | undefined): ParallelFlag {
  if (raw === undefined) return { ok: true, value: undefined };

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    return { ok: false, message: "--parallel must be a positive integer (omit it to run sequentially)" };
  }

  return { ok: true, value };
}
