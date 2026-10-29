import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeFakeClock } from "@test/helpers";
import { _runChatAsksDeps, CHAT_ASK_SECRET_READ_MS, parseChatAsksFlag, readChatAskSecret } from "@/cli/run-chat-asks";

const original = { ..._runChatAsksDeps };
let clock = makeFakeClock();
beforeEach(() => {
  clock = makeFakeClock();
  Object.assign(_runChatAsksDeps, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
});
afterEach(() => {
  expect(clock.pending()).toBe(0);
  Object.assign(_runChatAsksDeps, original);
});
function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("parseChatAsksFlag", () => {
  test("AC-7 accepts an absent flag", () => {
    expect(parseChatAsksFlag(undefined)).toEqual({ ok: true, value: undefined });
  });
  test("AC-8 preserves an absolute directory", () => {
    const value = "/tmp/out/chat-jobs/run-1a2b3c4d.asks";
    expect(parseChatAsksFlag(value)).toEqual({ ok: true, value });
  });
  test.each(["relative/dir", "", "~/asks"])("AC-9 rejects relative value %s", (value) => {
    expect(parseChatAsksFlag(value)).toEqual({ ok: false, message: "--chat-asks must be an absolute path" });
  });
});

describe("readChatAskSecret", () => {
  test("AC-11 decodes a complete hex line", async () => {
    expect(CHAT_ASK_SECRET_READ_MS).toBe(5000);
    const result = await readChatAskSecret(stream(`${"aB".repeat(32)}\n`), CHAT_ASK_SECRET_READ_MS);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(new Uint8Array(32).fill(0xab));
  });
  test("AC-11 handles chunked input and ignores later lines", async () => {
    expect(await readChatAskSecret(stream("12".repeat(10), "12".repeat(22), "\nnot-a-secret\n"), 50)).toEqual(
      new Uint8Array(32).fill(0x12),
    );
  });
  test.each(["not-hex\n", "\n", `${"a".repeat(63)}\n`, `${"a".repeat(65)}\n`, `${"g".repeat(64)}\n`])(
    "AC-12 rejects invalid line %s",
    async (line) => {
      expect(await readChatAskSecret(stream(line), 50)).toBeUndefined();
    },
  );
  test("AC-13 times out an idle stream and cancels its reader", async () => {
    const cancel = mock(() => {});
    const input = new ReadableStream<Uint8Array>({ cancel });
    let settled = false;
    const result = readChatAskSecret(input, 50).then((value) => {
      settled = true;
      return value;
    });
    await clock.advance(49);
    expect(settled).toBe(false);
    await clock.advance(1);
    expect(await result).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(input.locked).toBe(false);
  });
  test.each(["", "a".repeat(64), "partial"])("AC-14 rejects EOF without a complete line %j", async (chunk) => {
    expect(await readChatAskSecret(stream(chunk), 50)).toBeUndefined();
  });
  test("returns undefined when the stream errors", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("closed"));
      },
    });
    expect(await readChatAskSecret(input, 50)).toBeUndefined();
    expect(input.locked).toBe(false);
  });
});
