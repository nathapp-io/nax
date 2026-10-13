import { describe, expect, test } from "bun:test";
import type { SessionDescriptor } from "@/session";
import { TurnHooks } from "@/session/turn-hooks";

function makeDesc(id: string): SessionDescriptor {
  return {
    id,
    role: "implementer",
    state: "RUNNING",
    agent: "claude",
    workdir: "/tmp/nax-turn-hooks",
    storyId: "US-001",
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("TurnHooks.afterTurn (#2497)", () => {
  test("counts turns per session and passes the descriptor", async () => {
    const seen: [string, number][] = [];
    const hooks = new TurnHooks();
    hooks.setAfterTurn(async (d, turn) => {
      seen.push([d.id, turn]);
    });
    await hooks.afterTurn(makeDesc("sess-1"), "sess-1");
    await hooks.afterTurn(makeDesc("sess-1"), "sess-1");
    await hooks.afterTurn(makeDesc("sess-2"), "sess-2");
    expect(seen).toEqual([
      ["sess-1", 1],
      ["sess-1", 2],
      ["sess-2", 1],
    ]);
  });

  test("a throwing hook is swallowed", async () => {
    const hooks = new TurnHooks();
    hooks.setAfterTurn(async () => {
      throw new Error("git gone");
    });
    await expect(hooks.afterTurn(makeDesc("sess-1"), "sess-1")).resolves.toBeUndefined();
  });

  test("no hook, no descriptor: no-op", async () => {
    await expect(new TurnHooks().afterTurn(undefined, "sess-1")).resolves.toBeUndefined();
  });
});
