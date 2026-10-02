/**
 * US-003 — `NativeSessionAdapter.sendTurn` carries `opts.loopHandlers` into the turn.
 *
 * The adapter is where a caller-supplied plugin set first meets the native
 * loop: `opts.loopHandlers` / `opts.loopHandlerContext` are forwarded into the
 * `runNativeTurn` deps, and `runNativeTurn` hands them to
 * `registerBuiltinLoopHandlers`. These tests drive the REAL adapter end to end
 * against a scripted fake model (the `_clientDeps.build` seam, as
 * adapter-turn-signal.test.ts does) and observe what each criterion names:
 *
 *  - AC9: a `before_turn` seed reaches the first model request;
 *  - AC10/AC11: a plugin `before_tool` decision is honoured by the batch — the
 *    call is never executed and the plugin's text is that call's tool result;
 *  - AC12: a `before_turn_end` followUp buys exactly one extra round trip and
 *    one extra user message;
 *  - AC13: every plugin handler is handed the very object the caller passed.
 *
 * Nothing here touches the network or spawns a process: the model is a scripted
 * stub, and the tool path is answered by the harness's own interaction handler,
 * whose invocation record is what makes "the command never ran" observable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ConversationMessage, ResolvedModel, ToolCall } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import type { LoopHandlerContext, LoopHandlerEntry, LoopHandlerSet } from "#src/native/session/loop-events/types";
import { clearNativeSessionState } from "#src/native/session/session";
import { loadTranscript } from "#src/native/session/transcript-store";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import type { SendTurnOpts } from "#src/session/session-types";
import type { CodingTool } from "#src/tools/index";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

const REAL_BUILD = _clientDeps.build;
const createdDirs: string[] = [];

afterEach(() => {
  for (const path of createdDirs) cleanupTempDir(path);
  createdDirs.length = 0;
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

function tempDir(prefix: string): string {
  const path = makeTempDir(prefix);
  createdDirs.push(path);
  return path;
}

/** What one round trip of the scripted model is answered with. */
interface ScriptedAnswer {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
}

/** Observable facts about the turn the adapter ran. */
interface Capture {
  /** Every messages array the model was asked to answer, in request order. */
  readonly requests: (readonly ConversationMessage[])[];
  /** Every coding-tool call the loop actually INVOKED, in order. */
  readonly invokedTools: string[];
  roundTrips: number;
}

function scriptedClient(script: (roundTrip: number) => ScriptedAnswer, capture: Capture): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async (_model: ResolvedModel, req: { readonly messages: readonly ConversationMessage[] }) => {
      capture.roundTrips += 1;
      capture.requests.push([...req.messages]);
      const answer = script(capture.roundTrips);
      return {
        text: answer.text,
        ...(answer.toolCalls !== undefined ? { toolCalls: answer.toolCalls } : {}),
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: answer.toolCalls !== undefined ? ("tool_use" as const) : ("stop" as const),
      };
    },
    validate: () => {},
  };
}

/** A coding tool the loop advertises; the harness's handler answers in its place. */
function codingToolStub(name: string, properties: Record<string, unknown>, required: readonly string[]): CodingTool {
  return {
    name,
    description: `${name} stub`,
    inputSchema: { type: "object", properties, required },
    scope: { pathFields: [] },
    async run() {
      return { content: `${name} ran` };
    },
  };
}

const READ_TOOL = codingToolStub("Read", { path: { type: "string" } }, ["path"]);
const BASH_TOOL = codingToolStub("Bash", { command: { type: "string" } }, ["command"]);

interface TurnFixture {
  readonly capture: Capture;
  readonly transcript: ConversationMessage[];
}

let sessionSeq = 0;

/**
 * Run one real `sendTurn` on a native session whose model is the scripted stub,
 * with the caller's plugin set passed exactly as `SessionManager` would.
 */
async function driveTurn(args: {
  readonly script: (roundTrip: number) => ScriptedAnswer;
  readonly loopHandlers: LoopHandlerSet;
  readonly loopHandlerContext?: LoopHandlerContext;
  readonly codingTools?: readonly CodingTool[];
}): Promise<TurnFixture> {
  const root = tempDir("nax-adapter-loop-handlers-root-");
  const transcriptDir = tempDir("nax-adapter-loop-handlers-");
  const capture: Capture = { requests: [], invokedTools: [], roundTrips: 0 };
  _clientDeps.build = async () => scriptedClient(args.script, capture);

  const adapter = new NativeSessionAdapter();
  const sessionName = `sess-adapter-loop-handlers-${++sessionSeq}`;
  const handle = await adapter.openSession(sessionName, {
    agentName: "native",
    workdir: root,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    timeoutSeconds: 60,
    transcriptDir,
  });

  const opts: SendTurnOpts = {
    interactionHandler: {
      async onInteraction(req) {
        if (req.kind !== "coding-tool") return { answer: "" };
        capture.invokedTools.push(req.name);
        return { answer: `${req.name} output` };
      },
    },
    ...(args.codingTools !== undefined ? { codingTools: args.codingTools } : {}),
    loopHandlers: args.loopHandlers,
    ...(args.loopHandlerContext !== undefined ? { loopHandlerContext: args.loopHandlerContext } : {}),
  };

  try {
    await adapter.sendTurn(handle, "hi", opts);
    return { capture, transcript: await loadTranscript(transcriptDir, handle.id) };
  } finally {
    clearNativeSessionState(handle.id);
  }
}

/** The stored tool result answering `callId`, or a failed test. */
function toolResultFor(transcript: readonly ConversationMessage[], callId: string): { content: string } {
  const found = transcript.find((message) => message.role === "tool-result" && message.toolCallId === callId);
  assertDefined(found, `the tool result for call "${callId}"`);
  return found;
}

/** The Nth model request, or a failed test. */
function requestAt(capture: Capture, index: number): readonly ConversationMessage[] {
  const request = capture.requests[index];
  assertDefined(request, `model request #${index + 1}`);
  return request;
}

/** One staged registration, as `PluginRegistry.getLoopHandlers()` hands it over. */
function pluginEntry(event: LoopHandlerEntry["event"], handler: LoopHandlerEntry["handler"], plugin = "p") {
  return { plugin, event, handler };
}

const CTX: LoopHandlerContext = { sessionName: "caller-supplied-ctx", role: "implementer", storyId: "US-003" };

const SEED: ConversationMessage = { role: "user", content: "SEED-NOTE" };

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — a before_turn seed reaches the model
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — NativeSessionAdapter.sendTurn: before_turn seeds", () => {
  test("AC9: a seed returned by a before_turn entry is part of the first model request", async () => {
    const fixture = await driveTurn({
      script: () => ({ text: "done" }),
      loopHandlers: [pluginEntry("before_turn", () => ({ seed: [SEED] }), "seeder-plugin")],
      loopHandlerContext: CTX,
    });

    expect(requestAt(fixture.capture, 0)).toContainEqual(SEED);
  });

  test("AC9 (boundary): an honoured seed is the conversation the model sees, not an addition to the prompt", async () => {
    const fixture = await driveTurn({
      script: () => ({ text: "done" }),
      loopHandlers: [pluginEntry("before_turn", () => ({ seed: [SEED] }), "seeder-plugin")],
      loopHandlerContext: CTX,
    });

    expect(requestAt(fixture.capture, 0)).toEqual([SEED]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — a plugin block stops the tool call
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — NativeSessionAdapter.sendTurn: a plugin before_tool block", () => {
  test("AC10: a block for a Bash call leaves the command unexecuted and records its content as the tool result", async () => {
    const fixture = await driveTurn({
      script: (roundTrip) =>
        roundTrip === 1
          ? { text: "", toolCalls: [{ id: "b1", name: "Bash", input: { command: "npm test" } }] }
          : { text: "done" },
      loopHandlers: [
        pluginEntry("before_tool", () => ({ kind: "block", content: "refused", isError: true }), "gate-plugin"),
      ],
      loopHandlerContext: CTX,
      codingTools: [BASH_TOOL],
    });

    expect(fixture.capture.invokedTools).toEqual([]);
    expect(toolResultFor(fixture.transcript, "b1").content).toBe("refused");
  });

  test("AC10 (boundary): a plugin entry that answers nothing leaves the call to run and records the tool's output", async () => {
    let pluginCalls = 0;
    const fixture = await driveTurn({
      script: (roundTrip) =>
        roundTrip === 1
          ? { text: "", toolCalls: [{ id: "b1", name: "Bash", input: { command: "npm test" } }] }
          : { text: "done" },
      loopHandlers: [
        pluginEntry(
          "before_tool",
          () => {
            pluginCalls += 1;
            return undefined;
          },
          "observer-plugin",
        ),
      ],
      loopHandlerContext: CTX,
      codingTools: [BASH_TOOL],
    });

    // The handler was installed AND consulted — an unanswered decision is not
    // a block, so the call runs on the ordinary path.
    expect(pluginCalls).toBe(1);
    expect(fixture.capture.invokedTools).toEqual(["Bash"]);
    expect(toolResultFor(fixture.transcript, "b1").content).toBe("Bash output");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — a throwing plugin before_tool handler blocks the call
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — NativeSessionAdapter.sendTurn: a throwing plugin before_tool handler", () => {
  test("AC11: records a tool result whose content starts with the plugin-attributed block", async () => {
    const fixture = await driveTurn({
      script: (roundTrip) =>
        roundTrip === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }] }
          : { text: "done" },
      loopHandlers: [
        pluginEntry(
          "before_tool",
          () => {
            throw new Error("the gate exploded");
          },
          "p",
        ),
      ],
      loopHandlerContext: CTX,
      codingTools: [READ_TOOL],
    });

    const content = toolResultFor(fixture.transcript, "c1").content;
    expect(content.startsWith("Blocked: loop handler from plugin 'p' failed")).toBe(true);
  });

  test("AC11 (boundary): the failed call is not executed", async () => {
    const fixture = await driveTurn({
      script: (roundTrip) =>
        roundTrip === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }] }
          : { text: "done" },
      loopHandlers: [
        pluginEntry(
          "before_tool",
          () => {
            throw new Error("the gate exploded");
          },
          "p",
        ),
      ],
      loopHandlerContext: CTX,
      codingTools: [READ_TOOL],
    });

    expect(fixture.capture.invokedTools).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12 — a before_turn_end followUp buys one extra round trip
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — NativeSessionAdapter.sendTurn: a before_turn_end followUp", () => {
  test("AC12: a followUp returned once sends exactly one extra user message and one extra model request", async () => {
    let followUpCalls = 0;
    const fixture = await driveTurn({
      script: () => ({ text: "done" }),
      loopHandlers: [
        pluginEntry(
          "before_turn_end",
          () => {
            followUpCalls += 1;
            return followUpCalls === 1 ? { followUp: "keep going" } : undefined;
          },
          "follow-up-plugin",
        ),
      ],
      loopHandlerContext: CTX,
    });

    expect(fixture.capture.requests).toHaveLength(2);
    expect(fixture.transcript.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "hi",
      "keep going",
    ]);
  });

  test("AC12 (boundary): the extra request carries the injected follow-up as its newest message", async () => {
    let followUpCalls = 0;
    const fixture = await driveTurn({
      script: () => ({ text: "done" }),
      loopHandlers: [
        pluginEntry(
          "before_turn_end",
          () => {
            followUpCalls += 1;
            return followUpCalls === 1 ? { followUp: "keep going" } : undefined;
          },
          "follow-up-plugin",
        ),
      ],
      loopHandlerContext: CTX,
    });

    const secondRequest = fixture.capture.requests[1];
    expect(secondRequest).toBeDefined();
    if (secondRequest === undefined) throw new Error("the follow-up turn issued no second model request");
    expect(secondRequest[secondRequest.length - 1]).toEqual({ role: "user", content: "keep going" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13 — the caller's context object reaches every plugin handler
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — NativeSessionAdapter.sendTurn: opts.loopHandlerContext", () => {
  test("AC13: every plugin handler is handed the object passed as opts.loopHandlerContext", async () => {
    const seen: LoopHandlerContext[] = [];
    const context: LoopHandlerContext = { sessionName: "ctx-object", role: "implementer", storyId: "US-003" };
    const fixture = await driveTurn({
      script: (roundTrip) =>
        roundTrip === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }] }
          : { text: "done" },
      loopHandlers: [
        pluginEntry("before_turn", (_payload, ctx) => {
          seen.push(ctx);
          return undefined;
        }),
        pluginEntry("before_tool", (_payload, ctx) => {
          seen.push(ctx);
          return undefined;
        }),
        pluginEntry("after_tool", (_payload, ctx) => {
          seen.push(ctx);
          return undefined;
        }),
      ],
      loopHandlerContext: context,
      codingTools: [READ_TOOL],
    });

    // One handler per event fired: before_turn, before_tool, after_tool.
    expect(seen).toHaveLength(3);
    for (const handlerContext of seen) expect(handlerContext).toBe(context);
    // The turn really did reach every one of those events.
    expect(fixture.capture.invokedTools).toEqual(["Read"]);
  });

  test("AC13 (boundary): handlers from two plugins on the same event both receive that same object", async () => {
    const seen: LoopHandlerContext[] = [];
    const context: LoopHandlerContext = { sessionName: "ctx-object", role: "implementer" };
    await driveTurn({
      script: () => ({ text: "done" }),
      loopHandlers: [
        pluginEntry(
          "before_turn",
          (_payload, ctx) => {
            seen.push(ctx);
            return undefined;
          },
          "first-plugin",
        ),
        pluginEntry(
          "before_turn",
          (_payload, ctx) => {
            seen.push(ctx);
            return undefined;
          },
          "second-plugin",
        ),
      ],
      loopHandlerContext: context,
    });

    expect(seen).toHaveLength(2);
    for (const handlerContext of seen) expect(handlerContext).toBe(context);
  });
});
