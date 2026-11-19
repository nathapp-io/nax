/**
 * US-002 — a coding tool's images reach the NEXT model request.
 *
 * Each case drives a REAL `NativeSessionAdapter` over the production
 * `createSessionInteractionHandler` and a real coding-tool runtime, so the
 * images travel the whole path the chat loop walks: tool result → runtime
 * outcome → handler answer → `after_tool` chokepoint → tool-result message →
 * request. The model is scripted to call the image tool once and end on the
 * second round trip, so the second captured request is what the model was
 * actually shown.
 *
 * AC-8 pins the split the spec chose: `after_tool` still shapes content only,
 * and the images ride BESIDE the patch rather than through it. AC-9 pins the
 * other half of the absent-stays-absent rule — a tool that failed carries none.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ImageAttachment } from "#src/cost/standard-types";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { createSessionInteractionHandler } from "#src/session/session-interaction";
import { type CodingTool, compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import { cleanupTempDir, installTurnClient, makeTempDir, type ScriptedTurn } from "#test/helpers/index";

const PNG_A: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 2, height: 2 };

const tempDirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

/** A tool that answers with fixed content and images, or throws. */
function screenTool(result: { content: string; images?: readonly ImageAttachment[] } | "throw"): CodingTool {
  return {
    name: "Screen",
    description: "Return a screenshot",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [] },
    async run() {
      if (result === "throw") throw new Error("boom");
      return result;
    },
  };
}

/**
 * One native turn: the model calls the tool on the first round trip and ends on
 * the second. Returns every request the adapter sent, in order.
 */
async function runImageTurn(
  tool: CodingTool,
  options: { afterToolContent?: string } = {},
): Promise<readonly { readonly messages: readonly Record<string, unknown>[] }[]> {
  const root = makeTestDir("nax-tool-images-root-");
  const turns: ScriptedTurn[] = [{ text: "", toolCalls: [{ id: "c1", name: tool.name, input: {} }] }, { text: "done" }];
  const client = installTurnClient(turns);
  cleanups.push(client.restore);

  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: tool.name, patterns: ["*"] }], root),
    extraTools: [tool],
  });
  const adapter = new NativeSessionAdapter();
  const handle = await adapter.openSession("sess-tool-images", {
    agentName: "native",
    workdir: root,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "ignored", model: "stub/stub-model" },
    timeoutSeconds: 600,
    transcriptDir: makeTestDir("nax-tool-images-transcript-"),
  });
  cleanups.push(() => adapter.closeSession(handle));

  const interactionHandler = createSessionInteractionHandler({
    sessionId: "sess-tool-images",
    runtime,
    embedderTools: new Map(),
    asks: createSessionAskPort({ table: createPendingAskTable(30_000), emit: () => {}, turn: () => undefined }),
    turnSignal: () => new AbortController().signal,
    setCurrentCallId: () => {},
  });
  const loopEvents = createLoopEventRegistry();
  if (options.afterToolContent !== undefined) {
    loopEvents.register("after_tool", () => ({ content: options.afterToolContent }));
  }

  await adapter.sendTurn(handle, "look at the screen", {
    interactionHandler,
    codingTools: [tool],
    loopEvents,
  });
  return client.requests;
}

/** The tool-result messages of the LAST request the model was sent. */
function lastRequestToolResults(requests: readonly { readonly messages: readonly Record<string, unknown>[] }[]) {
  const messages = requests.at(-1)?.messages ?? [];
  return messages.filter((message) => message.role === "tool-result");
}

describe("NativeSessionAdapter — tool-result images reach the model (US-002)", () => {
  test("AC-7: the tool result in the second request carries the tool's images", async () => {
    const requests = await runImageTurn(screenTool({ content: "x", images: [PNG_A] }));

    expect(requests).toHaveLength(2);
    expect(lastRequestToolResults(requests)).toEqual([
      { role: "tool-result", toolCallId: "c1", content: "x", images: [PNG_A] },
    ]);
  });

  test("AC-8: an after_tool content patch rewrites the content and keeps the images", async () => {
    const requests = await runImageTurn(screenTool({ content: "x", images: [PNG_A] }), {
      afterToolContent: "y",
    });

    expect(lastRequestToolResults(requests)).toEqual([
      { role: "tool-result", toolCallId: "c1", content: "y", images: [PNG_A] },
    ]);
  });

  test("AC-9: a tool that throws leaves no images key on its result", async () => {
    const requests = await runImageTurn(screenTool("throw"));

    const results = lastRequestToolResults(requests);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("boom");
    expect(Object.hasOwn(results[0] ?? {}, "images")).toBe(false);
  });
});
