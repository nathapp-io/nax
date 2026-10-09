import { describe, expect, test } from "bun:test";
import { NAX_AGENT_AUTH } from "#src/server/auth";

describe("NAX_AGENT_AUTH", () => {
  test("builds a terminal interaction around the given log", () => {
    const interaction = NAX_AGENT_AUTH.interaction(() => undefined);
    expect(typeof interaction.prompt).toBe("function");
    expect(typeof interaction.notify).toBe("function");
  });
});
