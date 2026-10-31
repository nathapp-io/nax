/** The four container formats `sniffImage` recognises from magic bytes alone. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** What a header says about an image: its format and — when the header carries them — its pixel size. */
export interface SniffedImage {
  readonly format: ImageFormat;
  readonly mimeType: string; // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  readonly width?: number;
  readonly height?: number;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

type DimensionReader = (bytes: Uint8Array) => Dimensions | undefined;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;

const GIF_MAGICS = ["GIF87a", "GIF89a"];
const GIF_WIDTH_OFFSET = 6;
const GIF_HEIGHT_OFFSET = 8;

/** `FF D8` is SOI and the third `FF` opens the first segment — the marker walk starts there. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const JPEG_MARKER_START = JPEG_MAGIC.length - 1;
const JPEG_MARKER_PREFIX = 0xff;
/** Stand-alone markers carry no length, so the next marker immediately follows the code. */
const JPEG_TEM = 0x01;
const JPEG_RST0 = 0xd0;
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_SOF_MIN = 0xc0;
const JPEG_SOF_MAX = 0xcf;
/** C4 (DHT), C8 (JPG) and CC (DAC) sit in the SOF range but carry no frame dimensions. */
const JPEG_NOT_SOF = [0xc4, 0xc8, 0xcc];
/** Offsets of height and width from a SOF marker's own `FF`. */
const JPEG_HEIGHT_DELTA = 5;
const JPEG_WIDTH_DELTA = 7;

const WEBP_RIFF_MAGIC = "RIFF";
const WEBP_TAG = "WEBP";
const WEBP_TAG_OFFSET = 8;
const WEBP_CHUNK_OFFSET = 12;
/** `VP8 ` stores little-endian u16 at 26 and 28, each masked to its 14-bit dimension field. */
const WEBP_VP8_WIDTH_OFFSET = 26;
const WEBP_VP8_HEIGHT_OFFSET = 28;
const WEBP_SIZE_MASK = 0x3fff;
/** `VP8L` packs both sizes minus one into the four bytes at 21. */
const WEBP_VP8L_BITS_OFFSET = 21;
const WEBP_VP8L_BITS_LENGTH = 4;
const WEBP_VP8L_WIDTH_MASK = 0x3f;
const WEBP_VP8L_HEIGHT_TAIL_MASK = 0x0f;
/** `VP8X` stores each size minus one as a little-endian u24 at 24 and 27. */
const WEBP_VP8X_WIDTH_OFFSET = 24;
const WEBP_VP8X_HEIGHT_OFFSET = 27;

const MIME_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const DIMENSION_READERS: Readonly<Record<ImageFormat, DimensionReader>> = {
  png: pngDimensions,
  jpeg: jpegDimensions,
  gif: gifDimensions,
  webp: webpDimensions,
};

/**
 * Recognise an image from its magic bytes and read its pixel size from the header.
 *
 * Never guesses from a file name, and never decodes pixels. A recognised format whose
 * header is too short or malformed for its dimensions is returned without them; bytes
 * that match no signature give `undefined`.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  const format = detectFormat(bytes);
  if (format === undefined) return undefined;
  const mimeType = MIME_TYPES[format];
  const dimensions = DIMENSION_READERS[format](bytes);
  return dimensions === undefined
    ? { format, mimeType }
    : { format, mimeType, width: dimensions.width, height: dimensions.height };
}

function detectFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (matchesBytes(bytes, 0, PNG_MAGIC)) return "png";
  if (GIF_MAGICS.some((magic) => matchesText(bytes, 0, magic))) return "gif";
  if (matchesBytes(bytes, 0, JPEG_MAGIC)) return "jpeg";
  if (matchesText(bytes, 0, WEBP_RIFF_MAGIC) && matchesText(bytes, WEBP_TAG_OFFSET, WEBP_TAG)) return "webp";
  return undefined;
}

function pngDimensions(bytes: Uint8Array): Dimensions | undefined {
  const width = readU32BE(bytes, PNG_WIDTH_OFFSET);
  const height = readU32BE(bytes, PNG_HEIGHT_OFFSET);
  return pair(width, height);
}

function gifDimensions(bytes: Uint8Array): Dimensions | undefined {
  const width = readU16LE(bytes, GIF_WIDTH_OFFSET);
  const height = readU16LE(bytes, GIF_HEIGHT_OFFSET);
  return pair(width, height);
}

/**
 * Walk the JPEG marker chain to the first SOF segment, which holds height then width.
 * Fill bytes are skipped, stand-alone markers carry no length, and reaching SOS, EOI or
 * the end of the bytes gives no dimensions.
 */
function jpegDimensions(bytes: Uint8Array): Dimensions | undefined {
  let offset = JPEG_MARKER_START;
  while (readU8(bytes, offset) === JPEG_MARKER_PREFIX) {
    const marker = skipFillBytes(bytes, offset);
    if (marker === undefined) return undefined;
    const code = bytes[marker];
    if (code === JPEG_SOS || code === JPEG_EOI) return undefined;
    if (isStandaloneMarker(code)) {
      offset = marker + 1;
      continue;
    }
    if (isStartOfFrame(code)) return sofDimensions(bytes, marker - 1);
    // The length counts the two length bytes and the payload, but not the marker itself.
    const length = readU16BE(bytes, marker + 1);
    if (length === undefined) return undefined;
    const next = marker + 1 + length;
    // A segment length that does not move forward would walk the same bytes forever.
    if (next <= offset) return undefined;
    offset = next;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (matchesText(bytes, WEBP_CHUNK_OFFSET, "VP8 ")) return vp8Dimensions(bytes);
  if (matchesText(bytes, WEBP_CHUNK_OFFSET, "VP8L")) return vp8lDimensions(bytes);
  if (matchesText(bytes, WEBP_CHUNK_OFFSET, "VP8X")) return vp8xDimensions(bytes);
  return undefined;
}

function vp8Dimensions(bytes: Uint8Array): Dimensions | undefined {
  const width = readU16LE(bytes, WEBP_VP8_WIDTH_OFFSET);
  const height = readU16LE(bytes, WEBP_VP8_HEIGHT_OFFSET);
  if (width === undefined || height === undefined) return undefined;
  return { width: width & WEBP_SIZE_MASK, height: height & WEBP_SIZE_MASK };
}

function vp8lDimensions(bytes: Uint8Array): Dimensions | undefined {
  const start = WEBP_VP8L_BITS_OFFSET;
  if (!hasBytes(bytes, start, WEBP_VP8L_BITS_LENGTH)) return undefined;
  const width = 1 + (bytes[start] | ((bytes[start + 1] & WEBP_VP8L_WIDTH_MASK) << 8));
  const height =
    1 + ((bytes[start + 1] >> 6) | (bytes[start + 2] << 2) | ((bytes[start + 3] & WEBP_VP8L_HEIGHT_TAIL_MASK) << 10));
  return { width, height };
}

function vp8xDimensions(bytes: Uint8Array): Dimensions | undefined {
  const width = readU24LE(bytes, WEBP_VP8X_WIDTH_OFFSET);
  const height = readU24LE(bytes, WEBP_VP8X_HEIGHT_OFFSET);
  if (width === undefined || height === undefined) return undefined;
  return { width: width + 1, height: height + 1 };
}

function sofDimensions(bytes: Uint8Array, markerStart: number): Dimensions | undefined {
  const height = readU16BE(bytes, markerStart + JPEG_HEIGHT_DELTA);
  const width = readU16BE(bytes, markerStart + JPEG_WIDTH_DELTA);
  return pair(width, height);
}

function isStandaloneMarker(code: number): boolean {
  return code === JPEG_TEM || (code >= JPEG_RST0 && code <= JPEG_SOI);
}

function isStartOfFrame(code: number): boolean {
  return code >= JPEG_SOF_MIN && code <= JPEG_SOF_MAX && !JPEG_NOT_SOF.includes(code);
}

/** Index of the marker code that follows the run of `FF` fill bytes starting at `offset`. */
function skipFillBytes(bytes: Uint8Array, offset: number): number | undefined {
  let index = offset;
  while (bytes[index] === JPEG_MARKER_PREFIX) index += 1;
  return index < bytes.length ? index : undefined;
}

function pair(width: number | undefined, height: number | undefined): Dimensions | undefined {
  return width === undefined || height === undefined ? undefined : { width, height };
}

function hasBytes(bytes: Uint8Array, offset: number, count: number): boolean {
  return offset + count <= bytes.length;
}

function matchesBytes(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  return hasBytes(bytes, offset, magic.length) && magic.every((value, index) => bytes[offset + index] === value);
}

function matchesText(bytes: Uint8Array, offset: number, text: string): boolean {
  if (!hasBytes(bytes, offset, text.length)) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readU8(bytes: Uint8Array, offset: number): number | undefined {
  return hasBytes(bytes, offset, 1) ? bytes[offset] : undefined;
}

function readU16BE(bytes: Uint8Array, offset: number): number | undefined {
  return hasBytes(bytes, offset, 2) ? (bytes[offset] << 8) | bytes[offset + 1] : undefined;
}

function readU16LE(bytes: Uint8Array, offset: number): number | undefined {
  return hasBytes(bytes, offset, 2) ? bytes[offset] | (bytes[offset + 1] << 8) : undefined;
}

function readU24LE(bytes: Uint8Array, offset: number): number | undefined {
  if (!hasBytes(bytes, offset, 3)) return undefined;
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (!hasBytes(bytes, offset, 4)) return undefined;
  return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
