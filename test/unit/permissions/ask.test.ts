import { describe, expect, test } from "bun:test";
import { ASK_UNAVAILABLE_REASON, headlessAskResolver } from "@/permissions";

describe("headlessAskResolver", () => {
  test("always resolves to deny", async () => {
    const resolver = headlessAskResolver();
    const decision = await resolver.resolve({
      tool: "Write",
      stage: "run",
      rule: "Write(src/**)",
      summary: "Write src/x.ts",
    });
    expect(decision).toBe("deny");
  });

  test("ASK_UNAVAILABLE_REASON names the headless limitation", () => {
    expect(ASK_UNAVAILABLE_REASON).toContain("headless");
    expect(ASK_UNAVAILABLE_REASON).toContain("approval");
  });
});
