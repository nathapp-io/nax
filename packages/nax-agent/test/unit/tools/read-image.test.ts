/**
 * US-004: `Read` returns supported images as tool-result images.
 *
 * The decision is by bytes, never by file name — AC-8 reads a PNG out of a
 * `.bin` file and AC-9 reads a `.png` with text in it — and the image branch
 * never throws: a refused header or an oversized file comes back as an
 * `isError` result the model can react to.
 *
 * The builders below write the smallest valid header for each format; the
 * pixel dimensions are the only part of the payload the sniffer reads.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _boundedIoDeps, type BoundedHandle } from "#src/internal/bounded-io";
import { compileToolPolicy, createCodingToolRuntime, DEFAULT_TOOL_MAX_FILE_BYTES, readTool } from "#src/tools/index";
import { readImageResult } from "#src/tools/read-image";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMAGE_LIMIT_BYTES = 3_932_160;

const tempDirs: string[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

let root: string;

beforeAll(() => {
  root = makeTestDir("nax-read-image-");
});

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** A GIF89a whose logical screen descriptor carries the dimensions. */
function gifBytes(width: number, height: number): number[] {
  const dimensions = [width & 0xff, (width >>> 8) & 0xff, height & 0xff, (height >>> 8) & 0xff];
  return [...ascii("GIF89a"), ...dimensions, 0x00, 0x00, 0x00];
}

/** A PNG: signature then an IHDR chunk carrying width and height. */
function pngHeader(width: number, height: number): number[] {
  return [
    ...PNG_SIGNATURE,
    0x00,
    0x00,
    0x00,
    0x0d,
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ];
}

/** A JPEG: SOI, an APP0 segment, then a SOF0 segment carrying height and width. */
function jpegBytes(height: number, width: number): number[] {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
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
  ];
  return [0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9];
}

function writeBytes(name: string, bytes: readonly number[]): string {
  const path = join(root, name);
  writeFileSync(path, Uint8Array.from(bytes));
  return path;
}

function ctx(paths: string[], overrides: { maxBytes?: number; maxFileBytes?: number } = {}) {
  return {
    root,
    resolvedPaths: paths,
    maxBytes: overrides.maxBytes ?? 40_000,
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_TOOL_MAX_FILE_BYTES,
  };
}

const hasMkfifo = Bun.which("mkfifo") !== null;

describe("readTool — image branch", () => {
  test("AC-6 returns an image result for a 100x50 PNG with no offset or limit", async () => {
    const path = writeBytes("shot.png", pngHeader(100, 50));
    const size = statSync(path).size;

    const result = await readTool.run({ path: "shot.png" }, ctx([path]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`[image: image/png 100x50, ${size} bytes]`);
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]).toEqual({
      mimeType: "image/png",
      data: Buffer.from(Uint8Array.from(pngHeader(100, 50))).toString("base64"),
      width: 100,
      height: 50,
      source: "shot.png",
    });
  });

  test("AC-7 reads a JPEG and reports the image/jpeg mime type", async () => {
    const path = writeBytes("shot.jpg", jpegBytes(240, 320));

    const result = await readTool.run({ path: "shot.jpg" }, ctx([path]));

    expect(result.isError).toBeUndefined();
    expect(result.images?.[0]?.mimeType).toBe("image/jpeg");
    expect(result.content).toBe(`[image: image/jpeg 320x240, ${statSync(path).size} bytes]`);
  });

  test("AC-8 decides by bytes, not by file name: a PNG stored as data.bin is an image", async () => {
    const path = writeBytes("data.bin", pngHeader(10, 20));

    const result = await readTool.run({ path: "data.bin" }, ctx([path]));

    expect(result.isError).toBeUndefined();
    expect(result.images?.[0]).toMatchObject({ mimeType: "image/png", width: 10, height: 20, source: "data.bin" });
  });

  test("AC-9 a .png holding the text hello is still read as text", async () => {
    const path = join(root, "notes.png");
    writeFileSync(path, "hello");

    const result = await readTool.run({ path: "notes.png" }, ctx([path]));

    expect(result).toEqual({ content: "[1 lines]\nhello", truncated: false });
    expect(Object.hasOwn(result, "images")).toBe(false);
  });

  test("AC-10 a GIF header too short to hold its size yields a size-less image label", async () => {
    const path = writeBytes("short.gif", ascii("GIF89a"));
    const size = statSync(path).size;

    const result = await readTool.run({ path: "short.gif" }, ctx([path]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`[image: image/gif, ${size} bytes]`);
    expect(result.images?.[0]).toEqual({
      mimeType: "image/gif",
      data: Buffer.from("GIF89a").toString("base64"),
      source: "short.gif",
    });
    expect(Object.hasOwn(result.images?.[0] ?? {}, "width")).toBe(false);
    expect(Object.hasOwn(result.images?.[0] ?? {}, "height")).toBe(false);
  });

  test("a GIF89a carrying its size keeps both dimensions", async () => {
    const path = writeBytes("small.gif", gifBytes(3, 2));

    const result = await readTool.run({ path: "small.gif" }, ctx([path]));

    expect(result.content).toBe(`[image: image/gif 3x2, ${statSync(path).size} bytes]`);
    expect(result.images?.[0]).toMatchObject({ mimeType: "image/gif", width: 3, height: 2 });
  });

  test("AC-11 refuses a file one byte over the image limit", async () => {
    const path = join(root, "huge.png");
    const header = pngHeader(100, 50);
    writeFileSync(path, Uint8Array.from([...header, ...new Array(IMAGE_LIMIT_BYTES + 1 - header.length).fill(0x00)]));

    const result = await readTool.run({ path: "huge.png" }, ctx([path]));

    expect(statSync(path).size).toBe(IMAGE_LIMIT_BYTES + 1);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("image too large to view: 3932161 bytes (limit 3932160)");
    expect(Object.hasOwn(result, "images")).toBe(false);
  });

  test("AC-12 accepts a file exactly at the image limit", async () => {
    const path = join(root, "at-limit.png");
    const header = pngHeader(100, 50);
    writeFileSync(path, Uint8Array.from([...header, ...new Array(IMAGE_LIMIT_BYTES - header.length).fill(0x00)]));

    const result = await readTool.run({ path: "at-limit.png" }, ctx([path]));

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(statSync(path).size).toBe(IMAGE_LIMIT_BYTES);
  });

  test("AC-13 refuses an image read with offset", async () => {
    const path = writeBytes("shot.png", pngHeader(100, 50));

    const result = await readTool.run({ path: "shot.png", offset: 1 }, ctx([path]));

    expect(result.isError).toBe(true);
    expect(result.content).toBe('offset/limit apply to text files; "shot.png" is an image/png image');
  });

  test("AC-14 refuses an image read with limit", async () => {
    const path = writeBytes("shot.png", pngHeader(100, 50));

    const result = await readTool.run({ path: "shot.png", limit: 10 }, ctx([path]));

    expect(result.isError).toBe(true);
    expect(result.content).toBe('offset/limit apply to text files; "shot.png" is an image/png image');
  });

  test("AC-15 rejects an unsupported range alias before the image branch runs", async () => {
    const path = writeBytes("shot.png", pngHeader(100, 50));

    const result = await readTool.run({ path: "shot.png", start_line: 1 }, ctx([path]));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"start_line" is not a supported Read argument');
    expect(result.content).not.toContain("offset/limit apply to text files");
  });

  test("AC-19 keeps neither dimension when the PNG header declares width 0", async () => {
    const path = writeBytes("zero.png", pngHeader(0, 50));
    const size = statSync(path).size;

    const result = await readTool.run({ path: "zero.png" }, ctx([path]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`[image: image/png, ${size} bytes]`);
    expect(Object.hasOwn(result.images?.[0] ?? {}, "width")).toBe(false);
    expect(Object.hasOwn(result.images?.[0] ?? {}, "height")).toBe(false);
  });

  test("AC-20 the image branch ignores ctx.maxFileBytes", async () => {
    const path = join(root, "wide.png");
    const header = pngHeader(100, 50);
    writeFileSync(path, Uint8Array.from([...header, ...new Array(2_500_000 - header.length).fill(0x00)]));

    const result = await readTool.run({ path: "wide.png" }, ctx([path], { maxFileBytes: 2_000_000 }));

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.width).toBe(100);
  });

  test("AC-22 the coding-tool runtime carries the image onto an ok outcome", async () => {
    const dir = makeTestDir("nax-read-image-runtime-");
    writeFileSync(join(dir, "shot.png"), Uint8Array.from(pngHeader(100, 50)));
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], dir),
      maxBytes: 40_000,
    });

    const outcome = await runtime.callTool("Read", { path: "shot.png" });

    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" ? outcome.images?.length : 0).toBe(1);
    expect(outcome.kind === "ok" ? outcome.images?.[0]?.mimeType : undefined).toBe("image/png");
  });
});

describe("readTool — non-regular files keep the READ_NOT_REGULAR_FILE message", () => {
  test("AC-16 a directory is reported as not a regular file", async () => {
    const dir = makeTestDir("nax-read-image-dir-");
    const nested = join(dir, "adir");
    mkdirSync(nested);

    const result = await readTool.run({ path: "adir" }, { ...ctx([nested]), root: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(`"${nested}" is not a regular file`);
  });

  test("AC-16 readImageResult resolves the refusal instead of throwing it", async () => {
    const dir = makeTestDir("nax-read-image-dir-");
    const nested = join(dir, "adir");
    mkdirSync(nested);

    const result = await readImageResult(nested, { path: "adir" }, false, false);

    expect(result).toEqual({ content: `"${nested}" is not a regular file`, isError: true });
  });

  test.skipIf(!hasMkfifo)(
    "AC-17 a FIFO is reported as not a regular file without blocking",
    async () => {
      const dir = makeTestDir("nax-read-image-fifo-");
      const fifo = join(dir, "pipe");
      execFileSync("mkfifo", [fifo]);

      const result = await readTool.run({ path: "pipe" }, { ...ctx([fifo]), root: dir });

      expect(result.isError).toBe(true);
      expect(result.content).toBe(`"${fifo}" is not a regular file`);
    },
    5_000,
  );

  test.skipIf(!hasMkfifo)(
    "AC-17 readImageResult resolves the FIFO refusal instead of throwing it",
    async () => {
      const dir = makeTestDir("nax-read-image-fifo-");
      const fifo = join(dir, "pipe");
      execFileSync("mkfifo", [fifo]);

      const result = await readImageResult(fifo, { path: "pipe" }, false, false);

      expect(result).toEqual({ content: `"${fifo}" is not a regular file`, isError: true });
    },
    5_000,
  );
});

describe("readTool — description", () => {
  test("AC-18 names the image formats immediately before the closing cap sentence", () => {
    expect(readTool.description).toContain(
      "PNG, JPEG, GIF and WebP files are returned as images. Output is capped at 1000 lines or 40000 bytes.",
    );
    expect(readTool.description.endsWith("Output is capped at 1000 lines or 40000 bytes.")).toBe(true);
    expect(readTool.description.startsWith("Read a UTF-8 text file from the repository.")).toBe(true);
  });
});

/**
 * The header, the size check and the body all come from ONE open handle, so a
 * path replaced between two opens can no longer hand back a body the header did
 * not describe. A fake handle is the only deterministic way to drive that: the
 * real filesystem refuses to swap a file mid-read.
 */
describe("readTool — the body must be the file the header described", () => {
  const realOpen = _boundedIoDeps.open;

  afterEach(() => {
    _boundedIoDeps.open = realOpen;
  });

  /** A handle over `source`, reporting `size` and never serving past `readable` bytes. */
  function fakeHandle(source: Uint8Array, overrides: { size?: number; readable?: number } = {}): BoundedHandle {
    const readable = overrides.readable ?? source.length;
    return {
      stat: async () => ({ size: overrides.size ?? source.length, isFile: () => true }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const available = Math.max(0, Math.min(readable - position, length));
        buffer.set(source.subarray(position, position + available), offset);
        return { bytesRead: available };
      },
      close: async () => {},
    };
  }

  /** Serves `first` for the header read and `next` for every read after it. */
  function switchingHandle(first: Uint8Array, next: Uint8Array, size: number): BoundedHandle {
    let calls = 0;
    return {
      stat: async () => ({ size, isFile: () => true }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        calls += 1;
        const source = calls === 1 ? first : next;
        const available = Math.max(0, Math.min(source.length - position, length));
        buffer.set(source.subarray(position, position + available), offset);
        return { bytesRead: available };
      },
      close: async () => {},
    };
  }

  test("a file that shrank after the header read is an error, not a truncated image", async () => {
    const png = Uint8Array.from(pngHeader(100, 50));
    _boundedIoDeps.open = async () => fakeHandle(png, { size: 4096, readable: png.length });

    const result = await readImageResult("/fake/shot.png", { path: "shot.png" }, false, false);

    expect(result).toEqual({
      content: '"shot.png" changed while it was being read; run Read again',
      isError: true,
    });
    expect(result !== undefined && Object.hasOwn(result, "images")).toBe(false);
  });

  test("bytes that are no longer the header's format are an error, not the old MIME type", async () => {
    const header = Uint8Array.from(pngHeader(100, 50));
    const replacement = new TextEncoder().encode("x".repeat(header.length));
    _boundedIoDeps.open = async () => switchingHandle(header, replacement, header.length);

    const result = await readImageResult("/fake/shot.png", { path: "shot.png" }, false, false);

    expect(result).toEqual({
      content: '"shot.png" changed while it was being read; run Read again',
      isError: true,
    });
  });

  test("a file that grew after the header read is an error, not a truncated image", async () => {
    const png = Uint8Array.from(pngHeader(100, 50));
    // The open's stat answers the size the header was sniffed against; every
    // later stat shows the file grew, so reading exactly `file.size` bytes hands
    // back a truncated image unless the growth is noticed.
    let stats = 0;
    _boundedIoDeps.open = async () => ({
      stat: async () => {
        stats += 1;
        return { size: stats === 1 ? png.length : png.length + 1_024, isFile: () => true };
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const available = Math.max(0, Math.min(png.length - position, length));
        buffer.set(png.subarray(position, position + available), offset);
        return { bytesRead: available };
      },
      close: async () => {},
    });

    const result = await readImageResult("/fake/shot.png", { path: "shot.png" }, false, false);

    expect(result).toEqual({
      content: '"shot.png" changed while it was being read; run Read again',
      isError: true,
    });
    expect(result !== undefined && Object.hasOwn(result, "images")).toBe(false);
  });

  test("a rejected close after a good read resolves to an error result with no image", async () => {
    const png = Uint8Array.from(pngHeader(100, 50));
    _boundedIoDeps.open = async () => ({
      ...fakeHandle(png),
      close: async () => Promise.reject(new Error("close failed")),
    });

    const result = await readImageResult("/fake/shot.png", { path: "shot.png" }, false, false);

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("close failed");
    expect(result !== undefined && Object.hasOwn(result, "images")).toBe(false);
  });

  test("a rejected close does not replace the primary read error", async () => {
    const png = Uint8Array.from(pngHeader(100, 50));
    _boundedIoDeps.open = async () => ({
      ...fakeHandle(png, { size: 4096, readable: png.length }),
      close: async () => Promise.reject(new Error("close failed")),
    });

    const result = await readImageResult("/fake/shot.png", { path: "shot.png" }, false, false);

    expect(result).toEqual({
      content: '"shot.png" changed while it was being read; run Read again',
      isError: true,
    });
  });

  test("a rejected close on a non-image resolves to an error result rather than rejecting", async () => {
    const text = new TextEncoder().encode("hello");
    _boundedIoDeps.open = async () => ({
      ...fakeHandle(text),
      close: async () => Promise.reject(new Error("close failed")),
    });

    const result = await readImageResult("/fake/notes.png", { path: "notes.png" }, false, false);

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("close failed");
  });

  test("a short body read is retried until the file's size is reached", async () => {
    const png = Uint8Array.from([...pngHeader(100, 50), 0x00, 0x01, 0x02]);
    // A handle that answers one byte at a time: POSIX allows this, and a single
    // `read` call would otherwise base64-encode a fragment as a whole image.
    _boundedIoDeps.open = async () => ({
      stat: async () => ({ size: png.length, isFile: () => true }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const available = Math.max(0, Math.min(1, length));
        buffer.set(png.subarray(position, position + available), offset);
        return { bytesRead: available };
      },
      close: async () => {},
    });

    const result = await readImageResult("/fake/shot.png", { path: "shot.png" }, false, false);

    expect(result?.isError).toBeUndefined();
    expect(result?.images?.[0]?.data).toBe(Buffer.from(png).toString("base64"));
    expect(result?.content).toBe(`[image: image/png 100x50, ${png.length} bytes]`);
  });
});
