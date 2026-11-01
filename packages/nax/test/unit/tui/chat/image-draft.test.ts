/**
 * The image draft, in isolation: which number a new attachment takes, where its placeholder
 * lands in the prompt, when the attach is refused, and which images travel with a send.
 *
 * Every case is pure — the draft holds no I/O and never reads the filesystem — so the
 * fixtures are hand-built attachments whose only meaningful property is `data.length`.
 */
import { describe, expect, test } from "bun:test";
import { type ImageAttachment, MAX_IMAGES_PER_MESSAGE, MAX_REQUEST_IMAGE_BASE64_CHARS } from "@nathapp/nax-agent";
import {
  attachToDraft,
  EMPTY_IMAGE_DRAFT,
  type ImageDraft,
  imagePlaceholder,
  imagesForSend,
  titleWithoutPlaceholders,
} from "@/tui/chat/image-draft";
import type { EditorState } from "@/tui/chat/line-editor";

/** An attachment whose base64 payload is `chars` characters long. */
function imageOf(chars = 4, source = "clipboard"): ImageAttachment {
  return { mimeType: "image/png", data: "A".repeat(chars), source };
}

/** A draft of `count` images numbered 1..count, each attachment `chars` base64 characters. */
function draftOf(count: number, chars = 4): ImageDraft {
  return {
    next: count + 1,
    images: Array.from({ length: count }, (_, index) => ({ number: index + 1, image: imageOf(chars) })),
  };
}

/** The placeholders of images 1..count, space-separated, as the prompt would hold them. */
function placeholdersFor(count: number): string {
  return Array.from({ length: count }, (_, index) => imagePlaceholder(index + 1)).join(" ");
}

/** The success arm, or a throw naming the refusal — keeps each case reading as an assertion. */
function attached(result: ReturnType<typeof attachToDraft>): {
  readonly draft: ImageDraft;
  readonly editor: EditorState;
} {
  if ("refusal" in result) throw new Error(`expected the image to attach, refused with: ${result.refusal}`);
  return result;
}

describe("imagePlaceholder", () => {
  test("AC-1 renders a number as the placeholder the prompt carries", () => {
    expect(imagePlaceholder(3)).toBe("[Image #3]");
    expect(imagePlaceholder(1)).toBe("[Image #1]");
  });
});

describe("EMPTY_IMAGE_DRAFT", () => {
  test("AC-1 starts at number 1 with no images", () => {
    expect(EMPTY_IMAGE_DRAFT).toEqual({ next: 1, images: [] });
  });
});

describe("attachToDraft", () => {
  test("AC-2 appends the placeholder at the cursor and takes the next number", () => {
    const image = imageOf();

    expect(attachToDraft(EMPTY_IMAGE_DRAFT, { text: "look ", cursor: 5 }, image)).toEqual({
      draft: { next: 2, images: [{ number: 1, image }] },
      editor: { text: "look [Image #1]", cursor: 15 },
    });
  });

  test("AC-3 inserts in the middle of the text, leaving the cursor after the placeholder", () => {
    const result = attached(attachToDraft(EMPTY_IMAGE_DRAFT, { text: "ab", cursor: 1 }, imageOf()));

    expect(result.editor).toEqual({ text: "a[Image #1]b", cursor: 11 });
  });

  test("AC-4 treats the cursor as a code-point index, so it inserts after an emoji", () => {
    const result = attached(attachToDraft(EMPTY_IMAGE_DRAFT, { text: "😀", cursor: 1 }, imageOf()));

    expect(result.editor).toEqual({ text: "😀[Image #1]", cursor: 11 });
  });

  test("AC-5 leaves the draft and the editor it was given unchanged", () => {
    // Frozen, so an in-place mutation throws rather than passing unnoticed.
    const draft: ImageDraft = Object.freeze({
      next: 3,
      images: Object.freeze([
        { number: 1, image: imageOf() },
        { number: 2, image: imageOf() },
      ]),
    });
    const editor: EditorState = Object.freeze({ text: "[Image #1] ab [Image #2]", cursor: 6 });
    const draftBefore = structuredClone(draft);
    const editorBefore = structuredClone(editor);

    const result = attached(attachToDraft(draft, editor, imageOf()));

    expect(draft).toEqual(draftBefore);
    expect(editor).toEqual(editorBefore);
    expect(result.draft).not.toBe(draft);
    expect(result.editor).not.toBe(editor);
  });

  test("AC-6 refuses an eleventh image while ten placeholders are present", () => {
    const text = placeholdersFor(MAX_IMAGES_PER_MESSAGE);

    expect(attachToDraft(draftOf(MAX_IMAGES_PER_MESSAGE), { text, cursor: text.length }, imageOf())).toEqual({
      refusal: "at most 10 images per message",
    });
  });

  test("AC-7 counts only the placeholders still in the text, so a deleted one frees a slot", () => {
    const draft = draftOf(MAX_IMAGES_PER_MESSAGE);
    const text = placeholdersFor(MAX_IMAGES_PER_MESSAGE).replace(imagePlaceholder(5), "");
    const image = imageOf();

    const result = attached(attachToDraft(draft, { text, cursor: text.length }, image));

    expect(result.draft.images.at(-1)).toEqual({ number: 11, image });
    expect(result.draft.next).toBe(12);
    expect(result.editor.text.endsWith("[Image #11]")).toBe(true);
  });

  test("AC-8 refuses when the present images plus the new one exceed the request limit", () => {
    const draft: ImageDraft = {
      next: 2,
      images: [{ number: 1, image: imageOf(MAX_REQUEST_IMAGE_BASE64_CHARS) }],
    };

    expect(attachToDraft(draft, { text: "[Image #1] ", cursor: 10 }, imageOf())).toEqual({
      refusal: "images in one message must total at most 20 MB",
    });
  });

  test("AC-8 attaches when the totals land exactly on the request limit", () => {
    const held = imageOf(MAX_REQUEST_IMAGE_BASE64_CHARS - 4);
    const draft: ImageDraft = { next: 2, images: [{ number: 1, image: held }] };
    const image = imageOf();

    const result = attached(attachToDraft(draft, { text: "[Image #1] ", cursor: 10 }, image));

    expect(result.draft.images).toEqual([
      { number: 1, image: held },
      { number: 2, image },
    ]);
  });

  test("AC-9 reports the count refusal when the count and the size are both exceeded", () => {
    // Ten present images, each a tenth of the request budget: the count refuses, and the
    // new image's 4 characters would have pushed the total over the size limit too.
    const text = placeholdersFor(MAX_IMAGES_PER_MESSAGE);

    expect(
      attachToDraft(
        draftOf(MAX_IMAGES_PER_MESSAGE, MAX_REQUEST_IMAGE_BASE64_CHARS / MAX_IMAGES_PER_MESSAGE),
        { text, cursor: text.length },
        imageOf(),
      ),
    ).toEqual({ refusal: "at most 10 images per message" });
  });
});

describe("imagesForSend", () => {
  test("AC-10 returns the text unchanged and both images in placeholder order", () => {
    const first = imageOf();
    const second = imageOf();
    const draft: ImageDraft = {
      next: 3,
      images: [
        { number: 1, image: first },
        { number: 2, image: second },
      ],
    };

    expect(imagesForSend(draft, "a [Image #1] b [Image #2]")).toEqual({
      text: "a [Image #1] b [Image #2]",
      images: [first, second],
    });
  });

  test("AC-11 drops a deleted placeholder's image and renumbers the survivor to 1", () => {
    const first = imageOf();
    const second = imageOf();
    const draft: ImageDraft = {
      next: 3,
      images: [
        { number: 1, image: first },
        { number: 2, image: second },
      ],
    };

    expect(imagesForSend(draft, "see [Image #2]")).toEqual({ text: "see [Image #1]", images: [second] });
  });

  test("AC-12 orders the images by first appearance and renumbers every placeholder", () => {
    const first = imageOf();
    const second = imageOf();
    const draft: ImageDraft = {
      next: 3,
      images: [
        { number: 1, image: first },
        { number: 2, image: second },
      ],
    };

    expect(imagesForSend(draft, "[Image #2] then [Image #1]")).toEqual({
      text: "[Image #1] then [Image #2]",
      images: [second, first],
    });
  });

  test("AC-13 carries one image once even when its placeholder appears twice", () => {
    const image = imageOf();
    const draft: ImageDraft = { next: 2, images: [{ number: 1, image }] };

    expect(imagesForSend(draft, "[Image #1] and again [Image #1]")).toEqual({
      text: "[Image #1] and again [Image #1]",
      images: [image],
    });
  });

  test("AC-14 leaves a placeholder no draft image owns as typed, and sends nothing", () => {
    expect(imagesForSend(EMPTY_IMAGE_DRAFT, "old [Image #4]")).toEqual({ text: "old [Image #4]", images: [] });
  });

  test("AC-15 sends nothing when the text holds no placeholder", () => {
    expect(imagesForSend({ next: 2, images: [{ number: 1, image: imageOf() }] }, "no placeholder")).toEqual({
      text: "no placeholder",
      images: [],
    });
  });
});

describe("titleWithoutPlaceholders", () => {
  test("US-003 AC-5 drops the leading placeholder and its spacing", () => {
    expect(titleWithoutPlaceholders("[Image #1] what colour is it")).toBe("what colour is it");
  });

  test("US-003 AC-6 drops every placeholder and collapses the whitespace runs it leaves", () => {
    expect(titleWithoutPlaceholders("compare [Image #1]  and   [Image #2] now")).toBe("compare and now");
  });

  test("US-003 AC-7 names a message that was nothing but pictures", () => {
    expect(titleWithoutPlaceholders("[Image #1][Image #2]")).toBe("image");
  });

  test("US-003 AC-8 returns text with no placeholder exactly as typed", () => {
    expect(titleWithoutPlaceholders("  two  spaces  ")).toBe("  two  spaces  ");
  });
});
