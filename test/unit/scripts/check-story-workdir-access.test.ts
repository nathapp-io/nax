import { describe, expect, test } from "bun:test";
import { findStaleExemptions, findViolations } from "@scripts/check-story-workdir-access";

/**
 * The walker keys on DECLARED type (nax#2084). Each test fixture therefore
 * declares the receiver's type at the top so the walker can resolve it from
 * the in-file binding map. Without an explicit `: UserStory` annotation the
 * walker cannot tell the receiver is a story — that is the point: the regex's
 * name-based heuristic is dropped, and a re-bind to a non-`*story` name now
 * requires explicit type to be flagged.
 *
 * The original brief suggested `const target = prd.userStories[i]; target.workdir`
 * as the case-4 fixture. Resolving `target`'s inferred type would need a real
 * checker, which TypeScript 7 does not expose to JavaScript (the `ts` import
 * only carries `version`; the old `createProgram`/`createSourceFile` are gone).
 * The fixture below is parse-only detectable: the explicit annotation is what
 * the walker reads. Production code is free to keep using inferred bindings —
 * the gate then does not flag it, which is the trade-off a type-aware walk
 * makes on purpose.
 */

describe("findStaleExemptions", () => {
  test("reports an exemption that matched no read", () => {
    expect(findStaleExemptions(["a.ts"], new Set())).toEqual(["a.ts"]);
  });
  test("does not report a used exemption", () => {
    expect(findStaleExemptions(["a.ts"], new Set(["a.ts"]))).toEqual([]);
  });
  test("is empty when there are no exemptions", () => {
    expect(findStaleExemptions([], new Set(["a.ts"]))).toEqual([]);
  });
});

describe("findViolations", () => {
  test("flags a raw read on a UserStory binding", () => {
    const src = "declare const story: UserStory;\nconst w = story.workdir ?? '';";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags a property-access chain where the root binding has UserStory type", () => {
    const src = "declare const story: UserStory;\nreframe(body, story.workdir);";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("ignores a non-story receiver (no UserStory type)", () => {
    expect(findViolations("a.ts", "declare const ctx: { workdir: string };\nconst w = ctx.workdir;")).toHaveLength(0);
  });

  test("ignores line comments and doc comments", () => {
    const src = [
      "declare const story: UserStory;",
      "// story.workdir is repo-relative",
      "/** When story.workdir is set, the plan-time writer is the SSOT. */",
      "/* story.workdir can also appear in a block comment. */",
    ].join("\n");
    expect(findViolations("a.ts", src)).toHaveLength(0);
  });

  test("ignores an accessor call", () => {
    expect(findViolations("a.ts", "declare const story: UserStory;\nconst w = storyWorkdir(story);")).toHaveLength(0);
  });

  test("reports every occurrence on separate lines", () => {
    const src = [
      "declare const a: UserStory;",
      "declare const story: UserStory;",
      "const x = a.workdir;",
      "const y = story.workdir;",
    ].join("\n");
    expect(findViolations("a.ts", src)).toHaveLength(2);
  });
});

describe("findViolations bypass idioms (nax#2084)", () => {
  test("flags optional chaining story?.workdir", () => {
    const src = "declare const story: UserStory;\nconst w = story?.workdir ?? '.';";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags destructuring const { workdir } = story", () => {
    const src = "declare const story: UserStory;\nconst { workdir } = story;";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags element access story['workdir']", () => {
    const src = "declare const story: UserStory;\nconst w = story['workdir'];";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test('flags element access story["workdir"]', () => {
    const src = 'declare const story: UserStory;\nconst w = story["workdir"];';
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("flags target.workdir when target has UserStory type (non-*story name)", () => {
    const src = "declare const target: UserStory;\nconst w = target.workdir;";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  test("does not flag target.workdir when target lacks a story type", () => {
    const src = "declare const target: { other: string };\nconst w = target.other;";
    expect(findViolations("a.ts", src)).toHaveLength(0);
  });

  test("does not flag storyWorkdir(story) accessor call", () => {
    expect(findViolations("a.ts", "declare const story: UserStory;\nconst w = storyWorkdir(story);")).toHaveLength(0);
  });

  test("does not flag destructuring from a non-story options object", () => {
    const src = "declare const someNonStoryOptions: { workdir: string };\nconst { workdir } = someNonStoryOptions;";
    expect(findViolations("a.ts", src)).toHaveLength(0);
  });

  test("does not flag ctx.workdir on a context type (not UserStory)", () => {
    const src = "declare const ctx: { workdir?: string };\nconst w = ctx.workdir;";
    expect(findViolations("a.ts", src)).toHaveLength(0);
  });

  test("also keys on StoryWorkdirLike (path-frame.ts structural type)", () => {
    const src = "declare const story: StoryWorkdirLike;\nconst w = story.workdir ?? '.';";
    const found = findViolations("a.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });
});
