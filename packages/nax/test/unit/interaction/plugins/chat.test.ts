import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeClock, makeTempDir, waitForCondition } from "@test/helpers";
import { InteractionChain } from "@/interaction/chain";
import {
  CHAT_ASK_POLL_MS,
  chatAskKey,
  readChatAsks,
  readChatSettled,
  takeChatNotices,
  writeChatAnswer,
} from "@/interaction/chat-ask-files";
import { _chatAskPluginDeps, ChatAskPlugin } from "@/interaction/plugins/chat";
import type { InteractionRequest } from "@/interaction/types";

const secret = new Uint8Array(32).fill(7);
const originalDeps = { ..._chatAskPluginDeps };
let dir: string;
let clock = makeFakeClock();
let plugin: ChatAskPlugin;
const request: InteractionRequest = {
  id: "ix-chat",
  type: "confirm",
  featureName: "feature",
  stage: "execution",
  summary: "Proceed?",
  fallback: "abort",
  createdAt: 1,
};
beforeEach(() => {
  dir = makeTempDir("chat-plugin-");
  clock = makeFakeClock();
  Object.assign(_chatAskPluginDeps, { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  plugin = new ChatAskPlugin({ dir, secret });
});
afterEach(async () => {
  await plugin.destroy();
  expect(clock.pending()).toBe(0);
  Object.assign(_chatAskPluginDeps, originalDeps);
  cleanupTempDir(dir);
});
async function answer(value?: string): Promise<void> {
  await writeChatAnswer(
    dir,
    chatAskKey(request.id),
    {
      requestId: request.id,
      action: value ? "choose" : "approve",
      value,
      respondedBy: "chat-user",
      respondedAt: new Date(clock.now()).toISOString(),
    },
    secret,
  );
}

describe("ChatAskPlugin", () => {
  test("AC-1 names the transport chat", () => {
    expect(plugin.name).toBe("chat");
    expect(plugin.fallbackDelayMs).toBe(60_000);
  });
  test("AC-2 publishes a signed confirm ask with the request id", async () => {
    await plugin.send(request);
    expect((await readChatAsks(dir, secret)).map((ask) => ask.request.id)).toEqual([request.id]);
  });
  test("AC-3 and AC-4 notify writes only a signed notice", async () => {
    const notice = { ...request, type: "notify" as const };
    await plugin.send(notice);
    expect((await takeChatNotices(dir, secret)).map((record) => record.request)).toEqual([notice]);
    expect(await readChatAsks(dir, secret)).toEqual([]);
  });
  test("AC-5, AC-6 and AC-8 polls for approval and settles as the chat user", async () => {
    await plugin.send(request);
    const pending = plugin.receive(request.id, 60_000);
    await answer();
    await clock.advance(CHAT_ASK_POLL_MS);
    const response = await pending;
    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("chat-user");
    expect(response.respondedAt).toBe(clock.now() - CHAT_ASK_POLL_MS);
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("chat-user");
    expect(clock.pending()).toBe(0);
  });
  test("AC-7 preserves a choose response value", async () => {
    await plugin.send({ ...request, type: "choose" });
    const pending = plugin.receive(request.id, 60_000);
    await answer("skip");
    await clock.advance(CHAT_ASK_POLL_MS);
    expect(await pending).toMatchObject({ action: "choose", value: "skip" });
  });
  test("AC-9, AC-10 and AC-11 deadline skips and settles as timeout", async () => {
    await plugin.send(request);
    let resolved = false;
    const pending = plugin.receive(request.id, 2_000).then((response) => {
      resolved = true;
      return response;
    });
    await clock.advance(1_999);
    expect(resolved).toBe(false);
    await clock.advance(1);
    expect(await pending).toMatchObject({ action: "skip", respondedBy: "timeout", respondedAt: clock.now() });
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("timeout");
  });
  test("AC-12 real chain prompt normalizes choose allow to action allow", async () => {
    const chain = new InteractionChain({ defaultTimeout: 60_000, defaultFallback: "abort" });
    chain.register(plugin);
    const pending = chain.prompt({ ...request, type: "choose", options: [{ key: "allow", label: "Allow" }] });
    await waitForCondition(() => clock.pending() > 0);
    await answer("allow");
    await clock.advance(CHAT_ASK_POLL_MS);
    expect((await pending).action).toBe("allow");
  });
  test.each(["cancel", "destroy"] as const)("%s releases pending receivers and timers", async (method) => {
    await plugin.send(request);
    const pending = plugin.receive(request.id, 60_000);
    expect(clock.pending()).toBeGreaterThan(0);
    if (method === "cancel") await plugin.cancel(request.id);
    else await plugin.destroy();
    expect(await pending).toMatchObject({ action: "skip", respondedBy: "cancelled" });
    expect(clock.pending()).toBe(0);
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("cancelled");
  });
  test("deadline is measured from send rather than receive", async () => {
    await plugin.send(request);
    await clock.advance(1_500);
    const pending = plugin.receive(request.id, 2_000);
    await clock.advance(500);
    expect((await pending).respondedBy).toBe("timeout");
  });
});
