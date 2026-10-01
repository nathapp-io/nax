/**
 * BUG-14: dead `completedEarly` branch
 *
 * `RunnerExecutionResult.completedEarly` was never assigned anywhere —
 * `runExecutionPhase` never set it, and `executeUnified`'s result carries no
 * such field — so the early-return branch in `runner.ts` was dead code that
 * skipped `runCompletionPhase` (and with it `run:completed`, metrics, hooks)
 * on a path that could never activate. Deleted per the review's
 * "delete or wire it up".
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../src");

async function readSrc(relativePath: string): Promise<string> {
  const file = Bun.file(join(SRC, relativePath));
  return (await file.exists()) ? await file.text() : "";
}

describe("BUG-14: completedEarly dead branch removed", () => {
  test("RunnerExecutionResult no longer declares completedEarly", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).not.toContain("completedEarly");
  });

  test("runner.ts no longer early-returns on a completedEarly flag", async () => {
    const src = await readSrc("execution/runner.ts");
    expect(src).not.toContain("completedEarly");
  });

  test("no source file references completedEarly anymore", async () => {
    // Read every .ts file under src/execution and assert none mention it.
    const walk = new Bun.Glob(`${SRC}/execution/**/*.ts`);
    for await (const path of walk.scan()) {
      const text = await Bun.file(path).text();
      expect(text).not.toContain("completedEarly");
    }
  });
});
