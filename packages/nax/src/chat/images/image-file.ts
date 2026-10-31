import { type ImageAttachment, MAX_IMAGE_BASE64_CHARS } from "@nathapp/nax-agent";
import { type SniffedImage, sniffImage } from "./image-sniff";

/** Longest side, in pixels, an image may declare before it is refused. */
export const MAX_IMAGE_EDGE_PX = 8000;

const NOT_AN_IMAGE_REFUSAL = "not a PNG, JPEG, GIF or WebP image";
const TOO_LARGE_REFUSAL = "image is larger than 3.75 MiB";
const TOO_WIDE_REFUSAL = `image is larger than ${MAX_IMAGE_EDGE_PX} px on a side`;

const KIB_BYTES = 1024;
const MIB_BYTES = 1_048_576;

const MIME_FORMATS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);
const UNKNOWN_FORMAT = "image";
const DESCRIPTION_SEPARATOR = " · ";
/** U+00D7, the multiplication sign the transcript labels use between width and height. */
const PIXEL_SEPARATOR = "×";

/**
 * Turn sniffed bytes into an image attachment, or say why they cannot travel.
 *
 * The order is deliberate and the first failure wins: an unrecognised format first, then
 * the encoded size (`MAX_IMAGE_BASE64_CHARS` is the limit the send path enforces, so the
 * refusal names the raw size it corresponds to), then the pixel size. Dimensions travel
 * only when the header carried them.
 */
export function imageFromBytes(
  bytes: Uint8Array,
  source: string,
): { readonly image: ImageAttachment } | { readonly refusal: string } {
  const sniffed = sniffImage(bytes);
  if (sniffed === undefined) return { refusal: NOT_AN_IMAGE_REFUSAL };
  if (Math.ceil(bytes.length / 3) * 4 > MAX_IMAGE_BASE64_CHARS) return { refusal: TOO_LARGE_REFUSAL };
  if (exceedsEdge(sniffed.width) || exceedsEdge(sniffed.height)) return { refusal: TOO_WIDE_REFUSAL };
  return { image: toAttachment(bytes, source, sniffed) };
}

/** The short name of a mime type's format, or `"image"` when it is not one we sniff. */
export function imageFormatOf(mimeType: string): string {
  return MIME_FORMATS.get(mimeType) ?? UNKNOWN_FORMAT;
}

/** The decoded size of an image's base64 `data`. */
export function imageRawBytes(image: ImageAttachment): number {
  return (image.data.length / 4) * 3 - base64Padding(image.data);
}

/** A byte count as a transcript label: `"342 KB"` below a mebibyte, else `"1.5 MB"`. */
export function imageSizeLabel(bytes: number): string {
  if (bytes >= MIB_BYTES) return `${(bytes / MIB_BYTES).toFixed(1)} MB`;
  return `${Math.max(1, Math.floor(bytes / KIB_BYTES))} KB`;
}

/** The parts that describe an image without numbering it: `"png · 1280×720 · 342 KB"`. */
export function imageDescription(image: ImageAttachment): string {
  const pixels = pixelSize(image);
  const parts = [
    imageFormatOf(image.mimeType),
    ...(pixels === undefined ? [] : [pixels]),
    imageSizeLabel(imageRawBytes(image)),
  ];
  return parts.join(DESCRIPTION_SEPARATOR);
}

/** A numbered attachment label, with the image's origin appended when it carries one. */
export function imageNoteLabel(number: number, image: ImageAttachment): string {
  const label = `image ${number}${DESCRIPTION_SEPARATOR}${imageDescription(image)}`;
  return image.source === undefined ? label : `${label}${DESCRIPTION_SEPARATOR}${image.source}`;
}

function exceedsEdge(px: number | undefined): boolean {
  return px !== undefined && px > MAX_IMAGE_EDGE_PX;
}

function toAttachment(bytes: Uint8Array, source: string, sniffed: SniffedImage): ImageAttachment {
  const data = Buffer.from(bytes).toString("base64");
  const { width, height } = sniffed;
  if (width === undefined || height === undefined) return { mimeType: sniffed.mimeType, data, source };
  return { mimeType: sniffed.mimeType, data, width, height, source };
}

function base64Padding(data: string): number {
  if (data.endsWith("==")) return 2;
  return data.endsWith("=") ? 1 : 0;
}

function pixelSize(image: ImageAttachment): string | undefined {
  const { width, height } = image;
  return width === undefined || height === undefined ? undefined : `${width}${PIXEL_SEPARATOR}${height}`;
}
