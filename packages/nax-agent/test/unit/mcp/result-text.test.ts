import { describe, expect, test } from "bun:test";
import { resultText } from "#src/mcp/result-text";

describe("resultText", () => {
  test("joins text items with a blank line", () => {
    const out = resultText(
      {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      1000,
    );
    expect(out).toEqual({ text: "a\n\nb", isError: false, bytesBeforeCap: 4 });
  });

  test("keeps embedded text resources with their uri, placeholders for the rest", () => {
    const out = resultText(
      {
        content: [
          { type: "resource", resource: { uri: "file:///a.txt", text: "hello" } },
          { type: "resource", resource: { uri: "file:///b.bin", blob: "AAAA", mimeType: "application/octet-stream" } },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          { type: "resource_link", uri: "file:///c.txt", name: "c" },
          { type: "weird" },
        ],
      },
      10_000,
    );
    expect(out.text).toBe(
      [
        "file:///a.txt\nhello",
        "[resource omitted: application/octet-stream]",
        "[image omitted: image/png]",
        "[audio omitted: audio/wav]",
        "[resource link: file:///c.txt]",
        "[weird content omitted]",
      ].join("\n\n"),
    );
  });

  test("prints structuredContent only when there is no text item", () => {
    expect(resultText({ content: [], structuredContent: { n: 1 } }, 100).text).toBe('{"n":1}');
    expect(resultText({ content: [{ type: "text", text: "t" }], structuredContent: { n: 1 } }, 100).text).toBe("t");
  });

  test("carries isError", () => {
    expect(resultText({ content: [{ type: "text", text: "bad" }], isError: true }, 100).isError).toBe(true);
  });

  test("caps at maxBytes on a code point boundary with a truncation line", () => {
    const out = resultText({ content: [{ type: "text", text: "é".repeat(100) }] }, 51);
    expect(out.bytesBeforeCap).toBe(200);
    expect(out.text.startsWith("é".repeat(25))).toBe(true);
    expect(out.text).toContain("[truncated: 200 bytes in total]");
  });

  test("a malformed result is an empty, non-error text", () => {
    expect(resultText(null, 100)).toEqual({ text: "", isError: false, bytesBeforeCap: 0 });
    expect(resultText({ content: "nope" }, 100)).toEqual({ text: "", isError: false, bytesBeforeCap: 0 });
  });
});
