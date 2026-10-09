import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { OpenedSession, OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, MCP_NOTICE, NO_MODEL_MESSAGE } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { type FakeAgentSession, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/cfg/.agent-server/sessions",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [{ tier: "balanced", model: "anthropic/claude-sonnet-5-5", contextWindow: 200_000 }],
  catalogOverrides: [],
};

const usageTurn: Script = async function* () {
  yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.1 };
  yield turnEnd("completed");
};

function setup(options: ServerOptions = OPTIONS, opener?: (request: OpenSessionRequest) => Promise<OpenedSession>) {
  const opened: OpenSessionRequest[] = [];
  const fakes: FakeAgentSession[] = [];
  const port = fakePort();
  const { logger, lines } = recordingLogger();
  let next = 0;
  const registry = createSessionRegistry({
    options,
    openSession:
      opener ??
      (async (request) => {
        opened.push(request);
        const fake = fakeAgentSession(request.sessionId, [usageTurn], { closeFails: fakes.length === 0 });
        fakes.push(fake);
        return { session: fake.session, doc: null };
      }),
    newId: () => {
      next += 1;
      return `id-${next}`;
    },
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  const create = (cwd = "/w", mcpServers: readonly unknown[] = []) =>
    registry.create({ cwd, mcpServers, port: () => port.port });
  return { registry, create, opened, fakes, port, lines };
}

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

describe("createSessionRegistry.create (spec §5.3 session/new)", () => {
  test("opens with the resolved defaults and registers the session", async () => {
    const s = setup();
    const session = await s.create();
    expect(session.id).toBe("id-1");
    expect(s.opened).toEqual([
      { sessionId: "id-1", cwd: "/w", model: "anthropic/claude-sonnet-5-5", profile: "ask", bashApproval: "gated" },
    ]);
    expect(s.registry.get("id-1")).toBe(session);
    expect(s.registry.find("id-1")).toBe(session);
  });

  test("the context window comes from the tier entry for the model", async () => {
    const s = setup();
    const session = await s.create();
    await session.prompt([{ type: "text", text: "go" }]);
    expect(s.port.updates.find((u) => u.sessionUpdate === "usage_update")).toMatchObject({ size: 200_000 });
  });

  test("a model with no tier entry sends no usage_update", async () => {
    const s = setup({ ...OPTIONS, tiers: [] });
    const session = await s.create();
    await session.prompt([{ type: "text", text: "go" }]);
    expect(s.port.updates.some((u) => u.sessionUpdate === "usage_update")).toBe(false);
  });

  test("a relative cwd is invalid_params", async () => {
    const s = setup();
    const error = await failure(s.create("w"));
    expect(error.code).toBe(-32602);
    expect(s.opened).toEqual([]);
  });

  test("no model is invalid_params with the spec message", async () => {
    const { defaultModel: _unused, ...noModel } = OPTIONS;
    const s = setup(noModel);
    const error = await failure(s.create());
    expect(error.message).toContain(NO_MODEL_MESSAGE);
  });

  test("non-empty mcpServers queue one notice for the first turn", async () => {
    const s = setup();
    const session = await s.create("/w", [{ name: "fs", command: "mcp-fs", args: [], env: [] }]);
    expect(s.port.updates).toEqual([]);
    await session.prompt([{ type: "text", text: "go" }]);
    expect(JSON.stringify(s.port.updates[0])).toContain(MCP_NOTICE);
  });

  test("a failed open registers nothing and propagates", async () => {
    const s = setup(OPTIONS, async () => Promise.reject(new Error("sandbox unavailable")));
    await expect(s.create()).rejects.toThrow("sandbox unavailable");
    expect(s.registry.find("id-1")).toBeUndefined();
  });
});

describe("lookup and shutdown", () => {
  test("get on an unknown id is resource_not_found; find is undefined", () => {
    const s = setup();
    expect(s.registry.find("nope")).toBeUndefined();
    let caught: unknown;
    try {
      s.registry.get("nope");
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof RequestError ? caught.code : 0).toBe(-32002);
  });

  test("closeAll closes every session and forgets them, logging a failed close", async () => {
    const s = setup();
    await s.create();
    await s.create();
    await s.registry.closeAll();
    expect(s.fakes.map((f) => f.closed())).toEqual([true, true]);
    expect(s.registry.find("id-2")).toBeUndefined();
    expect(s.lines.some((l) => l.level === "warn" && l.data?.error === "close failed")).toBe(true);
  });
});
