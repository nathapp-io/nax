import { describe, expect, test } from "bun:test";
import {
  type ApprovalDecidedBy,
  type ApprovalRequest,
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_PROFILE_REASON,
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  type EmbedderTool,
  type EmbedderToolContext,
  type SessionAskPort,
} from "@nathapp/nax-agent";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import {
  approvalReason,
  createToolCalls,
  denyReason,
  MAX_CONCURRENT_TOOL_CALLS,
  NO_TURN_TEXT,
  TOO_MANY_TEXT,
  TOOL_SUMMARY_BYTES,
  type ToolCallDeps,
  toolSummary,
} from "#src/client/tool-calls";

type Verdict = { readonly decision: "allow" | "deny"; readonly decidedBy: ApprovalDecidedBy };

interface Ran {
  readonly input: unknown;
  readonly ctx: EmbedderToolContext;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function askPort(
  answer: (req: ApprovalRequest) => Promise<Verdict> = async () => ({ decision: "allow", decidedBy: "human" }),
) {
  const asked: ApprovalRequest[] = [];
  const port: SessionAskPort = {
    requestApproval: async (req) => {
      asked.push(req);
      return answer(req);
    },
    recordAutoDecision: () => {},
    askQuestion: async () => null,
    noteQuestion: () => {},
  };
  return { asked, port };
}

function tool(overrides: Partial<EmbedderTool> = {}, ran: Ran[] = []): EmbedderTool {
  return {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    approval: "never",
    run: async (input, ctx) => {
      ran.push({ input, ctx });
      return { content: `found: ${JSON.stringify(input)}` };
    },
    ...overrides,
  };
}

const IDLE = new AbortController().signal;

function deps(overrides: Partial<ToolCallDeps> = {}): ToolCallDeps {
  const turn = new AbortController();
  return {
    sessionId: "s-1",
    tools: [tool()],
    asks: askPort().port,
    currentTurnId: () => "turn-1",
    turnSignal: () => turn.signal,
    secrets: [],
    ...overrides,
  };
}

const text = (t: string) => [{ type: "text" as const, text: t }];

describe("tools/list", () => {
  test("exactly the session's tools, in order, with an object input schema", () => {
    const calls = createToolCalls(
      deps({ tools: [tool(), tool({ name: "fetch_page", description: "Fetch", inputSchema: {} })] }),
    );
    expect(calls.list()).toEqual([
      {
        name: "lookup",
        description: "Look a word up",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "fetch_page",
        description: "Fetch",
        inputSchema: { type: "object" },
      },
    ]);
  });

  // #2366: plan mode is gone, so the tools no longer claim to be read-only.
  test("tools carry no annotations, whatever their approval", () => {
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "never" }), tool({ name: "send_mail", approval: "always" })] }),
    );
    expect(calls.list().map((listed) => listed.annotations)).toEqual([undefined, undefined]);
  });
});

describe("tools/call: turn and name checks (spec §6.3, §6.6)", () => {
  test("no current turn id: a no-turn tool error and nothing runs", async () => {
    const ran: Ran[] = [];
    const calls = createToolCalls(deps({ tools: [tool({}, ran)], currentTurnId: () => undefined }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(NO_TURN_TEXT), isError: true });
    expect(ran).toEqual([]);
  });

  test("no bound turn signal: a no-turn tool error and nothing runs", async () => {
    const ran: Ran[] = [];
    const calls = createToolCalls(deps({ tools: [tool({}, ran)], turnSignal: () => undefined }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(NO_TURN_TEXT), isError: true });
    expect(ran).toEqual([]);
  });

  test.each(["missing", "__proto__", "constructor", "toString"])("unknown name %p: a tool error", async (name) => {
    const ran: Ran[] = [];
    const calls = createToolCalls(deps({ tools: [tool({}, ran)] }));
    const result = await calls.call(name, {}, IDLE);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(text(`Unknown tool "${name}"`));
    expect(ran).toEqual([]);
  });

  test("an unknown name with control characters is shown stripped and capped", async () => {
    const calls = createToolCalls(deps());
    const result = await calls.call(`bad\u001b[31m${"x".repeat(200)}`, {}, IDLE);
    // \u001b is stripped; the remaining "bad[31m" is 7 characters, so 57 x's make the 64-character cap.
    expect(result.content).toEqual(text(`Unknown tool "bad[31m${"x".repeat(57)}"`));
  });
});

describe("tools/call: approval never", () => {
  test("runs with the session id, an mcp-<n> call id and a live signal; ids count up", async () => {
    const ran: Ran[] = [];
    const { asked, port } = askPort();
    const calls = createToolCalls(deps({ tools: [tool({}, ran)], asks: port }));
    expect(await calls.call("lookup", { q: "a" }, IDLE)).toEqual({ content: text('found: {"q":"a"}') });
    expect(await calls.call("lookup", undefined, IDLE)).toEqual({ content: text("found: {}") });
    expect(ran.map((r) => [r.input, r.ctx.sessionId, r.ctx.toolCallId, r.ctx.signal.aborted])).toEqual([
      [{ q: "a" }, "s-1", "mcp-1", false],
      [{}, "s-1", "mcp-2", false],
    ]);
    expect(asked).toEqual([]);
  });

  test("a result with isError stays an error; a non-string content is stringified", async () => {
    const calls = createToolCalls(
      deps({ tools: [tool({ run: async () => JSON.parse('{"content": 42, "isError": true}') })] }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text("42"), isError: true });
  });

  test("a throw: 'Tool <name> failed: <message>'", async () => {
    const calls = createToolCalls(
      deps({
        tools: [
          tool({
            run: async () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({
      content: text('Tool "lookup" failed: boom'),
      isError: true,
    });
  });

  test("a run that resolves nothing: a tool error, not a protocol error", async () => {
    const calls = createToolCalls(deps({ tools: [tool({ run: async () => JSON.parse("null") })] }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({
      content: text('Tool "lookup" returned no result.'),
      isError: true,
    });
  });

  test("a non-Error throw is stringified", async () => {
    const calls = createToolCalls(deps({ tools: [tool({ run: () => Promise.reject("plain") })] }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({
      content: text('Tool "lookup" failed: plain'),
      isError: true,
    });
  });
});

describe("tools/call: approval always (spec §6.6)", () => {
  test("asks with the call id, tool, summary and reason; allow runs the tool", async () => {
    const ran: Ran[] = [];
    const { asked, port } = askPort();
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always", describe: (i) => `look up ${JSON.stringify(i)}` }, ran)], asks: port }),
    );
    expect(await calls.call("lookup", { q: "a" }, IDLE)).toEqual({ content: text('found: {"q":"a"}') });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      callId: "mcp-1",
      tool: "lookup",
      summary: 'look up {"q":"a"}',
      reason: approvalReason("lookup"),
    });
    expect(asked[0]?.signal?.aborted).toBe(false);
    expect(ran).toHaveLength(1);
  });

  test.each<[ApprovalDecidedBy, string]>([
    ["human", ASK_DENIED_REASON],
    ["timeout", ASK_TIMEOUT_REASON],
    ["cancelled", ASK_CANCELLED_REASON],
    ["unshowable", ASK_UNSHOWABLE_REASON],
    ["profile", ASK_PROFILE_REASON],
    ["unavailable", ASK_NO_CHANNEL_REASON],
  ])("deny decided by %p: 'Denied: <reason>' and the tool does not run", async (decidedBy, reason) => {
    const ran: Ran[] = [];
    const { port } = askPort(async () => ({ decision: "deny", decidedBy }));
    const calls = createToolCalls(deps({ tools: [tool({ approval: "always" }, ran)], asks: port }));
    expect(denyReason(decidedBy)).toBe(reason);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(`Denied: ${reason}`), isError: true });
    expect(ran).toEqual([]);
  });

  test("an approval value other than never asks (fail closed)", async () => {
    const { asked, port } = askPort(async () => ({ decision: "deny", decidedBy: "human" }));
    const odd = tool(JSON.parse('{"approval": "sometimes"}'));
    const calls = createToolCalls(deps({ tools: [odd], asks: port }));
    expect((await calls.call("lookup", {}, IDLE)).isError).toBe(true);
    expect(asked).toHaveLength(1);
  });

  test("the port throws (turn ended before the ask): a no-turn error and nothing runs", async () => {
    const ran: Ran[] = [];
    const { port } = askPort(() => Promise.reject(new Error("no-turn")));
    const calls = createToolCalls(deps({ tools: [tool({ approval: "always" }, ran)], asks: port }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(NO_TURN_TEXT), isError: true });
    expect(ran).toEqual([]);
  });
});

describe("tools/call: abort (Review Focus 1)", () => {
  test("the turn signal already aborted: abandoned, nothing runs, no ask", async () => {
    const ran: Ran[] = [];
    const { asked, port } = askPort();
    const turn = new AbortController();
    turn.abort();
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always" }, ran)], asks: port, turnSignal: () => turn.signal }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({
      content: text('Tool "lookup" was abandoned: the turn ended.'),
      isError: true,
    });
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a run that ignores its signal answers at once when the turn aborts; its signal is aborted", async () => {
    const turn = new AbortController();
    const seen: AbortSignal[] = [];
    const calls = createToolCalls(
      deps({
        turnSignal: () => turn.signal,
        tools: [
          tool({
            run: (_input, ctx) => {
              seen.push(ctx.signal);
              return new Promise(() => {});
            },
          }),
        ],
      }),
    );
    const pending = calls.call("lookup", {}, IDLE);
    await waitForCondition(() => seen.length === 1);
    turn.abort();
    expect(await pending).toEqual({ content: text('Tool "lookup" was abandoned: the turn ended.'), isError: true });
    expect(seen[0]?.aborted).toBe(true);
  });

  test("the request signal aborting (the agent hung up) abandons the run too", async () => {
    const request = new AbortController();
    const calls = createToolCalls(deps({ tools: [tool({ run: () => new Promise(() => {}) })] }));
    const pending = calls.call("lookup", {}, request.signal);
    request.abort();
    expect((await pending).content).toEqual(text('Tool "lookup" was abandoned: the turn ended.'));
  });

  test("the ask gets the call's signal: aborting it settles a pending ask", async () => {
    const turn = new AbortController();
    const { port } = askPort(
      (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener("abort", () => resolve({ decision: "deny", decidedBy: "cancelled" }));
        }),
    );
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always" })], asks: port, turnSignal: () => turn.signal }),
    );
    const pending = calls.call("lookup", {}, IDLE);
    turn.abort();
    expect(await pending).toEqual({ content: text(`Denied: ${ASK_CANCELLED_REASON}`), isError: true });
  });
});

describe("tools/call: concurrency cap (spec §6.6)", () => {
  test(`at most ${MAX_CONCURRENT_TOOL_CALLS} in flight; the next is refused and does not run; then one frees a slot`, async () => {
    const gate = deferred<void>();
    let started = 0;
    const calls = createToolCalls(
      deps({
        tools: [
          tool({
            run: async () => {
              started += 1;
              await gate.promise;
              return { content: "done" };
            },
          }),
        ],
      }),
    );
    const first = Array.from({ length: MAX_CONCURRENT_TOOL_CALLS }, () => calls.call("lookup", {}, IDLE));
    await waitForCondition(() => started === MAX_CONCURRENT_TOOL_CALLS);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(TOO_MANY_TEXT), isError: true });
    expect(started).toBe(MAX_CONCURRENT_TOOL_CALLS);
    gate.resolve();
    await Promise.all(first);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text("done") });
  });

  test("calls waiting for approval count; aborting them frees every slot", async () => {
    const turn = new AbortController();
    let pending = 0;
    const { port } = askPort(
      (req) =>
        new Promise((resolve) => {
          pending += 1;
          req.signal?.addEventListener("abort", () => resolve({ decision: "deny", decidedBy: "cancelled" }));
        }),
    );
    const ran: Ran[] = [];
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always" }, ran)], asks: port, turnSignal: () => turn.signal }),
    );
    const waiting = Array.from({ length: MAX_CONCURRENT_TOOL_CALLS }, () => calls.call("lookup", {}, IDLE));
    await waitForCondition(() => pending === MAX_CONCURRENT_TOOL_CALLS);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(TOO_MANY_TEXT), isError: true });
    turn.abort();
    await Promise.all(waiting);
    await calls.drain();
    // The slots are free: the next call is no longer refused by the cap (it is abandoned: the turn is aborted).
    expect((await calls.call("lookup", {}, IDLE)).content).toEqual(
      text('Tool "lookup" was abandoned: the turn ended.'),
    );
    expect(ran).toEqual([]);
  });
});

describe("drain", () => {
  test("resolves at once with nothing in flight", async () => {
    await createToolCalls(deps()).drain();
  });

  test("resolves only after every in-flight call has answered", async () => {
    const gate = deferred<void>();
    const calls = createToolCalls(
      deps({
        tools: [
          tool({
            run: async () => {
              await gate.promise;
              return { content: "late" };
            },
          }),
        ],
      }),
    );
    void calls.call("lookup", {}, IDLE);
    let drained = false;
    const draining = calls.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await draining;
    expect(drained).toBe(true);
  });
});

describe("toolSummary (Review Focus 5)", () => {
  const SESSION_SECRET = "session-secret-value-0123";

  test("describe wins; the JSON input otherwise", () => {
    expect(toolSummary(tool({ describe: () => "custom" }), { q: "a" }, [])).toBe("custom");
    expect(toolSummary(tool(), { q: "a" }, [])).toBe('{"q":"a"}');
    expect(toolSummary(tool(), undefined, [])).toBe("null");
  });

  test("a throwing describe falls back to the input", () => {
    const throwing = tool({
      describe: () => {
        throw new Error("nope");
      },
    });
    expect(toolSummary(throwing, { q: "a" }, [])).toBe('{"q":"a"}');
  });

  test("an input that cannot be serialized", () => {
    expect(toolSummary(tool(), { n: 1n }, [])).toBe("[input not serializable]");
  });

  test("the session's secrets and pattern secrets are redacted; secret-named keys too", () => {
    expect(toolSummary(tool({ describe: () => `use ${SESSION_SECRET}` }), {}, [SESSION_SECRET])).toBe("use [REDACTED]");
    expect(toolSummary(tool({ describe: () => "fetch ghp_abcdefghijklmnopqrst" }), {}, [])).toBe("fetch [REDACTED]");
    expect(toolSummary(tool(), { q: "x", token: "plainvalue123" }, [])).toBe('{"q":"x","token":"[REDACTED]"}');
  });

  test("control and invisible characters stripped; newlines and tabs collapse; trimmed", () => {
    const odd = tool({ describe: () => "  a\u0007b\u202ec\nd\t\te  " });
    expect(toolSummary(odd, {}, [])).toBe("abc d e");
  });

  test(`capped at ${TOOL_SUMMARY_BYTES} bytes without splitting a character`, () => {
    const long = tool({ describe: () => "é".repeat(TOOL_SUMMARY_BYTES) });
    const shown = toolSummary(long, {}, []);
    expect(Buffer.byteLength(shown, "utf8")).toBeLessThanOrEqual(TOOL_SUMMARY_BYTES);
    expect(shown).toBe("é".repeat(TOOL_SUMMARY_BYTES / 2));
  });
});
