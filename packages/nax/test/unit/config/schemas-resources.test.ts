import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

describe("NaxConfigSchema resources", () => {
  test("AC-1 defaults to Claude Code on and run skills off", () => {
    expect(NaxConfigSchema.parse({}).resources).toEqual({ claudeCode: true, skillsInRun: false, mcpInRun: false });
  });

  test("AC-2 rejects non-boolean skillsInRun", () => {
    expect(NaxConfigSchema.safeParse({ resources: { skillsInRun: "yes" } }).success).toBe(false);
  });

  test("AC-3 defaults claudeCode on when skillsInRun is enabled", () => {
    expect(NaxConfigSchema.parse({ resources: { skillsInRun: true } }).resources).toEqual({
      claudeCode: true,
      skillsInRun: true,
      mcpInRun: false,
    });
  });

  test("AC-1 mcpInRun defaults to false", () => {
    expect(NaxConfigSchema.parse({}).resources.mcpInRun).toBe(false);
  });

  test("AC-2 rejects non-boolean mcpInRun", () => {
    expect(NaxConfigSchema.safeParse({ resources: { mcpInRun: "yes" } }).success).toBe(false);
  });
});
