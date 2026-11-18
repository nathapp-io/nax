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
 * One open handle serves the header, the size check and the body. Reading the
 * body by reopening the path let a screenshot replaced between the two opens
 * produce either a truncated image labelled as a success or a non-image labelled
 * with the header's MIME type; both are refused as "changed while it was being
 * read" instead.
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
import { type BoundedFile, openBoundedFile } from "#src/internal/bounded-io";
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

/**
 * The body is not the file the header described: it shrank under the handle, or
 * its bytes are no longer the format the header matched. Base64-ing a truncated
 * or reinterpreted body would hand the model an image the wire cannot carry, and
 * saving it would bake the failure into the transcript — so we refuse instead.
 */
function changedResult(displayPath: string): ToolResult {
  return { content: `"${displayPath}" changed while it was being read; run Read again`, isError: true };
}

/**
 * Read the whole file the header matched, and describe it.
 *
 * Every read comes from the SAME handle as the header and the size check: a
 * screenshot replaced at the path between two opens used to be able to hand back
 * a truncated body (labelled a success) or a body that was no longer an image at
 * all (labelled with the old MIME type).
 */
async function wholeImageResult(file: BoundedFile, header: SniffedImage, displayPath: string): Promise<ToolResult> {
  const bytes = await file.prefix(file.size);
  if (bytes.length !== file.size) return changedResult(displayPath);
  // Growth is the mirror of shrinkage: a file that grew after the open still
  // answers `file.size` bytes, so the body is the old prefix -- most likely a
  // truncated image -- while every other check passes. Re-stat the SAME handle
  // and refuse a size that no longer matches what the header described.
  if ((await file.currentSize()) !== file.size) return changedResult(displayPath);
  // Sniff the whole file again: a header bigger than IMAGE_HEADER_BYTES can be
  // truncated mid-segment, in which case the full bytes give the dimensions the
  // header alone could not. The body is a superset of the header's bytes, so its
  // verdict must agree with the header's -- a different one means the file
  // changed under the handle, not that the header was mis-sniffed.
  const sniffed = sniffImage(bytes);
  if (sniffed === undefined || sniffed.mimeType !== header.mimeType) return changedResult(displayPath);
  const pixels = pixelSize(sniffed);
  const image = {
    mimeType: sniffed.mimeType,
    data: Buffer.from(bytes).toString("base64"),
    ...(pixels ?? {}),
    source: displayPath,
  };
  return { content: imageLabel(sniffed.mimeType, pixels, bytes.length), images: [image] };
}

/**
 * The image result for `target`, or `undefined` when the file is not an image
 * and belongs on the text path.
 *
 * `hasOffset`/`hasLimit` are the caller's already-parsed range flags: a range
 * on an image is refused before a byte of the body is read. One open handle
 * serves the header, the size check and the body.
 */
export async function readImageResult(
  target: string,
  input: Record<string, unknown>,
  hasOffset: boolean,
  hasLimit: boolean,
): Promise<ToolResult | undefined> {
  let file: BoundedFile;
  try {
    file = await openBoundedFile(target);
  } catch (error) {
    return errorResult(error);
  }
  try {
    const head = await file.prefix(IMAGE_HEADER_BYTES);
    const sniffed = sniffImage(head);
    if (sniffed === undefined) return undefined;
    if (file.size > MAX_IMAGE_FILE_BYTES) return tooLargeResult(file.size);
    if (hasOffset || hasLimit) return rangeResult(input, sniffed);
    return await wholeImageResult(file, sniffed, String(input.path));
  } catch (error) {
    return errorResult(error);
  } finally {
    await file.close();
  }
}
