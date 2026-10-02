import { describe, expect, test } from "bun:test";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";

describe("GitCommit default grant (stays in nax: DEFAULT_CODING_TOOLS is nax config)", () => {
  test("is NOT in the default grant -- mutation is always explicit", () => {
    expect(DEFAULT_CODING_TOOLS).not.toContain("GitCommit");
  });
});
