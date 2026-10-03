import { describe, expect, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "#src/session/no-op-interaction-handler";

describe("NO_OP_INTERACTION_HANDLER", () => {
  test("answers every interaction with null", async () => {
    expect(await NO_OP_INTERACTION_HANDLER.onInteraction()).toBeNull();
  });

  test("is the same object the package barrel exports", async () => {
    const barrel = await import("@nathapp/nax-agent");
    expect(barrel.NO_OP_INTERACTION_HANDLER).toBe(NO_OP_INTERACTION_HANDLER);
  });
});
