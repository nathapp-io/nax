import { describe, expect, mock, test } from "bun:test";
import type { AgentSession, SessionMeta } from "@nathapp/nax-agent";
import type { ChatSessionHandle } from "@/chat/open-chat-session";
import { closeChatResources } from "@/chat/session-hygiene";

const AT = "2026-10-01T00:00:00.000Z";

function handle(): ChatSessionHandle {
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: "s1",
    cwd: "/repo",
    mode: "ask",
    model: "p/m",
    bashApproval: "gated",
    title: null,
    createdAt: AT,
    updatedAt: AT,
  };
  const session: AgentSession = {
    id: "s1",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close: async () => {},
  };
  return { session, meta, release: async () => {} };
}

function fixture(closeImpl: () => Promise<void> = async () => {}) {
  const order: string[] = [];
  const hygiene = {
    close: mock(async () => {
      order.push("hygiene.close");
      await closeImpl();
    }),
  };
  const tasks = {
    stopAll: mock(async () => {
      order.push("tasks.stopAll");
    }),
  };
  const resources = {
    teardown: mock(async () => {
      order.push("resources.teardown");
    }),
  };
  const chain = {
    destroy: mock(async () => {
      order.push("chain.destroy");
    }),
  };
  return { order, hygiene, tasks, resources, chain };
}

describe("closeChatResources", () => {
  test("AC-13 a rejecting hygiene.close still stops tasks, tears down resources and destroys the chain", async () => {
    const f = fixture(async () => {
      throw new Error("close failed");
    });
    await closeChatResources({ ...f, handle: handle() }).catch(() => {});
    expect(f.tasks.stopAll).toHaveBeenCalledTimes(1);
    expect(f.resources.teardown).toHaveBeenCalledTimes(1);
    expect(f.chain.destroy).toHaveBeenCalledTimes(1);
  });

  test("AC-14 a rejecting hygiene.close rejects with that error after cleanup", async () => {
    const failure = new Error("close failed");
    const f = fixture(async () => {
      throw failure;
    });
    await expect(closeChatResources({ ...f, handle: handle() })).rejects.toBe(failure);
    expect(f.order).toEqual(["hygiene.close", "tasks.stopAll", "resources.teardown", "chain.destroy"]);
  });

  test("AC-15 with no handle stops tasks, then tears down resources, then destroys the chain", async () => {
    const f = fixture();
    await closeChatResources({ ...f });
    expect(f.hygiene.close).not.toHaveBeenCalled();
    expect(f.order).toEqual(["tasks.stopAll", "resources.teardown", "chain.destroy"]);
  });

  test("closes the handle through hygiene before cleanup when one is open", async () => {
    const f = fixture();
    const open = handle();
    await closeChatResources({ ...f, handle: open });
    expect(f.hygiene.close).toHaveBeenCalledWith(open);
    expect(f.order[0]).toBe("hygiene.close");
  });

  test("a rejecting stopAll still tears down resources and destroys the chain, rejecting with the stopAll error", async () => {
    const f = fixture();
    const failure = new Error("stop failed");
    f.tasks.stopAll.mockImplementation(async () => {
      throw failure;
    });
    await expect(closeChatResources({ ...f })).rejects.toBe(failure);
    expect(f.resources.teardown).toHaveBeenCalledTimes(1);
    expect(f.chain.destroy).toHaveBeenCalledTimes(1);
  });

  test("accepts absent tasks, resources and chain", async () => {
    const f = fixture();
    await closeChatResources({ hygiene: f.hygiene, chain: null });
    expect(f.hygiene.close).not.toHaveBeenCalled();
  });
});
