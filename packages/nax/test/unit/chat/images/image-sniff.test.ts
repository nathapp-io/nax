import { describe, expect, test } from "bun:test";
import { sniffImage } from "@/chat/images/image-sniff";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

/** A PNG: signature, then an IHDR chunk carrying width and height. */
function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...PNG_SIGNATURE,
    0x00,
    0x00,
    0x00,
    0x0d, // IHDR chunk length (13)
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    0x08,
    0x06,
    0x00,
    0x00,
    0x00, // bit depth, colour type, compression, filter, interlace
  ]);
}

/** A GIF: header, logical screen width and height, then the trailing screen fields. */
function gif(version: "87a" | "89a", width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...ascii(`GIF${version}`),
    ...u16le(width),
    ...u16le(height),
    0x00,
    0x00,
    0x00, // packed, background colour, aspect ratio
  ]);
}

/** A JPEG marker segment: FF, code, big-endian length (payload + those two bytes), payload. */
function jpegSegment(code: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, code, (length >>> 8) & 0xff, length & 0xff, ...payload];
}

/** A SOF segment: precision, height, width, then three components. */
function jpegSof(code: number, height: number, width: number): number[] {
  return jpegSegment(code, [
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
}

const JPEG_APP0 = jpegSegment(0xe0, [...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

/** A WebP container: RIFF header, "WEBP", then the first chunk type and its payload. */
function webp(chunk: string, payload: readonly number[]): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"),
    ...u32be(payload.length + 12),
    ...ascii("WEBP"),
    ...ascii(chunk),
    ...u32be(payload.length),
    ...payload,
  ]);
}

/** The `VP8 ` chunk payload: frame tag, start code, then little-endian width and height. */
function vp8Payload(width: number, height: number): number[] {
  return [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
}

/** The `VP8L` chunk payload: the 0x2f signature byte, then the packed dimensions (each size - 1). */
function vp8lPayload(width: number, height: number): number[] {
  const w = width - 1;
  const h = height - 1;
  return [0x2f, w & 0xff, ((w >>> 8) & 0x3f) | ((h & 0x03) << 6), (h >>> 2) & 0xff, (h >>> 10) & 0x0f];
}

/** The `VP8X` chunk payload: flags and reserved bytes, then little-endian u24 of each size - 1. */
function vp8xPayload(width: number, height: number): number[] {
  return [0x00, 0x00, 0x00, 0x00, ...u24le(width - 1), ...u24le(height - 1)];
}

describe("sniffImage", () => {
  test("AC-1 reads PNG dimensions from the IHDR chunk", () => {
    expect(sniffImage(png(1280, 720))).toEqual({
      format: "png",
      mimeType: "image/png",
      width: 1280,
      height: 720,
    });
  });

  test("AC-2 reads GIF89a dimensions as little-endian u16", () => {
    expect(sniffImage(gif("89a", 3, 2))).toEqual({
      format: "gif",
      mimeType: "image/gif",
      width: 3,
      height: 2,
    });
  });

  test("AC-3 recognises GIF87a", () => {
    const sniffed = sniffImage(gif("87a", 5, 7));
    expect(sniffed?.format).toBe("gif");
    expect(sniffed?.mimeType).toBe("image/gif");
  });

  test("AC-4 walks past APP0 to the SOF0 segment for JPEG dimensions", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...JPEG_APP0, ...jpegSof(0xc0, 600, 800), 0xff, 0xd9]);
    expect(sniffImage(bytes)).toEqual({
      format: "jpeg",
      mimeType: "image/jpeg",
      width: 800,
      height: 600,
    });
  });

  test("AC-5 reads dimensions from a progressive SOF2 segment", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...jpegSof(0xc2, 240, 320), 0xff, 0xd9]);
    const sniffed = sniffImage(bytes);
    expect(sniffed?.format).toBe("jpeg");
    expect([sniffed?.width, sniffed?.height]).toEqual([320, 240]);
  });

  test("AC-6 reads lossy VP8 dimensions", () => {
    expect(sniffImage(webp("VP8 ", vp8Payload(640, 480)))).toEqual({
      format: "webp",
      mimeType: "image/webp",
      width: 640,
      height: 480,
    });
  });

  test("AC-7 reads lossless VP8L dimensions", () => {
    const sniffed = sniffImage(webp("VP8L", vp8lPayload(100, 50)));
    expect(sniffed?.format).toBe("webp");
    expect([sniffed?.width, sniffed?.height]).toEqual([100, 50]);
  });

  test("AC-8 reads extended VP8X dimensions", () => {
    const sniffed = sniffImage(webp("VP8X", vp8xPayload(4000, 3000)));
    expect(sniffed?.format).toBe("webp");
    expect([sniffed?.width, sniffed?.height]).toEqual([4000, 3000]);
  });

  test("AC-9 returns undefined for text bytes", () => {
    expect(sniffImage(new TextEncoder().encode("hello world"))).toBeUndefined();
  });

  test("AC-10 returns undefined for an empty array", () => {
    expect(sniffImage(new Uint8Array(0))).toBeUndefined();
  });

  test("AC-11 returns a PNG with no width or height when the header stops at the signature", () => {
    const sniffed = sniffImage(Uint8Array.from(PNG_SIGNATURE));
    expect(sniffed).toEqual({ format: "png", mimeType: "image/png" });
    expect(Object.hasOwn(sniffed ?? {}, "width")).toBe(false);
    expect(Object.hasOwn(sniffed ?? {}, "height")).toBe(false);
  });

  test("AC-12 skips FF fill bytes and a stand-alone RST marker before the SOF0 segment", () => {
    const bytes = Uint8Array.from([
      0xff,
      0xd8,
      0xff, // JPEG magic, ending on the first marker's FF
      0xff,
      0xff, // fill bytes
      0xff,
      0xd0, // stand-alone RST0
      ...jpegSof(0xc0, 400, 300),
      0xff,
      0xd9,
    ]);
    const sniffed = sniffImage(bytes);
    expect(sniffed?.format).toBe("jpeg");
    expect([sniffed?.width, sniffed?.height]).toEqual([300, 400]);
  });

  test("returns a JPEG with no dimensions when the markers end without an SOF", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...JPEG_APP0]);
    expect(sniffImage(bytes)).toEqual({ format: "jpeg", mimeType: "image/jpeg" });
  });

  test("returns a JPEG with no dimensions when a segment length would not advance", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xe0, 0x00, 0x00, ...jpegSof(0xc0, 600, 800)]);
    expect(sniffImage(bytes)).toEqual({ format: "jpeg", mimeType: "image/jpeg" });
  });

  test("returns a GIF with no dimensions when the header stops before them", () => {
    const bytes = Uint8Array.from(ascii("GIF89a"));
    expect(sniffImage(bytes)).toEqual({ format: "gif", mimeType: "image/gif" });
  });

  test("returns a WebP with no dimensions for an unrecognised chunk", () => {
    const bytes = webp("VP8Z", [0x00, 0x00, 0x00, 0x00]);
    expect(sniffImage(bytes)).toEqual({ format: "webp", mimeType: "image/webp" });
  });

  test("returns a WebP with no dimensions when the VP8X header is truncated", () => {
    const bytes = Uint8Array.from([...ascii("RIFF"), ...u32be(4), ...ascii("WEBP"), ...ascii("VP8X"), ...u32be(4)]);
    expect(sniffImage(bytes)).toEqual({ format: "webp", mimeType: "image/webp" });
  });

  test("AC-13 returns a JPEG with no width or height when SOS comes before any SOF", () => {
    const bytes = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      ...JPEG_APP0,
      ...jpegSegment(0xda, [0x01, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]),
    ]);
    const sniffed = sniffImage(bytes);
    expect(sniffed).toEqual({ format: "jpeg", mimeType: "image/jpeg" });
    expect(Object.hasOwn(sniffed ?? {}, "width")).toBe(false);
    expect(Object.hasOwn(sniffed ?? {}, "height")).toBe(false);
  });
});
