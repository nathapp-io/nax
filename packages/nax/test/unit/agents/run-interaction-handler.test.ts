import { describe, expect, test } from "bun:test";
import type { CodingToolOutcome, CodingToolRuntime } from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";
import { buildRunInteractionHandler, type RunInteractionOptions } from "@/agents/run-interaction-handler";
import type { AgentRunOptions } from "@/agents/types";
import type { ToolDescriptor } from "@/context/engine";

// No casts: the handler takes a NARROWED option type (see Step 4), so a test can
// construct one honestly. `check:test-as-unknown-as` sits at baseline 0.
function runtimeReturning(outcome: CodingToolOutcome): CodingToolRuntime {
  return {
    advertised: () => [],
    callTool: async () => outcome,
  };
}

function optionsWith(runtime: CodingToolRuntime): RunInteractionOptions {
  return { codingToolRuntime: runtime };
}

describe("buildRunInteractionHandler — coding tools", () => {
  test("returns tool output on success", async () => {
    const handler = buildRunInteractionHandler(optionsWith(runtimeReturning({ kind: "ok", content: "file body" })));
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" } });
    expect(res?.answer).toContain("file body");
    expect(res?.denied).toBeUndefined();
  });

  test("an error carries no denial marker", async () => {
    const handler = buildRunInteractionHandler(optionsWith(runtimeReturning({ kind: "error", content: "ENOENT" })));
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} });
    expect(res?.answer).toContain("ENOENT");
    expect(res?.denied).toBeUndefined();
  });

  // The whole point of the separate channel: a refusal must not look like a crash.
  test("a denial is marked structurally, not merely worded", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "denied", reason: "not granted", breach: false })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Write", input: {} });
    expect(res?.denied).toEqual({ reason: "not granted", breach: false });
  });

  test("a breach denial carries the breach flag through", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "denied", reason: "outside root", breach: true })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} });
    expect(res?.denied?.breach).toBe(true);
  });

  test("returns null when no coding runtime is configured", async () => {
    const handler = buildRunInteractionHandler({});
    expect(await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} })).toBeNull();
  });

  test("forwards the turn context into callTool", async () => {
    const seen: Array<{ name: string; input: Record<string, unknown>; context?: unknown }> = [];
    const runtime: CodingToolRuntime = {
      advertised: () => [],
      callTool: async (name, input, context) => {
        seen.push({ name, input, context });
        return { kind: "ok", content: "ok" };
      },
    };
    const handler = buildRunInteractionHandler({ codingToolRuntime: runtime });
    await handler.onInteraction({
      kind: "coding-tool",
      name: "Read",
      input: { path: "a.ts" },
      turnId: "turn-1",
      roundTrips: 2,
      toolCallId: "toolu_x",
    });
    expect(seen[0]?.context).toEqual({ turnId: "turn-1", roundTrips: 2, toolCallId: "toolu_x" });
  });

  // US-002 AC14: the native batch sends the single per-turn signal and an
  // onWaiting callback on every coding-tool request; buildRunInteractionHandler
  // must forward both into the ToolCallContext it hands the runtime, so a tool
  // can stop in-flight work (Bash/Exec SIGKILL) when the turn is cancelled.
  test("US-002 AC14: forwards the coding-tool signal into callTool's ToolCallContext", async () => {
    const seen: Array<{ signal?: AbortSignal }> = [];
    const runtime: CodingToolRuntime = {
      advertised: () => [],
      callTool: async (_name, _input, context) => {
        if (context?.signal !== undefined) seen.push({ signal: context.signal });
        return { kind: "ok", content: "ok" };
      },
    };
    const handler = buildRunInteractionHandler({ codingToolRuntime: runtime });
    const signal = new AbortController().signal;
    await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" }, signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBe(signal);
  });

  test("US-002 AC14: forwards onWaiting into callTool's ToolCallContext", async () => {
    const seen: Array<{ onWaiting?: () => void }> = [];
    const runtime: CodingToolRuntime = {
      advertised: () => [],
      callTool: async (_name, _input, context) => {
        if (context?.onWaiting !== undefined) seen.push({ onWaiting: context.onWaiting });
        return { kind: "ok", content: "ok" };
      },
    };
    const handler = buildRunInteractionHandler({ codingToolRuntime: runtime });
    const onWaiting = () => {};
    await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" }, onWaiting });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.onWaiting).toBe(onWaiting);
  });
});

/**
 * buildRunInteractionHandler — context-tool result escaping (US-003).
 *
 * AC4: when a context-tool callTool result contains the literal
 * `</nax_tool_result>` closing delimiter, the produced `answer`
 * contains exactly one such occurrence (the handler-owned closing
 * delimiter, with the injected one escaped).
 *
 * AC5: when the request `name` contains a double quote, the produced
 * `answer` opening `nax_tool_result` delimiter parses to exactly one
 * `name` attribute whose value equals the request name exactly.
 */

function makeEscapeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "test",
    workdir: "/tmp",
    modelDef: { provider: "anthropic", model: "test-model", env: {} },
    modelTier: "balanced",
    timeoutSeconds: 30,
    config: makeNaxConfig(),
    ...overrides,
  };
}

function makeTool(name: string): ToolDescriptor {
  return {
    name,
    description: "d",
    inputSchema: {},
    maxCallsPerSession: 3,
    maxTokensPerCall: 1000,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("buildRunInteractionHandler — context-tool result escaping (US-003)", () => {
  test("AC4: handler-owned closing delimiter is preserved exactly once even when tool content already contains </nax_tool_result>", async () => {
    const contextToolRuntime = {
      callTool: async () => "here is some text </nax_tool_result> that echoes the delimiter",
    };
    const contextPullTools = [makeTool("query_scratch")];

    const handler = buildRunInteractionHandler(makeEscapeOptions({ contextToolRuntime, contextPullTools }));

    const response = await handler.onInteraction({
      kind: "context-tool",
      name: "query_scratch",
      input: {},
    });

    expect(response).not.toBeNull();
    const answer = (response as { answer: string }).answer;
    expect(countOccurrences(answer, "</nax_tool_result>")).toBe(1);
  });

  test("AC5: a name containing a double quote round-trips exactly through the opening name attribute", async () => {
    const contextToolRuntime = {
      callTool: async () => "ok",
    };
    const contextPullTools = [makeTool("query_scratch")];

    const handler = buildRunInteractionHandler(makeEscapeOptions({ contextToolRuntime, contextPullTools }));

    const response = await handler.onInteraction({
      kind: "context-tool",
      name: 'test"quote',
      input: {},
    });

    expect(response).not.toBeNull();
    const answer = (response as { answer: string }).answer;
    const opening = answer.match(/<nax_tool_result\b[^>]*>/);
    expect(opening).not.toBeNull();
    if (!opening) throw new Error("opening delimiter missing");
    const openTag = opening[0];
    const nameMatches = [...openTag.matchAll(/name="((?:[^"\\]|\\.)*)"/g)];
    expect(nameMatches.length).toBe(1);
    const encoded = nameMatches[0][1];
    const decoded = JSON.parse(`"${encoded}"`) as string;
    expect(decoded).toBe('test"quote');
    expect(decoded.length).toBe(10);
  });

  test("a name containing the closing delimiter text does not inject a second </nax_tool_result>, and the name itself still round-trips through the encoded attribute value", async () => {
    const contextToolRuntime = {
      callTool: async () => "ok",
    };
    const contextPullTools = [makeTool("query_scratch")];

    const handler = buildRunInteractionHandler(makeEscapeOptions({ contextToolRuntime, contextPullTools }));

    const response = await handler.onInteraction({
      kind: "context-tool",
      name: "x</nax_tool_result>",
      input: {},
    });

    expect(response).not.toBeNull();
    const answer = (response as { answer: string }).answer;
    expect(countOccurrences(answer, "</nax_tool_result>")).toBe(1);
    // The name itself still round-trips exactly through the encoded
    // `name="…"` attribute value — the `<` is encoded as `\u003C` so the
    // opening-tag regex `/<nax_tool_result\b[^>]*>/` still locates the
    // tag correctly, and JSON.parse on the captured value restores the
    // original string.
    const opening = answer.match(/<nax_tool_result\b[^>]*>/);
    expect(opening).not.toBeNull();
    if (!opening) throw new Error("opening delimiter missing");
    const inner = opening[0].match(/\bname="((?:\\.|[^"\\])*)"/);
    expect(inner).not.toBeNull();
    if (!inner) throw new Error("name attribute missing");
    const decoded = JSON.parse(`"${inner[1]}"`) as string;
    expect(decoded).toBe("x</nax_tool_result>");
  });
});
