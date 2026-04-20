#!/usr/bin/env bun
/**
 * Test runner wrapper for the three-phase suite.
 *
 * Rationale (fix for flaky `bun run test`):
 *   - Bun's JSC runtime occasionally SIGABRTs under sustained load
 *     (`std::span ... Assertion '__idx < size()' failed`). That abort is
 *     a known Bun bug — not something nax tests can prevent.
 *   - When a `bun test` invocation hangs or crashes, child processes the
 *     tests spawned (acpx, shells, etc.) can survive the parent.
 *   - When the agent retries `bun run test` on hang, those leaked
 *     children accumulate across retries.
 *
 * This wrapper:
 *   1. Caps each phase with a hard wall-clock timeout. On timeout, the
 *      whole process group is SIGTERMed, then SIGKILLed after a 5 s grace.
 *   2. Runs each phase in its own process group (detached spawn) so the
 *      kill propagates to every descendant, not just `bun test` itself.
 *   3. Emits a deterministic exit code — 0 on success, 124 on timeout,
 *      otherwise whatever `bun test` returned. Agents / CI see clean
 *      success/failure and do not retry indefinitely.
 *
 * Usage: `bun run scripts/run-tests.ts [--bail]`
 */

const BAIL = process.argv.includes("--bail");

type Phase = {
  name: string;
  dir: string;
  /** Per-test timeout passed to Bun. */
  testTimeoutMs: number;
  /** Wall-clock cap for the whole phase. */
  phaseTimeoutMs: number;
};

const PHASES: Phase[] = [
  { name: "unit", dir: "test/unit/", testTimeoutMs: 5_000, phaseTimeoutMs: 120_000 },
  { name: "integration", dir: "test/integration/", testTimeoutMs: 5_000, phaseTimeoutMs: 120_000 },
  { name: "ui", dir: "test/ui/", testTimeoutMs: 5_000, phaseTimeoutMs: 30_000 },
];

async function runPhase(phase: Phase): Promise<number> {
  const args = ["test", phase.dir, `--timeout=${phase.testTimeoutMs}`];
  if (BAIL) args.push("--bail");

  const startedAt = Date.now();
  process.stdout.write(`\n── ${phase.name} (${phase.dir}, cap ${phase.phaseTimeoutMs / 1000}s) ──\n`);

  // `detached: true` makes bun test the leader of its own process group so
  // `process.kill(-pid, SIGTERM)` reaches every descendant (acpx, subshells).
  const child = Bun.spawn(["bun", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    // biome-ignore lint/suspicious/noExplicitAny: Bun typings lag behind
    ...({ detached: true } as any),
  });

  // biome-ignore lint/suspicious/noExplicitAny: pid narrowing
  const pgid = (child as any).pid as number;

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(
      `\n[run-tests] ${phase.name} exceeded ${phase.phaseTimeoutMs / 1000}s — SIGTERM to pgid ${pgid}\n`,
    );
    try {
      // Negative pid targets the whole process group.
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Group may already be gone; fall through to SIGKILL below.
    }
    setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }, 5_000).unref();
  }, phase.phaseTimeoutMs);
  timer.unref();

  const exitCode = await child.exited;
  clearTimeout(timer);

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (timedOut) {
    process.stderr.write(`[run-tests] ${phase.name} killed after ${elapsedS}s (timeout)\n`);
    return 124;
  }
  process.stdout.write(`[run-tests] ${phase.name} done in ${elapsedS}s (exit ${exitCode})\n`);
  return exitCode ?? 1;
}

async function main(): Promise<void> {
  for (const phase of PHASES) {
    const code = await runPhase(phase);
    if (code !== 0) {
      process.exit(code);
    }
  }
  process.stdout.write(`\n[run-tests] all phases passed\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[run-tests] fatal: ${err}\n`);
  process.exit(1);
});
