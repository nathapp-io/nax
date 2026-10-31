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

const image = (length = 4, mimeType = "image/png"): ImageAttachment => ({ mimeType, data: "A".repeat(length) });
const user = (images: readonly ImageAttachment[], content = "look"): TranscriptMessage => ({
  role: "user",
  content,
  images,
});
const history = (count: number): TranscriptMessage[] => Array.from({ length: count }, () => user([image()]));
const imagesOf = (message: TranscriptMessage | undefined) => (message?.role === "user" ? message.images : undefined);
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
