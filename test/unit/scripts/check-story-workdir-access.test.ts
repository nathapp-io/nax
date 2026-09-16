import { describe, expect, test } from "bun:test";
import { findStaleExemptions, findViolations, isStoryReceiver } from "@scripts/check-story-workdir-access";

describe("isStoryReceiver", () => {
  test.each([["story"], ["this.story"], ["input.story"], ["ctx.story"], ["completedStory"], ["s"]])(
    "flags %p",
    (receiver) => {
      expect(isStoryReceiver(receiver)).toBe(true);
    },
  );

  test.each([["ctx"], ["input"], ["request"], ["gateCtx"], ["existing"], ["data"]])("does not flag %p", (receiver) => {
    expect(isStoryReceiver(receiver)).toBe(false);
  });
});

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
  test("flags a raw read", () => {
    const found = findViolations("a.ts", "const w = story.workdir ?? '';");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(1);
  });

  test("flags a nested receiver", () => {
    expect(findViolations("a.ts", "reframe(body, this.story.workdir);")).toHaveLength(1);
  });

  test("ignores a non-story receiver", () => {
    expect(findViolations("a.ts", "const w = ctx.workdir;")).toHaveLength(0);
  });

  test("ignores line comments and doc comments", () => {
    expect(findViolations("a.ts", "// story.workdir is repo-relative")).toHaveLength(0);
    expect(findViolations("a.ts", " * When story.workdir is set, ...")).toHaveLength(0);
  });

  test("ignores an accessor call", () => {
    expect(findViolations("a.ts", "const w = storyWorkdir(story);")).toHaveLength(0);
  });

  test("reports every occurrence on separate lines", () => {
    const source = ["const a = story.workdir;", "const b = input.story.workdir;"].join("\n");
    expect(findViolations("a.ts", source)).toHaveLength(2);
  });
});
