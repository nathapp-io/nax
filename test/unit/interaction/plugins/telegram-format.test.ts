import { describe, expect, test } from "bun:test";
import type { InteractionRequest } from "@/interaction";
import {
  buildBody,
  buildHeader,
  buildKeyboard,
  getStageEmoji,
  MAX_MESSAGE_CHARS,
  sanitizeMarkdown,
  splitText,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  truncateIdForCallbackData,
  truncateUtf8Bytes,
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

describe("truncateUtf8Bytes", () => {
  test("leaves text that already fits untouched", () => {
    expect(truncateUtf8Bytes("hello", 10)).toBe("hello");
  });

  test("returns empty for a non-positive budget", () => {
    expect(truncateUtf8Bytes("hello", 0)).toBe("");
    expect(truncateUtf8Bytes("hello", -1)).toBe("");
  });

  test("truncates ASCII at exactly the byte budget", () => {
    expect(truncateUtf8Bytes("abcdef", 3)).toBe("abc");
  });

  test("never splits a multi-byte codepoint", () => {
    // "é" is 2 bytes; a 3-byte budget over "ééé" must stop at one full "é".
    expect(truncateUtf8Bytes("ééé", 3)).toBe("é");
    // "😀" is 4 bytes; budgets of 1..3 can hold none of it.
    expect(truncateUtf8Bytes("😀", 3)).toBe("");
    expect(truncateUtf8Bytes("😀", 4)).toBe("😀");
    // Mixed: 1-byte "a" then a 4-byte emoji — a 4-byte budget keeps only "a".
    expect(truncateUtf8Bytes("a😀", 4)).toBe("a");
    expect(truncateUtf8Bytes("a😀", 5)).toBe("a😀");
  });

  test("output always fits the requested byte budget", () => {
    for (const text of ["ééé", "a😀b", "日本語テキスト", "plain"]) {
      for (let budget = 0; budget <= 12; budget++) {
        expect(Buffer.byteLength(truncateUtf8Bytes(text, budget), "utf8")).toBeLessThanOrEqual(budget);
      }
    }
  });

  test("handles a large input without quadratic rescanning", () => {
    // Under the previous one-character-at-a-time implementation this walked
    // ~1M slices, each re-encoding the prefix. Bounded here so a regression
    // to O(n^2) shows up as a timeout rather than passing silently.
    const big = "é".repeat(500_000);
    const started = Bun.nanoseconds();
    const out = truncateUtf8Bytes(big, 64);
    expect(Buffer.byteLength(out, "utf8")).toBe(64);
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(500);
  });
});

describe("callback_data round-trip integrity", () => {
  test("an option key containing a colon still round-trips through the callback_data grammar", () => {
    const request = makeRequest({
      id: "req-9",
      type: "choose",
      options: [{ key: "scope:api", label: "API" }],
    });
    const keyboard = buildKeyboard(request);
    const data = keyboard?.[0]?.[0]?.callback_data as string;

    // Parse side (telegram.ts parseUpdate): action is parts[1], and the value
    // is everything after it — not just parts[2], which would drop ":api".
    const parts = data.split(":");
    const action = parts[1];
    const value = parts.slice(2).join(":");
    expect(action).toBe("choose");
    expect(value).toBe("scope:api");

    // The id segment must reproduce under the same suffix the parser rebuilds.
    expect(parts[0]).toBe(truncateIdForCallbackData(request.id, `:${action}:${value}`));
  });

  test("a request id containing a colon is rejected loudly rather than producing an unanswerable button", () => {
    const request = makeRequest({ id: "req:1", type: "confirm" });
    // A colon in the id makes parts[0] unrecoverable, so every tap silently
    // fails to match and the prompt can only ever resolve by timeout.
    expect(() => buildKeyboard(request)).toThrow(/id/i);
  });
});

describe("MAX_MESSAGE_CHARS", () => {
  test("stays under the Telegram 4096 ceiling", () => {
    expect(MAX_MESSAGE_CHARS).toBe(4000);
  });
});
