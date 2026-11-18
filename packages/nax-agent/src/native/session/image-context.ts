import type { ImageAttachment } from "#src/cost/standard-types";
import { MAX_REQUEST_IMAGE_BASE64_CHARS, MAX_REQUEST_IMAGES } from "#src/session/image-input";
import type { TranscriptMessage } from "./compaction.ts";

/**
 * The two transcript arms that can carry attachments: a user prompt's images,
 * and a tool result's (US-002). Every function here treats them alike, because
 * the request budget and the summarizer's text-only view are both per REQUEST,
 * not per author.
 */
type ImageBearingMessage = Extract<TranscriptMessage, { role: "user" | "tool-result" }>;

/** True for the arms above, so a caller narrows instead of reaching into a union. */
function carriesImages(message: TranscriptMessage): message is ImageBearingMessage {
  return message.role === "user" || message.role === "tool-result";
}

/** Text-only summary input view; never rewrite the image-bearing transcript. */
export function imagesAsNotes(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  return messages.map((message) => {
    if (!carriesImages(message)) return message;
    const images = message.images;
    if (images === undefined) return message;
    return rewriteImages(message, images.map(describeImage), []);
  });
}

/** Bound only the wire copy, preserving transcript data and dormant array identity. */
export function capRequestImages(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  const budget: ImageBudget = { count: 0, chars: 0 };
  let bounded: TranscriptMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || !carriesImages(message)) continue;
    const images = message.images;
    if (images === undefined || images.length === 0) continue;
    const kept = keepNewest(images, budget);
    if (kept.size === images.length) continue;
    bounded ??= [...messages];
    const notes = images.flatMap((image, at) => (kept.has(at) ? [] : [droppedNote(image)]));
    bounded[index] = rewriteImages(
      message,
      notes,
      images.filter((_, at) => kept.has(at)),
    );
  }
  return bounded ?? messages;
}

/** The request-wide allowance left as the pass walks newest to oldest. */
interface ImageBudget {
  count: number;
  chars: number;
}

/**
 * The per-message keep/drop step both arms share: newest first, against the
 * budget the whole request shares. It KEEPS LOOKING after a drop — a small
 * image older than an oversized one still fits, and stopping at the first drop
 * would leave the request under-filled for no reason.
 *
 * Returns the kept INDEXES, because a kept set can be non-contiguous.
 */
function keepNewest(images: readonly ImageAttachment[], budget: ImageBudget): Set<number> {
  const kept = new Set<number>();
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index];
    if (image === undefined) continue;
    if (budget.count >= MAX_REQUEST_IMAGES) continue;
    if (budget.chars + image.data.length > MAX_REQUEST_IMAGE_BASE64_CHARS) continue;
    kept.add(index);
    budget.count += 1;
    budget.chars += image.data.length;
  }
  return kept;
}

const droppedNote = (image: ImageAttachment): string =>
  `[image from an earlier turn dropped from context: ${image.mimeType}]`;

function describeImage(image: ImageAttachment): string {
  const dimensions = image.width !== undefined && image.height !== undefined ? ` ${image.width}x${image.height}` : "";
  return `[image: ${image.mimeType}${dimensions}]`;
}

/**
 * The message with one note line per rewritten image appended to its content
 * and its images key replaced by `keptImages` — or removed when that is empty,
 * the absent-stays-absent rule the wire types follow everywhere.
 */
function rewriteImages(
  message: ImageBearingMessage,
  notes: readonly string[],
  keptImages: readonly ImageAttachment[],
): ImageBearingMessage {
  const { images: _images, ...textMessage } = message;
  const content = [...(message.content === "" ? [] : [message.content]), ...notes].join("\n");
  return { ...textMessage, content, ...(keptImages.length > 0 ? { images: keptImages } : {}) };
}
