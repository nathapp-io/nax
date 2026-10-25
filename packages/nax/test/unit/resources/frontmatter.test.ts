import { describe, expect, test } from "bun:test";
import { readResourceFrontmatter } from "@/resources/frontmatter";

const valid = "---\nname: a\ndescription: b\n---\nBody";
const tolerant =
  '---\ndescription: Use when X. Triggers: "a", "b"\ndisable-model-invocation: true\nname: "quoted"\n---\nBody';

describe("readResourceFrontmatter", () => {
  test.each([
    ["AC-6", "name", "a", valid],
    ["AC-7", "description", "b", valid],
    ["AC-10", "description", 'Use when X. Triggers: "a", "b"', tolerant],
    ["AC-11", "disable-model-invocation", true, tolerant],
    ["AC-12", "name", "quoted", tolerant],
  ] as const)("%s reads %s", (_ac, key, expected, text) => {
    const result = readResourceFrontmatter(text);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) throw new Error(result.error);
    expect(result.data[key]).toBe(expected);
  });

  test("AC-8 returns the body without frontmatter", () => {
    expect(readResourceFrontmatter(valid)).toEqual({ data: { name: "a", description: "b" }, body: "Body" });
  });

  test("AC-9 preserves text without frontmatter", () => {
    expect(readResourceFrontmatter("no frontmatter")).toEqual({ data: {}, body: "no frontmatter" });
  });

  test("AC-13 reports an unclosed block", () => {
    expect(readResourceFrontmatter("---\nname: a\n")).toEqual({ error: expect.any(String) });
  });

  test("AC-14 accepts an empty block", () => {
    expect(readResourceFrontmatter("---\n---\nBody")).toEqual({ data: {}, body: "Body" });
  });

  test.each([
    ["null", "null"],
    ["comment-only", "# comment"],
  ])("accepts %s YAML as empty data", (_label, block) => {
    expect(readResourceFrontmatter(`---\n${block}\n---\nBody`)).toEqual({ data: {}, body: "Body" });
  });

  test.each(["a scalar", "true", "42"])("rejects scalar YAML %s", (block) => {
    expect(readResourceFrontmatter(`---\n${block}\n---\nBody`)).toEqual({ error: expect.any(String) });
  });

  test("preserves CRLF and all whitespace in the body", () => {
    expect(readResourceFrontmatter("---\r\nname: a\r\n---\r\n\r\n Body\r\n")).toEqual({
      data: { name: "a" },
      body: "\r\n Body\r\n",
    });
  });

  test("fallback ignores invalid lines, unquotes strings and reads false", () => {
    const block =
      "description: Triggers: x\ninvalid line\n1bad: no\nflag: false\nsingle: 'value'\nempty: \nname: first\nname: last\n__proto__: ignored";
    expect(readResourceFrontmatter(`---\n${block}\n---`)).toEqual({
      data: { description: "Triggers: x", flag: false, single: "value", empty: "", name: "last" },
      body: "",
    });
  });

  test("does not recognize a non-leading delimiter", () => {
    const text = "prefix\n---\nname: a\n---\nBody";
    expect(readResourceFrontmatter(text)).toEqual({ data: {}, body: text });
  });

  test("AC-15 rejects a YAML list", () => {
    expect(readResourceFrontmatter("---\n- a\n- b\n---\nBody")).toEqual({ error: expect.any(String) });
  });
});
