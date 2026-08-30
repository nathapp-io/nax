import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_JSONL_TAIL_BYTES, readJsonlTail } from "@/utils/jsonl-tail";

describe("readJsonlTail", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-jsonl-tail-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("returns the whole file when it is at or under maxBytes", async () => {
    const path = join(tempDir, "scratch.jsonl");
    const content = '{"a":1}\n{"b":2}\n';
    await Bun.write(path, content);

    expect(await readJsonlTail(path, 1_000)).toBe(content);
  });

  test("DEFAULT_JSONL_TAIL_BYTES is generous enough for the default window", async () => {
    const path = join(tempDir, "small.jsonl");
    const content = '{"a":1}\n';
    await Bun.write(path, content);

    expect(await readJsonlTail(path)).toBe(content);
    expect(DEFAULT_JSONL_TAIL_BYTES).toBeGreaterThan(content.length);
  });

  test("returns only the tail window and drops a torn first line", async () => {
    const path = join(tempDir, "big.jsonl");
    // Three fixed-width lines so a small maxBytes window is guaranteed to
    // land inside the middle line, tearing it.
    const lines = ['{"line":"AAAAAAAAAA"}', '{"line":"BBBBBBBBBB"}', '{"line":"CCCCCCCCCC"}'];
    const content = `${lines.join("\n")}\n`;
    await Bun.write(path, content);

    // Window sized to tear into the middle of line1, so its remnant plus the
    // newline before line2 both sit inside the window ahead of the last line.
    const maxBytes = lines[2].length + 1 + 5;
    const result = await readJsonlTail(path, maxBytes);

    expect(result).toBe(`${lines[2]}\n`);
  });

  test("returns an empty string when the tail window contains no newline at all", async () => {
    const path = join(tempDir, "no-newline.jsonl");
    const content = "a".repeat(50);
    await Bun.write(path, content);

    const result = await readJsonlTail(path, 10);

    expect(result).toBe("");
  });
});
