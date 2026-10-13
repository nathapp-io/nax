import { describe, expect, test } from "bun:test";
import type { SessionHandle } from "@nathapp/nax-agent";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
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

const NO_HANDLERS: LoopHandlerSet = [];

function handleOf(id: string): SessionHandle {
  return { id, agentName: "claude" };
}

describe("TurnHooks.afterTurn (#2497)", () => {
  test("counts turns per session and passes the descriptor", async () => {
    const seen: [string, number][] = [];
    const hooks = new TurnHooks();
    hooks.setHooks({
      after: async (d, turn) => {
        seen.push([d.id, turn]);
      },
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
    hooks.setHooks({
      after: async () => {
        throw new Error("git gone");
      },
    });
    await expect(hooks.afterTurn(makeDesc("sess-1"), "sess-1")).resolves.toBeUndefined();
  });

  test("no hook, no descriptor: no-op", async () => {
    await expect(new TurnHooks().afterTurn(undefined, "sess-1")).resolves.toBeUndefined();
  });
});

describe("TurnHooks.beginTurn (nax#2500)", () => {
  test("runs the before hook, then returns the loop-handler opts", async () => {
    const seen: string[] = [];
    const hooks = new TurnHooks();
    hooks.setHooks({ before: async (d) => void seen.push(d.id) });
    const opts = await hooks.beginTurn(handleOf("sess-1"), makeDesc("sess-1"), NO_HANDLERS);
    expect(seen).toEqual(["sess-1"]);
    expect(opts).toEqual(hooks.loopHandlerOpts(handleOf("sess-1"), makeDesc("sess-1"), NO_HANDLERS));
  });

  test("a throwing before hook is swallowed", async () => {
    const hooks = new TurnHooks();
    hooks.setHooks({
      before: async () => {
        throw new Error("git gone");
      },
    });
    await expect(hooks.beginTurn(handleOf("s"), makeDesc("s"), NO_HANDLERS)).resolves.toBeDefined();
  });
});
