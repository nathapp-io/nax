import { describe, expect, test } from "bun:test";
import { sessionTitleText } from "@/chat";

const ID = "fba63185-0000-4000-8000-000000000000";
describe("sessionTitleText", () => {
  test.each([
    ["AC-6", null, "untitled fba63185"],
    ["AC-7", '<skill name="superpowers:brainstorming" location="/Users/a/.claude/plu', "/superpowers:brainstorming"],
    ["AC-8", "fix the login bug", "fix the login bug"],
    ["AC-9 closed quote without whitespace", '<skill name="x"', '<skill name="x"'],
    ["AC-9 unterminated name", '<skill name="x', '<skill name="x'],
    ["legacy without location", '<skill name="x" body', "/x"],
    ["not a prefix", 'before <skill name="x" body', 'before <skill name="x" body'],
  ])("%s", (_ac, title, expected) => {
    expect(sessionTitleText(title, ID)).toBe(expected);
  });
});
