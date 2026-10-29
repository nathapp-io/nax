import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import { NaxError } from "@/errors";
import { decideSessionOutcome } from "@/interaction/ask-link-session";
import {
  _chatAskFileDeps,
  CHAT_ASK_POLL_MS,
  chatAskKey,
  readChatAnswer,
  readChatSettled,
  signChatRecord,
  writeChatAnswer,
} from "@/interaction/chat-ask-files";
import { _chatAskPluginDeps, ChatAskPlugin } from "@/interaction/plugins/chat";
import type { InteractionRequest } from "@/interaction/types";

const secret = new Uint8Array(32).fill(7);
const originalTimers = { ..._chatAskPluginDeps };
const originalFiles = { ..._chatAskFileDeps };
const request: InteractionRequest = {
  id: "ix-guards",
  type: "choose",
  featureName: "feature",
  stage: "execution",
  summary: "Proceed?",
  fallback: "abort",
  createdAt: 1,
};
let dir: string;
let clock = makeFakeClock();
let logger = makeLogger();
let plugin: ChatAskPlugin;
beforeEach(() => {
  dir = makeTempDir("chat-guards-");
  clock = makeFakeClock();
  logger = makeLogger();
  Object.assign(_chatAskPluginDeps, { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  plugin = new ChatAskPlugin({ dir, secret, logger });
});
afterEach(async () => {
  Object.assign(_chatAskFileDeps, originalFiles);
  await plugin.destroy();
  expect(clock.pending()).toBe(0);
  Object.assign(_chatAskPluginDeps, originalTimers);
  cleanupTempDir(dir);
});
async function answer(respondedBy: "chat-user" | "chat-agent" = "chat-user", value = "allow"): Promise<void> {
  await writeChatAnswer(
    dir,
    chatAskKey(request.id),
    {
      requestId: request.id,
      action: "choose",
      value,
      respondedBy,
      respondedAt: clock.now(),
    },
    secret,
  );
}
async function poll(): Promise<void> {
  await clock.advance(CHAT_ASK_POLL_MS);
  await waitForCondition(() => clock.pending() !== 1);
}

describe("ChatAskPlugin guards", () => {
  test.each([
    ["malformed JSON", "AC-1 AC-2 AC-3"],
    ["unknown action", "AC-16"],
    ["missing mac", "AC-17 AC-18"],
    ["wrong mac", "AC-13 AC-18"],
  ])("%s is ignored once and a later valid answer wins (%s)", async (kind) => {
    await plugin.send(request);
    let resolved = false;
    const pending = plugin.receive(request.id, 60_000).then((response) => {
      resolved = true;
      return response;
    });
    const record = {
      schemaVersion: 1,
      requestId: request.id,
      action: kind === "unknown action" ? "surprise" : "choose",
      value: "allow",
      respondedBy: "chat-user",
      respondedAt: clock.now(),
    };
    const raw =
      kind === "malformed JSON"
        ? "{"
        : JSON.stringify(
            kind === "missing mac"
              ? record
              : {
                  ...record,
                  mac: signChatRecord(kind === "wrong mac" ? new Uint8Array(32).fill(8) : secret, record),
                },
          );
    await Bun.write(`${dir}/${chatAskKey(request.id)}.answer.json`, raw);
    for (let i = 0; i < 3; i++) {
      await poll();
      expect(resolved).toBe(false);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await answer();
    await poll();
    expect(await pending).toMatchObject({ value: "allow", respondedBy: "chat-user" });
  });
  test("AC-4 agent cannot remember an approval", async () => {
    await plugin.send({ ...request, metadata: { approvalPrompt: true } });
    const pending = plugin.receive(request.id);
    await answer("chat-agent", "allow-remember");
    await poll();
    expect(await pending).toMatchObject({ value: "allow", respondedBy: "chat-agent" });
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.value).toBe("allow");
  });
  test.each([
    [{ safety: "red" }, "AC-5 AC-6"],
    [{ trigger: "pre-merge" }, "AC-7"],
    [{ trigger: "human-review" }, "AC-8"],
  ])("human-only metadata %j rejects agents but accepts humans (%s)", async (metadata) => {
    await plugin.send({ ...request, metadata });
    let resolved = false;
    const pending = plugin.receive(request.id).then((response) => {
      resolved = true;
      return response;
    });
    await answer("chat-agent");
    await poll();
    expect(resolved).toBe(false);
    expect(await readChatSettled(dir, chatAskKey(request.id), secret)).toBeUndefined();
    expect(await readChatAnswer(dir, chatAskKey(request.id), secret)).toBeUndefined();
    await answer();
    await poll();
    expect(await pending).toMatchObject({ respondedBy: "chat-user", value: "allow" });
  });
  test("AC-9 AC-10 cancellation returns timeout but records cancelled", async () => {
    await plugin.send(request);
    const pending = plugin.receive(request.id);
    await plugin.cancel(request.id);
    expect(await pending).toMatchObject({ respondedBy: "timeout", action: "skip" });
    expect((await readChatSettled(dir, chatAskKey(request.id), secret))?.by).toBe("cancelled");
  });
  test("AC-11 write failure rejects with the protocol error", async () => {
    _chatAskFileDeps.write = Object.assign(() => {
      throw new NaxError("[test] write failed", "TEST", { stage: "test" });
    }, originalFiles.write);
    const error = await plugin.send(request).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "CHAT_ASK_WRITE_FAILED" });
  });
  test("AC-12 unknown receive rejects with the protocol error", async () => {
    const error = await plugin.receive("never-sent").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "CHAT_ASK_UNKNOWN" });
  });
});

describe("decideSessionOutcome chat attribution", () => {
  test.each(["chat-agent", "chat-user"] as const)("only a human can remember (%s)", async (respondedBy) => {
    let remembered = 0;
    const outcome = await decideSessionOutcome(
      { action: "allow-remember", respondedBy },
      { tool: "Bash", command: "echo ok", summary: "test", stage: "implementer", rule: "ask" },
      async () => {
        remembered++;
      },
    );
    expect(outcome).toEqual({ decision: "allow", decidedBy: respondedBy === "chat-agent" ? "model" : "human" });
    expect(remembered).toBe(respondedBy === "chat-user" ? 1 : 0);
  });
  test.each([
    ["allow", "chat-agent", "model", "AC-14"],
    ["deny", "chat-agent", "model", "AC-15"],
    ["allow", "chat-user", "human", "AC-19"],
    ["deny", "chat-user", "human", "AC-20"],
  ] as const)("%s by %s is attributed to %s (%s)", async (action, respondedBy, decidedBy) => {
    const outcome = await decideSessionOutcome(
      { action, respondedBy },
      {
        tool: "Bash",
        command: "echo ok",
        summary: "test",
        stage: "implementer",
        rule: "ask",
      },
      undefined,
    );
    expect(outcome).toEqual({ decision: action, decidedBy });
  });
});
