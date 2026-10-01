import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { clearStaleVerdictBeforeDispatch } from "@/execution/story-orchestrator/run-phase";
import { VERDICT_FILE } from "@/tdd";

describe("clearStaleVerdictBeforeDispatch", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-test-verdict-predispatch-");
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("removes a verdict file left by an earlier story", async () => {
    const path = join(dir, VERDICT_FILE);
    await Bun.write(path, JSON.stringify({ version: 1, approved: true }));

    await clearStaleVerdictBeforeDispatch("verifier", dir);

    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("is a no-op for a phase that is not the verifier", async () => {
    const path = join(dir, VERDICT_FILE);
    await Bun.write(path, JSON.stringify({ version: 1, approved: true }));

    await clearStaleVerdictBeforeDispatch("implementer", dir);

    expect(await Bun.file(path).exists()).toBe(true);
  });

  test("tolerates a missing file", async () => {
    await clearStaleVerdictBeforeDispatch("verifier", dir);

    expect(await Bun.file(join(dir, VERDICT_FILE)).exists()).toBe(false);
  });
});
