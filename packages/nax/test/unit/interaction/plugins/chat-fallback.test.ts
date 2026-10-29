import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import { NaxError } from "@/errors";
import {
  _chatAskFileDeps,
  CHAT_ASK_POLL_MS,
  CHAT_ASK_STALE_MS,
  chatAskKey,
  readChatSettled,
  writeChatAnswer,
  writeChatHeartbeat,
} from "@/interaction/chat-ask-files";
import { _chatAskPluginDeps, ChatAskPlugin } from "@/interaction/plugins/chat";
import type { InteractionRequest, InteractionResponse } from "@/interaction/types";

const secret = new Uint8Array(32).fill(7);
const originalTimers = { ..._chatAskPluginDeps };
const originalFiles = { ..._chatAskFileDeps };
const request: InteractionRequest = {
  id: "ix-fallback",
  type: "confirm",
  featureName: "feature",
  stage: "execution",
  summary: "Proceed?",
  fallback: "abort",
  createdAt: 1,
};
let dir: string;
let clock = makeFakeClock();
let logger = makeLogger();
let fallback = makeFallback();
let plugin: ChatAskPlugin;
function makeFallback() {
  return {
    name: "telegram",
    send: mock(async (_request: InteractionRequest) => {}),
    receive: mock((_id: string, _timeout?: number): Promise<InteractionResponse> => new Promise(() => {})),
    cancel: mock(async (_id: string) => {}),
    destroy: mock(async () => {}),
  };
}
function response(respondedBy = "telegram"): InteractionResponse {
  return { requestId: request.id, action: "approve", respondedBy, respondedAt: clock.now() };
}
beforeEach(() => {
  dir = makeTempDir("chat-fallback-");
  clock = makeFakeClock();
  logger = makeLogger();
  fallback = makeFallback();
  Object.assign(_chatAskPluginDeps, { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  plugin = new ChatAskPlugin({ dir, secret, fallback, logger, fallbackDelayMs: 60_000 });
});
afterEach(async () => {
  Object.assign(_chatAskFileDeps, originalFiles);
  await plugin.destroy();
  expect(clock.pending()).toBe(0);
  Object.assign(_chatAskPluginDeps, originalTimers);
  cleanupTempDir(dir);
});
async function fresh(): Promise<void> {
  await writeChatHeartbeat(dir, new Date(clock.now()));
}
async function tick(): Promise<void> {
  await clock.advance(CHAT_ASK_POLL_MS);
  await waitForCondition(() => clock.pending() !== 1);
}
async function chatAnswer(): Promise<void> {
  await writeChatAnswer(dir, chatAskKey(request.id), { ...response(), respondedBy: "chat-user" }, secret);
  await tick();
}
function failWrite(): void {
  _chatAskFileDeps.write = Object.assign(() => {
    throw new NaxError("[test] write failed", "TEST", { stage: "test" });
  }, originalFiles.write);
}
describe("ChatAskPlugin fallback", () => {
  test("AC-1 AC-2 AC-3 starts once at the delay with the remaining timeout", async () => {
    await fresh();
    await plugin.send(request);
    void plugin.receive(request.id, 600_000);
    for (let elapsed = 500; elapsed < 60_000; elapsed += 500) {
      await fresh();
      await tick();
      expect(fallback.send).not.toHaveBeenCalled();
    }
    await fresh();
    await tick();
    expect(fallback.send).toHaveBeenCalledTimes(1);
    expect(fallback.send).toHaveBeenCalledWith(request);
    await waitForCondition(() => fallback.receive.mock.calls.length === 1);
    expect(fallback.receive).toHaveBeenCalledWith(request.id, 540_000);
    await tick();
    expect(fallback.send).toHaveBeenCalledTimes(1);
  });
  test("AC-4 AC-5 fallback answer wins and is recorded", async () => {
    fallback.receive.mockImplementation(async () => response());
    await plugin.send(request);
    const pending = plugin.receive(request.id, 600_000);
    await waitForCondition(() => fallback.receive.mock.calls.length === 1);
    expect(await pending).toEqual(response());
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("telegram");
    expect(fallback.cancel).not.toHaveBeenCalled();
  });
  test("AC-6 AC-7 chat wins after fallback starts and cancels it", async () => {
    await plugin.send(request);
    const pending = plugin.receive(request.id);
    await waitForCondition(() => fallback.receive.mock.calls.length === 1);
    await chatAnswer();
    expect(await pending).toMatchObject({ action: "approve", respondedBy: "chat-user" });
    expect(fallback.cancel).toHaveBeenCalledWith(request.id);
  });
  test("AC-8 missing heartbeat starts fallback during send", async () => {
    await plugin.send(request);
    expect(fallback.send).toHaveBeenCalledWith(request);
  });
  test("AC-9 stale heartbeat starts fallback on the next poll", async () => {
    await fresh();
    await plugin.send(request);
    void plugin.receive(request.id, 600_000);
    for (let elapsed = 0; elapsed < CHAT_ASK_STALE_MS; elapsed += CHAT_ASK_POLL_MS) await tick();
    expect(fallback.send).not.toHaveBeenCalled();
    await tick();
    expect(fallback.send).toHaveBeenCalledTimes(1);
  });
  test.each(["timeout", "superseded", "destroyed"])("AC-10 AC-19 ignores fabricated %s response", async (by) => {
    fallback.receive.mockImplementation(async () => ({ ...response(by), action: "skip" }));
    await plugin.send(request);
    let resolved = false;
    const pending = plugin.receive(request.id).then((value) => {
      resolved = true;
      return value;
    });
    await waitForCondition(() => fallback.receive.mock.calls.length === 1);
    await tick();
    expect(resolved).toBe(false);
    await chatAnswer();
    expect(await pending).toMatchObject({ respondedBy: "chat-user" });
  });
  test.each(["send", "receive"] as const)(
    "AC-11 AC-12 AC-20 AC-21 %s failure warns and keeps chat alive",
    async (method) => {
      fallback[method].mockImplementation(async () => {
        throw new NaxError("[test] offline", "TEST", { stage: "test" });
      });
      await plugin.send(request);
      const pending = plugin.receive(request.id);
      await waitForCondition(() => logger.warn.mock.calls.length === 1);
      expect(logger.warn.mock.calls[0]).toEqual([
        "chat-asks",
        expect.stringContaining(`Fallback ${method} failed`),
        expect.objectContaining({ requestId: request.id, error: expect.stringContaining("offline") }),
      ]);
      await chatAnswer();
      expect(await pending).toMatchObject({ respondedBy: "chat-user" });
    },
  );
  test("AC-13 deadline cancels fallback and records timeout", async () => {
    await plugin.send(request);
    const pending = plugin.receive(request.id, 2_000);
    await clock.advance(2_000);
    expect(await pending).toMatchObject({ action: "skip", respondedBy: "timeout" });
    expect(fallback.cancel).toHaveBeenCalledWith(request.id);
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("timeout");
  });
  test.each([false, true])("AC-14 AC-15 notify forwarding with fresh=%s", async (isFresh) => {
    if (isFresh) await fresh();
    const notice = { ...request, type: "notify" as const };
    await plugin.send(notice);
    if (isFresh) expect(fallback.send).not.toHaveBeenCalled();
    else expect(fallback.send).toHaveBeenCalledWith(notice);
  });
  test.each(["write", "directory"])("persistent %s failure preserves the fallback approval", async (failure) => {
    if (failure === "write") failWrite();
    else {
      const blocked = `${dir}/blocked`;
      await Bun.write(blocked, "not a directory");
      plugin = new ChatAskPlugin({ dir: blocked, secret, fallback, logger });
    }
    fallback.receive.mockImplementation(async () => response());
    await plugin.send(request);
    expect(await plugin.receive(request.id)).toEqual(response());
    expect(logger.warn).toHaveBeenCalled();
  });
  test("AC-16 AC-17 write failure uses fallback only", async () => {
    await fresh();
    failWrite();
    await plugin.send(request);
    expect(fallback.send).toHaveBeenCalledWith(request);
    Object.assign(_chatAskFileDeps, originalFiles);
    fallback.receive.mockImplementation(async () => response());
    expect(await plugin.receive(request.id)).toEqual(response());
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("telegram");
  });
  test("a late fallback answer cannot overwrite the chat settlement", async () => {
    let resolveFallback: (value: InteractionResponse) => void = () => {};
    fallback.receive.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFallback = resolve;
        }),
    );
    await plugin.send(request);
    const pending = plugin.receive(request.id);
    await waitForCondition(() => fallback.receive.mock.calls.length === 1);
    await chatAnswer();
    expect(await pending).toMatchObject({ respondedBy: "chat-user" });
    resolveFallback(response());
    await clock.advance(0);
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("chat-user");
  });
  test("a send completing after the chat wins is cancelled without starting receive", async () => {
    let finishSend: () => void = () => {};
    fallback.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = resolve;
        }),
    );
    plugin = new ChatAskPlugin({ dir, secret, fallback, logger, fallbackDelayMs: CHAT_ASK_POLL_MS });
    await fresh();
    await plugin.send(request);
    const pending = plugin.receive(request.id);
    await tick();
    expect(fallback.send).toHaveBeenCalledTimes(1);
    await chatAnswer();
    expect(await pending).toMatchObject({ respondedBy: "chat-user" });
    finishSend();
    await clock.advance(0);
    expect(fallback.receive).not.toHaveBeenCalled();
    expect(fallback.cancel).toHaveBeenCalledWith(request.id);
  });
  test("write failure waits only on fallback even if a chat answer exists", async () => {
    failWrite();
    await plugin.send(request);
    Object.assign(_chatAskFileDeps, originalFiles);
    const pending = plugin.receive(request.id, 2_000);
    await writeChatAnswer(dir, chatAskKey(request.id), { ...response(), respondedBy: "chat-user" }, secret);
    await clock.advance(2_000);
    expect(await pending).toMatchObject({ respondedBy: "timeout" });
    expect(fallback.receive).toHaveBeenCalledTimes(1);
  });
  test("AC-18 destroy delegates to fallback", async () => {
    await plugin.destroy();
    expect(fallback.destroy).toHaveBeenCalledTimes(1);
  });
});
