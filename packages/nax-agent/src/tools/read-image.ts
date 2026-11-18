/**
 * The image half of `Read` (US-004).
 *
 * `Read` decided what a file is by name alone, so a PNG came back as a stream
 * of replacement characters. The decision is by leading bytes here, never by
 * the file name: a PNG stored as `data.bin` is an image, and a `notes.png`
 * holding the text `hello` is text.
 *
 * The branch lives outside `read.ts` because `readTool.run` sits one point
 * under the strict cognitive-complexity limit (20); it is called once, and it
 * never throws — a header or body read failure comes back as an `isError`
 * result the model can react to, exactly as the text path's `catch` does.
 *
 * Two ceilings, and the image one replaces both of the text path's: a file is
 * refused outright past `MAX_IMAGE_FILE_BYTES`, which is the raw size whose
 * base64 fits the per-image character limit the send path enforces. Over it
 * we refuse rather than resize -- re-encoding someone's screenshot silently is
 * a worse answer than saying it is too big. `ctx.maxFileBytes` and
 * `readCeiling` do not apply: they bound text the model is told about, and an
 * image is not read for display.
 */

import { errorMessage } from "#src/infra/errors";
import { type BytesPrefix, readBytesPrefix } from "#src/internal/bounded-io";
import { MAX_IMAGE_BASE64_CHARS } from "#src/session/image-input";
import { type SniffedImage, sniffImage } from "#src/session/image-sniff";
import type { ToolResult } from "./registry.ts";

/**
 * How much of a file is sniffed before deciding it is not an image: two halves
 * of the largest SOF segment a real JPEG carries, and comfortably past every
 * header these four formats read a dimension from.
 */
export const IMAGE_HEADER_BYTES = 65_536;

/** Raw bytes whose base64 fits `MAX_IMAGE_BASE64_CHARS`: 3,932,160. */
export const MAX_IMAGE_FILE_BYTES = (MAX_IMAGE_BASE64_CHARS / 4) * 3;

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

function errorResult(error: unknown): ToolResult {
  return { content: errorMessage(error), isError: true };
}

/**
 * A positive, finite pixel count, or nothing. A header that declares 0 is a
 * header we cannot describe — and `ImageAttachment` refuses a 0 dimension, so
 * carrying it would make the whole result invalid downstream.
 */
function usableDimension(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `[image: image/png 100x50, 35 bytes]`, or the same without the pixel size. */
function imageLabel(mimeType: string, pixels: Dimensions | undefined, bytes: number): string {
  const size = pixels === undefined ? "" : ` ${pixels.width}x${pixels.height}`;
  return `[image: ${mimeType}${size}, ${bytes} bytes]`;
}

function pixelSize(sniffed: SniffedImage): Dimensions | undefined {
  const width = usableDimension(sniffed.width);
  const height = usableDimension(sniffed.height);
  return width === undefined || height === undefined ? undefined : { width, height };
}

function tooLargeResult(size: number): ToolResult {
  return { content: `image too large to view: ${size} bytes (limit ${MAX_IMAGE_FILE_BYTES})`, isError: true };
}

function rangeResult(input: Record<string, unknown>, sniffed: SniffedImage): ToolResult {
  return {
    content: `offset/limit apply to text files; "${String(input.path)}" is an ${sniffed.mimeType} image`,
    isError: true,
  };
}

/** Everything `wholeImageResult` needs about the file the header already matched. */
interface WholeImageRequest {
  readonly target: string;
  /** The path as the caller gave it — `source` and the labels name it this way. */
  readonly displayPath: string;
  readonly header: SniffedImage;
  readonly size: number;
}

/** Read the whole file the header matched, and describe it. */
async function wholeImageResult(request: WholeImageRequest): Promise<ToolResult> {
  let body: BytesPrefix;
  try {
    body = await readBytesPrefix(request.target, request.size);
  } catch (error) {
    return errorResult(error);
  }
  // Sniff the whole file again: a header bigger than IMAGE_HEADER_BYTES can be
  // truncated mid-segment, in which case the full bytes give the dimensions the
  // header alone could not. The header's verdict is the fallback.
  const sniffed = sniffImage(body.bytes) ?? request.header;
  const pixels = pixelSize(sniffed);
  const image = {
    mimeType: sniffed.mimeType,
    data: Buffer.from(body.bytes).toString("base64"),
    ...(pixels ?? {}),
    source: request.displayPath,
  };
  return { content: imageLabel(sniffed.mimeType, pixels, body.bytes.length), images: [image] };
}

/**
 * The image result for `target`, or `undefined` when the file is not an image
 * and belongs on the text path.
 *
 * `hasOffset`/`hasLimit` are the caller's already-parsed range flags: a range
 * on an image is refused before a byte of the body is read.
 */
export async function readImageResult(
  target: string,
  input: Record<string, unknown>,
  hasOffset: boolean,
  hasLimit: boolean,
): Promise<ToolResult | undefined> {
  let head: BytesPrefix;
  try {
    head = await readBytesPrefix(target, IMAGE_HEADER_BYTES);
  } catch (error) {
    return errorResult(error);
  }
  const sniffed = sniffImage(head.bytes);
  if (sniffed === undefined) return undefined;
  if (head.size > MAX_IMAGE_FILE_BYTES) return tooLargeResult(head.size);
  if (hasOffset || hasLimit) return rangeResult(input, sniffed);
  return wholeImageResult({ target, displayPath: String(input.path), header: sniffed, size: head.size });
}
