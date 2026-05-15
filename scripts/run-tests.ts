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
 *   3. On ANY abnormal leader exit (timeout, Bun panic, SIGSEGV, SIGABRT,
 *      forwarded SIGINT), sweeps the process group to reap orphan
 *      descendants that outlived the leader.
 *   4. Forwards SIGINT/SIGTERM received by the wrapper to the child group,
 *      so Ctrl+C and CI kills propagate cleanly.
 *   5. Emits a deterministic exit code — 0 on success, 124 on timeout, 130
 *      on SIGINT, 134 on Bun panic / other signal, otherwise whatever
 *      `bun test` returned.
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

/**
 * Reap an entire process group, escalating TERM → KILL.
 * Safe to call multiple times; ESRCH errors are ignored.
 */
function reapGroup(pgid: number, reason: string): void {
  process.stderr.write(`[run-tests] reaping pgid ${pgid} (${reason})\n`);
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // Group may already be gone.
  }
  setTimeout(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }, 5_000).unref();
}

/**
 * Probe whether the process group still has live members. On Linux/macOS,
 * `kill(-pgid, 0)` returns 0 if any process in the group exists, throws ESRCH
 * otherwise. Used to detect orphaned descendants after the leader exits.
 */
function groupHasSurvivors(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  // Forward parent signals to the group so Ctrl+C / CI kill propagates.
  const forwardSignal = (sig: NodeJS.Signals) => () => {
    process.stderr.write(`\n[run-tests] received ${sig} — forwarding to pgid ${pgid}\n`);
    try {
      process.kill(-pgid, sig);
    } catch {
      // Group already gone.
    }
  };
  const onSigint = forwardSignal("SIGINT");
  const onSigterm = forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(
      `\n[run-tests] ${phase.name} exceeded ${phase.phaseTimeoutMs / 1000}s\n`,
    );
    reapGroup(pgid, "phase timeout");
  }, phase.phaseTimeoutMs);
  timer.unref();

  const exitCode = await child.exited;
  clearTimeout(timer);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);

  // Leader exited — but descendants spawned by tests (acpx, agent procs) may
  // have outlived it, especially on Bun panics (segfault, JSC assertion).
  // `null` or non-zero exit signals abnormal termination; always sweep the
  // group as a safety net to prevent orphan accumulation across phases.
  const abnormal = timedOut || exitCode === null || exitCode !== 0;
  if (abnormal && groupHasSurvivors(pgid)) {
    const reason =
      exitCode === null ? "leader signaled (likely Bun panic/segfault)" : `leader exit ${exitCode}`;
    reapGroup(pgid, reason);
    // Brief settle so SIGTERM lands before the next phase boots.
    await Bun.sleep(500);
  }

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (timedOut) {
    process.stderr.write(`[run-tests] ${phase.name} killed after ${elapsedS}s (timeout)\n`);
    return 124;
  }
  if (exitCode === null) {
    // biome-ignore lint/suspicious/noExplicitAny: Bun.Subprocess.signalCode typings lag
    const signal = ((child as any).signalCode as string | null) ?? "UNKNOWN";
    const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 134;
    process.stderr.write(
      `[run-tests] ${phase.name} signaled (${signal}) after ${elapsedS}s — likely Bun panic or Ctrl+C\n`,
    );
    return code;
  }
  process.stdout.write(`[run-tests] ${phase.name} done in ${elapsedS}s (exit ${exitCode})\n`);
  return exitCode;
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
