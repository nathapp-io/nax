import { describe, expect, mock, test } from "bun:test";
import { withDepsRestore } from "@test/helpers";
import { closePhysicalSession } from "@/agents/acp/adapter-close-physical";
import { _acpAdapterDeps } from "@/agents/acp/adapter-lifecycle";
import type { AcpClient, AcpSession } from "@/agents/acp/adapter-session-types";

function makeClient(overrides: Partial<AcpClient>): AcpClient {
  return {
    start: async () => {},
    createSession: async () => {
      throw new Error("createSession not expected in this test");
    },
    close: async () => {},
    ...overrides,
  };
}

describe("closePhysicalSession", () => {
  withDepsRestore(_acpAdapterDeps, ["createClient"]);

  test("closes via client.closeSession and calls client.close", async () => {
    const closeSession = mock(async () => {});
    let clientClosed = false;
    const client = makeClient({
      closeSession,
      close: async () => {
        clientClosed = true;
      },
    });
    _acpAdapterDeps.createClient = () => client;

    await closePhysicalSession("claude", "handle-1", "/workdir");

    expect(closeSession).toHaveBeenCalledWith("handle-1", "claude", undefined);
    expect(clientClosed).toBe(true);
  });

  test("force=true also invokes forceStop after closeSession", async () => {
    const closeSession = mock(async () => {});
    const forceStop = mock(async () => {});
    const client = makeClient({ closeSession, forceStop });
    _acpAdapterDeps.createClient = () => client;

    await closePhysicalSession("claude", "handle-1", "/workdir", { force: true });

    expect(forceStop).toHaveBeenCalledWith("claude", undefined);
  });

  test("force=true swallows a rejecting forceStop instead of throwing", async () => {
    const closeSession = mock(async () => {});
    const forceStop = mock(() => Promise.reject(new Error("stop failed")));
    let clientClosed = false;
    const client = makeClient({
      closeSession,
      forceStop,
      close: async () => {
        clientClosed = true;
      },
    });
    _acpAdapterDeps.createClient = () => client;

    await expect(closePhysicalSession("claude", "handle-1", "/workdir", { force: true })).resolves.toBeUndefined();
    expect(clientClosed).toBe(true);
  });

  test("falls back to loadSession + session.close when closeSession is absent", async () => {
    const sessionClose = mock(async () => {});
    const session: AcpSession = {
      close: sessionClose,
      cancelActivePrompt: async () => {},
      prompt: async () => ({ stopReason: "end_turn", messages: [] }),
    };
    const loadSession = mock(async () => session);
    const client = makeClient({ loadSession });
    _acpAdapterDeps.createClient = () => client;

    await closePhysicalSession("claude", "handle-1", "/workdir", { force: true });

    expect(loadSession).toHaveBeenCalled();
    expect(sessionClose).toHaveBeenCalledWith({ forceTerminate: true, signal: undefined });
  });

  test("does nothing extra when loadSession resolves null", async () => {
    const loadSession = mock(async () => null);
    let clientClosed = false;
    const client = makeClient({
      loadSession,
      close: async () => {
        clientClosed = true;
      },
    });
    _acpAdapterDeps.createClient = () => client;

    await expect(closePhysicalSession("claude", "handle-1", "/workdir")).resolves.toBeUndefined();
    expect(clientClosed).toBe(true);
  });

  test("logs a warning and still closes the client when closeSession throws", async () => {
    const closeSession = mock(() => Promise.reject(new Error("close failed")));
    let clientClosed = false;
    const client = makeClient({
      closeSession,
      close: async () => {
        clientClosed = true;
      },
    });
    _acpAdapterDeps.createClient = () => client;

    await expect(closePhysicalSession("claude", "handle-1", "/workdir")).resolves.toBeUndefined();
    expect(clientClosed).toBe(true);
  });

  test("client.close is called even when client.start throws", async () => {
    let clientClosed = false;
    const client = makeClient({
      start: async () => {
        throw new Error("start failed");
      },
      close: async () => {
        clientClosed = true;
      },
    });
    _acpAdapterDeps.createClient = () => client;

    await expect(closePhysicalSession("claude", "handle-1", "/workdir")).rejects.toThrow("start failed");
    expect(clientClosed).toBe(true);
  });

  test("swallows a rejecting client.close", async () => {
    const client = makeClient({
      close: () => Promise.reject(new Error("close boom")),
    });
    _acpAdapterDeps.createClient = () => client;

    await expect(closePhysicalSession("claude", "handle-1", "/workdir")).resolves.toBeUndefined();
  });
});
