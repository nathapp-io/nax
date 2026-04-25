import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, AcpSessionHandleImpl, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import type { OpenSessionOpts } from "../../../../src/agents/types";
import { makeClient, makeSession } from "./adapter.test";

const ACP_WORKDIR = "/tmp/nax-phase-a-test";

function makeOpenSessionOpts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: ACP_WORKDIR,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// openSession
// ─────────────────────────────────────────────────────────────────────────────

describe("openSession()", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    adapter = new AcpAgentAdapter("claude");
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  test("returns a SessionHandle with id = session name", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-aabbccdd-feat-story", makeOpenSessionOpts());

    expect(handle.id).toBe("nax-aabbccdd-feat-story");
    expect(handle.agentName).toBe("claude");
  });

  test("handle is AcpSessionHandleImpl with ACP-internal fields", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-test", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;

    expect(impl._session).toBe(session);
    expect(impl._timeoutSeconds).toBe(30);
    expect(impl._modelDef.model).toBe("claude-sonnet-4-5");
  });

  test("fires onSessionEstablished callback before returning", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const calls: Array<{ protocolIds: unknown; sessionName: string }> = [];
    const opts = makeOpenSessionOpts({
      onSessionEstablished: (protocolIds, sessionName) => {
        calls.push({ protocolIds, sessionName });
      },
    });

    await adapter.openSession("nax-test-session", opts);

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionName).toBe("nax-test-session");
  });

  test("tolerates onSessionEstablished throwing without failing openSession", async () => {
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client as any);

    const opts = makeOpenSessionOpts({
      onSessionEstablished: () => {
        throw new Error("callback error");
      },
    });

    const handle = await adapter.openSession("nax-test", opts);
    expect(handle.id).toBe("nax-test");
  });

  test("marks handle resumed=false for a new session", async () => {
    const session = makeSession();
    const client = makeClient(session, { loadSessionFn: undefined });
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-test", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;
    expect(impl._resumed).toBe(false);
  });

  test("marks handle resumed=true when loadSession returns an existing session", async () => {
    const session = makeSession();
    const client = makeClient(session, {
      loadSessionFn: async () => session,
    });
    _acpAdapterDeps.createClient = mock(() => client as any);

    const handle = await adapter.openSession("nax-existing", makeOpenSessionOpts());
    const impl = handle as AcpSessionHandleImpl;
    expect(impl._resumed).toBe(true);
  });
});
