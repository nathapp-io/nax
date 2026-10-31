import { describe, expect, test } from "bun:test";
import { createNativeSessionState, runNativeTurn, saveTranscript } from "@nathapp/nax-agent/internal";
import type { TranscriptMessage } from "#src/native/session/compaction";
import * as imageContext from "#src/native/session/image-context";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createTurnAccumulator } from "#src/native/session/turn-accumulator";
import { runProactiveCompaction } from "#src/native/session/turn-compaction-step";
import { seedNativeSession, withTempDir } from "#test/helpers/index";

const image = { mimeType: "image/png", data: "AAAA", width: 640, height: 480 };
const compaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };
const usage = { inputTokens: 1, outputTokens: 1 };
const history = (): TranscriptMessage[] => [
  { role: "user", content: "task" },
  { role: "user", content: "see", images: [image] },
  { role: "assistant", content: "a".repeat(20_000) },
  { role: "user", content: "keep going" },
  { role: "assistant", content: "b".repeat(20_000) },
];

describe("imagesAsNotes", () => {
  test("replaces a dimensioned image with a note and removes the images key (AC-1)", () => {
    expect(imageContext.imagesAsNotes([{ role: "user", content: "see", images: [image] }])).toEqual([
      { role: "user", content: "see\n[image: image/png 640x480]" },
    ]);
  });

  test.each([
    { mimeType: "image/png", data: "AAAA", height: 480 },
    { mimeType: "image/png", data: "AAAA", width: 640 },
    { mimeType: "image/png", data: "AAAA" },
  ])("omits dimensions unless both exist (AC-2): %j", (attachment) => {
    expect(imageContext.imagesAsNotes([{ role: "user", content: "see", images: [attachment] }])).toEqual([
      { role: "user", content: "see\n[image: image/png]" },
    ]);
  });

  test("preserves messages without images, including assistant and tool accounting (AC-3)", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "text" },
      { role: "assistant", content: "reply" },
      { role: "tool-result", toolCallId: "c", content: "result" },
    ];
    expect(imageContext.imagesAsNotes(messages)).toEqual(messages);
  });

  test("does not mutate its input array, messages or images (AC-4)", () => {
    const messages = history();
    const before = structuredClone(messages);
    const result = imageContext.imagesAsNotes(messages);
    expect(messages).toEqual(before);
    expect(result).not.toBe(messages);
    expect(result[1]).not.toHaveProperty("images");
  });

  test("appends once per image in order without a leading newline for empty content", () => {
    expect(
      imageContext.imagesAsNotes([
        { role: "user", content: "", images: [image, image, { mimeType: "image/jpeg", data: "BBBB" }] },
      ]),
    ).toEqual([
      { role: "user", content: "[image: image/png 640x480]\n[image: image/png 640x480]\n[image: image/jpeg]" },
    ]);
    expect(imageContext.imagesAsNotes([{ role: "user", content: "", images: [] }])).toEqual([
      { role: "user", content: "" },
    ]);
  });
});

describe("image compaction", () => {
  test.each(["no bytes (AC-5)", "image note (AC-6)"])("proactive turn summary receives %s", async (check) => {
    await withTempDir(async (dir) => {
      await saveTranscript(dir, "image-compaction", history());
      const sessionState = seedNativeSession(createNativeSessionState(), "image-compaction", { transcriptDir: dir });
      let summarized: readonly TranscriptMessage[] = [];
      let calls = 0;
      await runNativeTurn(
        { id: "image-compaction", agentName: "native" },
        "next",
        { interactionHandler: { onInteraction: async () => ({ answer: "" }) } },
        {
          sessionState,
          contextWindow: 8000,
          compaction,
          summarize: async (messages) => {
            calls += 1;
            summarized = messages;
            return { text: "summary", usage, costUsd: 0 };
          },
          complete: async () => ({ text: "done", usage, costUsd: 0 }),
        },
      );
      expect(calls).toBe(1);
      if (check.startsWith("no bytes")) {
        for (const message of summarized) expect(message).not.toHaveProperty("images");
        expect(JSON.stringify(summarized)).not.toContain("AAAA");
      } else {
        expect(summarized).toContainEqual({ role: "user", content: "see\n[image: image/png 640x480]" });
      }
    });
  });

  test("returns original image-bearing history when summary rejects (AC-11)", async () => {
    const messages = history();
    const before = structuredClone(messages);
    let calls = 0;
    let summarized: readonly TranscriptMessage[] = [];
    const result = await runProactiveCompaction({
      messages,
      usage: createTurnAccumulator(),
      sessionName: "image-compaction",
      lastUsage: undefined,
      anchorIndex: undefined,
      loopEvents: createLoopEventRegistry(),
      signal: new AbortController().signal,
      deps: {
        contextWindow: 8000,
        compaction,
        deadline: { expired: () => false, remainingMs: () => 1000 },
        summarize: async (input) => {
          calls += 1;
          summarized = input;
          throw new Error("summary unavailable");
        },
      },
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ messages: before, compacted: false, summarizeFailed: true });
    expect(result.messages).toBe(messages);
    expect(messages).toEqual(before);
    // Prove the fallback was not the note-only view passed to the failing summarizer.
    expect(summarized).toContainEqual({ role: "user", content: "see\n[image: image/png 640x480]" });
  });
});
