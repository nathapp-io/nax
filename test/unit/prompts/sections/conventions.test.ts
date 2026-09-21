import { describe, expect, test } from "bun:test";
import { buildConventionsSection } from "@/prompts/sections/conventions";

describe("buildConventionsSection", () => {
  test("includes code pattern guidelines; includes commit message instruction; includes conventional commit format examples", () => {
    const result = buildConventionsSection();
    expect(result).toContain("code patterns");
    expect(result).toContain("commit");
    expect(result).toContain("feat:");
  });

  test("is a pure function", () => {
    const result1 = buildConventionsSection();
    const result2 = buildConventionsSection();
    expect(result1).toEqual(result2);
  });
});
