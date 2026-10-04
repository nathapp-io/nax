/**
 * S3-4: the facade's InteractionHandler. Questions go to the pending-ask
 * table; embedder tools run in-process (after an approval when declared
 * "always"); built-in tools go to the CodingToolRuntime with the call id in
 * the current-call slot. A failed tool is reported by throwing, which the
 * tool batch records as an isError result.
 */
import { describe, expect, test } from "bun:test";
import type { EmbedderTool, EmbedderToolContext, SessionEventBody } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import type { AdapterInteraction } from "#src/session/interaction-handler";
import { createPendingAskTable } from "#src/session/pending-asks";
import {
  createSessionInteractionHandler,
  defaultSummary,
  EMBEDDER_SUMMARY_BYTES,
  embedderToolDescriptor,
  type SessionInteractionDeps,
} from "#src/session/session-interaction";
import type { CodingToolOutcome, CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";
import { withDepsRestore } from "#test/helpers/index";

interface Harness {
  readonly deps: SessionInteractionDeps;
  readonly events: SessionEventBody[];
  readonly runtimeCalls: Array<{
    name: string;
    context: ToolCallContext | undefined;
    callIdDuring: string | undefined;
  }>;
  readonly slot: { callId: string | undefined };
  readonly fireTimers: () => void;
}

function harness(outcome: CodingToolOutcome, tools: readonly EmbedderTool[] = []): Harness {
  const timers: Array<() => void> = [];
  _agentSessionDeps.setTimeout = (fn: () => void): unknown => timers.push(fn);
  _agentSessionDeps.clearTimeout = () => {};
  let n = 0;
  _agentSessionDeps.randomUUID = () => `req-${++n}`;
  const events: SessionEventBody[] = [];
  const slot: { callId: string | undefined } = { callId: undefined };
  const runtimeCalls: Harness["runtimeCalls"] = [];
  const runtime: CodingToolRuntime = {
    advertised: () => [],
    async callTool(name, _input, context) {
      runtimeCalls.push({ name, context, callIdDuring: slot.callId });
      return outcome;
    },
  };
  const turn = new AbortController();
  const deps: SessionInteractionDeps = {
    sessionId: "s1",
    runtime,
    embedderTools: new Map(tools.map((tool) => [tool.name, tool])),
    asks: { table: createPendingAskTable(30_000), emit: (body) => events.push(body), currentCallId: () => slot.callId },
    turnSignal: () => turn.signal,
    setCurrentCallId: (callId) => {
      slot.callId = callId;
    },
  };
  const fireTimers = (): void => {
    for (const fn of timers.splice(0)) fn();
  };
  return { deps, events, runtimeCalls, slot, fireTimers };
}

function codingTool(
  name: string,
  input: Record<string, unknown> = {},
): Extract<AdapterInteraction, { kind: "coding-tool" }> {
  return {
    kind: "coding-tool",
    name,
    input,
    toolCallId: "call-1",
    turnId: "turn-1",
    roundTrips: 2,
    deferModelTruncation: true,
  };
}

async function thrown(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected a NaxError");
}

function embedder(extra: Partial<EmbedderTool> & { run?: EmbedderTool["run"] } = {}): {
  tool: EmbedderTool;
  seen: EmbedderToolContext[];
} {
  const seen: EmbedderToolContext[] = [];
  const tool: EmbedderTool = {
    name: "lookup",
    description: "look a record up",
    inputSchema: { type: "object" },
    approval: "never",
    async run(_input, ctx) {
      seen.push(ctx);
      return { content: "record 42" };
    },
    ...extra,
  };
  return { tool, seen };
}

describe("embedderToolDescriptor and defaultSummary", () => {
  test("the descriptor carries the model-facing fields and refuses to run directly", async () => {
    const { tool } = embedder();
    const descriptor = embedderToolDescriptor(tool);
    expect(descriptor).toMatchObject({
      name: "lookup",
      description: "look a record up",
      inputSchema: { type: "object" },
    });
    expect(descriptor.scope).toEqual({ pathFields: [] });
    const direct = await descriptor.run({}, { root: "/", resolvedPaths: [], maxBytes: 1, maxFileBytes: 1 });
    expect(direct.isError).toBe(true);
  });

  test("the default summary is redacted, byte-capped JSON", () => {
    expect(defaultSummary({ id: 7, apiKey: "plainsecret" })).toBe('{"id":7,"apiKey":"[REDACTED]"}');
    expect(Buffer.byteLength(defaultSummary({ blob: "z".repeat(5000) }))).toBeLessThanOrEqual(EMBEDDER_SUMMARY_BYTES);
  });
});

describe("createSessionInteractionHandler", () => {
  withDepsRestore(_agentSessionDeps);

  test("a question is raised and answered with the person's text", async () => {
    const h = harness({ kind: "ok", content: "" });
    const answer = createSessionInteractionHandler(h.deps).onInteraction({ kind: "question", text: "Which env?" });
    expect(h.events[0]).toMatchObject({ type: "question", requestId: "req-1", text: "Which env?" });
    h.deps.asks.table.answer("req-1", { text: "staging" });
    expect(await answer).toEqual({ answer: "staging" });
  });

  test("an unanswered question returns null, the loop's no-operator answer", async () => {
    const h = harness({ kind: "ok", content: "" });
    const answer = createSessionInteractionHandler(h.deps).onInteraction({ kind: "question", text: "?" });
    h.fireTimers();
    expect(await answer).toBeNull();
  });

  test("a context-tool request is an unknown tool", async () => {
    const h = harness({ kind: "ok", content: "" });
    const err = await thrown(
      createSessionInteractionHandler(h.deps).onInteraction({ kind: "context-tool", name: "mystery" }),
    );
    expect(err.message).toContain('Unknown tool "mystery"');
  });

  test("a built-in tool runs through the runtime with its call context, inside the current-call slot", async () => {
    const h = harness({ kind: "ok", content: "file body" });
    const answer = await createSessionInteractionHandler(h.deps).onInteraction(codingTool("Read", { path: "a.ts" }));
    expect(answer).toEqual({ answer: "file body" });
    expect(h.runtimeCalls[0]).toEqual({
      name: "Read",
      context: { turnId: "turn-1", roundTrips: 2, toolCallId: "call-1", deferModelTruncation: true },
      callIdDuring: "call-1",
    });
    expect(h.slot.callId).toBeUndefined();
  });

  test("a denied built-in returns the denial; an erroring one throws its content", async () => {
    const denied = harness({ kind: "denied", reason: "outside the root", breach: false });
    expect(await createSessionInteractionHandler(denied.deps).onInteraction(codingTool("Read"))).toEqual({
      answer: "Denied: outside the root",
      denied: { reason: "outside the root", breach: false },
    });
    const failed = harness({ kind: "error", content: "ENOENT: a.ts" });
    const err = await thrown(createSessionInteractionHandler(failed.deps).onInteraction(codingTool("Read")));
    expect(err.message).toBe("ENOENT: a.ts");
    expect(failed.slot.callId).toBeUndefined();
  });

  test("an embedder tool runs with the session id, call id and turn signal", async () => {
    const { tool, seen } = embedder();
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const answer = await createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup", { id: 42 }));
    expect(answer).toEqual({ answer: "record 42" });
    expect(seen[0]?.sessionId).toBe("s1");
    expect(seen[0]?.toolCallId).toBe("call-1");
    expect(seen[0]?.signal.aborted).toBe(false);
    expect(h.runtimeCalls).toHaveLength(0);
  });

  test("embedder isError and a throwing run both throw, with the content or the cause", async () => {
    const isError = embedder({ run: async () => ({ content: "no such record", isError: true }) });
    const h1 = harness({ kind: "ok", content: "" }, [isError.tool]);
    expect((await thrown(createSessionInteractionHandler(h1.deps).onInteraction(codingTool("lookup")))).message).toBe(
      "no such record",
    );
    const throwing = embedder({
      run: async () => {
        throw new Error("db down");
      },
    });
    const h2 = harness({ kind: "ok", content: "" }, [throwing.tool]);
    expect((await thrown(createSessionInteractionHandler(h2.deps).onInteraction(codingTool("lookup")))).message).toBe(
      'Tool "lookup" failed: db down',
    );
  });

  test("approval always: asks with the described summary and the call id, then runs on allow", async () => {
    const { tool, seen } = embedder({ approval: "always", describe: (input) => `look up ${JSON.stringify(input)}` });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const answer = createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup", { id: 42 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.events[0]).toMatchObject({
      type: "approval_requested",
      callId: "call-1",
      tool: "lookup",
      summary: 'look up {"id":42}',
    });
    expect(seen).toHaveLength(0);
    h.deps.asks.table.answer("req-1", { decision: "allow" });
    expect(await answer).toEqual({ answer: "record 42" });
    expect(seen).toHaveLength(1);
  });

  test("approval always: a denial or a timeout does not run the tool", async () => {
    const { tool, seen } = embedder({ approval: "always" });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const handler = createSessionInteractionHandler(h.deps);
    const first = handler.onInteraction(codingTool("lookup"));
    await new Promise((resolve) => setImmediate(resolve));
    h.deps.asks.table.answer("req-1", { decision: "deny" });
    expect(await first).toMatchObject({ denied: { breach: false } });
    const second = handler.onInteraction(codingTool("lookup"));
    await new Promise((resolve) => setImmediate(resolve));
    h.fireTimers();
    expect(await second).toMatchObject({ denied: { breach: false } });
    expect(seen).toHaveLength(0);
  });

  test("a run that ignores its signal is abandoned when the turn aborts", async () => {
    const { tool } = embedder({ run: () => new Promise(() => {}) });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const controller = new AbortController();
    const pending = createSessionInteractionHandler(h.deps).onInteraction({
      ...codingTool("lookup"),
      signal: controller.signal,
    });
    controller.abort();
    expect((await thrown(pending)).message).toContain("abandoned");
  });

  test("a describe summary is redacted and capped", async () => {
    const { tool } = embedder({
      approval: "always",
      describe: () => `deploy with apiKey=supersecretvalue ${"x".repeat(5000)}`,
    });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    void createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup"));
    await new Promise((resolve) => setImmediate(resolve));
    const summary = JSON.stringify(h.events[0]);
    expect(summary).not.toContain("supersecretvalue");
    expect(Buffer.byteLength(summary)).toBeLessThan(EMBEDDER_SUMMARY_BYTES + 400);
  });

  test("a throwing describe falls back to the default summary", async () => {
    const { tool } = embedder({
      approval: "always",
      describe: () => {
        throw new Error("bad describe");
      },
    });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    void createSessionInteractionHandler(h.deps).onInteraction(codingTool("lookup", { id: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.events[0]).toMatchObject({ summary: '{"id":1}' });
  });
});
