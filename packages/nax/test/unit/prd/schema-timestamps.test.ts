import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { validatePlanOutput } from "@/prd/schema";

const raw = {
  userStories: [
    makeStory({
      acceptanceCriteria: ["works"],
      routing: { complexity: "simple", testStrategy: "tdd-simple", reasoning: "test" },
    }),
  ],
  createdAt: "2026-12-04T00:00:00.000Z",
  updatedAt: "wrong",
};

describe("validatePlanOutput timestamps", () => {
  test("stamps both dates from the supplied clock, ignoring model dates", () => {
    const prd = validatePlanOutput(raw, "f", "feat/f", new Date("2026-11-12T00:00:00.000Z"));
    expect(prd.createdAt).toBe("2026-11-12T00:00:00.000Z");
    expect(prd.updatedAt).toBe("2026-11-12T00:00:00.000Z");
  });

  test("uses the current time when no clock is supplied", () => {
    const before = Date.now();
    const prd = validatePlanOutput(raw, "f", "feat/f");
    expect(Math.abs(Date.parse(prd.createdAt) - before)).toBeLessThan(1000);
  });
});
