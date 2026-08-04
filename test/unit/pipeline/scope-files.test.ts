/**
 * Unit tests for resolveScopeFiles() — Story: Resolve and thread complete scope files.
 *
 * Covers AC-1 through AC-7: the diff/union/dedupe/sort composition of the
 * scope-file resolver and its fail-open behaviour when the git ref is
 * unresolvable, when collectDiffFileList returns undefined, and when
 * collectDiffFileList rejects.
 *
 * AC-8/AC-9 (context and prompt stages threading) and AC-10/AC-11
 * (assembleForStage threading) live in:
 *   - test/unit/pipeline/stages/context-scope-files.test.ts
 *   - test/unit/pipeline/stages/prompt-scope-files.test.ts
 *   - test/unit/context/engine/stage-assembler-scope-files.test.ts
 *
 * Tests rely on `_scopeFilesDeps` injection — no `mock.module()`, no real git.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PipelineContext } from "@/pipeline";
import { _scopeFilesDeps, resolveScopeFiles } from "@/pipeline";
import type { UserStory } from "@/prd/types";
import { makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals (restored per test)
// ─────────────────────────────────────────────────────────────────────────────

let origResolveEffectiveRef: typeof _scopeFilesDeps.resolveEffectiveRef;
let origCollectDiffFileList: typeof _scopeFilesDeps.collectDiffFileList;

beforeEach(() => {
  origResolveEffectiveRef = _scopeFilesDeps.resolveEffectiveRef;
  origCollectDiffFileList = _scopeFilesDeps.collectDiffFileList;
});

afterEach(() => {
  _scopeFilesDeps.resolveEffectiveRef = origResolveEffectiveRef;
  _scopeFilesDeps.collectDiffFileList = origCollectDiffFileList;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(story: UserStory, workdir = "/repo"): PipelineContext {
  return {
    story,
    workdir,
    projectDir: workdir,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: union of contextFiles and expectedFiles when diff yields no additional files
// AC-2: no duplicates when a path appears in both contextFiles and the git diff
//       (collapsed here as: union contains every entry exactly once)
// AC-3: ascending lexicographic order
// AC-4: includes a collectDiffFileList() path absent from contextFiles/expectedFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveScopeFiles — union / dedupe / sort / diff merging", () => {
  test("AC-1: returns union of contextFiles and expectedFiles when diff is empty", async () => {
    const story = makeStory({
      contextFiles: ["src/a.ts", "src/b.ts"],
      expectedFiles: ["src/c.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).toContain("src/c.ts");
    expect(result).toHaveLength(3);
  });

  test("AC-2: returns no duplicate entries when a path appears in both contextFiles and the diff", async () => {
    const story = makeStory({
      contextFiles: ["src/shared.ts", "src/declared-only.ts"],
      expectedFiles: [],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    // Diff includes "src/shared.ts" — must not produce a duplicate in result.
    _scopeFilesDeps.collectDiffFileList = async () => ["src/shared.ts", "src/diff-only.ts"];

    const result = await resolveScopeFiles(makeCtx(story));

    const sharedOccurrences = result.filter((p) => p === "src/shared.ts");
    expect(sharedOccurrences).toHaveLength(1);
    expect(result).toContain("src/declared-only.ts");
    expect(result).toContain("src/diff-only.ts");
  });

  test("AC-2 (related): collapses duplicates when the same path appears in both contextFiles and expectedFiles", async () => {
    const story = makeStory({
      contextFiles: ["src/x.ts"],
      expectedFiles: ["src/x.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["src/x.ts"]);
  });

  test("AC-3: returns entries in ascending lexicographic order", async () => {
    const story = makeStory({
      // Intentionally unsorted inputs to assert the resolver sorts.
      contextFiles: ["src/zeta.ts", "src/alpha.ts"],
      expectedFiles: ["src/middle.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["src/alpha.ts", "src/middle.ts", "src/zeta.ts"]);
  });

  test("AC-4: includes a collectDiffFileList() path absent from contextFiles and expectedFiles", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: [],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => ["src/from-diff-only.ts"];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toContain("src/declared.ts");
    expect(result).toContain("src/from-diff-only.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 / AC-6 / AC-7 — fail-open: declared sources only, no throw
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveScopeFiles — fail-open behaviour", () => {
  test("AC-5: returns only declared contextFiles+expectedFiles without throwing when resolveEffectiveRef resolves undefined", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: ["src/expected.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => undefined;
    _scopeFilesDeps.collectDiffFileList = async () => {
      throw new Error("should not be called when ref is undefined");
    };

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toContain("src/declared.ts");
    expect(result).toContain("src/expected.ts");
  });

  test("AC-6: returns only declared contextFiles+expectedFiles without throwing when collectDiffFileList resolves undefined", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: ["src/expected.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => undefined;

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toContain("src/declared.ts");
    expect(result).toContain("src/expected.ts");
  });

  test("AC-7: returns only declared contextFiles+expectedFiles without throwing when collectDiffFileList rejects", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: ["src/expected.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => {
      throw new Error("git command failed");
    };

    // Must not throw — fail-open returns declared sources only.
    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toContain("src/declared.ts");
    expect(result).toContain("src/expected.ts");
  });
});
