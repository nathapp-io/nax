import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testPresenceGateOp } from "@/operations";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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

  test("returns success=true (safe fallback) when workdir does not exist (isGreenfieldStory absorbs error)", async () => {
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
    // isGreenfieldStory catches filesystem errors and returns false (= not greenfield = has tests)
    // so success=true, hasTests=true.
    expect(out.success).toBe(true);
    expect(out.hasTests).toBe(true);
  });
});
