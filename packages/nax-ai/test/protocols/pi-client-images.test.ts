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
const TEXT_ONLY: Model<Api> = { ...MODEL, id: "test-text-only", input: ["text"] };
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

const PNG_A: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 2, height: 2 };
const JPEG_B: ImageAttachment = { mimeType: "image/jpeg", data: "BBBB" };
/** A Read tool call and its result: the conversation shape an image read produces. */
function readConversation(images: readonly ImageAttachment[] | undefined): readonly ConversationMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "a.png" } }] },
    {
      role: "tool-result",
      toolCallId: "c1",
      content: "shot",
      ...(images !== undefined ? { images } : {}),
    },
  ];
}
function toolResult(model: Model<Api>, messages: readonly ConversationMessage[]) {
  return toPiContext({ model: model.id, messages }, model).messages[1];
}

describe("toPiContext tool-result images", () => {
  it("AC-1 maps tool-result images to image parts after the text", () => {
    expect(toolResult(MODEL, readConversation([PNG_A, JPEG_B]))?.content).toEqual([
      { type: "text", text: "shot" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "image", data: "BBBB", mimeType: "image/jpeg" },
    ]);
  });
  it("AC-2 sends exactly the wire image keys for a tool-result image", () => {
    const content = toolResult(MODEL, readConversation([{ ...PNG_A, source: "a.png" }]))?.content;
    expect(content).toEqual([
      { type: "text", text: "shot" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(Object.keys(content?.[1] ?? {}).sort()).toEqual(["data", "mimeType", "type"]);
  });
  it("AC-3 appends one not-shown note for a text-only model", () => {
    expect(toolResult(TEXT_ONLY, readConversation([PNG_A]))?.content).toEqual([
      { type: "text", text: "shot\n[image not shown: this model does not accept image input (image/png 2x2)]" },
    ]);
  });
  it("AC-4 omits dimensions from the note when the attachment has none", () => {
    const content = toolResult(TEXT_ONLY, readConversation([JPEG_B]))?.content;
    expect(content).toEqual([
      { type: "text", text: "shot\n[image not shown: this model does not accept image input (image/jpeg)]" },
    ]);
    expect((content as { text: string }[])[0]?.text.split("\n")[1]).toBe(
      "[image not shown: this model does not accept image input (image/jpeg)]",
    );
  });
  it("AC-5 appends one note per image, in order, after the original content", () => {
    expect(toolResult(TEXT_ONLY, readConversation([PNG_A, JPEG_B]))?.content).toEqual([
      {
        type: "text",
        text:
          "shot\n[image not shown: this model does not accept image input (image/png 2x2)]" +
          "\n[image not shown: this model does not accept image input (image/jpeg)]",
      },
    ]);
  });
  it("AC-6 maps a tool result with no images key exactly as before", () => {
    expect(toolResult(MODEL, readConversation(undefined))?.content).toEqual([{ type: "text", text: "shot" }]);
  });
  it("AC-7 maps a tool result with an empty images list exactly as before", () => {
    expect(toolResult(MODEL, readConversation([]))?.content).toEqual([{ type: "text", text: "shot" }]);
  });
  it("AC-8 keeps isError and maps images even on a failed tool result", () => {
    const messages: readonly ConversationMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Read", input: {} }] },
      { role: "tool-result", toolCallId: "c1", content: "shot", isError: true, images: [PNG_A] },
    ];
    expect(toolResult(MODEL, messages)).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [
        { type: "text", text: "shot" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
  });
});
