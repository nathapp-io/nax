import { describe, expect, test } from "bun:test";
import { closeImplementerSession } from "@/workflow/sessions";

describe("closeImplementerSession", () => {
  test("a getForStory throw is contained, not propagated", async () => {
    const sessionManager = {
      getForStory: () => {
        throw new Error("registry down");
      },
      getLiveHandle: () => undefined,
      closeSession: async () => {},
    };
    await expect(closeImplementerSession(sessionManager, "US-001")).resolves.toBeUndefined();
  });
});
