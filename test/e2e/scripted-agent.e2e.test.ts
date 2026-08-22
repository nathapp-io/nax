import { describe, expect, test } from "bun:test";
import type { SendTurnOpts, SessionHandle } from "@/agents/types";
import { makeScriptedAgent } from "@test/helpers";

function fakeHandle(role: string): SessionHandle {
  return { id: `nax-abcd1234-feat-US-001-${role}`, agentName: "claude", role: role as never };
}
const noopOpts = { interactionHandler: {} as never } satisfies SendTurnOpts;

describe("E2E: makeScriptedAgent", () => {
  test("dispatches sendTurn by role and attempt", async () => {
    const seen: string[] = [];
    const agent = makeScriptedAgent({
      "test-writer": (attempt) => ({ output: `tw-${attempt}` }),
      implementer: (attempt) => ({ output: `impl-${attempt}` }),
    });

    const r1 = await agent.sendTurn(fakeHandle("test-writer"), "p", noopOpts);
    const r2 = await agent.sendTurn(fakeHandle("test-writer"), "p", noopOpts);
    const r3 = await agent.sendTurn(fakeHandle("implementer"), "p", noopOpts);
    seen.push(r1.output, r2.output, r3.output);

    expect(seen).toEqual(["tw-0", "tw-1", "impl-0"]);
  });

  test("unknown role returns benign success turn", async () => {
    const agent = makeScriptedAgent({});
    const r = await agent.sendTurn(fakeHandle("verifier"), "p", noopOpts);
    expect(r.output).toBe("{}");
    expect(r.estimatedCostUsd).toBe(0);
  });
});
