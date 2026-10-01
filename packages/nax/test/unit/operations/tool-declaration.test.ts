import { describe, expect, test } from "bun:test";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
import { resolveDeclaredTools } from "@/operations/types";

describe("resolveDeclaredTools", () => {
  test("an op declaring nothing gets the default read set", () => {
    expect(resolveDeclaredTools({})).toEqual(DEFAULT_CODING_TOOLS);
  });

  test("an explicit empty array opts out entirely", () => {
    expect(resolveDeclaredTools({ tools: [] })).toEqual([]);
  });

  test("an explicit declaration is used verbatim", () => {
    expect(resolveDeclaredTools({ tools: ["Read", "Git"] })).toEqual(["Read", "Git"]);
  });

  test("the default set excludes the mutating and broad tools", () => {
    for (const excluded of ["Write", "Edit", "Git"]) {
      expect(DEFAULT_CODING_TOOLS).not.toContain(excluded);
    }
  });
});
