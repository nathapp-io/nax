import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { testPresenceGateOp } from "@/operations";

describe("testPresenceGateOp — post-implementer test presence check", () => {
  test("kind is deterministic (no LLM session)", () => {
    expect(testPresenceGateOp.kind).toBe("deterministic");
  });

  test("name is test-presence-gate", () => {
    expect(testPresenceGateOp.name).toBe("test-presence-gate");
  });

  test("has execute() function, not build()/parse()", () => {
    expect(typeof (testPresenceGateOp as any).execute).toBe("function");
    expect((testPresenceGateOp as any).build).toBeUndefined();
    expect((testPresenceGateOp as any).parse).toBeUndefined();
  });

  test("returns hasTests=true when a test file exists in workdir", async () => {
    const dir = makeTempDir();
    try {
      await writeFile(join(dir, "example.test.ts"), "");
      const ctx = { runtime: {} } as any;
      const out = await (testPresenceGateOp as any).execute(
        {
          story: { id: "s1" } as any,
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
      const ctx = { runtime: {} } as any;
      const out = await (testPresenceGateOp as any).execute(
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
      const ctx = { runtime: {} } as any;
      const out = await (testPresenceGateOp as any).execute(
        {
          story: { id: "s3" } as any,
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
      expect(out.success).toBe(true);
      expect(out.hasTests).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns success=true (safe fallback) when workdir does not exist (scan error absorbed)", async () => {
    const ctx = { runtime: {} } as any;
    const out = await (testPresenceGateOp as any).execute(
      {
        story: { id: "s4" } as any,
        workdir: "/tmp/nax-test-nonexistent-dir-xyz-99999-presence",
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
      const out = await (testPresenceGateOp as any).execute(
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
      const out = await (testPresenceGateOp as any).execute(
        {
          story: { id: "s6" } as any,
          workdir: dir,
          resolvedTestPatterns: { globs: ["**/*.test.ts"], regex: [/\.test\.ts$/], pathspec: [], testDirs: ["test"] },
        },
        { runtime: {} } as any,
      );
      expect(out.success).toBe(false);
      expect(out.hasTests).toBe(false);
      expect(out.pauseReason).toBe("no-tests-authored");
    } finally {
      cleanupTempDir(dir);
    }
  });
});
