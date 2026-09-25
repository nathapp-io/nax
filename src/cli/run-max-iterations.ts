/**
 * `nax run` `-m/--max-iterations` flag handling (US-001).
 *
 * Extracted as pure functions so the parse and the config override are
 * unit-testable — they previously lived inline in bin/nax.ts, an untested CLI
 * entry point (same rationale as run-mode.ts / BUG-23).
 */

import type { NaxConfig } from "../config";

export type MaxIterationsFlag = { ok: true; value: number | undefined } | { ok: false; message: string };

/**
 * Parse the raw `-m/--max-iterations` option. `undefined` means the flag was
 * not passed — callers must not substitute a default, or a configured
 * `execution.maxIterations` would never take effect under `nax run`.
 */
export function parseMaxIterationsFlag(raw: string | undefined): MaxIterationsFlag {
  if (raw === undefined) return { ok: true, value: undefined };

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    return { ok: false, message: "--max-iterations must be a positive integer" };
  }

  return { ok: true, value };
}

/**
 * Return a new config with `execution.maxIterations` replaced only when `flag`
 * is defined. Never mutates `config`.
 */
export function applyMaxIterationsFlag(config: NaxConfig, flag: number | undefined): NaxConfig {
  if (flag === undefined) return { ...config, execution: { ...config.execution } };

  return { ...config, execution: { ...config.execution, maxIterations: flag } };
}
