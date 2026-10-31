import { describe, expect, test } from "bun:test";
import { findMentionTokens, formatMentionToken } from "@/chat";

describe("findMentionTokens", () => {
  test("AC-1 finds an unquoted mention between words", () => {
    expect(findMentionTokens("see @src/a.ts now")).toEqual([{ start: 4, end: 13, path: "src/a.ts", quoted: false }]);
  });

  test("AC-2 starts a token at index 0", () => {
    expect(findMentionTokens("@a.ts")).toEqual([{ start: 0, end: 5, path: "a.ts", quoted: false }]);
  });

  test("AC-3 ignores an @ that is neither at the start nor after whitespace", () => {
    expect(findMentionTokens("mail a@b.com")).toEqual([]);
  });

  test("AC-4 ignores a bare @ with an empty path", () => {
    expect(findMentionTokens("a @ b")).toEqual([]);
  });

  test("AC-5 ignores an empty quoted path", () => {
    expect(findMentionTokens('see @"" now')).toEqual([]);
  });

  test("AC-6 reads a quoted path containing whitespace", () => {
    expect(findMentionTokens('open @"my dir/x.ts" please')).toEqual([
      { start: 5, end: 19, path: "my dir/x.ts", quoted: true },
    ]);
  });

  test("AC-7 ignores a quoted path whose quote is unclosed", () => {
    expect(findMentionTokens('open @"my dir/x.ts')).toEqual([]);
  });

  test("AC-8 finds mentions across lines in order", () => {
    expect(findMentionTokens("@a.ts and\n@b.ts").map((token) => token.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("runs to the end of the text without a trailing space", () => {
    expect(findMentionTokens("look @a.ts").map((token) => [token.path, token.end])).toEqual([["a.ts", 10]]);
  });

  test("finds several mentions on one line", () => {
    expect(findMentionTokens("@a.ts @b.ts").map((token) => token.start)).toEqual([0, 6]);
  });

  test("treats a tab as whitespace before the @", () => {
    expect(findMentionTokens("\t@a.ts").map((token) => token.start)).toEqual([1]);
  });

  test("does not treat an @ inside a quoted path as a new token", () => {
    expect(findMentionTokens('@"a@b c.ts"')).toEqual([{ start: 0, end: 11, path: "a@b c.ts", quoted: true }]);
  });
});

describe("formatMentionToken", () => {
  test("AC-9 formats a path without whitespace unquoted", () => {
    expect(formatMentionToken("src/a.ts")).toBe("@src/a.ts");
  });

  test("AC-10 quotes a path containing whitespace", () => {
    expect(formatMentionToken("my dir/x.ts")).toBe('@"my dir/x.ts"');
  });

  test("round-trips through findMentionTokens for both path shapes", () => {
    for (const path of ["src/a.ts", "my dir/x.ts"]) {
      const tokens = findMentionTokens(`hi ${formatMentionToken(path)}`);
      expect(tokens.map((token) => token.path)).toEqual([path]);
    }
  });
});
