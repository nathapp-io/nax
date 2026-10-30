/**
 * US-009 AC-14..AC-17, AC-20: the ACP host helpers — the install preflight and
 * the opener wrapper that reports ACP opens to the catalog.
 */
import { describe, expect, mock, test } from "bun:test";
import { type AgentSession, AgentSessionError, createSessionStorage } from "@nathapp/nax-agent";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import type { AcpCatalog } from "@/chat/acp";
import { assertAcpInstalled, reportAcpOpens } from "@/chat/acp/acp-host";
import { _openChatSessionDeps, type ChatSessionHandle, type openChatSession } from "@/chat/open-chat-session";
import { NaxError } from "@/errors";

type Opener = typeof openChatSession;
type OpenRequest = Parameters<Opener>[0];

const STORAGE = createSessionStorage({
  dir: "/unused/sessions",
  pid: process.pid,
  now: () => new Date("2026-10-01T00:00:00.000Z"),
  logger: makeLogger(),
  isAlive: () => true,
});

function stubCatalog(overrides: Partial<AcpCatalog> = {}): AcpCatalog {
  return {
    rows: () => [],
    effortLevels: () => ["default"],
    installed: () => true,
    unavailable: () => undefined,
    opened: mock(() => {}),
    failed: mock(() => {}),
    ...overrides,
  };
}

function handleOn(model: string): ChatSessionHandle {
  const session: AgentSession = {
    id: "s1",
    backend: { kind: "acp", capabilities: { offeredModels: ["m"] } },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    async close() {},
  };
  return {
    session,
    meta: {
      schemaVersion: 1,
      sessionId: "s1",
      cwd: "/repo",
      mode: "ask",
      model,
      bashApproval: "gated",
      title: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: null,
    },
    release: async () => {},
  };
}

function request(model?: string): OpenRequest {
  return {
    ...(model === undefined ? {} : { model }),
    storage: STORAGE,
    cwd: "/repo",
    repoRoot: "/repo",
    loopHandlers: [],
    config: makeNaxConfig(),
  };
}

describe("assertAcpInstalled", () => {
  test("AC-14 returns without throwing for a native model on a catalog that reports nothing installed", () => {
    const installed = mock(() => false);
    expect(() => assertAcpInstalled(stubCatalog({ installed }), "openai/gpt-6")).not.toThrow();
  });

  test("AC-15 returns without throwing without a catalog", () => {
    expect(() => assertAcpInstalled(undefined, "acp:cursor")).not.toThrow();
  });

  test("AC-20 throws CHAT_ACP_AGENT_UNAVAILABLE with stage chat naming the agent when it is not installed", () => {
    const catalog = stubCatalog({ installed: () => false });
    let caught: unknown;
    try {
      assertAcpInstalled(catalog, "acp:cursor/composer");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof NaxError)) throw new Error("expected a NaxError");
    const error = caught;
    expect(error.code).toBe("CHAT_ACP_AGENT_UNAVAILABLE");
    expect(error.context?.stage).toBe("chat");
    expect(error.message).toContain("Cursor");
    expect(error.message).toContain("not installed");
  });

  test("returns without throwing for an installed ACP agent", () => {
    expect(() => assertAcpInstalled(stubCatalog({ installed: () => true }), "acp:codex")).not.toThrow();
  });
});

describe("reportAcpOpens", () => {
  test("AC-16 a native model resolves the opener's handle and reports nothing", async () => {
    const handle = handleOn("openai/gpt-6");
    const catalog = stubCatalog();
    const wrapped = reportAcpOpens(async () => handle, catalog);
    await expect(wrapped(request("openai/gpt-6"))).resolves.toBe(handle);
    expect(catalog.opened).not.toHaveBeenCalled();
    expect(catalog.failed).not.toHaveBeenCalled();
  });

  test("AC-16 a failing native open reports nothing and rethrows", async () => {
    const catalog = stubCatalog();
    const failure = new Error("boom");
    const wrapped = reportAcpOpens(async () => {
      throw failure;
    }, catalog);
    await expect(wrapped(request("openai/gpt-6"))).rejects.toBe(failure);
    expect(catalog.failed).not.toHaveBeenCalled();
  });

  test("AC-17 forwards exactly the request and deps it was given", async () => {
    const open = mock<Opener>(async () => handleOn("openai/gpt-6"));
    const req = request("openai/gpt-6");
    const deps = { ..._openChatSessionDeps };
    await reportAcpOpens(open, stubCatalog())(req, deps);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toBe(req);
    expect(open.mock.calls[0]?.[1]).toBe(deps);
  });

  test("AC-17 forwards a request alone without adding a deps argument", async () => {
    const open = mock<Opener>(async () => handleOn("openai/gpt-6"));
    await reportAcpOpens(open, stubCatalog())(request("openai/gpt-6"));
    expect(open.mock.calls[0]).toHaveLength(1);
  });

  test("reports an ACP open's model and capabilities to catalog.opened", async () => {
    const catalog = stubCatalog();
    await reportAcpOpens(async () => handleOn("acp:codex"), catalog)(request("acp:codex"));
    expect(catalog.opened).toHaveBeenCalledWith("acp:codex", { offeredModels: ["m"] });
  });

  test("reports a failed ACP open to catalog.failed with the request model, then rethrows", async () => {
    const catalog = stubCatalog();
    const failure = new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED");
    const wrapped = reportAcpOpens(async () => {
      throw failure;
    }, catalog);
    await expect(wrapped(request("acp:claude"))).rejects.toBe(failure);
    expect(catalog.failed).toHaveBeenCalledWith("acp:claude", failure);
  });

  test("a failed resume request carries no model and is not reported", async () => {
    const catalog = stubCatalog();
    const wrapped = reportAcpOpens(async () => {
      throw new Error("gone");
    }, catalog);
    await expect(wrapped(request())).rejects.toThrow("gone");
    expect(catalog.failed).not.toHaveBeenCalled();
  });

  test("without a catalog the opener is returned as is", async () => {
    const open = mock<Opener>(async () => handleOn("acp:codex"));
    expect(reportAcpOpens(open, undefined)).toBe(open);
  });
});
