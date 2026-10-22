import { describe, expect, test } from "bun:test";
import { parseRulingKeyword } from "@/workflow/ruling-keyword";

describe("parseRulingKeyword", () => {
  test.each([
    ["waive: flaky upstream", { disposition: "waived", reason: "flaky upstream" }],
    ["WAIVE:   ", null],
    ["fixed abc1234 — moved the guard", { disposition: "fixed", sha: "abc1234", reason: "moved the guard" }],
    ["fixed abc1234", { disposition: "fixed", sha: "abc1234", reason: "fixed" }],
    ["fixed", null],
    ["Confirm", { disposition: "confirmed", reason: "confirmed" }],
    ["override: product decided", { disposition: "overridden", reason: "product decided" }],
    ["override:", null],
    ["verified: ran the smoke suite", { disposition: "verified", reason: "ran the smoke suite" }],
    ["\n\n  confirm\nmore text", { disposition: "confirmed", reason: "confirmed" }],
    ["I think this is fine", null],
  ] as const)("parses %j", (text, expected) => {
    expect(parseRulingKeyword(text)).toEqual(expected);
  });

  test.each([
    ["fixed 1234567 - reason", { disposition: "fixed", sha: "1234567", reason: "reason" }],
    [
      "FIXED ABCDEF0123456789012345678901234567890123: reason",
      { disposition: "fixed", sha: "ABCDEF0123456789012345678901234567890123", reason: "reason" },
    ],
    ["waived: reason", { disposition: "waived", reason: "reason" }],
    ["confirmed: reason", { disposition: "confirmed", reason: "reason" }],
    ["verify", { disposition: "verified", reason: "verified" }],
    ["overridden: reason", { disposition: "overridden", reason: "reason" }],
    ["fixed abc123", null],
    ["fixed abc1234 extra", null],
    ["waive:\nnext line", null],
  ] as const)("supports grammar edge case %j", (text, expected) => {
    expect(parseRulingKeyword(text)).toEqual(expected);
  });
});

test.each(["", "  ", "\n\t\n"])("blank reply %j is conversation", (body) => {
  expect(parseRulingKeyword(body)).toBeNull();
});
