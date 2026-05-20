import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { greenfieldGateOp } from "@/operations";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";

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

  test("returns success=true (safe fallback) when workdir does not exist (isGreenfieldStory absorbs error)", async () => {
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
    // isGreenfieldStory catches filesystem errors from the root call and re-throws,
    // then the outer try-catch in isGreenfieldStory's wrapper returns false (not greenfield).
    // Wait — actually looking at the code: scanForTestFiles throws for root call,
    // and isGreenfieldStory catches all errors and returns false (= not greenfield = has tests).
    // So success=true, hasPreExistingTests=true.
    expect(out.success).toBe(true);
    expect(out.hasPreExistingTests).toBe(true);
  });
});
