import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

describe("removed config defaults", () => {
  test.each([
    ["review.conflictDetection", "review", "conflictDetection"],
    ["review.parseRetryMaxAttempts", "review", "parseRetryMaxAttempts"],
    ["quality.testing", "quality", "testing"],
  ] as const)("does not include %s", (_path, parent, key) => {
    const config = NaxConfigSchema.parse({});
    expect(Object.hasOwn(config[parent], key)).toBe(false);
  });

  test("does not include prompts", () => {
    expect(Object.hasOwn(NaxConfigSchema.parse({}), "prompts")).toBe(false);
  });
});
