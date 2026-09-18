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
import { makeStory, makeTestContext } from "@test/helpers";
import type { PipelineContext } from "@/pipeline";
import { _scopeFilesDeps, resolveScopeFiles } from "@/pipeline";
import type { UserStory } from "@/prd/types";

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

// Note: production sets ctx.workdir = join(projectDir, story.workdir) (see
// src/pipeline/types.ts:89); every test here stubs both git deps, so ctx.workdir
// is only ever passed through to a stub and the relationship does not matter.
// Framing reads story.workdir, not ctx.workdir.
function makeCtx(story: UserStory, workdir = "/repo"): PipelineContext {
  return makeTestContext({ story, workdir, projectDir: workdir });
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

// ─────────────────────────────────────────────────────────────────────────────
// nax#2071: the union must be single-framed.
//
// Declared paths come from the PRD and are package-relative; collectDiffFileList
// runs without `--relative`, so git frames its output at the repo top-level
// regardless of cwd. Unioned raw, the same file appears under two spellings.
//
// The impact is narrower than the issue states. globToRegex anchors as
// `(?:^|/)...$` (static-rules.ts:158), so a repo-rooted entry CANNOT fail to
// match a package-relative `appliesTo` glob -- `src/**/*.ts` already matched
// `packages/app/src/index.ts` before this fix. What framing actually buys is
// (a) duplicate near-identical union entries collapse, and (b) a ROOT-ANCHORED
// `appliesTo` glob now matches the declared spelling, where before it could
// only match the diff-sourced one. Admission is monotone: framing only ever
// prepends, and the anchor accepts an internal `/`, so no rule admitted before
// can be dropped now.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveScopeFiles — nax#2071 canonical repo frame", () => {
  test("maps package-relative declared paths into the repo frame for a monorepo story", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/declared.ts"],
      expectedFiles: ["src/expected.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/declared.ts", "packages/app/src/expected.ts"]);
  });

  test("does not double-frame a declared path already spelled repo-rooted", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["packages/app/src/declared.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/declared.ts"]);
  });

  test("collapses the declared and diff spellings of the same file to one entry", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/shared.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    // Repo-rooted, as git emits without --relative.
    _scopeFilesDeps.collectDiffFileList = async () => ["packages/app/src/shared.ts"];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/shared.ts"]);
  });

  // Residual, blast radius nil today: a declared path that genuinely names a
  // SIBLING package is indistinguishable from a package-relative one, so
  // toRepoFrame prepends rather than passing it through. toRepoFrame only ever
  // prepends -- it never slices -- and its segment-boundary test is what
  // decides "already framed" from "needs a prefix". For THIS input a looser
  // startsWith(prefix) would happen to give the right answer; the boundary
  // guard is justified by the sibling-prefix case documented in path-frame.ts,
  // not by this one.
  //
  // The fabricated path cannot exist, but nothing stats a scopeFiles entry, so
  // it can only match or fail to match a glob -- and it still matches the
  // package-relative globs it did before. The exposure is a spurious match
  // against a root-anchored glob.
  //
  // nax#2067 does NOT retire this. Its plan-time pass canonicalizes declared
  // paths to the REPO frame (see the design spec's #2067 section), which makes
  // story-local paths arrive already framed -- so this call becomes a no-op for
  // them -- while a genuine sibling path still lands here and is still
  // prefixed. #2067 is what starts reliably producing this input; revisit the
  // case when that PR lands.
  test("prefixes a sibling-package path rather than treating it as already-framed", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["packages/application/src/other.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/packages/application/src/other.ts"]);
  });

  test("leaves a root story's declared paths unchanged", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: ["src/expected.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["src/declared.ts", "src/expected.ts"]);
  });

  test("frames declared paths on the degraded path too, when the ref is unresolvable", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/declared.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => undefined;
    _scopeFilesDeps.collectDiffFileList = async () => {
      throw new Error("should not be called when ref is undefined");
    };

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/declared.ts"]);
  });

  test("frames declared paths when resolveEffectiveRef throws", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/declared.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => {
      throw new Error("git command failed");
    };
    _scopeFilesDeps.collectDiffFileList = async () => {
      throw new Error("should not be called when resolveEffectiveRef throws");
    };

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/declared.ts"]);
  });

  test("frames declared paths when collectDiffFileList resolves undefined", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/declared.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => undefined;

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/declared.ts"]);
  });

  test("frames declared paths when collectDiffFileList rejects", async () => {
    const story = makeStory({
      workdir: "packages/app",
      contextFiles: ["src/declared.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => {
      throw new Error("git command failed");
    };

    const result = await resolveScopeFiles(makeCtx(story));

    expect(result).toEqual(["packages/app/src/declared.ts"]);
  });
});
