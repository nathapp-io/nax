import { describe, expect, test } from "bun:test";
import type { ImageAttachment } from "@nathapp/nax-agent";
import {
  imageDescription,
  imageFormatOf,
  imageFromBytes,
  imageNoteLabel,
  imageRawBytes,
  imageSizeLabel,
  MAX_IMAGE_EDGE_PX,
  sniffImage,
} from "@/chat";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most raw bytes whose base64 form still fits MAX_IMAGE_BASE64_CHARS (5,242,880). */
const LARGEST_ACCEPTED_BYTES = 3_932_160;

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * A PNG: signature, then an IHDR chunk carrying width and height. `totalBytes` pads the
 * tail with zeros so a header can be checked at a given file size.
 */
function pngOfSize(width: number, height: number, totalBytes = 0): Uint8Array {
  const header = [
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
  ];
  const bytes = new Uint8Array(Math.max(totalBytes, header.length));
  bytes.set(header);
  return bytes;
}

/** A PNG attachment whose decoded `data` is `byteCount` bytes. */
function pngImage(byteCount: number, overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return { mimeType: "image/png", data: Buffer.alloc(byteCount).toString("base64"), ...overrides };
}

describe("imageFromBytes", () => {
  test("AC-1 returns a PNG attachment carrying the bytes, dimensions and source", () => {
    const bytes = pngOfSize(1280, 720);

    expect(imageFromBytes(bytes, "clipboard")).toEqual({
      image: {
        mimeType: "image/png",
        data: Buffer.from(bytes).toString("base64"),
        width: 1280,
        height: 720,
        source: "clipboard",
      },
    });
  });

  test("AC-2 refuses bytes that carry no image signature", () => {
    expect(imageFromBytes(new TextEncoder().encode("hello"), "clipboard")).toEqual({
      refusal: "not a PNG, JPEG, GIF or WebP image",
    });
  });

  test("AC-3 accepts 3,932,160 bytes and refuses 3,932,161", () => {
    const accepted = imageFromBytes(pngOfSize(8, 8, LARGEST_ACCEPTED_BYTES), "clipboard");
    expect("image" in accepted).toBe(true);

    expect(imageFromBytes(pngOfSize(8, 8, LARGEST_ACCEPTED_BYTES + 1), "clipboard")).toEqual({
      refusal: "image is larger than 3.75 MiB",
    });
  });

  test("AC-4 accepts an edge of 8000 px and refuses 8001 on either side", () => {
    expect("image" in imageFromBytes(pngOfSize(MAX_IMAGE_EDGE_PX, 720), "clipboard")).toBe(true);

    expect(imageFromBytes(pngOfSize(MAX_IMAGE_EDGE_PX + 1, 720), "clipboard")).toEqual({
      refusal: "image is larger than 8000 px on a side",
    });
    expect(imageFromBytes(pngOfSize(720, MAX_IMAGE_EDGE_PX + 1), "clipboard")).toEqual({
      refusal: "image is larger than 8000 px on a side",
    });
  });

  test("AC-5 reports the size refusal before the edge refusal", () => {
    const bytes = pngOfSize(9000, 720, LARGEST_ACCEPTED_BYTES + 1);

    expect(imageFromBytes(bytes, "clipboard")).toEqual({ refusal: "image is larger than 3.75 MiB" });
  });
});

describe("imageRawBytes", () => {
  test("AC-6 returns the decoded byte count of the base64 payload", () => {
    expect(imageRawBytes({ mimeType: "image/png", data: "AAAA" })).toBe(3);
    expect(imageRawBytes({ mimeType: "image/png", data: "AA==" })).toBe(1);
  });
});

describe("imageSizeLabel", () => {
  test.each([
    [0, "0 B"],
    [100, "100 B"],
    [178, "178 B"],
    [1023, "1023 B"],
  ])("US-003 AC-1 prints a sub-kibibyte size in bytes: %i -> %s", (bytes, label) => {
    expect(imageSizeLabel(bytes)).toBe(label);
  });

  test.each([
    [1024, "1 KB"],
    [1536, "1 KB"],
    [350_208, "342 KB"],
    [1_048_575, "1023 KB"],
  ])("US-003 AC-2 keeps the KB label from a kibibyte up: %i -> %s", (bytes, label) => {
    expect(imageSizeLabel(bytes)).toBe(label);
  });

  test("US-003 AC-3 keeps the MB label as one decimal", () => {
    expect(imageSizeLabel(1_572_864)).toBe("1.5 MB");
  });
});

describe("imageDescription", () => {
  test("AC-8 joins format, pixel size and size label", () => {
    expect(imageDescription(pngImage(350_208, { width: 1280, height: 720 }))).toBe("png · 1280×720 · 342 KB");
    expect(imageDescription(pngImage(350_208))).toBe("png · 342 KB");
  });
});

describe("imageNoteLabel", () => {
  test("US-003 AC-4 labels a four-character base64 payload as 3 B", () => {
    expect(imageNoteLabel(1, { mimeType: "image/png", data: "AAAA" })).toBe("image 1 · png · 3 B");
  });

  test("AC-9 prefixes the image number and appends the source when present", () => {
    expect(imageNoteLabel(2, pngImage(350_208, { width: 1280, height: 720, source: "clipboard" }))).toBe(
      "image 2 · png · 1280×720 · 342 KB · clipboard",
    );
    expect(imageNoteLabel(2, pngImage(350_208, { width: 1280, height: 720 }))).toBe(
      "image 2 · png · 1280×720 · 342 KB",
    );
  });
});

describe("imageFormatOf", () => {
  test("AC-10 names a supported mime type and falls back to the generic name", () => {
    expect(imageFormatOf("image/jpeg")).toBe("jpeg");
    expect(imageFormatOf("image/bmp")).toBe("image");
  });
});

describe("the images barrel", () => {
  test("AC-11 re-exports the helpers from @/chat and takes the format from the sniffer", () => {
    expect(MAX_IMAGE_EDGE_PX).toBe(8000);
    expect(sniffImage(Uint8Array.from(PNG_SIGNATURE))).toEqual({ format: "png", mimeType: "image/png" });

    const result = imageFromBytes(Uint8Array.from(PNG_SIGNATURE), "path /tmp/a.png");
    const image = "image" in result ? result.image : undefined;
    expect(image?.mimeType).toBe("image/png");
    expect(image?.source).toBe("path /tmp/a.png");
    expect(Object.hasOwn(image ?? {}, "width")).toBe(false);
    expect(Object.hasOwn(image ?? {}, "height")).toBe(false);

    expect(imageNoteLabel(1, { mimeType: "image/png", data: "AAAA" })).toBe("image 1 · png · 3 B");
  });
});
