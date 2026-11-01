/**
 * The image draft: the pictures attached to the message being typed, kept **beside** the
 * line editor rather than inside it.
 *
 * `InputDraft` in `ChatInput.tsx` holds text only, and this module keeps it that way: the
 * draft here is a separate, immutable value that the chat screen owns, so the line editor
 * stays a pure text reducer and nothing in the input has to know about attachments.
 *
 * Each attachment is given the draft's next number, starting at 1, and shows in the prompt
 * as the placeholder `[Image #N]`. The number is what ties a picture to its place in the
 * text: `imagesForSend` keeps only the images whose placeholder is still in the message and
 * renumbers them `1..k` in the order their placeholders first appear, so "image 1" in the
 * text the model reads is always the first image part. A placeholder the user deleted takes
 * its image with it, and one the user duplicated still sends its image once.
 *
 * Everything here is pure and returns new values — nothing mutates its inputs, reads the
 * filesystem or writes to the prompt. The chat screen does that I/O (`use-image-attach.ts`)
 * and hands the result back in.
 */
import { type ImageAttachment, MAX_IMAGES_PER_MESSAGE, MAX_REQUEST_IMAGE_BASE64_CHARS } from "@nathapp/nax-agent";
import type { EditorState } from "./line-editor";

/** One attachment and the number it was given, in the order the draft took it. */
export interface DraftImage {
  readonly number: number;
  readonly image: ImageAttachment;
}

/** The attachments for the prompt being typed, and the next number to hand out. */
export interface ImageDraft {
  readonly next: number;
  readonly images: readonly DraftImage[];
}

/** No attachments yet — where every draft starts and where a send resets it. */
export const EMPTY_IMAGE_DRAFT: ImageDraft = { next: 1, images: [] };

/**
 * The refusal texts, shown verbatim in the chat notice. The count is spelled from the
 * shared limit so the two cannot drift; the size limit is a base64-character budget and the
 * design states it to the user in MB, so that number is its own constant.
 */
const COUNT_REFUSAL = `at most ${MAX_IMAGES_PER_MESSAGE} images per message`;
const SIZE_REFUSAL = "images in one message must total at most 20 MB";

/** Every placeholder in a message. Only the ones a draft image owns are rewritten. */
const PLACEHOLDER = /\[Image #(\d+)\]/g;

/** A run of whitespace, so a removed placeholder does not leave its spacing doubled. */
const WHITESPACE_RUN = /\s+/gu;

/** What a message that was nothing but pictures is titled. */
const IMAGE_TITLE = "image";

/** The placeholder an attachment shows as in the prompt. */
export function imagePlaceholder(number: number): string {
  return `[Image #${number}]`;
}

/**
 * The title a send carrying pictures earns: its placeholders removed, the whitespace runs
 * they leave collapsed to one space and the ends trimmed.
 *
 * A title is what the session is called, so `[Image #1] what colour is it` is titled
 * `what colour is it` rather than by the placeholder the prompt used to point at its own
 * picture. Text with no placeholder is returned **exactly** as typed: the collapse is part of
 * dropping placeholders, not a tidy-up the screen applies to every title.
 *
 * A message that was nothing but pictures carries no words to be called by, so it falls back
 * to `image` rather than to an empty title.
 */
export function titleWithoutPlaceholders(text: string): string {
  const stripped = text.replace(PLACEHOLDER, "");
  if (stripped === text) return text;
  return stripped.replace(WHITESPACE_RUN, " ").trim() || IMAGE_TITLE;
}

/** The draft images whose placeholder is still in `text`, in draft order. */
function presentImages(draft: ImageDraft, text: string): readonly DraftImage[] {
  return draft.images.filter((draftImage) => text.includes(imagePlaceholder(draftImage.number)));
}

/**
 * `text` with `insertion` at the code-point `cursor`, and the cursor moved past it. The
 * text is read as code points, as the line editor reads it, so a cursor after an emoji
 * lands after the whole emoji rather than between its surrogates.
 */
function insertAt(text: string, cursor: number, insertion: string): EditorState {
  const chars = Array.from(text);
  const at = Math.min(Math.max(cursor, 0), chars.length);
  const added = Array.from(insertion);
  return {
    text: [...chars.slice(0, at), ...added, ...chars.slice(at)].join(""),
    cursor: at + added.length,
  };
}

/**
 * The draft with `image` attached and the prompt with its placeholder inserted at the
 * cursor, or the reason it cannot be attached.
 *
 * Only the images whose placeholder is still in the text count towards the limits: an
 * image whose placeholder the user deleted has left the message, so it no longer occupies a
 * slot or any of the size budget, and the number it held is not reused.
 */
export function attachToDraft(
  draft: ImageDraft,
  editor: EditorState,
  image: ImageAttachment,
): { readonly draft: ImageDraft; readonly editor: EditorState } | { readonly refusal: string } {
  const present = presentImages(draft, editor.text);
  // Count first: a message already at the count limit is refused whatever the sizes say.
  if (present.length >= MAX_IMAGES_PER_MESSAGE) return { refusal: COUNT_REFUSAL };
  const total = present.reduce((sum, draftImage) => sum + draftImage.image.data.length, 0) + image.data.length;
  if (total > MAX_REQUEST_IMAGE_BASE64_CHARS) return { refusal: SIZE_REFUSAL };
  return {
    draft: { next: draft.next + 1, images: [...draft.images, { number: draft.next, image }] },
    editor: insertAt(editor.text, editor.cursor, imagePlaceholder(draft.next)),
  };
}

/**
 * The images a send carries and the text they belong to: only the draft images whose
 * placeholder survives in `text`, ordered by first appearance, with every placeholder
 * renumbered `1..k` in that order.
 *
 * A `[Image #N]` no draft image owns is left exactly as typed — the user may have written
 * it, or recalled it from history — and rewriting is a single pass over the original text,
 * so renumbering 2 to 1 cannot then renumber that fresh 1 again.
 */
export function imagesForSend(
  draft: ImageDraft,
  text: string,
): { readonly text: string; readonly images: readonly ImageAttachment[] } {
  const ordered: DraftImage[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const number = Number(match[1]);
    if (ordered.some((draftImage) => draftImage.number === number)) continue;
    const draftImage = draft.images.find((candidate) => candidate.number === number);
    if (draftImage !== undefined) ordered.push(draftImage);
  }
  if (ordered.length === 0) return { text, images: [] };
  const renumbered = new Map(ordered.map((draftImage, index) => [draftImage.number, index + 1]));
  return {
    text: text.replace(PLACEHOLDER, (placeholder, digits: string) => {
      const number = renumbered.get(Number(digits));
      return number === undefined ? placeholder : imagePlaceholder(number);
    }),
    images: ordered.map((draftImage) => draftImage.image),
  };
}
