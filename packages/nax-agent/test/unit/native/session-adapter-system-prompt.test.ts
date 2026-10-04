/**
 * S3-4: OpenSessionOpts.systemPrompt reaches every round-trip request as
 * nax-ai's top-level `system`. A session opened without one sends none, and
 * the prompt is forgotten on close.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { NativeSessionAdapter, nativeSessionStateOf } from "#src/native/session-adapter";
import type { OpenSessionOpts } from "#src/session/session-types";
import type { CodingTool } from "#src/tools/registry";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const model: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};

const TOOL_ROUND: ProtocolEvent[] = [
  { type: "tool-call", call: { id: "c1", name: "Read", input: { path: "a.ts" } } },
  { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
  { type: "done", stopReason: "tool_use" },
];
const TEXT_ROUND: ProtocolEvent[] = [
  { type: "text-delta", text: "done" },
  { type: "usage", usage: { inputTokens: 6, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

function recordingClient(requests: ClientRequest[]): Client {
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream(_model, req) {
      requests.push(req);
      const events = requests.length === 1 ? TOOL_ROUND : TEXT_ROUND;
      return (async function* replay() {
        yield* events;
      })();
    },
    complete: async () => {
      throw new Error("round trips must stream");
    },
    validate: () => {},
  };
}

const fakeRead: CodingTool = {
  name: "Read",
  description: "read a file",
  inputSchema: { type: "object" },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "contents" };
  },
};

async function openOpts(extra: Partial<OpenSessionOpts>): Promise<OpenSessionOpts> {
  const dir = await mkdtemp(join(tmpdir(), "nax-system-prompt-"));
  return {
    agentName: "native",
    workdir: dir,
    transcriptDir: dir,
    timeoutSeconds: 60,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    ...extra,
  };
}

async function turnWith(extra: Partial<OpenSessionOpts>): Promise<ClientRequest[]> {
  const requests: ClientRequest[] = [];
  _resetNativeClient();
  _clientDeps.build = async () => recordingClient(requests);
  const adapter = new NativeSessionAdapter();
  const handle = await adapter.openSession("system-prompt", await openOpts(extra));
  await adapter.sendTurn(handle, "read a.ts", {
    interactionHandler: { onInteraction: async () => ({ answer: "contents" }) },
    codingTools: [fakeRead],
  });
  await adapter.closeSession(handle);
  return requests;
}

describe("OpenSessionOpts.systemPrompt", () => {
  test("is sent as `system` on every round-trip request", async () => {
    const requests = await turnWith({ systemPrompt: "You are terse." });
    expect(requests).toHaveLength(2);
    expect(requests.map((req) => req.system)).toEqual(["You are terse.", "You are terse."]);
  });

  test("a session opened without one sends no `system` key", async () => {
    const requests = await turnWith({});
    expect(requests).toHaveLength(2);
    expect(requests.some((req) => "system" in req)).toBe(false);
  });

  test("close forgets the prompt; reopening the same name without one sends none", async () => {
    _resetNativeClient();
    _clientDeps.build = async () => recordingClient([]);
    const adapter = new NativeSessionAdapter();
    const first = await adapter.openSession("reused", await openOpts({ systemPrompt: "first" }));
    expect(nativeSessionStateOf(adapter).systemPrompts.get("reused")).toBe("first");
    await adapter.closeSession(first);
    expect(nativeSessionStateOf(adapter).systemPrompts.has("reused")).toBe(false);
    await adapter.openSession("reused", await openOpts({}));
    expect(nativeSessionStateOf(adapter).systemPrompts.has("reused")).toBe(false);
  });
});
