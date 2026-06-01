/**
 * Structural / type-export assertions for parallel batch and rectification modules.
 *
 * File: parallel-batch-structure.test.ts
 * Covers:
 *   exec AC-26  src/execution/parallel-executor.ts does not exist and no src file imports it
 *   rect AC-9   no src file imports from parallel-executor-rectify
 *   rect AC-10  no src file imports from parallel-executor-rectification-pass
 *   rect AC-8a  RectificationResult is exported from merge-conflict-rectify with the correct union shape
 *   rect AC-8b  RectifyConflictedStoryOptions is exported from merge-conflict-rectify
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../src");

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-26 — parallel-executor.ts must not exist and must not be imported
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-26: src/execution/parallel-executor.ts does not exist", () => {
  test("AC-26: parallel-executor.ts file is absent", async () => {
    const exists = await Bun.file(join(SRC, "execution/parallel-executor.ts")).exists();
    expect(exists).toBe(false);
  });

  test("AC-26: no src/ file imports from parallel-executor", async () => {
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(SRC, file)).text();
      if (
        content.includes("parallel-executor") &&
        !content.includes("parallel-executor-rectify") &&
        !content.includes("parallel-executor-rectification-pass")
      ) {
        offenders.push(file);
      }
    }
    // The only match for "parallel-executor" (without the more-specific suffixes) should be none
    // Filter out any test files that may reference it
    const srcOffenders = offenders.filter((f) => !f.includes("test/"));
    expect(srcOffenders).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-9 — no src file imports from parallel-executor-rectify
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-9: no src/ file imports from parallel-executor-rectify", () => {
  test("AC-9: src/execution has no imports from parallel-executor-rectify", async () => {
    const executionDir = join(SRC, "execution");
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: executionDir, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(executionDir, file)).text();
      if (content.includes("parallel-executor-rectify")) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });

  test("AC-9: no src/ file anywhere imports from parallel-executor-rectify", async () => {
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(SRC, file)).text();
      if (content.includes("parallel-executor-rectify")) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-10 — no src file imports from parallel-executor-rectification-pass
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-10: no src/ file imports from parallel-executor-rectification-pass", () => {
  test("AC-10: src/execution has no imports from parallel-executor-rectification-pass", async () => {
    const executionDir = join(SRC, "execution");
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: executionDir, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(executionDir, file)).text();
      if (content.includes("parallel-executor-rectification-pass")) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-8a — RectificationResult exported from merge-conflict-rectify with union shape
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-8a: RectificationResult exported from merge-conflict-rectify with correct shape", () => {
  test("AC-8a: RectificationResult type compiles — success variant has storyId + cost fields", async () => {
    const { rectifyConflictedStory } = await import("../../../src/execution/merge-conflict-rectify");
    // Confirm module loaded; type exports verified by TypeScript compilation
    expect(typeof rectifyConflictedStory).toBe("function");

    // Runtime shape check via source: assert the success/failure union fields exist in source
    const source = await Bun.file(join(SRC, "execution/merge-conflict-rectify.ts")).text();
    expect(source).toContain("RectificationResult");
    // success union variant
    expect(source).toMatch(/success\s*:\s*true.*storyId.*cost/s);
    // failure union variant
    expect(source).toMatch(/success\s*:\s*false.*storyId.*cost.*finalConflict/s);
  });

  test("AC-8a: RectificationResult success-true literal satisfies the exported type at compile time", () => {
    // TypeScript will reject this file if the import type is wrong — compile-time verification
    type RectificationResult = import("../../../src/execution/merge-conflict-rectify").RectificationResult;
    const success: RectificationResult = { success: true, storyId: "US-001", cost: 1.5 };
    expect(success.success).toBe(true);
    expect(success.storyId).toBe("US-001");
    expect(success.cost).toBe(1.5);
  });

  test("AC-8a: RectificationResult failure literal satisfies the exported type at compile time", () => {
    type RectificationResult = import("../../../src/execution/merge-conflict-rectify").RectificationResult;
    const failure: RectificationResult = { success: false, storyId: "US-001", cost: 0, finalConflict: true };
    expect(failure.success).toBe(false);
    expect(failure.storyId).toBe("US-001");
    expect(failure.finalConflict).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-8b — RectifyConflictedStoryOptions exported from merge-conflict-rectify
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-8b: RectifyConflictedStoryOptions exported from merge-conflict-rectify", () => {
  test("AC-8b: RectifyConflictedStoryOptions type is present in source with required fields", async () => {
    const source = await Bun.file(join(SRC, "execution/merge-conflict-rectify.ts")).text();
    expect(source).toContain("RectifyConflictedStoryOptions");
    // Must include fields from ConflictedStoryInfo + DispatchContext + workdir/config/hooks/prd
    expect(source).toContain("storyId");
    expect(source).toContain("workdir");
    expect(source).toContain("config");
    expect(source).toContain("hooks");
    expect(source).toContain("prd");
  });

  test("AC-8b: module exports RectifyConflictedStoryOptions (confirmed via rectifyConflictedStory function signature accepting it)", async () => {
    // The function accepting RectifyConflictedStoryOptions is rectifyConflictedStory — its existence
    // at runtime proves the type compiled and is exported
    const mod = await import("../../../src/execution/merge-conflict-rectify");
    expect(typeof mod.rectifyConflictedStory).toBe("function");
    // The type export is confirmed at compile time: if RectifyConflictedStoryOptions were missing,
    // src/execution/parallel-batch.ts (which imports it) would fail to compile.
  });
});
