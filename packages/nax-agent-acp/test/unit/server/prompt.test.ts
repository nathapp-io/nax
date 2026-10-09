import { describe, expect, test } from "bun:test";
import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk";
import { flattenPrompt } from "#src/server/prompt";

function rejects(blocks: readonly ContentBlock[]): RequestError {
  try {
    flattenPrompt(blocks);
  } catch (error) {
    if (error instanceof RequestError) return error;
  }
  throw new Error("expected a RequestError");
}

describe("flattenPrompt (spec §3.2)", () => {
  test("text blocks verbatim, joined by a blank line", () => {
    expect(
      flattenPrompt([
        { type: "text", text: "fix the bug" },
        { type: "text", text: "in parser.ts" },
      ]),
    ).toBe("fix the bug\n\nin parser.ts");
  });

  test("an embedded text resource is a fenced block headed by its URI", () => {
    expect(flattenPrompt([{ type: "resource", resource: { uri: "file:///w/a.ts", text: "const a = 1;" } }])).toBe(
      "file:///w/a.ts\n```\nconst a = 1;\n```",
    );
  });

  test("the fence outgrows any backtick run in the text", () => {
    const text = "see:\n```ts\nx\n```\nand ````";
    const out = flattenPrompt([{ type: "resource", resource: { uri: "file:///w/README.md", text } }]);
    expect(out.startsWith("file:///w/README.md\n`````\n")).toBe(true);
    expect(out.endsWith("\n`````")).toBe(true);
  });

  test("a resource link is its URI only", () => {
    expect(flattenPrompt([{ type: "resource_link", uri: "file:///w/b.ts", name: "b.ts" }])).toBe("file:///w/b.ts");
  });

  test("image, audio and binary resources are invalid_params", () => {
    expect(rejects([{ type: "image", data: "AA==", mimeType: "image/png" }]).code).toBe(-32602);
    expect(rejects([{ type: "audio", data: "AA==", mimeType: "audio/wav" }]).code).toBe(-32602);
    const binary = rejects([{ type: "resource", resource: { uri: "file:///w/x.bin", blob: "AA==" } }]);
    expect(binary.code).toBe(-32602);
    expect(binary.message).toContain("file:///w/x.bin");
  });

  test("a prompt with no text is invalid_params", () => {
    expect(rejects([]).code).toBe(-32602);
    expect(rejects([{ type: "text", text: "" }]).code).toBe(-32602);
  });
});
