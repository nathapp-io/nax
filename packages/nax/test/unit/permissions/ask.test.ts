import { describe, expect, test } from "bun:test";
import { ASK_UNAVAILABLE_REASON, headlessAskResolver } from "@/permissions";

describe("headlessAskResolver", () => {
  test("always resolves to deny", async () => {
    const resolver = headlessAskResolver();
    const verdict = await resolver.resolve({
      tool: "Write",
      stage: "run",
      rule: "Write(src/**)",
      summary: "Write src/x.ts",
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("ASK_UNAVAILABLE_REASON names the missing approval channel", () => {
    expect(ASK_UNAVAILABLE_REASON).toContain("approval channel");
    expect(ASK_UNAVAILABLE_REASON).toContain("refused");
  });
});
