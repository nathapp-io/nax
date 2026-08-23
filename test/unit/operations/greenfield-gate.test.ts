import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { greenfieldGateOp } from "@/operations";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("greenfieldGateOp — deterministic filesystem detection", () => {
  test("kind is deterministic (no LLM session)", () => {
    expect(greenfieldGateOp.kind).toBe("deterministic");
  });

  test("name is greenfield-gate", () => {
    expect(greenfieldGateOp.name).toBe("greenfield-gate");
  });

  test("has execute() function, not build()/parse()", () => {
    expect(typeof (greenfieldGateOp as any).execute).toBe("function");
    expect((greenfieldGateOp as any).build).toBeUndefined();
    expect((greenfieldGateOp as any).parse).toBeUndefined();
  });

  test("returns hasPreExistingTests=true when test files exist", async () => {
    const dir = makeTempDir();
    try {
      // Use a flat file in workdir root so scanForTestFiles (which tests entry.name) finds it
      await writeFile(join(dir, "example.test.ts"), "");
      const ctx = { runtime: {} } as any;
      const out = await (greenfieldGateOp as any).execute(
        {
          story: { id: "s1" } as any,
          workdir: dir,
          // **/*.test.ts produces a regex that matches on filename alone
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [],
            testDirs: ["test"],
          },
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
      const ctx = { runtime: {} } as any;
      const out = await (greenfieldGateOp as any).execute(
        {
          story: { id: "s2" } as any,
          workdir: dir,
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [],
            testDirs: ["test"],
          },
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
    const ctx = { runtime: {} } as any;
    const out = await (greenfieldGateOp as any).execute(
      {
        story: { id: "s3" } as any,
        workdir: "/tmp/nax-test-nonexistent-dir-xyz-99999",
        resolvedTestPatterns: {
          globs: ["**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [],
          testDirs: ["test"],
        },
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
      const out = await (greenfieldGateOp as any).execute(
        {
          story: { id: "s5" } as any,
          workdir: dir,
          resolvedTestPatterns: {
            globs: ["test/**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [],
            testDirs: ["test"],
          },
        },
        { runtime: {} } as any,
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
      const out = await (greenfieldGateOp as any).execute(
        {
          story: { id: "s6" } as any,
          workdir: dir,
          resolvedTestPatterns: { globs: ["**/*.test.ts"], regex: [/\.test\.ts$/], pathspec: [], testDirs: ["test"] },
        },
        { runtime: {} } as any,
      );
      expect(out.success).toBe(false);
      expect(out.hasPreExistingTests).toBe(false);
      expect(out.pauseReason).toBe("greenfield-no-tests");
    } finally {
      cleanupTempDir(dir);
    }
  });
});
