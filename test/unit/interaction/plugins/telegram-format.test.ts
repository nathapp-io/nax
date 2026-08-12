import { describe, expect, test } from "bun:test";
import type { InteractionRequest } from "@/interaction";
import {
  MAX_MESSAGE_CHARS,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  buildBody,
  buildHeader,
  buildKeyboard,
  getStageEmoji,
  sanitizeMarkdown,
  splitText,
  truncateIdForCallbackData,
} from "@/interaction";

function makeRequest(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "req-1",
    type: "confirm",
    featureName: "my-feature",
    stage: "review",
    summary: "Proceed with merge?",
    fallback: "abort",
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as InteractionRequest;
}

describe("sanitizeMarkdown", () => {
  test("escapes each Telegram Markdown delimiter", () => {
    expect(sanitizeMarkdown("a_b")).toBe("a\\_b");
    expect(sanitizeMarkdown("a`b")).toBe("a\\`b");
    expect(sanitizeMarkdown("a*b")).toBe("a\\*b");
    expect(sanitizeMarkdown("a[b")).toBe("a\\[b");
  });

  test("escapes a pre-existing backslash that precedes a delimiter", () => {
    expect(sanitizeMarkdown("a\\_b")).toBe("a\\\\\\_b");
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeMarkdown("hello world")).toBe("hello world");
  });
});

describe("splitText", () => {
  test("returns a single chunk when the text fits", () => {
    expect(splitText("short", 100)).toEqual(["short"]);
  });

  test("prefers a newline as the split point when one sits past the halfway mark", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    const chunks = splitText(text, 100);
    expect(chunks).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  test("hard-breaks at maxChars when no newline is late enough", () => {
    const chunks = splitText("a".repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });

  test("every chunk respects maxChars", () => {
    const chunks = splitText("word ".repeat(500), 100);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("getStageEmoji", () => {
  test.each([
    ["pre-flight", "🚀"],
    ["execution", "⚙️"],
    ["review", "🔍"],
    ["merge", "🔀"],
    ["cost", "💰"],
    ["anything-else", "📌"],
  ])("maps %s", (stage, emoji) => {
    expect(getStageEmoji(stage)).toBe(emoji);
  });
});

describe("buildHeader", () => {
  test("includes stage, feature and story", () => {
    const header = buildHeader(makeRequest({ storyId: "US-001" }));
    expect(header).toContain("🔍");
    expect(header).toContain("*REVIEW*");
    expect(header).toContain("*Feature:* my-feature");
    expect(header).toContain("*Story:* US-001");
  });

  test("omits the story line when there is no storyId", () => {
    expect(buildHeader(makeRequest())).not.toContain("*Story:*");
  });
});

describe("buildBody", () => {
  test("sanitizes the summary", () => {
    expect(buildBody(makeRequest({ summary: "a_b" }))).toContain("a\\_b");
  });

  test("renders options and the timeout footer", () => {
    const body = buildBody(
      makeRequest({
        type: "choose",
        options: [{ key: "a", label: "Alpha", description: "first" }],
        timeout: 30_000,
      }),
    );
    expect(body).toContain("*Options:*");
    expect(body).toContain("Alpha");
    expect(body).toContain("first");
    expect(body).toContain("Timeout: 30s");
    expect(body).toContain("Fallback: abort");
  });
});

describe("buildKeyboard", () => {
  test("confirm produces approve/reject/skip/abort", () => {
    const keyboard = buildKeyboard(makeRequest({ id: "k-1" }));
    const data = (keyboard ?? []).flat().map((b) => b.callback_data);
    expect(data).toEqual(["k-1:approve", "k-1:reject", "k-1:skip", "k-1:abort"]);
  });

  test("choose produces one row per option plus the skip/abort row", () => {
    const keyboard = buildKeyboard(
      makeRequest({
        id: "k-2",
        type: "choose",
        options: [
          { key: "a", label: "Alpha" },
          { key: "b", label: "Beta" },
        ],
      }),
    );
    expect(keyboard).toHaveLength(3);
    expect(keyboard?.[0][0].callback_data).toBe("k-2:choose:a");
    expect(keyboard?.[1][0].callback_data).toBe("k-2:choose:b");
  });

  test("choose with no options produces no keyboard", () => {
    expect(buildKeyboard(makeRequest({ type: "choose", options: [] }))).toBeNull();
  });

  test("input and notify are button-free", () => {
    expect(buildKeyboard(makeRequest({ type: "input" }))).toBeNull();
    expect(buildKeyboard(makeRequest({ type: "notify" }))).toBeNull();
  });

  test("BUG-48: every callback_data stays within Telegram's 64-byte limit even with a long request id", () => {
    const longId = "s".repeat(120);
    const confirmData = (buildKeyboard(makeRequest({ id: longId })) ?? []).flat().map((b) => b.callback_data);
    for (const cb of confirmData) {
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }

    const chooseData = (
      buildKeyboard(
        makeRequest({
          id: longId,
          type: "choose",
          options: [
            { key: "resume", label: "Resume" },
            { key: "abort-now", label: "Abort now" },
          ],
        }),
      ) ?? []
    )
      .flat()
      .map((b) => b.callback_data);
    for (const cb of chooseData) {
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  test("BUG-48: short ids are left untouched (no unnecessary truncation)", () => {
    const keyboard = buildKeyboard(makeRequest({ id: "k-1" }));
    const data = (keyboard ?? []).flat().map((b) => b.callback_data);
    expect(data).toEqual(["k-1:approve", "k-1:reject", "k-1:skip", "k-1:abort"]);
  });
});

describe("truncateIdForCallbackData", () => {
  test("leaves the id untouched when it already fits", () => {
    expect(truncateIdForCallbackData("short-id", ":approve")).toBe("short-id");
  });

  test("truncates a long id so id+suffix fits the 64-byte budget", () => {
    const longId = "x".repeat(200);
    const suffix = ":choose:resume";
    const result = truncateIdForCallbackData(longId, suffix);
    expect(Buffer.byteLength(result + suffix, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });

  test("is deterministic — same inputs produce the same truncated id (parse-side must reproduce this)", () => {
    const longId = "y".repeat(150);
    const a = truncateIdForCallbackData(longId, ":skip");
    const b = truncateIdForCallbackData(longId, ":skip");
    expect(a).toBe(b);
  });
});

describe("MAX_MESSAGE_CHARS", () => {
  test("stays under the Telegram 4096 ceiling", () => {
    expect(MAX_MESSAGE_CHARS).toBe(4000);
  });
});
