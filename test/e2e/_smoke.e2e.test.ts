import { describe, expect, test } from "bun:test";

describe("E2E: smoke", () => {
  test("test/e2e suite executes", () => {
    expect(1 + 1).toBe(2);
  });
});
