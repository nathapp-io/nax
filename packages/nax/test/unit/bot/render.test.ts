import { describe, expect, test } from "bun:test";
import * as bot from "@/bot";
import { parseNaxBotMarker, withNaxBotMarker } from "@/forge";

describe("breakLinks", () => {
  test.each([
    ["AC-6", "[x](http://e.com)", "[x]\u200b(http:\u200b//e.com)"],
    ["AC-7", "![i](https://e.com/a.png)", "![i]\u200b(https:\u200b//e.com/a.png)"],
  ])("%s: breaks links and images", (_ac, input, expected) => {
    const result = bot.breakLinks(input);
    expect(result).toBe(expected);
    expect(result).not.toContain("](");
    expect(result).not.toContain("://");
  });
  test("breaks every occurrence and leaves plain text unchanged", () => {
    expect(bot.breakLinks("](x) ](y) ftp://a https://b")).toBe("]\u200b(x) ]\u200b(y) ftp:\u200b//a https:\u200b//b");
    expect(bot.breakLinks("plain")).toBe("plain");
    expect(bot.breakLinks("")).toBe("");
  });
});

describe("safeText", () => {
  test("AC-8: neutralises mentions and issue references", () => {
    const result = bot.safeText("see @alice and #12", 100);
    expect(result).toBe("see @\u200balice and #\u200b12");
    expect(result).not.toContain("@alice");
    expect(result).not.toContain("#12");
  });
  test("AC-9: strictly caps long link-free text", () => {
    const result = bot.safeText("x".repeat(3000), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toBe("x".repeat(100));
  });
  test.each([0, 1, 2, 10, 100])("caps at %i even after escaping", (max) => {
    expect(bot.safeText("<".repeat(200), max).length).toBeLessThanOrEqual(max);
  });
  test("flattens newlines, escapes HTML and breaks links after the cap", () => {
    expect(bot.safeText("<b>\n[x](https://e.com)", 100)).toBe("&lt;b&gt; [x]\u200b(https:\u200b//e.com)");
    expect(bot.safeText("](https://a)", 12)).toBe("]\u200b(https:\u200b//");
  });
  test("reuses shared secret redaction", () => {
    expect(bot.safeText("token ghp_abcdefghijklmnopqrstuvwxyz1234567890", 100)).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    );
  });
});

describe("findingKey", () => {
  test("AC-10: normalises issue case and whitespace with an exact hash", () => {
    expect(bot.findingKey({ file: "a.ts", issue: "Null  check\nmissing" })).toBe("f-cb6ef9baf04eb099");
    expect(bot.findingKey({ file: "a.ts", issue: "null check missing" })).toBe("f-cb6ef9baf04eb099");
    expect(bot.findingKey({ file: "a.ts", issue: " \tNULL check missing  " })).toBe("f-cb6ef9baf04eb099");
  });
  test("AC-11: includes the file in the identity", () => {
    expect(bot.findingKey({ file: "a.ts", issue: "x" })).not.toBe(bot.findingKey({ file: "b.ts", issue: "x" }));
  });
  test("AC-12: emits a valid f-prefixed marker key", () => {
    const key = bot.findingKey({ issue: "x" });
    expect(key).toBe("f-bbe56d7c2d0f1f72");
    expect(key).toMatch(/^f-[0-9a-f]{16}$/);
    expect(bot.findingKey({ file: "", issue: "x" })).toBe(key);
    expect(parseNaxBotMarker(withNaxBotMarker("body", key))).toEqual({ key });
  });
});

describe("threadKey", () => {
  test("AC-13: hashes the thread id into a valid marker key", () => {
    const key = bot.threadKey("PRRT_kwDOabc");
    expect(key).toBe("t-67a66e20ec14c5fc");
    expect(key).toMatch(/^t-[0-9a-f]{16}$/);
    expect(parseNaxBotMarker(withNaxBotMarker("body", key))).toEqual({ key });
  });
});

describe("earlierKey", () => {
  test("US-007 AC-11/12 hashes the id deterministically in a separate namespace", () => {
    const key = bot.earlierKey("T1");
    expect(key).toMatch(/^e-[0-9a-f]{16}$/);
    expect(key).toBe("e-1f93603db53bfad5");
    expect(bot.earlierKey("T1")).toBe(key);
    expect(key).not.toBe(bot.threadKey("T1"));
  });
});

describe("commentKey", () => {
  test("AC-14: hashes the comment id into a valid marker key", () => {
    const key = bot.commentKey("99");
    expect(key).toBe("c-8c1f1046219ddd21");
    expect(key).toMatch(/^c-[0-9a-f]{16}$/);
    expect(parseNaxBotMarker(withNaxBotMarker("body", key))).toEqual({ key });
  });
});

test.each([
  ["b".repeat(8) + "<", 10, "b".repeat(8)],
  ["b".repeat(9) + "😀", 10, "b".repeat(9)],
  ["](https://" + "b".repeat(8) + "<", 21, "]\u200b(https:\u200b//" + "b".repeat(8)],
])("safeText preserves whole escaped tokens for %s", (text, max, expected) => {
  expect(bot.safeText(text, max)).toBe(expected);
});
