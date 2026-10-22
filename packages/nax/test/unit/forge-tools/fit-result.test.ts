import { describe, expect, test } from "bun:test";
import { fitToolResult } from "@/forge-tools";
import { markdownFence } from "@/utils/markdown-fence";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const parts = {
  header: ["header", "count: 10"],
  entries: Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, "0")}:${"x".repeat(97)}`),
  footer: ["footer one", "footer two"],
};

describe("fitToolResult", () => {
  test("AC-10 renders header, safe fence and footer in order without truncating", () => {
    const small = { header: ["header"], entries: ["untrusted ``` text", "second"], footer: ["footer"] };
    expect(fitToolResult(small, 600, "start")).toBe(
      ["header", markdownFence(small.entries.join("\n")), "footer"].join("\n"),
    );
  });
  test.each(["start", "end"] as const)("AC-11/12/13 keeps whole entries from %s and preserves framing", (keep) => {
    const result = fitToolResult(parts, 600, keep);
    expect(bytes(result)).toBeLessThanOrEqual(600);
    expect(result).toContain(parts.entries[keep === "start" ? 0 : 9]);
    expect(result).not.toContain(parts.entries[keep === "start" ? 9 : 0]);
    expect(result).toMatch(/```\nfooter one\nfooter two\n\[truncated: \d+ entries not shown\]$/);
    const count = Number(result.match(/truncated: (\d+)/)?.[1]);
    expect(result.split("\n").filter((line) => /^\d\d:/.test(line))).toHaveLength(10 - count);
  });
  test.each(["start", "end"] as const)("AC-14 cuts oversized multibyte entry at code points (%s)", (keep) => {
    const result = fitToolResult({ header: ["h"], entries: ["界".repeat(1_000)], footer: ["f"] }, 600, keep);
    expect(bytes(result)).toBeLessThanOrEqual(600);
    expect(result).toContain("界");
    expect(result).not.toContain("�");
    expect(Buffer.from(result).toString("utf8")).toBe(result);
    expect(result).toMatch(/\n```\nf$/);
  });
  test("closes dynamically sized fences after cutting backtick-heavy entries", () => {
    const result = fitToolResult({ header: [], entries: ["`".repeat(1_000)], footer: ["footer"] }, 100, "start");
    expect(bytes(result)).toBeLessThanOrEqual(100);
    const lines = result.split("\n");
    expect(lines[0]).toBe(lines[2]);
    expect(lines[0].length).toBeGreaterThan(lines[1].length);
    expect(lines[3]).toBe("footer");
  });
});
