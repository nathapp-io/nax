/**
 * US-004 (spec §US-004): the ACP abandoned-tool text names why the turn ended.
 *
 * This package keeps its own copies of nax-agent's `TurnEndAbort` and
 * `abandonedToolMessage` (`#src/client/turn-end-abort`), because neither is
 * exported from `@nathapp/nax-agent`'s public entry. Every ACP-owned turn end
 * that used to abort with no reason aborts with a `TurnEndAbort` instead: the
 * tool host's response close and its stop, the inbound binding's detach, and
 * the agent process exit. A caller's own cancel or timeout signal keeps
 * whatever reason it carried, and a `NaxError` reason is named as it is on the
 * native backend.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type EmbedderTool, type EmbedderToolContext, NaxError, type SessionAskPort } from "@nathapp/nax-agent";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter } from "#src/client/inbound";
import { createToolCalls, type ToolCallDeps, type ToolCalls } from "#src/client/tool-calls";
import { createToolHost, type ToolHost } from "#src/client/tool-host";
import { abandonedText, TurnEndAbort } from "#src/client/turn-end-abort";
import { mcpClient } from "#test/helpers/mcp-client";

const IDLE = new AbortController().signal;
const text = (t: string) => [{ type: "text" as const, text: t }];

const NO_ASK: SessionAskPort = {
  requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
  recordAutoDecision: () => {},
  askQuestion: async () => null,
  noteQuestion: () => {},
};

/** A signal aborted with `reason`, or with no argument at all. */
function abortedWith(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  if (reason === undefined) controller.abort();
  else controller.abort(reason);
  return controller.signal;
}

function tool(overrides: Partial<EmbedderTool> = {}): EmbedderTool {
  return {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object" },
    approval: "never",
    run: async () => ({ content: "found" }),
    ...overrides,
  };
}

/** A tool that ignores its signal and never finishes, recording the context it was given. */
function hanging(seen: EmbedderToolContext[], name = "lookup"): EmbedderTool {
  return tool({
    name,
    description: "Never finishes and ignores its signal",
    run: (_input, ctx) => {
      seen.push(ctx);
      return new Promise(() => {});
    },
  });
}

function deps(overrides: Partial<ToolCallDeps> = {}): ToolCallDeps {
  const turn = new AbortController();
  return {
    sessionId: "s-1",
    tools: [tool()],
    asks: NO_ASK,
    currentTurnId: () => "turn-1",
    turnSignal: () => turn.signal,
    secrets: [],
    ...overrides,
  };
}

describe("abandonedText: the reason rule (AC-1, AC-2, AC-3)", () => {
  test("AC-1: a TurnEndAbort reason is named: (the ACP prompt turn ended)", () => {
    expect(abandonedText("acme__put", abortedWith(new TurnEndAbort("the ACP prompt turn ended")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended (the ACP prompt turn ended).',
    );
  });

  test("AC-2: a bare abort's DOMException names nothing", () => {
    expect(abandonedText("acme__put", abortedWith())).toBe('Tool "acme__put" was abandoned: the turn ended.');
  });

  test("AC-3: a NaxError reason is named as code: message", () => {
    expect(abandonedText("acme__put", abortedWith(new NaxError("cancelled", "AGENT_SESSION_CANCELLED")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).',
    );
  });

  test("an unrelated reason also names nothing", () => {
    expect(abandonedText("acme__put", abortedWith(new DOMException("some text", "AbortError")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended.',
    );
    expect(abandonedText("acme__put", abortedWith(new Error("boom")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended.',
    );
  });

  test("TurnEndAbort keeps the AbortError contract: name, message and Error identity", () => {
    const error = new TurnEndAbort("the tool host stopped");
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("the tool host stopped");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("the tool-call runner names the reason it raced (AC-4, AC-5)", () => {
  test("AC-4: a run in flight when the turn aborts returns the TurnEndAbort's message", async () => {
    const turn = new AbortController();
    const seen: EmbedderToolContext[] = [];
    const calls = createToolCalls(deps({ turnSignal: () => turn.signal, tools: [hanging(seen)] }));
    const pending = calls.call("lookup", {}, IDLE);
    await waitForCondition(() => seen.length === 1);
    turn.abort(new TurnEndAbort("the tool host stopped"));
    expect(await pending).toEqual({
      content: text('Tool "lookup" was abandoned: the turn ended (the tool host stopped).'),
      isError: true,
    });
  });

  test("AC-5: a call whose signal is already aborted before it starts uses the same text", async () => {
    const ran: EmbedderToolContext[] = [];
    const calls = createToolCalls(
      deps({ turnSignal: () => abortedWith(new TurnEndAbort("the tool host stopped")), tools: [hanging(ran)] }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({
      content: text('Tool "lookup" was abandoned: the turn ended (the tool host stopped).'),
      isError: true,
    });
    expect(ran).toEqual([]);
  });

  test("a caller's own NaxError cancel reason is named", async () => {
    const seen: EmbedderToolContext[] = [];
    const turn = new AbortController();
    const calls = createToolCalls(deps({ turnSignal: () => turn.signal, tools: [hanging(seen)] }));
    const pending = calls.call("lookup", {}, IDLE);
    await waitForCondition(() => seen.length === 1);
    turn.abort(new NaxError("cancelled", "AGENT_SESSION_CANCELLED"));
    expect((await pending).content).toEqual(
      text('Tool "lookup" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).'),
    );
  });
});

describe("the inbound binding's detach names its reason (AC-6)", () => {
  test("a detach during a call answers it with (the ACP prompt turn ended)", async () => {
    const router = createInboundRouter(async () => ({ outcome: { outcome: "cancelled" } }));
    const release = router.attach("agent-1", createTurnCollector(undefined), IDLE);
    const seen: EmbedderToolContext[] = [];
    const calls = createToolCalls(deps({ turnSignal: () => router.activeSignal(), tools: [hanging(seen)] }));
    const pending = calls.call("lookup", {}, IDLE);
    await waitForCondition(() => seen.length === 1);
    await release();
    expect(await pending).toEqual({
      content: text('Tool "lookup" was abandoned: the turn ended (the ACP prompt turn ended).'),
      isError: true,
    });
  });
});

interface Observed {
  readonly calls: ToolCalls;
  /** Every accepted call's server-side answer, in call order. */
  readonly answered: Promise<CallToolResult>[];
}

/** The tool-call runner, with the answer of every accepted call kept: a dropped HTTP client cannot receive it. */
function observedCalls(inner: ToolCalls): Observed {
  const answered: Promise<CallToolResult>[] = [];
  return {
    answered,
    calls: {
      list: () => inner.list(),
      drain: () => inner.drain(),
      call: (name, args, signal) => {
        const answer = inner.call(name, args, signal);
        answered.push(answer);
        return answer;
      },
    },
  };
}

interface Started {
  readonly host: ToolHost;
  readonly url: string;
  readonly answered: Promise<CallToolResult>[];
}

const hosts: ToolHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function startedHost(seen: EmbedderToolContext[]): Promise<Started> {
  const observed = observedCalls(createToolCalls(deps({ tools: [hanging(seen, "slow")] })));
  const host = createToolHost(observed.calls);
  hosts.push(host);
  const server = await host.start();
  return { host, url: server.url, answered: observed.answered };
}

describe("the tool host's own aborts name their reasons (AC-7, AC-8)", () => {
  test("AC-7: stop() during a call answers it with (the tool host stopped)", async () => {
    const seen: EmbedderToolContext[] = [];
    const s = await startedHost(seen);
    const client = await mcpClient(s.url, s.host.token);
    void client.callTool({ name: "slow", arguments: {} }).catch(() => undefined);
    await waitForCondition(() => seen.length === 1, 3_000);
    await s.host.stop();
    expect((await s.answered[0])?.content).toEqual(
      text('Tool "slow" was abandoned: the turn ended (the tool host stopped).'),
    );
    await client.close().catch(() => undefined);
  });

  test("AC-8: closing the HTTP response during a call answers it with (the agent closed the tool request)", async () => {
    const seen: EmbedderToolContext[] = [];
    const s = await startedHost(seen);
    const client = await mcpClient(s.url, s.host.token);
    void client.callTool({ name: "slow", arguments: {} }).catch(() => undefined);
    await waitForCondition(() => seen.length === 1, 3_000);
    // The client drops the request's connection: the server sees the response close.
    await client.close().catch(() => undefined);
    expect((await s.answered[0])?.content).toEqual(
      text('Tool "slow" was abandoned: the turn ended (the agent closed the tool request).'),
    );
  });
});
