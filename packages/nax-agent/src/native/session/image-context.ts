import { MAX_REQUEST_IMAGE_BASE64_CHARS, MAX_REQUEST_IMAGES } from "#src/session/image-input";
import type { TranscriptMessage } from "./compaction.ts";

/** Text-only summary input view; never rewrite the image-bearing transcript. */
export function imagesAsNotes(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || message.images === undefined) return message;
    const { images, ...textMessage } = message;
    const notes = images.map((image) => {
      const dimensions =
        image.width !== undefined && image.height !== undefined ? ` ${image.width}x${image.height}` : "";
      return `[image: ${image.mimeType}${dimensions}]`;
    });
    const content = [...(message.content === "" ? [] : [message.content]), ...notes].join("\n");
    return { ...textMessage, content };
  });
}

/** Bound only the wire copy, preserving transcript data and dormant array identity. */
export function capRequestImages(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  let count = 0;
  let chars = 0;
  let bounded: TranscriptMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !message.images?.length) continue;
    const kept = new Set<number>();
    for (let i = message.images.length - 1; i >= 0; i -= 1) {
      const image = message.images[i];
      if (image && count < MAX_REQUEST_IMAGES && chars + image.data.length <= MAX_REQUEST_IMAGE_BASE64_CHARS) {
        kept.add(i);
        count += 1;
        chars += image.data.length;
      }
    }
    if (kept.size === message.images.length) continue;
    bounded ??= [...messages];
    const images = message.images.filter((_, i) => kept.has(i));
    const notes = message.images
      .filter((_, i) => !kept.has(i))
      .map((image) => `[image from an earlier turn dropped from context: ${image.mimeType}]`);
    const { images: _images, ...textMessage } = message;
    const content = [...(message.content === "" ? [] : [message.content]), ...notes].join("\n");
    bounded[index] = { ...textMessage, content, ...(images.length ? { images } : {}) };
  }
  return bounded ?? messages;
}
