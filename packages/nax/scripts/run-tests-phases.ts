/**
 * The phases `scripts/run-tests.ts` runs. Kept pure (no spawning) so the
 * selection is unit-testable; the wrapper owns the timeouts and the reaping.
 */
export type Phase = {
  name: string;
  dir: string;
  /** Per-test timeout passed to Bun. */
  testTimeoutMs: number;
  /** Wall-clock cap for the whole phase. */
  phaseTimeoutMs: number;
};

export const SUITE_PHASES: readonly Phase[] = [
  // 240s, not 120s: the unit suite is ~21.7k tests across ~1.4k files, and a
  // fully-passing run was observed at 123.7s wall on a loaded runner — killed
  // by the old 120s budget with zero failing tests. The budget exists to bound
  // hangs (per-test timeout stays 5s; the group reap still fires on overrun),
  // so it must not sit at the suite's legitimate steady-state cost.
  { name: "unit", dir: "test/unit/", testTimeoutMs: 5_000, phaseTimeoutMs: 240_000 },
  { name: "integration", dir: "test/integration/", testTimeoutMs: 5_000, phaseTimeoutMs: 120_000 },
  { name: "ui", dir: "test/ui/", testTimeoutMs: 5_000, phaseTimeoutMs: 30_000 },
];

/**
 * `test/e2e/` is outside the default run by design (CI runs it as its own step).
 * The caps are the ones the old `timeout -k 5s 180s bun test test/e2e/ --timeout=60000`
 * script used; running it here makes them portable (stock macOS has no GNU `timeout`).
 */
export const E2E_PHASE: Phase = { name: "e2e", dir: "test/e2e/", testTimeoutMs: 60_000, phaseTimeoutMs: 180_000 };

export function selectPhases(argv: readonly string[]): readonly Phase[] {
  return argv.includes("--e2e") ? [E2E_PHASE] : SUITE_PHASES;
}
