import { describe, test } from "bun:test";
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { nodeRuntime } from "#src/runtime/index";
import { isConfinedTestRun } from "#test/helpers/index";

/**
 * `ps` is a setuid program and a confined OS sandbox withholds it (the macOS
 * Seatbelt profile refuses it outright), so the one case that reads its own
 * process group with `ps` cannot run inside a confined test run and is skipped
 * there. Every other case runs in both, and SPAWN_CASES itself is unchanged.
 */
const NEEDS_PS = "detached makes the child its own process-group leader";

describe("nodeRuntime meets the spawn behaviour cases", () => {
  for (const c of SPAWN_CASES) {
    const runner = c.name === NEEDS_PS ? test.skipIf(isConfinedTestRun()) : test;
    runner(c.name, () => c.run(nodeRuntime), 15_000);
  }
});
