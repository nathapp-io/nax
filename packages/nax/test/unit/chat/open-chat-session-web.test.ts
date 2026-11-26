import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { AgentSessionError, createMemoryTranscriptStore, type SendInput, type ToolProvider } from "@nathapp/nax-agent";
import {
  assertDefined,
  fetchChatPage,
  makeChatWebHarness,
  makeNaxConfig,
  turnEndEvent,
  waitForAsyncCondition,
} from "@test/helpers";
import { _acpSessionDeps } from "@/chat/acp/acp-session-options";
import { formatMentionMessage } from "@/chat/mentions/mention-envelope";

let h: ReturnType<typeof makeChatWebHarness>;
const savedAcp = { ..._acpSessionDeps };
beforeEach(() => {
  h = makeChatWebHarness();
});
afterEach(async () => {
  await h.dispose();
  Object.assign(_acpSessionDeps, savedAcp);
});

function nativeOptions() {
  return h.deps.nativeBackend.mock.calls.at(-1)?.[0];
}
const otherWeb: ToolProvider = { id: "web", kind: "static", stages: ["*"], tools: async () => [] };

test("AC-1 native web guard is merged with existing host ports and sandbox wins posture", async () => {
  const backgroundCommands = { adopt: mock(), foreground: () => () => {} };
  const shadow = { observe() {}, settle() {}, drain: async () => {} };
  h.deps.buildCommandShadow = () => shadow;
  await h.open({ mode: "guarded", backgroundCommands });
  const web = h.web();
  assertDefined(web);
  expect(nativeOptions()?.hostPorts).toEqual({ backgroundCommands, commandShadow: shadow, webExposure: web.guard });
  expect(nativeOptions()?.sandbox).toBe(web.sandbox);
});
test("AC-2 conflicting web provider is removed and session web occurs exactly once", async () => {
  const providers = [otherWeb];
  await h.open({ toolProviders: providers });
  const web = h.web();
  assertDefined(web);
  expect(nativeOptions()?.toolProviders?.filter((p) => p.id === "web")).toEqual([web.provider]);
  expect(nativeOptions()?.toolProviders).not.toContain(otherWeb);
  expect(providers).toEqual([otherWeb]);
});
test("AC-3 ACP gets no web provider or guard", async () => {
  const received: (readonly ToolProvider[])[] = [];
  _acpSessionDeps.chatAcpTools = async (providers) => {
    received.push(providers);
    return { tools: [] };
  };
  _acpSessionDeps.acpBackend = () => ({
    kind: "acp:stub",
    async open() {
      throw new Error("unused");
    },
  });
  await h.open({ model: "acp:claude", toolProviders: [otherWeb] });
  expect(received.flat().map((p) => p.id)).not.toContain("web");
  expect(h.deps.createChatWeb).toHaveBeenCalledWith(expect.objectContaining({ backend: "acp" }));
  expect(h.deps.nativeBackend).not.toHaveBeenCalled();
});
test("AC-4 factory notice is returned with the native session", async () => {
  const handle = await h.open();
  expect(handle.notice).toContain("TAVILY_API_KEY");
});
test("AC-4 ACP joins the web notice after an existing fallback notice", async () => {
  const store = createMemoryTranscriptStore();
  await store.save("web-session-1", {
    savedAt: "2026-11-01T00:00:00.000Z",
    messages: [],
    turn: { turnId: "t", state: "ended" },
  });
  h.deps.createFileTranscriptStore = () => store;
  h.deps.resumeAgentSession = mock(async () => {
    throw new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND", {});
  });
  _acpSessionDeps.chatAcpTools = async () => ({ tools: [] });
  _acpSessionDeps.acpBackend = () => ({
    kind: "acp:stub",
    async open() {
      throw new Error("unused");
    },
  });
  const handle = await h.open({ model: "acp:claude" });
  expect(handle.notice).toContain("; web tools need the native agent; they are off in this session");
  expect(handle.notice).not.toStartWith("web tools");
  expect(h.deps.resumeAgentSession).toHaveBeenCalledTimes(1);
});

test("AC-5 a second open builds a fresh unexposed exposure; resume restores its own snapshot", async () => {
  const first = await h.open();
  await fetchChatPage(first.web);
  await waitForAsyncCondition(
    async () => Boolean((await h.storage.readMeta(first.meta.sessionId))?.web?.exposedAt),
    (value) => value,
  );
  const second = await h.open();
  expect(second.web?.exposure.isExposed()).toBe(false);
  expect(second.web?.exposure.snapshot().seenUrls).toEqual([]);
  await first.release();
  const resumed = await h.open({ resumeId: first.meta.sessionId });
  expect(resumed.web?.exposure.isExposed()).toBe(true);
});
test("AC-6 successful web fetch persists exposure before turn end", async () => {
  const handle = await h.open();
  expect((await fetchChatPage(handle.web)).isError).not.toBe(true);
  await waitForAsyncCondition(
    async () => Boolean((await h.storage.readMeta(handle.meta.sessionId))?.web?.exposedAt),
    (value) => value,
  );
  expect(handle.web?.exposure.snapshot()).toEqual((await h.storage.readMeta(handle.meta.sessionId))?.web);
  expect(handle.meta.web).toBeUndefined();
});
test("AC-9 typed URL is seen synchronously before send starts and send input is preserved", async () => {
  const handle = await h.open();
  const original = mock((message: string, _input?: SendInput) => {
    expect(h.web()?.exposure.hasSeen("https://b.example/doc")).toBe(true);
    return (async function* () {
      yield turnEndEvent(message);
    })();
  });
  h.session.send = original;
  const input: SendInput = { images: [{ data: "AA==", mimeType: "image/png" }] };
  for await (const _ of handle.session.send("read https://b.example/doc", input)) {
    /* consume */
  }
  expect(original).toHaveBeenCalledWith("read https://b.example/doc", input);
});
test("AC-10 URLs inside attached files are not pre-approved", async () => {
  const handle = await h.open();
  const message = formatMentionMessage("see file", [
    { path: "a.txt", status: "attached", note: "", body: "https://c.example/x" },
  ]);
  h.script(async function* () {
    expect(h.web()?.exposure.hasSeen("https://c.example/x")).toBe(false);
    yield turnEndEvent();
  });
  for await (const _ of handle.session.send(message)) {
    /* consume */
  }
  expect(handle.web?.exposure.snapshot().seenUrls).toEqual([]);
});
test("AC-11 returned handle carries the exact guard passed to the backend", async () => {
  const handle = await h.open();
  assertDefined(handle.web);
  expect(nativeOptions()?.hostPorts?.webExposure).toBe(handle.web.guard);
});
test("AC-16 one warning names a conflicting provider", async () => {
  await h.open({ toolProviders: [otherWeb, otherWeb] });
  expect(h.logger.warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.logger.warn.mock.calls)).toContain("web");
});
test("AC-17 disabled web omits hostPorts and preserves native no-web send identity", async () => {
  const handle = await h.open({ config: makeNaxConfig({ chat: { web: { enabled: false } } }) });
  expect(h.deps.createChatWeb).toHaveBeenCalled();
  expect(nativeOptions()).not.toHaveProperty("hostPorts");
  expect(handle.web).toBeUndefined();
  expect(handle.session).toBe(h.session);
});
test("a failed exposure write does not unlock until the command shadow has drained", async () => {
  const shadowDone = Promise.withResolvers<void>();
  const writeFailed = Promise.withResolvers<void>();
  let unlocked = false;
  h.storage.acquireLock = async () => async () => {
    unlocked = true;
  };
  h.deps.buildCommandShadow = () => ({ observe() {}, settle() {}, drain: () => shadowDone.promise });
  const handle = await h.open({ mode: "guarded" });
  let writes = 0;
  h.storage.writeMeta = async () => {
    if (++writes === 2) writeFailed.resolve();
    throw new Error("write failed");
  };
  await fetchChatPage(handle.web);
  await writeFailed.promise;
  const releasing = handle.release().catch((error) => error);
  // Yield one event-loop turn so the rejected durability promise can finish its handlers.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const unlockedBeforeDrain = unlocked;
  shadowDone.resolve();
  const failure = await releasing;
  h.handles.pop();
  expect(failure.message).toBe("write failed");
  expect(unlockedBeforeDrain).toBe(false);
  expect(unlocked).toBe(true);
  // Teardown must not rethrow this intentionally failed release.
  h.storage.writeMeta = async () => {};
});

test("release drains pending writes and retires the subscription without stale overwrite", async () => {
  const handle = await h.open();
  await fetchChatPage(handle.web);
  await handle.release({ retainLock: true });
  const stored = await h.storage.readMeta(handle.meta.sessionId);
  expect(stored?.web?.exposedAt).toBeString();
  handle.web?.exposure.countSearch();
  await handle.release();
  expect(await h.storage.readMeta(handle.meta.sessionId)).toEqual(stored);
});
