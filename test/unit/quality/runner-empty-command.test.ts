import { describe, expect, test } from "bun:test";
import { runQualityCommand } from "@/quality";

describe("runQualityCommand empty-command guard", () => {
  test("returns failure (does not spawn) for an empty command", async () => {
    const result = await runQualityCommand({ commandName: "lint", command: "", workdir: "/tmp", storyId: "US-001" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("empty command");
  });

  test("returns failure for a whitespace-only command", async () => {
    const result = await runQualityCommand({ commandName: "lint", command: "   ", workdir: "/tmp", storyId: "US-001" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
  });
});
