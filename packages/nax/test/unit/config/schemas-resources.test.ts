import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

describe("NaxConfigSchema resources", () => {
  test("AC-1 defaults to Claude Code on and run skills off", () => {
    expect(NaxConfigSchema.parse({}).resources).toEqual({ claudeCode: true, skillsInRun: false });
  });

  test("AC-2 rejects non-boolean skillsInRun", () => {
    expect(NaxConfigSchema.safeParse({ resources: { skillsInRun: "yes" } }).success).toBe(false);
  });

  test("AC-3 defaults claudeCode on when skillsInRun is enabled", () => {
    expect(NaxConfigSchema.parse({ resources: { skillsInRun: true } }).resources).toEqual({
      claudeCode: true,
      skillsInRun: true,
    });
  });
});
