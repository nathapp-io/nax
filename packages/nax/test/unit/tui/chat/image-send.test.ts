/**
 * Preparing an image send, in isolation: which images travel, when the brain's capability is
 * asked and what the expander is handed, and which refusals come back as a notice.
 *
 * Every case is pure — the draft holds no I/O and the expander is a mock — so the fixtures are
 * hand-built attachments whose only meaningful property is `data.length`.
 */
import { describe, expect, mock, test } from "bun:test";
import { type ImageAttachment, MAX_IMAGES_PER_MESSAGE, validateImageAttachments } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ExpandedMentions, MentionWhere } from "@/chat";
import { EMPTY_IMAGE_DRAFT, type ImageDraft } from "@/tui/chat/image-draft";
import { type ImageSendInput, type ImageSendResult, prepareImageSend } from "@/tui/chat/image-send";

/** Where a mention is resolved: the process cwd, and the repo it must stay inside. */
const WHERE: MentionWhere = { cwd: "/repo/pkg", repoRoot: "/repo" };
/** A model name the capability notice names back. */
const TEXT_ONLY_MODEL = "openai/text-only";

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

/** An expander that answers with `reply`, recording the arguments it was handed. */
function expanderOf(reply: (text: string) => ExpandedMentions) {
  return mock(async (text: string, _where: MentionWhere): Promise<ExpandedMentions> => reply(text));
}

/** Every field of an input, with the defaults a case does not care about. */
function inputOf(overrides: Partial<ImageSendInput>): ImageSendInput {
  return {
    text: "",
    draft: EMPTY_IMAGE_DRAFT,
    where: WHERE,
    expand: expanderOf((text) => ({ message: text, records: [] })),
    acceptsImages: async () => true,
    model: "claude",
    ...overrides,
  };
}

/** The message and images of a send, or a throw naming the refusal — keeps each case an assertion. */
function sent(result: ImageSendResult): { readonly message: string; readonly images: readonly ImageAttachment[] } {
  if (result.kind === "refuse") throw new Error(`expected a send, refused with: ${result.notice}`);
  return { message: result.message, images: result.images };
}

describe("prepareImageSend", () => {
  test("AC-1 sends the renumbered text with the draft's image and expands nothing", async () => {
    const image = imageOf();
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [] }));

    const result = await prepareImageSend(
      inputOf({ text: "look [Image #1]", draft: { next: 2, images: [{ number: 1, image }] }, expand }),
    );

    expect(result).toEqual({ kind: "send", message: "look [Image #1]", images: [image] });
    expect(expand).not.toHaveBeenCalled();
  });

  test("AC-2 refuses a present image on a brain that cannot read one, and never expands", async () => {
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [] }));

    const result = await prepareImageSend(
      inputOf({
        text: "look [Image #1] @a.png",
        draft: draftOf(1),
        expand,
        acceptsImages: async () => false,
        model: TEXT_ONLY_MODEL,
      }),
    );

    expect(result).toEqual({
      kind: "refuse",
      notice: "openai/text-only cannot read images; switch model (/model) or remove the image",
    });
    expect(expand).not.toHaveBeenCalled();
  });

  test("AC-3 asks the capability once, expands with images: true, and appends mentioned images", async () => {
    const placeholder = imageOf(4, "clipboard");
    const mentioned = imageOf(8, "a.png");
    const acceptsImages = mock(async () => true);
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [], images: [mentioned] }));

    const result = await prepareImageSend(
      inputOf({
        text: "[Image #1] @a.png",
        draft: { next: 2, images: [{ number: 1, image: placeholder }] },
        expand,
        acceptsImages,
      }),
    );

    expect(acceptsImages).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("[Image #1] @a.png", { ...WHERE, images: true });
    expect(sent(result)).toEqual({
      message: "EXPANDED [Image #1] @a.png",
      images: [placeholder, mentioned],
    });
  });

  test("AC-4 asks once and keeps today's expander arguments when the brain cannot read images", async () => {
    const acceptsImages = mock(async () => false);
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [] }));

    const result = await prepareImageSend(inputOf({ text: "@a.png", expand, acceptsImages, model: TEXT_ONLY_MODEL }));

    expect(acceptsImages).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand.mock.calls[0]?.[1]).toBe(WHERE);
    expect(expand.mock.calls[0]?.[1]).not.toHaveProperty("images");
    expect(sent(result)).toEqual({ message: "EXPANDED @a.png", images: [] });
  });

  test("AC-4 asks once and expands with images: true when the brain reads images", async () => {
    const acceptsImages = mock(async () => true);
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [] }));

    const result = await prepareImageSend(inputOf({ text: "@a.png", expand, acceptsImages }));

    expect(acceptsImages).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("@a.png", { ...WHERE, images: true });
    expect(expand.mock.calls[0]?.[1]).toHaveProperty("images", true);
    expect(sent(result)).toEqual({ message: "EXPANDED @a.png", images: [] });
  });

  test("AC-5 refuses with the validator's reason when the images break the shared limits", async () => {
    const placeholder = imageOf(4, "clipboard");
    const mentioned = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, index) => imageOf(4, `m${index}.png`));
    const images = [placeholder, ...mentioned];
    const reason = validateImageAttachments(images);
    assertDefined(reason, "eleven images overrun the count limit");

    const result = await prepareImageSend(
      inputOf({
        text: "[Image #1] @a.png",
        draft: { next: 2, images: [{ number: 1, image: placeholder }] },
        expand: expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [], images: mentioned })),
      }),
    );

    expect(result).toEqual({ kind: "refuse", notice: `images not sent: ${reason}` });
    expect(reason).toBe("Image count exceeds the limit of 10 images per message");
  });

  test("treats a rejected capability as cannot-read: the image send is refused", async () => {
    const result = await prepareImageSend(
      inputOf({
        text: "[Image #1]",
        draft: draftOf(1),
        acceptsImages: async () => {
          throw new Error("backend cannot say");
        },
        model: TEXT_ONLY_MODEL,
      }),
    );

    expect(result).toEqual({
      kind: "refuse",
      notice: "openai/text-only cannot read images; switch model (/model) or remove the image",
    });
  });

  test("treats a rejected capability as cannot-read: the expander keeps today's arguments", async () => {
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [] }));

    const result = await prepareImageSend(
      inputOf({
        text: "@a.png",
        expand,
        acceptsImages: async () => {
          throw new Error("backend cannot say");
        },
      }),
    );

    expect(expand).toHaveBeenCalledWith("@a.png", WHERE);
    expect(expand.mock.calls[0]?.[1]).not.toHaveProperty("images");
    expect(sent(result)).toEqual({ message: "EXPANDED @a.png", images: [] });
  });

  test("asks nothing and sends the text as typed when it carries no image and no mention", async () => {
    const acceptsImages = mock(async () => true);
    const expand = expanderOf((text) => ({ message: `EXPANDED ${text}`, records: [] }));

    const result = await prepareImageSend(inputOf({ text: "hello there", draft: draftOf(1), expand, acceptsImages }));

    expect(acceptsImages).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "send", message: "hello there", images: [] });
  });
});
