/**
 * US-004 — the ACP tool host's MCP instructions (#2517) and Claude's loopback
 * grant (#2538).
 *
 * The agent's own MCP client is what receives `initialize`, so the instructions
 * reach the agent without touching the prompt. The initialize assertions go
 * over raw HTTP with the host's token, which is exactly what that client sends;
 * the host is built with `enableJsonResponse`, so one JSON body comes back and
 * `"instructions" in result` is answerable.
 *
 * `toolHostFor` is driven directly with a stubbed `createToolHost`: the options
 * the backend hands the host are otherwise invisible, and the AC pins the
 * exact third argument.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  buildSandboxPolicy,
  EMPTY_OWNED_PATHS_POLICY,
  type EmbedderTool,
  type SandboxPolicy,
  type SessionAskPort,
} from "@nathapp/nax-agent";
import { _acpBackendDeps, toolHostFor } from "#src/client/backend";
import { claudeSandboxOptions } from "#src/client/claude-sandbox";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { rejectLocally } from "#src/client/permissions";
import { createToolCalls, type ToolCallDeps } from "#src/client/tool-calls";
import { createToolHost, newToolHostToken, type ToolHost, type ToolHostOptions } from "#src/client/tool-host";
import { type RawResponse, rawRequest } from "#test/helpers/http";
import { openContext } from "#test/helpers/open-context";

const INSTRUCTIONS = "Pass the repo root as project";

const NO_ASK: SessionAskPort = {
  requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
  recordAutoDecision: () => {},
  askQuestion: async () => null,
  noteQuestion: () => {},
};

const echo: EmbedderTool = {
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  approval: "never",
  run: async (input) => ({ content: JSON.stringify(input) }),
};

function deps(): ToolCallDeps {
  const scope = new AbortController();
  return {
    sessionId: "s-1",
    tools: [echo],
    asks: NO_ASK,
    currentTurnId: () => "turn-1",
    turnSignal: () => scope.signal,
    secrets: [],
  };
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
});

const hosts: ToolHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

/** A started host, sent one MCP initialize carrying its token: what the agent's MCP client does. */
async function initialize(options?: ToolHostOptions): Promise<RawResponse> {
  const host = createToolHost(createToolCalls(deps()), newToolHostToken(), options);
  hosts.push(host);
  const server = await host.start();
  return rawRequest({
    port: Number(new URL(server.url).port),
    headers: { ...MCP_HEADERS, authorization: `Bearer ${host.token}` },
    body: [INITIALIZE],
  });
}

describe("the tool host's MCP instructions (#2517)", () => {
  test("AC-1: instructions given to createToolHost come back as the initialize result's instructions", async () => {
    const res = await initialize({ instructions: INSTRUCTIONS });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result.instructions).toBe(INSTRUCTIONS);
  });

  test("AC-2: a host created without instructions answers initialize with no instructions field", async () => {
    const res = await initialize();
    expect(res.status).toBe(200);
    expect("instructions" in JSON.parse(res.body).result).toBe(false);
  });
});

describe("the options the backend hands the tool host (#2517)", () => {
  const realCreate = _acpBackendDeps.createToolHost;
  const seen: (ToolHostOptions | undefined)[] = [];
  const stub: ToolHost = {
    token: "stub-token",
    serverName: "nax-0badc0de",
    start: async () => {
      throw new Error("the stub host is never started");
    },
    drain: async () => {},
    stop: async () => {},
  };

  /** The stub createToolHost: records its third argument, the only place the wiring shows. */
  function capture(): void {
    _acpBackendDeps.createToolHost = (_calls, _token, options) => {
      seen.push(options);
      return stub;
    };
  }

  function router(): InboundRouter {
    return createInboundRouter(async (request) => rejectLocally(request));
  }

  afterEach(() => {
    _acpBackendDeps.createToolHost = realCreate;
    seen.splice(0);
  });

  test("AC-3: providerInstructions reach the host as its only instruction option", () => {
    capture();
    const ctx = openContext("/repo", { providerInstructions: INSTRUCTIONS, tools: [echo] });
    expect(toolHostFor(ctx, router(), [], "token-1")).toBe(stub);
    expect(seen).toEqual([{ instructions: INSTRUCTIONS }]);
  });

  test("AC-4: no providerInstructions means no instructions option at all", () => {
    capture();
    toolHostFor(openContext("/repo", { tools: [echo] }), router(), [], "token-1");
    expect(seen).toEqual([undefined]);
  });

  test("an empty providerInstructions counts as none, as the native path does", () => {
    capture();
    toolHostFor(openContext("/repo", { providerInstructions: "", tools: [echo] }), router(), [], "token-1");
    expect("instructions" in (seen[0] ?? {})).toBe(false);
  });
});

describe("claudeSandboxOptions network (#2538)", () => {
  const BASE: SandboxPolicy = { writeRoots: ["/repo"], denyWrite: [], denyRead: [], network: {} };

  /** A policy as nax-agent builds it: only the network is interesting here. */
  function builtPolicy(network: { allowedDomains?: string[]; allowLocalBinding?: boolean }): SandboxPolicy {
    return buildSandboxPolicy({
      root: "/repo",
      git: { kind: "main", gitDir: "/repo/.git" },
      gitGuardFiles: [],
      naxEntries: [],
      ownedPaths: EMPTY_OWNED_PATHS_POLICY,
      credentialFiles: [],
      home: "/home/u",
      tempRoots: [],
      platform: "linux",
      config: {
        enabled: true,
        backend: "srt",
        filesystem: { allowWrite: [], denyRead: [], allowSharedTmp: false },
        network,
      },
    });
  }

  test("AC-5: the allow-list and the loopback grant both ride the network option", () => {
    const policy: SandboxPolicy = { ...BASE, network: { allowedDomains: ["x.test"], allowLocalBinding: true } };
    expect(claudeSandboxOptions(policy).network).toEqual({ allowedDomains: ["x.test"], allowLocalBinding: true });
  });

  test("AC-6: the loopback grant alone is sent, with no allow-list key", () => {
    const policy: SandboxPolicy = { ...BASE, network: { allowLocalBinding: true } };
    expect(claudeSandboxOptions(policy).network).toEqual({ allowLocalBinding: true });
  });

  test("AC-7: a policy with no network at all sends no network option", () => {
    expect("network" in claudeSandboxOptions(BASE)).toBe(false);
  });

  test("AC-8: the loopback grant survives buildSandboxPolicy into the sent options", () => {
    const policy = builtPolicy({ allowLocalBinding: true });
    expect(policy.network).toEqual({ allowLocalBinding: true });
    expect(claudeSandboxOptions(policy).network).toEqual({ allowLocalBinding: true });
  });

  test("AC-8 boundary: an allow-list policy reaches the options unchanged", () => {
    const policy = builtPolicy({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true });
    expect(claudeSandboxOptions(policy).network).toEqual({
      allowedDomains: ["registry.npmjs.org"],
      allowLocalBinding: true,
    });
  });
});
