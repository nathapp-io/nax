import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import * as files from "@/interaction/chat-ask-files";
import type { InteractionRequest } from "@/interaction/types";

let dir: string;
const secret = new Uint8Array(32).fill(7);
const wrong = new Uint8Array(32).fill(8);
const now = new Date("2026-10-29T12:00:00Z");
const request: InteractionRequest = {
  id: "ix-a",
  type: "choose",
  featureName: "feature",
  stage: "execution",
  summary: "Proceed?",
  fallback: "abort",
  createdAt: now.getTime(),
  options: [{ key: "yes", label: "Yes" }],
};
const answer = {
  requestId: request.id,
  action: "choose" as const,
  value: "yes",
  respondedBy: "chat-user" as const,
  respondedAt: now.getTime(),
  reason: "approved",
};
const settled = {
  requestId: request.id,
  by: "telegram",
  action: "choose" as const,
  value: "yes",
  settledAt: now.toISOString(),
};
const key = (): string => files.chatAskKey(request.id);
const originalRename = files._chatAskFileDeps.rename;
beforeEach(() => {
  dir = makeTempDir("chat-ask-files-");
});
afterEach(() => {
  files._chatAskFileDeps.rename = originalRename;
  cleanupTempDir(dir);
});
async function raw(suffix: string, record: unknown, fileKey = key()): Promise<void> {
  await Bun.write(join(dir, `${fileKey}.${suffix}.json`), typeof record === "string" ? record : JSON.stringify(record));
}
describe("chat ask file protocol", () => {
  test("rejects forged notices and settlements", async () => {
    await files.writeChatNotice(dir, request, now, wrong);
    await files.writeChatSettled(dir, key(), settled, wrong);
    expect(await files.takeChatNotices(dir, secret)).toEqual([]);
    expect(await files.readChatSettled(dir, key(), secret)).toBeUndefined();
  });
  test("overlapping notice reads deliver only once", async () => {
    await files.writeChatNotice(dir, request, now, secret);
    const batches = await Promise.all([files.takeChatNotices(dir, secret), files.takeChatNotices(dir, secret)]);
    expect(batches.flat()).toHaveLength(1);
  });
  test("F1 answer waits for an in-flight settlement and is not published after it", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = files._chatAskFileDeps.write;
    files._chatAskFileDeps.write = Object.assign(async (...args: Parameters<typeof write>) => {
      if (String(args[0]).includes(".settled.json.")) {
        entered.resolve();
        await release.promise;
      }
      return write(...args);
    }, write);
    let settlement: Promise<void> | undefined;
    let delivery: Promise<void> | undefined;
    try {
      settlement = files.writeChatSettled(dir, key(), settled, secret);
      await entered.promise;
      delivery = files.writeChatAnswer(dir, key(), answer, secret);
      release.resolve();
      await Promise.all([settlement, delivery]);
      expect(await files.readChatSettled(dir, key(), secret)).toEqual(settled);
      expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([settlement, delivery]);
      files._chatAskFileDeps.write = write;
    }
  });
  test.each(["chat-agent", "chat-user"] as const)(
    "rejected-agent cleanup rechecks attribution under the lock (%s)",
    async (respondedBy) => {
      await files.writeChatAnswer(dir, key(), { ...answer, respondedBy }, secret);
      await files.discardChatAgentAnswer(dir, key(), secret);
      expect(await files.readChatAnswer(dir, key(), secret)).toEqual(
        respondedBy === "chat-agent" ? undefined : { ...answer, respondedBy },
      );
    },
  );
  test("duplicate answer is refused before rename and preserves the first answer", async () => {
    await files.writeChatAnswer(dir, key(), answer, secret);
    const rename = mock(originalRename);
    files._chatAskFileDeps.rename = rename;
    await expect(files.writeChatAnswer(dir, key(), { ...answer, action: "reject" }, secret)).rejects.toThrow(
      "Answer already exists",
    );
    expect(rename).not.toHaveBeenCalled();
    expect(await files.readChatAnswer(dir, key(), secret)).toEqual(answer);
  });
  test("failed initial answer rename publishes no answer", async () => {
    files._chatAskFileDeps.rename = () => {
      throw new Error("rename failure");
    };
    await expect(files.writeChatAnswer(dir, key(), answer, secret)).rejects.toThrow("Failed to write");
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
  });
  test("malformed heartbeat is closed", async () => {
    await Bun.write(join(dir, "heartbeat.json"), "{");
    expect(await files.chatHeartbeatFresh(dir, now.getTime())).toBe(false);
  });
  test("rejects path traversal keys", async () => {
    await expect(files.writeChatAnswer(dir, "../answer", answer, secret)).rejects.toThrow("Invalid key");
  });
  test("missing directories are empty", async () => {
    expect(await files.readChatAsks(join(dir, "missing"), secret)).toEqual([]);
    expect(await files.takeChatNotices(join(dir, "missing"), secret)).toEqual([]);
  });
  test("accepts the spec's ISO answer timestamp", async () => {
    const payload = { ...answer, respondedAt: now.toISOString() };
    const record = { ...payload, schemaVersion: 1 };
    await raw("answer", { ...record, mac: files.signChatRecord(secret, record) });
    expect(await files.readChatAnswer(dir, key(), secret)).toEqual(payload);
  });
  test("AC-1 key format", () => {
    expect(files.chatAskKey("trigger-pre-merge-1-abc")).toMatch(/^[a-f0-9]{16}$/);
  });
  test("AC-2 deterministic", () => {
    expect(key()).toBe(key());
  });
  test("AC-3 distinct", () => {
    expect(key()).not.toBe(files.chatAskKey("ix-b"));
  });
  test("AC-4 returns key", async () => {
    expect(await files.writeChatAsk(dir, request, now, secret)).toBe(key());
  });
  test("AC-5 preserves request", async () => {
    await files.writeChatAsk(dir, request, now, secret);
    expect((await files.readChatAsks(dir, secret))[0]?.request).toEqual(request);
  });
  test("AC-6 preserves askedAt", async () => {
    await files.writeChatAsk(dir, request, now, secret);
    expect((await files.readChatAsks(dir, secret))[0]?.askedAt).toBe(now.toISOString());
  });
  test("AC-7 isolates malformed JSON", async () => {
    await files.writeChatAsk(dir, request, now, secret);
    await raw("ask", "{", files.chatAskKey("broken"));
    expect(await files.readChatAsks(dir, secret)).toHaveLength(1);
  });
  test("AC-8 answer payload", async () => {
    await files.writeChatAnswer(dir, key(), answer, secret);
    expect(await files.readChatAnswer(dir, key(), secret)).toEqual(answer);
  });
  test("AC-9 absent answer", async () => {
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
  });
  test("AC-10 malformed answer", async () => {
    await raw("answer", "{");
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
  });
  test("AC-11 invalid signed action", async () => {
    const record = { schemaVersion: 1, ...answer, action: "bogus" };
    await raw("answer", { ...record, mac: files.signChatRecord(secret, record) });
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
  });
  test("AC-12 settled payload", async () => {
    await files.writeChatSettled(dir, key(), settled, secret);
    expect(await files.readChatSettled(dir, key(), secret)).toEqual(settled);
  });
  test("AC-13 notice request", async () => {
    await files.writeChatNotice(dir, request, now, secret);
    expect((await files.takeChatNotices(dir, secret))[0]?.request).toEqual(request);
  });
  test("AC-14 consumes once", async () => {
    await files.writeChatNotice(dir, request, now, secret);
    expect(await files.takeChatNotices(dir, secret)).toHaveLength(1);
    expect(await files.takeChatNotices(dir, secret)).toEqual([]);
  });
  test("AC-15 rename failure rejects", async () => {
    files._chatAskFileDeps.rename = () => {
      throw new Error("rename failure");
    };
    await expect(files.writeChatAnswer(dir, key(), answer, secret)).rejects.toThrow();
  });
  test("AC-16 failed rename leaves no answer or temp", async () => {
    files._chatAskFileDeps.rename = () => {
      throw new Error("rename failure");
    };
    await expect(files.writeChatAnswer(dir, key(), answer, secret)).rejects.toThrow();
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
  test("AC-17 inclusive freshness", async () => {
    await files.writeChatHeartbeat(dir, now);
    expect(await files.chatHeartbeatFresh(dir, now.getTime() + files.CHAT_ASK_STALE_MS)).toBe(true);
  });
  test("AC-18 stale beyond boundary", async () => {
    await files.writeChatHeartbeat(dir, now);
    expect(await files.chatHeartbeatFresh(dir, now.getTime() + files.CHAT_ASK_STALE_MS + 1)).toBe(false);
  });
  test("AC-19 absent heartbeat", async () => {
    expect(await files.chatHeartbeatFresh(dir, Date.now())).toBe(false);
  });
  test("AC-20 removes idempotently", async () => {
    await files.writeChatHeartbeat(dir, now);
    await files.removeChatHeartbeat(dir);
    await files.removeChatHeartbeat(dir);
    expect(await files.chatHeartbeatFresh(dir, Date.now())).toBe(false);
  });
  test("AC-21 wrong secret", async () => {
    await files.writeChatAnswer(dir, key(), answer, wrong);
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
  });
  test("AC-22 absent MAC", async () => {
    await raw("answer", { schemaVersion: 1, ...answer });
    expect(await files.readChatAnswer(dir, key(), secret)).toBeUndefined();
  });
  test("AC-23 binds filename", async () => {
    await files.writeChatAnswer(dir, key(), answer, secret);
    await Bun.write(join(dir, `${files.chatAskKey("ix-b")}.answer.json`), Bun.file(join(dir, `${key()}.answer.json`)));
    expect(await files.readChatAnswer(dir, files.chatAskKey("ix-b"), secret)).toBeUndefined();
  });
  test("AC-24 skips forged ask", async () => {
    await files.writeChatAsk(dir, request, now, wrong);
    expect(await files.readChatAsks(dir, secret)).toEqual([]);
  });
  test.each(["approve", "reject", "choose", "input", "skip", "abort"] as const)(
    "round-trips action %s",
    async (action) => {
      const response = { ...answer, action };
      await files.writeChatAnswer(dir, key(), response, secret);
      expect(await files.readChatAnswer(dir, key(), secret)).toEqual(response);
    },
  );
  test("canonical nested signing and tamper rejection", () => {
    const record = { b: { z: 1, a: 2 }, a: [3, { y: 4, x: 5 }] };
    const reordered = { a: [3, { x: 5, y: 4 }], b: { a: 2, z: 1 } };
    const mac = files.signChatRecord(secret, record);
    expect(mac).toMatch(/^[a-f0-9]{64}$/);
    expect(files.signChatRecord(secret, reordered)).toBe(mac);
    expect(files.verifyChatRecord(secret, { ...record, mac })).toBe(true);
    expect(files.verifyChatRecord(secret, { ...record, mac: "bad" })).toBe(false);
    expect(files.verifyChatRecord(secret, { ...record, b: {}, mac })).toBe(false);
  });
});
