/**
 * Pasted image paths, in isolation: what a pasted chunk has to look like to be attached
 * rather than typed. The parser never touches the filesystem — whether the path exists and
 * is really an image is decided by reading it — so every case here is a pure string.
 */
import { describe, expect, test } from "bun:test";
import { pastedImagePath } from "@/tui/chat/pasted-path";

/** The working directory every case resolves against. */
const CWD = "/repo";

describe("pastedImagePath", () => {
  test("AC-1 returns an absolute image path as it is", () => {
    expect(pastedImagePath("/Users/me/Desktop/shot.png", CWD)).toBe("/Users/me/Desktop/shot.png");
  });

  test("AC-2 trims the surrounding whitespace and accepts an upper-case extension", () => {
    expect(pastedImagePath("  /tmp/a.PNG \n", CWD)).toBe("/tmp/a.PNG");
  });

  test("AC-3 drops one pair of matching quotes, single or double", () => {
    expect(pastedImagePath("'/tmp/my shot.png'", CWD)).toBe("/tmp/my shot.png");
    expect(pastedImagePath('"/tmp/my shot.png"', CWD)).toBe("/tmp/my shot.png");
  });

  test("AC-4 unescapes a backslash-escaped space", () => {
    expect(pastedImagePath("/tmp/my\\ shot.png", CWD)).toBe("/tmp/my shot.png");
  });

  test("AC-5 decodes a file URL into its pathname", () => {
    expect(pastedImagePath("file:///tmp/my%20shot.jpg", CWD)).toBe("/tmp/my shot.jpg");
  });

  test("AC-6 resolves a relative path against the working directory", () => {
    expect(pastedImagePath("shots/a.webp", CWD)).toBe("/repo/shots/a.webp");
  });

  test.each([
    ["a non-image extension", "/tmp/a.txt"],
    ["words with no extension", "hello world"],
    ["an empty chunk", ""],
    ["nothing but whitespace", "   \n"],
  ])("AC-7 returns undefined for %s", (_case, chunk) => {
    expect(pastedImagePath(chunk, CWD)).toBeUndefined();
  });

  test("AC-8 returns undefined for a chunk holding a newline", () => {
    expect(pastedImagePath("/tmp/a.png\n/tmp/b.png", CWD)).toBeUndefined();
  });

  test("AC-9 returns undefined for a file URL it cannot decode, without throwing", () => {
    expect(pastedImagePath("file:///tmp/%zz.png", CWD)).toBeUndefined();
    expect(pastedImagePath("file://", CWD)).toBeUndefined();
  });

  test.each([".png", ".jpg", ".jpeg", ".gif", ".webp"])("AC-10 accepts the %s extension", (extension) => {
    expect(pastedImagePath(`/tmp/a${extension}`, CWD)).toBe(`/tmp/a${extension}`);
  });

  test("AC-10 returns undefined for an extension nax cannot read", () => {
    expect(pastedImagePath("/tmp/a.bmp", CWD)).toBeUndefined();
  });
});
