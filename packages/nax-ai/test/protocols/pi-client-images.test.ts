import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "../../src/index.ts";
import { toPiContext } from "../../src/protocols/pi-client.ts";
import type { ConversationMessage } from "../../src/protocols/types.ts";

const MODEL: Model<Api> = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};
const IMAGE = { mimeType: "image/png", data: "AAAA" };
const PART = { type: "image", ...IMAGE };
function context(messages: readonly ConversationMessage[]) {
  return toPiContext({ model: MODEL.id, messages }, MODEL);
}

describe("toPiContext user images", () => {
  it.each([
    ["AC-1 image before text", "what is this", [IMAGE], [PART, { type: "text", text: "what is this" }]],
    [
      "AC-2 preserves two-image order",
      "compare",
      [IMAGE, { mimeType: "image/jpeg", data: "BBBB" }],
      [PART, { type: "image", mimeType: "image/jpeg", data: "BBBB" }, { type: "text", text: "compare" }],
    ],
    ["AC-3 omits empty text", "", [IMAGE], [PART]],
    ["AC-6 empty images preserve string", "hi", [], "hi"],
  ] as const)("%s", (_name, content, images, expected) => {
    expect(context([{ role: "user", content, images }]).messages[0]?.content).toEqual(expected);
  });
  it("AC-4 sends exactly the wire image keys", () => {
    const image: ImageAttachment = { ...IMAGE, width: 10, height: 20, source: "clipboard" };
    const content = context([{ role: "user", content: "", images: [image] }]).messages[0]?.content;
    expect(content).toEqual([PART]);
    expect(Object.keys(content?.[0] ?? {}).sort()).toEqual(["data", "mimeType", "type"]);
  });
  it("AC-5 preserves text-only strings", () => {
    expect(context([{ role: "user", content: "hi" }]).messages[0]?.content).toBe("hi");
  });
  it("AC-16 refuses orphan tool results after images", () => {
    expect(() =>
      context([
        { role: "user", content: "look", images: [IMAGE] },
        { role: "tool-result", toolCallId: "ghost", content: "ok" },
      ]),
    ).toThrow(/ghost/);
  });
});
