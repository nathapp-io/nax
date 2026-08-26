import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeStory, makeTempDir } from "@test/helpers";
import { greenfieldGateOp } from "@/operations";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";

function makePatterns(globs: string[]): ResolvedTestPatterns {
  return {
    globs,
    regex: [/\.test\.ts$/],
    pathspec: [],
    testDirs: ["test"],
    resolution: "fallback",
  };
}

describe("greenfieldGateOp — deterministic filesystem detection", () => {
  test("kind is deterministic (no LLM session)", () => {
    expect(greenfieldGateOp.kind).toBe("deterministic");
  });

  test("name is greenfield-gate", () => {
    expect(greenfieldGateOp.name).toBe("greenfield-gate");
  });

  test("has execute() function, not build()/parse()", () => {
    expect(typeof greenfieldGateOp.execute).toBe("function");
    expect("build" in greenfieldGateOp).toBe(false);
    expect("parse" in greenfieldGateOp).toBe(false);
  });

  test("returns hasPreExistingTests=true when test files exist", async () => {
    const dir = makeTempDir();
    try {
      // Use a flat file in workdir root so scanForTestFiles (which tests entry.name) finds it
      await writeFile(join(dir, "example.test.ts"), "");
      const ctx = makeMockCallContext();
      const out = await greenfieldGateOp.execute(
        {
          story: makeStory({ id: "s1" }),
          workdir: dir,
          // **/*.test.ts produces a regex that matches on filename alone
          resolvedTestPatterns: makePatterns(["**/*.test.ts"]),
        },
        ctx,
      );
      expect(out.success).toBe(true);
      expect(out.hasPreExistingTests).toBe(true);
      expect(out.pauseReason).toBeUndefined();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns success=false, pauseReason='greenfield-no-tests' when no test files exist", async () => {
    const dir = makeTempDir();
    try {
      const ctx = makeMockCallContext();
      const out = await greenfieldGateOp.execute(
        {
          story: makeStory({ id: "s2" }),
          workdir: dir,
          resolvedTestPatterns: makePatterns(["**/*.test.ts"]),
        },
        ctx,
      );
      expect(out.success).toBe(false);
      expect(out.hasPreExistingTests).toBe(false);
      expect(out.pauseReason).toBe("greenfield-no-tests");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns success=true (safe fallback) when workdir does not exist (scan error absorbed)", async () => {
    const ctx = makeMockCallContext();
    const out = await greenfieldGateOp.execute(
      {
        story: makeStory({ id: "s3" }),
        workdir: "/tmp/nax-test-nonexistent-dir-xyz-99999",
        resolvedTestPatterns: makePatterns(["**/*.test.ts"]),
      },
      ctx,
    );
    // hasTestFilesOnDisk throws on a missing dir; the gate catches it and does NOT
    // pause the story on a flaky scan → success=true, hasPreExistingTests=true.
    expect(out.success).toBe(true);
    expect(out.hasPreExistingTests).toBe(true);
  });

  test("detects an UNTRACKED test file in a git repo (regression: must not use git ls-files)", async () => {
    const dir = makeTempDir();
    try {
      await Bun.spawn(["git", "init"], { cwd: dir }).exited;
      await writeFile(join(dir, "index.ts"), "export const x = 1;");
      await Bun.spawn(["git", "add", "index.ts"], { cwd: dir }).exited;
      await Bun.spawn(["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-m", "init"], {
        cwd: dir,
      }).exited;
      // Test-writer authored a test file — committed source, but the test is UNTRACKED.
      await mkdir(join(dir, "test"), { recursive: true });
      await writeFile(join(dir, "test", "index.test.ts"), "test('x', () => {});");
      const out = await greenfieldGateOp.execute(
        {
          story: makeStory({ id: "s5" }),
          workdir: dir,
          resolvedTestPatterns: makePatterns(["test/**/*.test.ts"]),
        },
        makeMockCallContext(),
      );
      expect(out.success).toBe(true);
      expect(out.hasPreExistingTests).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("does NOT count a .nax/ acceptance harness as a test file", async () => {
    const dir = makeTempDir();
    try {
      await mkdir(join(dir, ".nax", "features", "feat"), { recursive: true });
      await writeFile(join(dir, ".nax", "features", "feat", ".nax-acceptance.test.ts"), "test('ac', () => {});");
      const out = await greenfieldGateOp.execute(
        {
          story: makeStory({ id: "s6" }),
          workdir: dir,
          resolvedTestPatterns: makePatterns(["**/*.test.ts"]),
        },
        makeMockCallContext(),
      );
      expect(out.success).toBe(false);
      expect(out.hasPreExistingTests).toBe(false);
      expect(out.pauseReason).toBe("greenfield-no-tests");
    } finally {
      cleanupTempDir(dir);
    }
  });
});
