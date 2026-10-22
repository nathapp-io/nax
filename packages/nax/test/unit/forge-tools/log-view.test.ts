import { describe, expect, test } from "bun:test";
import type { ForgeCheck } from "@/forge";
import { FORGE_LOG_LINE_CHARS } from "@/forge-tools/constants";
import { logViewResult } from "@/forge-tools/log-view";

const check: ForgeCheck = { id: "7", name: "test", status: "completed", hasJobLog: true };
const numbered = (content: string) => content.split("\n").filter((line) => /^\d+: /.test(line));

describe("logViewResult", () => {
  test("search matches full lines before applying the numbered line cap", () => {
    const content = logViewResult(`${"x".repeat(5_000)}MATCH\nother`, check, { search: "match", maxBytes: 10_000 });
    expect(content).toContain("1 of 1 matches");
    expect(numbered(content)).toEqual([`1: ${"x".repeat(FORGE_LOG_LINE_CHARS - 3)}`]);
  });
  test.each([{}, { from: 1 }, { search: "😀" }])("line cap preserves emoji in view %j", (view) => {
    const content = logViewResult("😀".repeat(FORGE_LOG_LINE_CHARS), check, { ...view, maxBytes: 10_000 });
    expect(numbered(content)).toEqual([`1: ${"😀".repeat(FORGE_LOG_LINE_CHARS - 3)}`]);
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });
  test.each(["", "\n"])("empty and single blank logs have correct bounds (%j)", (text) => {
    const content = logViewResult(text, check, { from: 2, maxBytes: 10_000 });
    expect(numbered(content)).toEqual([]);
    expect(content).toContain(`showing lines 0-0 of ${text === "" ? 0 : 1}`);
  });
  test("search with no matches has zero bounds", () => {
    const content = logViewResult("one\ntwo\n", check, { search: "absent", maxBytes: 10_000 });
    expect(numbered(content)).toEqual([]);
    expect(content).toContain("0 of 0 matches");
    expect(content).toContain("showing lines 0-0 of 2");
  });
  test("search fits from the start and counts matches before byte fitting", () => {
    const text = Array.from({ length: 70 }, (_, i) => `match ${i + 1}`).join("\n");
    const content = logViewResult(text, check, { search: "match", maxBytes: 250 });
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(250);
    expect(numbered(content)[0]).toBe("1: match 1");
    expect(content).not.toContain("50: match 50");
    expect(content).toContain("50 of 70 matches");
    expect(content).toContain("[truncated:");
  });
  test("page includes final blank content line but excludes trailing newline element", () => {
    const content = logViewResult("one\ntwo\n\n", check, { from: 2, lines: 5, maxBytes: 10_000 });
    expect(numbered(content)).toEqual(["2: two", "3: "]);
    expect(content).toContain("showing lines 2-3 of 3");
  });
  test.each(["queued", "in_progress"] as const)("page keeps %s partial footer", (status) => {
    const content = logViewResult("one", { ...check, status }, { from: 1, maxBytes: 10_000 });
    expect(content).toContain("this log is partial");
    expect(numbered(content)).toEqual(["1: one"]);
  });
});
