import { describe, expect, test } from "bun:test";
import { sniffImage as agentSniffImage } from "@nathapp/nax-agent";
import { imageFromBytes, sniffImage } from "@/chat";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
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

describe("the @/chat image sniffer", () => {
  test("AC-1 returns the PNG format, mime type and dimensions of a 100x50 PNG", () => {
    expect(sniffImage(png(100, 50))).toEqual({
      format: "png",
      mimeType: "image/png",
      width: 100,
      height: 50,
    });
  });

  test("AC-2 turns the same bytes into a PNG attachment with mimeType, width and height", () => {
    const result = imageFromBytes(png(100, 50), "clipboard");

    expect("image" in result).toBe(true);
    const image = "image" in result ? result.image : undefined;
    expect(image?.mimeType).toBe("image/png");
    expect(image?.width).toBe(100);
    expect(image?.height).toBe(50);
  });

  test("AC-3 refuses the UTF-8 bytes of hello", () => {
    expect(imageFromBytes(new TextEncoder().encode("hello"), "clipboard")).toEqual({
      refusal: "not a PNG, JPEG, GIF or WebP image",
    });
  });

  test("is the agent's shared sniffer, not a second copy of it", () => {
    expect(sniffImage).toBe(agentSniffImage);
  });
});
