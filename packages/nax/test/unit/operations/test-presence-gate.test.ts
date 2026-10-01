import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeStory, makeTempDir } from "@test/helpers";
import { type TestPresenceGateInput, testPresenceGateOp } from "@/operations";
import type { UserStory } from "@/prd";

/**
 * Complete TestPresenceGateInput fixture. The op reads only `story`, `workdir`
 * and `resolvedTestPatterns.globs`; the remaining pattern formats are filled
 * with the values every call site here already passed, plus a `resolution`
 * tier (required by ResolvedTestPatterns) matching the hand-declared patterns.
 */
function makeGateInput(story: UserStory, workdir: string, globs: string[]): TestPresenceGateInput {
  return {
    story,
    workdir,
    resolvedTestPatterns: {
      globs,
      regex: [/\.test\.ts$/],
      pathspec: [],
      testDirs: ["test"],
      resolution: "root-config",
    },
  };
}

describe("testPresenceGateOp — post-implementer test presence check", () => {
  test("kind is deterministic (no LLM session)", () => {
    expect(testPresenceGateOp.kind).toBe("deterministic");
  });

  test("name is test-presence-gate", () => {
    expect(testPresenceGateOp.name).toBe("test-presence-gate");
  });

  test("has execute() function, not build()/parse()", () => {
    expect(typeof testPresenceGateOp.execute).toBe("function");
    // Probe members DeterministicOperation deliberately lacks — the intersection
    // keeps the read checked while admitting the absence assertion.
    const op = testPresenceGateOp as typeof testPresenceGateOp & Record<string, unknown>;
    expect(op.build).toBeUndefined();
    expect(op.parse).toBeUndefined();
  });

  test("returns hasTests=true when a test file exists in workdir", async () => {
    const dir = makeTempDir();
    try {
      await writeFile(join(dir, "example.test.ts"), "");
      const ctx = makeMockCallContext();
      const out = await testPresenceGateOp.execute(makeGateInput(makeStory({ id: "s1" }), dir, ["**/*.test.ts"]), ctx);
      expect(out.success).toBe(true);
      expect(out.hasTests).toBe(true);
      expect(out.pauseReason).toBeUndefined();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns success=false, hasTests=false, pauseReason='no-tests-authored' when no test files exist", async () => {
    const dir = makeTempDir();
    try {
      const ctx = makeMockCallContext();
      const out = await testPresenceGateOp.execute(makeGateInput(makeStory({ id: "s2" }), dir, ["**/*.test.ts"]), ctx);
      expect(out.success).toBe(false);
      expect(out.hasTests).toBe(false);
      expect(out.pauseReason).toBe("no-tests-authored");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns hasTests=true when test file is in a subdirectory", async () => {
    const dir = makeTempDir();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "utils.test.ts"), "");
      const ctx = makeMockCallContext();
      const out = await testPresenceGateOp.execute(makeGateInput(makeStory({ id: "s3" }), dir, ["**/*.test.ts"]), ctx);
      expect(out.success).toBe(true);
      expect(out.hasTests).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns success=true (safe fallback) when workdir does not exist (scan error absorbed)", async () => {
    const ctx = makeMockCallContext();
    const out = await testPresenceGateOp.execute(
      makeGateInput(makeStory({ id: "s4" }), "/tmp/nax-test-nonexistent-dir-xyz-99999-presence", ["**/*.test.ts"]),
      ctx,
    );
    // hasTestFilesOnDisk throws on a missing dir; the gate catches it and does NOT
    // block the story on a flaky scan → success=true, hasTests=true.
    expect(out.success).toBe(true);
    expect(out.hasTests).toBe(true);
  });

  test("detects an UNTRACKED authored test file in a git repo (regression: must not use git ls-files)", async () => {
    const dir = makeTempDir();
    try {
      await Bun.spawn(["git", "init"], { cwd: dir }).exited;
      await writeFile(join(dir, "index.ts"), "export const x = 1;");
      await Bun.spawn(["git", "add", "index.ts"], { cwd: dir }).exited;
      await Bun.spawn(["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-m", "init"], {
        cwd: dir,
      }).exited;
      // Implementer authors a test file — committed source, but the test is UNTRACKED.
      await mkdir(join(dir, "test"), { recursive: true });
      await writeFile(join(dir, "test", "index.test.ts"), "test('x', () => {});");
      const out = await testPresenceGateOp.execute(
        makeGateInput(makeStory({ id: "s5" }), dir, ["test/**/*.test.ts"]),
        makeMockCallContext(),
      );
      expect(out.success).toBe(true);
      expect(out.hasTests).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("does NOT count a .nax/ acceptance harness as an authored test", async () => {
    const dir = makeTempDir();
    try {
      // Only a nax-generated harness exists under .nax/ — no real source tests.
      await mkdir(join(dir, ".nax", "features", "feat"), { recursive: true });
      await writeFile(join(dir, ".nax", "features", "feat", ".nax-acceptance.test.ts"), "test('ac', () => {});");
      const out = await testPresenceGateOp.execute(
        makeGateInput(makeStory({ id: "s6" }), dir, ["**/*.test.ts"]),
        makeMockCallContext(),
      );
      expect(out.success).toBe(false);
      expect(out.hasTests).toBe(false);
      expect(out.pauseReason).toBe("no-tests-authored");
    } finally {
      cleanupTempDir(dir);
    }
  });
});
