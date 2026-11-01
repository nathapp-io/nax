import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  createSessionStorage,
  type ImageAttachment,
  type SendInput,
  type SessionEvent,
  type SessionMeta,
  type SessionStorage,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import {
  type ChatHost,
  type ChatLedger,
  type ChatSessionHandle,
  createChatHost,
  runChatTurn,
  sessionAcceptsImages,
} from "@/chat";
import { _openChatSessionDeps } from "@/chat/open-chat-session";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const ISO = NOW.toISOString();
const MODEL = "anthropic/test";
const IMAGE: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 2, height: 2, source: "clipboard" };

const originals = { ..._openChatSessionDeps };
const quietLedger: ChatLedger = { record: () => {}, drain: async () => {} };
let dir: string;
let storage: SessionStorage;
let host: ChatHost;
let send: Mock<(message: string, input?: SendInput) => AsyncIterable<SessionEvent>>;
let accepts: (() => Promise<boolean>) | undefined;

/** The three events a turn needs: `turn_end` last, or `runChatTurn` refuses the turn. */
async function* events(sessionId: string): AsyncGenerator<SessionEvent> {
  const base = { sessionId, turnId: "t1", at: ISO, metadata: {} };
  yield { ...base, type: "turn_start" };
  yield { ...base, type: "usage", round: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01 };
  yield {
    ...base,
    type: "turn_end",
    status: "completed",
    output: "ok",
    usage: { inputTokens: 10, outputTokens: 2 },
    costUsd: 0.02,
  };
}

/** A session that is only asked about its capability: its turn is never claimed. */
async function* idle(): AsyncGenerator<SessionEvent> {}

function fakeSession(id: string, sendTurn: AgentSession["send"], capability?: () => Promise<boolean>): AgentSession {
  return {
    id,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    send: sendTurn,
    answer: () => "unknown",
    cancel() {},
    async close() {},
    ...(capability === undefined ? {} : { acceptsImages: capability }),
  };
}

function handleFor(session: AgentSession): ChatSessionHandle {
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: session.id,
    cwd: dir,
    model: MODEL,
    mode: "ask",
    bashApproval: "gated",
    title: null,
    createdAt: ISO,
    updatedAt: null,
  };
  return { session, meta, release: async () => {} };
}

/** Drive one turn and report the arguments `send` received. */
async function turnSend(images?: readonly ImageAttachment[]): Promise<unknown[][]> {
  const sendTurn = mock((_message: string, _input?: SendInput) => events("turn-session"));
  await runChatTurn({
    handle: handleFor(fakeSession("turn-session", sendTurn)),
    storage,
    message: "look",
    ...(images === undefined ? {} : { images }),
    asks: { handle: () => {} },
    ledger: quietLedger,
    onEvent: () => {},
    now: ISO,
  });
  return sendTurn.mock.calls;
}

const start = () => host.start({ mode: "guarded", model: MODEL });

/** The host's capability answer, read through the optional member the interface declares. */
async function capabilityAnswer(): Promise<boolean> {
  const capability = host.acceptsImages;
  assertDefined(capability, "host acceptsImages");
  return capability.call(host);
}

beforeEach(() => {
  dir = makeTempDir("chat-images-");
  storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
    isAlive: () => true,
  });
  accepts = undefined;
  send = mock((_message: string, _input?: SendInput) => events("session-1"));
  Object.assign(_openChatSessionDeps, {
    randomUUID: () => "session-1",
    now: () => NOW,
    createAgentSession: mock(async () => fakeSession("session-1", send, accepts)),
  });
  host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: dir,
    repoRoot: dir,
    storage,
    now: () => NOW,
    logger: makeLogger(),
    chain: null,
  });
});
afterEach(async () => {
  await host?.close();
  Object.assign(_openChatSessionDeps, originals);
  cleanupTempDir(dir);
});

describe("runChatTurn images", () => {
  test("AC-1 sends the message with its images when the caller supplied some", async () => {
    expect(await turnSend([IMAGE])).toEqual([["look", { images: [IMAGE] }]]);
  });
  test("AC-2 sends the message as the only argument without images", async () => {
    expect(await turnSend()).toEqual([["look"]]);
  });
  test("AC-2 sends the message as the only argument for an empty image list", async () => {
    expect(await turnSend([])).toEqual([["look"]]);
  });
});

describe("chat host images", () => {
  test("AC-3 send passes the image options through to the open session", async () => {
    await start();
    await host.send("look", () => {}, { images: [IMAGE] });
    expect(send.mock.calls).toEqual([["look", { images: [IMAGE] }]]);
  });
  test("AC-2 send without images calls the open session with the message alone", async () => {
    await start();
    await host.send("look", () => {});
    expect(send.mock.calls).toEqual([["look"]]);
  });
  test.each([true, false])("AC-4 acceptsImages resolves %p for the open session", async (answer) => {
    accepts = async () => answer;
    await start();
    expect(await capabilityAnswer()).toBe(answer);
  });
  test("AC-7 a rejecting session capability resolves false instead of rejecting", async () => {
    accepts = async () => {
      throw new Error("capability probe failed");
    };
    await start();
    expect(await capabilityAnswer()).toBe(false);
  });
  test("acceptsImages resolves false when no session is open", async () => {
    expect(await capabilityAnswer()).toBe(false);
  });
});

describe("sessionAcceptsImages", () => {
  test("AC-5 resolves false when the session has no capability", async () => {
    expect(await sessionAcceptsImages(fakeSession("s", idle))).toBe(false);
  });
  test("AC-5 resolves false with no open session", async () => {
    expect(await sessionAcceptsImages(undefined)).toBe(false);
  });
  test("AC-6 resolves false when the session's capability rejects", async () => {
    const session = fakeSession("s", idle, async () => {
      throw new Error("capability probe failed");
    });
    expect(await sessionAcceptsImages(session)).toBe(false);
  });
  test("resolves the session's answer when the capability can say", async () => {
    expect(await sessionAcceptsImages(fakeSession("s", idle, async () => true))).toBe(true);
    expect(await sessionAcceptsImages(fakeSession("s", idle, async () => false))).toBe(false);
  });
});
