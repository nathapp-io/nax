import { describe, expect, test } from "bun:test";
import { extractContextToolCall, extractQuestion } from "@/agents/interaction/output-parsing";

describe("extractQuestion", () => {
  test("returns null for empty or whitespace output", () => {
    expect(extractQuestion("")).toBeNull();
    expect(extractQuestion("  \n\n ")).toBeNull();
  });

  test("detects a last line ending in ? longer than 10 chars", () => {
    expect(extractQuestion("Done.\n\nShould the cache be cleared first?")).toBe(
      "Done.\n\nShould the cache be cleared first?",
    );
  });

  test("ignores a last line of 10 chars or fewer ending in ?", () => {
    expect(extractQuestion("Finished the change.\nOk?")).toBeNull();
  });

  test("BUG-097: a ? mid-output (optional chaining) is not a question", () => {
    expect(extractQuestion("const a = b?.c ?? d;\nImplemented the change.")).toBeNull();
  });

  test("detects keyword markers on the last line, case-insensitively", () => {
    expect(extractQuestion("Two options exist.\nPlease confirm the target branch.")).toBe(
      "Two options exist.\nPlease confirm the target branch.",
    );
    expect(extractQuestion("x\nDo You Want me to proceed with the migration")).toBe(
      "x\nDo You Want me to proceed with the migration",
    );
  });

  test("a marker on an earlier line does not count", () => {
    expect(extractQuestion("Please confirm later.\nImplemented everything.")).toBeNull();
  });

  test("returns only the last two paragraphs", () => {
    const out = "Table here\n\nConclusion: both paths work.\n\nWhich would you prefer, A or B?";
    expect(extractQuestion(out)).toBe("Conclusion: both paths work.\n\nWhich would you prefer, A or B?");
  });
});

describe("extractContextToolCall", () => {
  test("returns null when no call block is present", () => {
    expect(extractContextToolCall("plain output")).toBeNull();
  });

  test("parses the name and JSON input", () => {
    const out = 'text\n<nax_tool_call name="query_neighbor">\n{"filePath": "src/a.ts"}\n</nax_tool_call>';
    expect(extractContextToolCall(out)).toEqual({ name: "query_neighbor", input: { filePath: "src/a.ts" } });
  });

  test("an empty body becomes an empty object", () => {
    expect(extractContextToolCall('<nax_tool_call name="t">  </nax_tool_call>')).toEqual({ name: "t", input: {} });
  });

  test("invalid JSON yields an error, not a throw", () => {
    const result = extractContextToolCall('<nax_tool_call name="t">{bad</nax_tool_call>');
    expect(result?.name).toBe("t");
    expect(result?.input).toBeUndefined();
    expect(result?.error).toStartWith("Invalid JSON tool input: ");
  });

  test("the tag match is case-insensitive and takes the first block", () => {
    const out = '<NAX_TOOL_CALL name="first">{}</NAX_TOOL_CALL>\n<nax_tool_call name="second">{}</nax_tool_call>';
    expect(extractContextToolCall(out)?.name).toBe("first");
  });
});
