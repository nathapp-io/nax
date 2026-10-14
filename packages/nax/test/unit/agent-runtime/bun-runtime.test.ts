import { beforeAll, describe, test } from "bun:test";
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { isConfinedTestRun, psCanReportProcessGroup } from "@test/helpers";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

/**
 * `ps` is a setuid program and a confined OS sandbox withholds it (the macOS
 * Seatbelt profile refuses it outright), so the one case that reads its own
 * process group with `ps` cannot run inside a confined test run — nor on a host
 * whose own shell withholds it. The skip is therefore decided both ways: the
 * confined marker, and whether `ps` answers at all. Every other case runs in
 * both, and SPAWN_CASES itself is unchanged — the same skip
 * `packages/nax-agent/test/unit/runtime/node-runtime.test.ts` applies to this
 * shared case list.
 */
const NEEDS_PS = "detached makes the child its own process-group leader";

const confined = isConfinedTestRun();
const skipPs = confined || !psCanReportProcessGroup();

/**
 * A confined sandbox charges its first process launch a one-time cost, so the
 * cases get the runner's own 60 s budget there rather than the 15 s a bare host
 * needs. Every case still runs with every assertion; only the budget moves.
 */
const CASE_TIMEOUT_MS = confined ? 60_000 : 15_000;

describe("nax's Bun runtime meets the spawn behaviour cases", () => {
  // Absorb the confined sandbox's one-time first-launch cost here, so no timed
  // case pays it. A no-op outside a confined run.
  beforeAll(async () => {
    if (!confined) return;
    const p = bunAgentRuntime.spawn(["sh", "-c", "exit 0"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
  }, CASE_TIMEOUT_MS);

  for (const c of SPAWN_CASES) {
    const runner = c.name === NEEDS_PS && skipPs ? test.skip : test;
    runner(c.name, () => c.run(bunAgentRuntime), CASE_TIMEOUT_MS);
  }
});
