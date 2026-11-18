import { describe, expect, test } from "bun:test";
import {
  completeWithRecovery,
  createLoopEventRegistry,
  createNativeSessionState,
  createTurnAccumulator,
} from "@nathapp/nax-agent/internal";
import type { ImageAttachment } from "#src/cost/standard-types";
import type { TranscriptMessage } from "#src/native/session/compaction";
import { capRequestImages } from "#src/native/session/image-context";
import { createTurnEventEmitter } from "#src/native/session/turn-event-emitter";
import { MAX_REQUEST_IMAGE_BASE64_CHARS } from "#src/session/image-input";

const image = (length = 4, mimeType = "image/png"): ImageAttachment => ({ mimeType, data: "A".repeat(length) });
const user = (images: readonly ImageAttachment[], content = "look"): TranscriptMessage => ({
  role: "user",
  content,
  images,
});
const toolResult = (images: readonly ImageAttachment[], content = "shot"): TranscriptMessage => ({
  role: "tool-result",
  toolCallId: "c1",
  content,
  images,
});
const imagesOf = (message: TranscriptMessage | undefined) =>
  message?.role === "user" || message?.role === "tool-result" ? message.images : undefined;
const history = (count: number): TranscriptMessage[] => Array.from({ length: count }, () => user([image()]));
const note = "[image from an earlier turn dropped from context: image/png]";
const countImages = (messages: readonly TranscriptMessage[]) =>
  messages.reduce((sum, message) => sum + (imagesOf(message)?.length ?? 0), 0);

describe("completeWithRecovery image budget", () => {
  test.each([
    { ac: "AC-10/11", count: 25, patched: false },
    { ac: "AC-12", count: 25, patched: true },
    { ac: "AC-13", count: 3, patched: false },
  ])("$ac: caps the final wire only and preserves dormant identity", async ({ count, patched }) => {
    const input = history(patched ? 1 : count);
    const patch = history(count);
    const registry = createLoopEventRegistry();
    let handlerCalls = 0;
    if (patched)
      registry.register("transform_context", () => {
        handlerCalls += 1;
        return { messages: patch };
      });
    let wire: readonly TranscriptMessage[] = [];
    const result = await completeWithRecovery({
      messages: input,
      tools: [],
      usage: createTurnAccumulator(),
      summarizeFailed: false,
      sessionName: "image-budget",
      lastUsage: undefined,
      anchorIndex: undefined,
      loopEvents: registry,
      roundTrip: 1,
      turnEvents: createTurnEventEmitter(undefined),
      deps: {
        sessionState: createNativeSessionState(),
        complete: async (messages) => {
          wire = messages;
          return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        },
      },
    });
    // Assert transcript preservation even when the old wire-boundary assertion fails.
    expect(result.messages).toBe(input);
    expect(countImages(result.messages)).toBe(patched ? 1 : count);
    expect(handlerCalls).toBe(patched ? 1 : 0);
    expect(countImages(patch)).toBe(count);
    expect(countImages(wire)).toBe(Math.min(count, 20));
    if (count === 3) expect(wire).toBe(input);
    if (patched) expect(result.honoured).toBe(true);
  });
});

describe("capRequestImages", () => {
  test("AC-1: returns the original array for three small images", () => {
    const input = history(3);
    expect(capRequestImages(input)).toBe(input);
  });
  test("AC-2/3/7: keeps the newest twenty and annotates the oldest without mutation", () => {
    const input = history(25);
    const original = structuredClone(input);
    for (const message of input) {
      if (message.role === "user") Object.freeze(message.images);
      Object.freeze(message);
    }
    Object.freeze(input);
    const result = capRequestImages(input);
    expect(result).not.toBe(input);
    expect(result.slice(5)).toEqual(input.slice(5));
    for (const message of result.slice(0, 5)) {
      expect(message).not.toHaveProperty("images");
      expect(message.content).toBe(`look\n${note}`);
    }
    expect(input).toEqual(original);
    expect(input.every((message) => imagesOf(message)?.length === 1)).toBe(true);
  });
  test.each([
    { ac: "AC-4", sizes: [10_000_000, 10_000_000, 5_000_000], kept: [false, true, true] },
    { ac: "AC-5", sizes: [1_000_000, 10_000_000, 15_000_000], kept: [true, false, true] },
  ])("$ac: checks count and bytes together, continuing after a drop", ({ sizes, kept }) => {
    const result = capRequestImages(sizes.map((size) => user([image(size)])));
    expect(result.map((message) => !!imagesOf(message)?.length)).toEqual([...kept]);
  });
  test("AC-6: keeps the last image when only one slot remains", () => {
    const first = image(4, "image/jpeg");
    const last = image();
    const result = capRequestImages([user([first, last]), ...history(19)]);
    expect(imagesOf(result[0])).toEqual([last]);
    expect(result[0]?.content).toBe("look\n[image from an earlier turn dropped from context: image/jpeg]");
  });
  test("AC-8: preserves assistant and tool-result messages", () => {
    const others: TranscriptMessage[] = [
      { role: "assistant", content: "calling", toolCalls: [{ id: "call", name: "read", input: {} }] },
      { role: "tool-result", toolCallId: "call", content: "denied", isError: true },
    ];
    const input = [...others, ...history(25)];
    const result = capRequestImages(input);
    expect(result).not.toBe(input);
    expect(result.slice(0, 2)).toEqual(others);
  });
  test("AC-9: does not prepend a newline to empty content", () => {
    const result = capRequestImages([user([image()], ""), ...history(20)]);
    expect(result[0]?.content).toBe(note);
    expect(result[0]).not.toHaveProperty("images");
  });
  test("appends one note per dropped image in original image order", () => {
    const result = capRequestImages([user([image(4, "image/jpeg"), image()], ""), ...history(20)]);
    expect(result[0]?.content).toBe(`[image from an earlier turn dropped from context: image/jpeg]\n${note}`);
  });
});

// US-002: a tool result may carry images the way a user message does, so the
// request budget counts both in ONE newest-first pass and a note replaces what
// it drops, whichever arm the image came from.
describe("capRequestImages — tool-result images (US-002)", () => {
  const many = (count: number) => Array.from({ length: count }, () => image());

  test("AC-10: the tool result keeps all ten, the older user images become notes", () => {
    const [userMessage, result] = capRequestImages([user(many(15)), toolResult(many(10))]);
    expect(imagesOf(result)).toHaveLength(10);
    expect(imagesOf(userMessage)).toHaveLength(10);
    expect(userMessage?.content).toBe(`look\n${note}\n${note}\n${note}\n${note}\n${note}`);
    expect(Object.hasOwn(result ?? {}, "images")).toBe(true);
  });

  test("AC-11: the user message keeps all ten, the older tool-result images become notes", () => {
    const [result, userMessage] = capRequestImages([toolResult(many(15)), user(many(10))]);
    expect(imagesOf(userMessage)).toHaveLength(10);
    expect(imagesOf(result)).toHaveLength(10);
    expect(result?.content).toBe(`shot\n${note}\n${note}\n${note}\n${note}\n${note}`);
  });

  test("AC-12: combined base64 length stays within the request limit", () => {
    const big = image(10_000_000);
    const [oldest, middle, newest] = capRequestImages([user([big]), toolResult([big]), user([big])]);
    const kept = [middle, newest].flatMap((message) => [...(imagesOf(message) ?? [])]);
    expect(kept.reduce((sum, attachment) => sum + attachment.data.length, 0)).toBeLessThanOrEqual(
      MAX_REQUEST_IMAGE_BASE64_CHARS,
    );
    // Two of the three fit (20 MB of the 20.97 MB budget); the OLDEST is the
    // one dropped, and it is dropped whatever arm it came from.
    expect(kept).toHaveLength(2);
    expect(imagesOf(oldest)).toBeUndefined();
    expect(oldest?.content).toBe(`look\n${note}`);
  });

  test("AC-13: totals that fit both limits return the same array instance", () => {
    const input = [user(many(2)), toolResult(many(2)), user(many(1))];
    expect(capRequestImages(input)).toBe(input);
  });
});
