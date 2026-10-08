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
import { capStrings } from "#src/internal/redact";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import type { AdapterInteraction } from "#src/session/interaction-handler";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
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
  readonly table: ReturnType<typeof createPendingAskTable>;
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
  const table = createPendingAskTable(30_000);
  const deps: SessionInteractionDeps = {
    sessionId: "s1",
    runtime,
    embedderTools: new Map(tools.map((tool) => [tool.name, tool])),
    asks: createSessionAskPort({
      table,
      emit: (body) => events.push(body),
      turn: () => ({ turnId: "t", signal: turn.signal }),
    }),
    turnSignal: () => turn.signal,
    setCurrentCallId: (callId) => {
      slot.callId = callId;
    },
  };
  const fireTimers = (): void => {
    for (const fn of timers.splice(0)) fn();
  };
  return { deps, events, table, runtimeCalls, slot, fireTimers };
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

  test("a multi-MB string is cut before redactSecrets walks it; a key-named secret is still masked", () => {
    const summary = defaultSummary({ content: "x".repeat(2_000_000), apiKey: "plainsecret" });
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(EMBEDDER_SUMMARY_BYTES);
    expect(summary).not.toContain("plainsecret");
  });

  test("non-ASCII content at the scan-cap boundary is not corrupted to U+FFFD", () => {
    // 2-byte (é), 3-byte (中), 4-byte (😀) chars at byte boundaries that
    // would land inside the codepoint. The cap must back up to a clean
    // boundary; a too-narrow continuation-byte predicate (matching 0x80
    // only, not 0x80-0xBF) would emit U+FFFD in the scan-cap region for
    // nearly every non-ASCII character. Observed directly on capStrings
    // because the display cap (cutToByteCap) uses the proper predicate
    // and would otherwise mask the bug in higher-level callers.
    for (const ch of ["é", "中", "😀"]) {
      const capped = capStrings({ note: ch.repeat(20_000) }, 16_384) as { note: string };
      expect(capped.note).not.toContain("\uFFFD");
    }
  });

  test("a cyclic input does not recurse forever", () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    expect(() => defaultSummary(cyclic)).not.toThrow();
  });
});

describe("createSessionInteractionHandler", () => {
  withDepsRestore(_agentSessionDeps);

  test("a question is raised and answered with the person's text", async () => {
    const h = harness({ kind: "ok", content: "" });
    const answer = createSessionInteractionHandler(h.deps).onInteraction({ kind: "question", text: "Which env?" });
    expect(h.events[0]).toMatchObject({ type: "question", requestId: "req-1", text: "Which env?" });
    h.table.answer("req-1", { text: "staging" });
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

  test("a built-in tool runs through the runtime with its call context and the resolved turn signal", async () => {
    const h = harness({ kind: "ok", content: "file body" });
    const answer = await createSessionInteractionHandler(h.deps).onInteraction(codingTool("Read", { path: "a.ts" }));
    expect(answer).toEqual({ answer: "file body" });
    expect(h.runtimeCalls[0]).toMatchObject({
      name: "Read",
      context: { turnId: "turn-1", roundTrips: 2, toolCallId: "call-1", deferModelTruncation: true },
      callIdDuring: "call-1",
    });
    // The request carried no signal, so the resolved turn signal is forwarded
    // to the tool (the pre-fix code dropped it and the tool saw none).
    expect(h.runtimeCalls[0]?.context?.signal).toBe(h.deps.turnSignal());
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
    h.table.answer("req-1", { decision: "allow" });
    expect(await answer).toEqual({ answer: "record 42" });
    expect(seen).toHaveLength(1);
  });

  test("approval always: a denial or a timeout does not run the tool", async () => {
    const { tool, seen } = embedder({ approval: "always" });
    const h = harness({ kind: "ok", content: "" }, [tool]);
    const handler = createSessionInteractionHandler(h.deps);
    const first = handler.onInteraction(codingTool("lookup"));
    await new Promise((resolve) => setImmediate(resolve));
    h.table.answer("req-1", { decision: "deny" });
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

  test("a built-in tool that ignores its signal is abandoned when the turn aborts", async () => {
    const h = harness({ kind: "ok", content: "" });
    const deps: SessionInteractionDeps = {
      ...h.deps,
      runtime: { advertised: () => [], callTool: () => new Promise(() => {}) },
    };
    const controller = new AbortController();
    const pending = createSessionInteractionHandler(deps).onInteraction({
      ...codingTool("Read"),
      signal: controller.signal,
    });
    controller.abort();
    expect((await thrown(pending)).message).toContain("abandoned");
    expect(h.slot.callId).toBeUndefined();
  });

  test("a pre-aborted signal abandons the call without ever invoking the tool", async () => {
    let called = false;
    const h = harness({ kind: "ok", content: "" });
    const deps: SessionInteractionDeps = {
      ...h.deps,
      runtime: {
        advertised: () => [],
        async callTool() {
          called = true;
          return { kind: "ok", content: "" };
        },
      },
    };
    const controller = new AbortController();
    controller.abort();
    const err = await thrown(
      createSessionInteractionHandler(deps).onInteraction({
        ...codingTool("Read"),
        signal: controller.signal,
      }),
    );
    expect(err.message).toContain("abandoned");
    expect(called).toBe(false);
    expect(h.slot.callId).toBeUndefined();
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
