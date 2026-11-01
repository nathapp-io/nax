/**
 * The image step of the mention expander: a mentioned image travels as an ImageAttachment when
 * the brain reads images, and as its path alone when it does not. The bytes decide what is an
 * image — never the file name — and the image step runs after every existing guard (resolve,
 * repo boundary, git-ignored, the read ceiling) so those keep their behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as chat from "@/chat";
import { expandChatMentions, parseMentionMessage } from "@/chat";

const REPO = "/repo";
const NOT_IGNORED: GitResult = { stdout: "", exitCode: 1, timedOut: false };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** One raw byte over the largest accepted image, whose base64 form no longer fits. */
const OVER_LIMIT_BYTES = 3_932_161;

interface GitResult {
  readonly stdout: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

const originalDeps = { ...chat._mentionExpandDeps };

let realPaths: Map<string, string>;
let contents: Map<string, Uint8Array>;

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/** `header` padded with zeros to `totalBytes`, so a real header can be presented at any size. */
function padded(header: readonly number[], totalBytes = 0): Uint8Array {
  const bytes = new Uint8Array(Math.max(header.length, totalBytes));
  bytes.set(header);
  return bytes;
}

/** A PNG: signature, then an IHDR chunk carrying width and height. */
function png(width: number, height: number, totalBytes = 0): Uint8Array {
  return padded(
    [
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
    ],
    totalBytes,
  );
}

/** A GIF: header, logical screen width and height, then the trailing screen fields. */
function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...ascii("GIF89a"),
    ...u16le(width),
    ...u16le(height),
    0x00,
    0x00,
    0x00, // packed, background colour, aspect ratio
  ]);
}

/** A JPEG: SOI, then a SOF0 segment declaring its height and width, the way a camera's does. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x0b, // segment length
    0x08, // precision
    ...u16be(height),
    ...u16be(width),
    0x03,
    0x01,
    0x22,
    0x00, // one component, and the bytes a SOF's payload always carries
  ]);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Register a file in the fake repo: `candidate` is the typed path, `realPath` what it resolves to. */
function addBytes(candidate: string, bytes: Uint8Array, realPath = candidate): void {
  realPaths.set(candidate, realPath);
  contents.set(realPath, bytes);
}

function addText(candidate: string, text: string): void {
  addBytes(candidate, new TextEncoder().encode(text));
}

/** Expand with a brain that reads images. */
function expandImages(text: string): ReturnType<typeof expandChatMentions> {
  return expandChatMentions(text, { cwd: REPO, repoRoot: REPO, images: true });
}

/** Expand with today's arguments: nothing says the brain reads images. */
function expand(text: string): ReturnType<typeof expandChatMentions> {
  return expandChatMentions(text, { cwd: REPO, repoRoot: REPO });
}

/** The envelope `formatMentionMessage` writes, assembled by hand so parsing is tested alone. */
function handBuiltEnvelope(text: string, records: readonly string[]): string {
  const block = `<nax-mentions>\n${records.join("")}`;
  return `${text}\n\n${block}</nax-mentions length="${block.length}">`;
}

/** One record's XML, as the envelope carries it. */
function recordXml(path: string, status: string, note: string, body = ""): string {
  return `<mention path="${path}" status="${status}" note="${note}" length="${body.length}">\n${body}\n</mention>\n`;
}

beforeEach(() => {
  realPaths = new Map([[REPO, REPO]]);
  contents = new Map();
  chat._mentionExpandDeps.realpath = async (path) => {
    const real = realPaths.get(path);
    if (real === undefined) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    return real;
  };
  chat._mentionExpandDeps.stat = async (path) => {
    const bytes = contents.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return { isDirectory: false, size: bytes.length };
  };
  chat._mentionExpandDeps.readBytes = async (path) => {
    const bytes = contents.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: no such file, '${path}'`);
    return bytes;
  };
  chat._mentionExpandDeps.git = async () => NOT_IGNORED;
});

afterEach(() => {
  Object.assign(chat._mentionExpandDeps, originalDeps);
});

describe("expandChatMentions — mentioned images", () => {
  test("AC-1 records a mentioned image as an image record describing it", async () => {
    addBytes("/repo/shot.png", png(2, 3));
    const result = await expandImages("see @shot.png");
    expect(result.records).toEqual([{ path: "shot.png", status: "image", note: "image · png · 2×3 · 1 KB", body: "" }]);
  });

  test("AC-2 collects the file's bytes as a PNG attachment with its pixel size and typed path", async () => {
    const bytes = png(2, 3);
    addBytes("/repo/shot.png", bytes);
    const result = await expandImages("see @shot.png");
    expect(result.images).toEqual([
      {
        mimeType: "image/png",
        data: base64(bytes),
        width: 2,
        height: 3,
        source: "shot.png",
      },
    ]);
  });

  test("AC-3 a brain that cannot read images gets the path alone, and no images key", async () => {
    addBytes("/repo/shot.png", png(2, 3));
    const result = await expand("see @shot.png");
    expect(result.records).toEqual([
      { path: "shot.png", status: "path-only", note: "path only: model cannot read images", body: "" },
    ]);
    expect(result).not.toHaveProperty("images");
  });

  test("AC-4 an image over the size limit is path-only, carrying the refusal, and adds no image", async () => {
    addBytes("/repo/huge.png", png(2, 3, OVER_LIMIT_BYTES));
    const result = await expandImages("@huge.png");
    expect(result.records).toEqual([
      { path: "huge.png", status: "path-only", note: "path only: image is larger than 3.75 MiB", body: "" },
    ]);
    expect(result).not.toHaveProperty("images");
  });

  test("AC-5 a .png name over text bytes is attached as text, because the format comes from the bytes", async () => {
    addText("/repo/notes.png", "not a picture\n");
    const result = await expandImages("@notes.png");
    expect(result.records).toEqual([
      { path: "notes.png", status: "attached", note: "1 lines", body: "not a picture\n" },
    ]);
    expect(result).not.toHaveProperty("images");
  });

  test("AC-6 a .dat name over JPEG bytes is an image, because the format comes from the bytes", async () => {
    const bytes = jpeg(2, 3);
    addBytes("/repo/photo.dat", bytes);
    const result = await expandImages("@photo.dat");
    expect(result.records).toEqual([
      { path: "photo.dat", status: "image", note: "image · jpeg · 2×3 · 1 KB", body: "" },
    ]);
    expect(result.images).toEqual([
      { mimeType: "image/jpeg", data: base64(bytes), width: 2, height: 3, source: "photo.dat" },
    ]);
  });

  test("AC-7 collects two mentions' images in the order they were typed", async () => {
    addBytes("/repo/a.png", png(2, 3));
    addBytes("/repo/b.gif", gif(3, 2));
    const result = await expandImages("@a.png @b.gif");
    expect(result.images?.map((image) => image.source)).toEqual(["a.png", "b.gif"]);
    expect(result.images?.map((image) => image.mimeType)).toEqual(["image/png", "image/gif"]);
  });

  test("AC-8 an image outside the repo is refused as before and adds no image", async () => {
    addBytes("/outside/shot.png", png(2, 3));
    const result = await expandImages("@../outside/shot.png");
    expect(result.records).toEqual([
      { path: "../outside/shot.png", status: "refused", note: "not attached: outside the repo", body: "" },
    ]);
    expect(result).not.toHaveProperty("images");
  });

  test("AC-9 an image record survives the envelope round trip with an empty body", async () => {
    addBytes("/repo/shot.png", png(2, 3));
    const expanded = await expandImages("see @shot.png");
    const parsed = parseMentionMessage(expanded.message);
    expect(parsed).toEqual({
      text: "see @shot.png",
      records: [{ path: "shot.png", status: "image", note: "image · png · 2×3 · 1 KB", body: "" }],
    });
  });

  test("AC-10 parses a hand-built envelope whose record says status=image", () => {
    const note = "image · png · 2×3 · 1 KB";
    const message = handBuiltEnvelope("see @shot.png", [recordXml("shot.png", "image", note)]);
    expect(parseMentionMessage(message)).toEqual({
      text: "see @shot.png",
      records: [{ path: "shot.png", status: "image", note, body: "" }],
    });
  });

  test("never attaches an image the brain cannot read, whatever its size", async () => {
    addBytes("/repo/huge.png", png(2, 3, OVER_LIMIT_BYTES));
    const result = await expand("@huge.png");
    expect(result.records.map((record) => record.note)).toEqual(["path only: model cannot read images"]);
  });

  test("leaves a text file among image mentions attached as text, in typed order", async () => {
    addText("/repo/a.txt", "x\n");
    addBytes("/repo/shot.png", png(2, 3));
    const result = await expandImages("@a.txt @shot.png");
    expect(result.records.map((record) => [record.path, record.status])).toEqual([
      ["a.txt", "attached"],
      ["shot.png", "image"],
    ]);
    expect(result.images?.map((image) => image.source)).toEqual(["shot.png"]);
  });
});
