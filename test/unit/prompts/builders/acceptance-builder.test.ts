import { describe, expect, test } from "bun:test";
import { AcceptancePromptBuilder } from "@/prompts";

describe("AcceptancePromptBuilder.buildPathCorrection", () => {
  const target = "/repo/apps/web/.nax/features/foo/.nax-acceptance.test.tsx";

  test("embeds the exact target path", () => {
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt).toContain(target);
  });

  test("instructs the agent not to rename/sanitize and to preserve content", () => {
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt.toLowerCase()).toContain("exact");
    expect(prompt.toLowerCase()).toContain("do not");
    expect(prompt.toLowerCase()).toContain("preserve");
  });
});
