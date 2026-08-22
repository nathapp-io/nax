import { describe, expect, test } from "bun:test";

describe("SuccessfulProposal source surface", () => {
  test("session-helpers.ts no longer declares a handle field on SuccessfulProposal", async () => {
    const source = await Bun.file("src/debate/session-helpers.ts").text();

    expect(source).not.toContain('handle?: import("../agents/types").SessionHandle;');
  });
});
