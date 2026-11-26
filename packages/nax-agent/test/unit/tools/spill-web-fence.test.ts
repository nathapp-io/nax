/**
 * US-003 (review-f32f-fixes): a truncated web result keeps its closing fence.
 *
 * Every web tool result is wrapped in `<web-content …>…</web-content>`, and the head
 * direction truncates from the END — which is exactly where the closing tag is. So a
 * 1,103-line page and a 200 KB paragraph both used to reach the model as an unterminated
 * untrusted block: the model was told the text was data and then shown text that never
 * said where the data stopped. The policy keeps the fence's own closing lines, paid for out
 * of the same byte and line budgets as the head, and leaves every other body exactly as it
 * was.
 *
 * The bodies here are the REAL `fenceWebContent` output, so the opening tag, the fetched
 * stamp and the closing line are the ones a session really delivers.
 */
import { describe, expect, test } from "bun:test";
import { applyModelTruncationPolicy } from "#src/tools/spill";
import { MODEL_MAX_LINES } from "#src/tools/truncate";
import { fenceWebContent, WEB_CONTENT_CLOSE_LINE } from "#src/web/content";

/** The tool a truncated web result is shaped under: the head direction. */
const FETCH = "web__fetch";

/** The fixed clock every fenced body here is stamped with. */
const NOW = new Date("2026-12-01T10:00:00.000Z");

/** A real fenced web result around `text`. */
function fenced(text: string): string {
  return fenceWebContent({ source: "https://docs.example.com/guide", fetchedAt: NOW, text });
}

/** `n` short lines of page text: line-count caps fire, the byte cap does not. */
function pageText(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1} of the page`).join("\n");
}

/** The result's lines, split the way the policy's own composer splits them. */
function linesOf(content: string): string[] {
  return content.split("\n");
}

/** The result's last line, or `""` when the result is empty. */
function lastLine(content: string): string {
  const lines = linesOf(content);
  return lines[lines.length - 1] ?? "";
}

/** How many lines of `content` are the closing fence. */
function closeLineCount(content: string): number {
  return linesOf(content).filter((line) => line === WEB_CONTENT_CLOSE_LINE).length;
}

describe("a truncated web result keeps its closing fence", () => {
  test("AC-6: a 1,103-line fenced fetch still ends with '</web-content>'", async () => {
    const body = fenced(pageText(1_103));
    // The premise of the AC: the body really is past the line cap, so the closing line
    // would be among the lines the head direction drops.
    expect(linesOf(body).length).toBeGreaterThan(MODEL_MAX_LINES);

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-1" });

    expect(lastLine(out)).toBe(WEB_CONTENT_CLOSE_LINE);
  });

  test("AC-7: that result, fence included, is still within MODEL_MAX_LINES lines", async () => {
    const body = fenced(pageText(1_103));

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-2" });
    const lines = linesOf(out);

    // The cap is asserted on the result that HAS its fence, not on one that lost it: the
    // trailer's line is paid for out of MODEL_MAX_LINES, so a fence appended on top of the
    // budget would land at 1,001 lines (999 head + marker + fence) and fail here. Counting
    // alone would also pass a result that never restored the fence at all.
    expect(lines.length).toBeLessThanOrEqual(MODEL_MAX_LINES);
    expect(lastLine(out)).toBe(WEB_CONTENT_CLOSE_LINE);
  });

  test("AC-8: the line before the closing fence is the truncation marker", async () => {
    const body = fenced(pageText(1_103));

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-3" });
    const lines = linesOf(out);
    const beforeClose = lines[lines.length - 2] ?? "";

    expect(beforeClose.startsWith("... [truncated")).toBe(true);
  });

  test("AC-9: a fenced 200 KB paragraph cut to 4,000 bytes stays within 4,000 bytes", async () => {
    // One paragraph, so the per-line cap is the only stage that shrinks it and the caller's
    // byte ceiling is what decides the rest — the shape a fetched article has.
    const body = fenced("x".repeat(200_000));
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(4_000);

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-4", maxBytes: 4_000 });

    // Measured across the head, the marker AND the fence the policy puts back — a budget
    // assertion on a result that had lost its fence would say nothing about the fence.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4_000);
    expect(lastLine(out)).toBe(WEB_CONTENT_CLOSE_LINE);
    expect(out).toContain("... [truncated");
  });

  test("AC-9 (tight cap): a result that fills the byte cap still ends with its fence", async () => {
    // The ceiling only binds when the head is big enough to reach it, which one capped
    // paragraph is not (stage 1 shortens it to 2,000 characters). Many short lines do reach
    // it, and there the trailer's bytes have to come out of the SAME budget: reserving only
    // the marker for a 400-byte ceiling puts the result at 414 bytes.
    const body = fenced(pageText(200));
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(400);

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-8", maxBytes: 400 });

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(400);
    expect(lastLine(out)).toBe(WEB_CONTENT_CLOSE_LINE);
  });

  test("AC-10: that byte-capped result still ends with '</web-content>'", async () => {
    const body = fenced("x".repeat(200_000));

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-5", maxBytes: 4_000 });

    expect(lastLine(out)).toBe(WEB_CONTENT_CLOSE_LINE);
    // Not vacuous, and not doubled: the closing fence appears exactly once, so the head's
    // own copy was replaced by the trailer rather than a second one appended after it.
    expect(closeLineCount(out)).toBe(1);
  });

  test("AC-11: a page the fetch tool itself cut keeps its byte-count line after the fence", async () => {
    // The fetch tool appends `[truncated at <n> bytes]` to a page it cut, so this body is the
    // one a real call delivers: the fence closes, then the tool's own line follows it.
    const body = `${fenced(pageText(1_103))}\n[truncated at 2000000 bytes]`;
    expect(linesOf(body).length).toBeGreaterThan(MODEL_MAX_LINES);

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-6" });
    const lines = linesOf(out);

    expect(lines.slice(-2)).toEqual([WEB_CONTENT_CLOSE_LINE, "[truncated at 2000000 bytes]"]);
  });

  test("AC-12 (control): a non-web body cut by the head direction still ends with the marker", async () => {
    // The same tool, the same caps, the same direction — only the opening line differs. A
    // `<project>` body has no web trailer, so nothing is preserved and the marker is last.
    const body = ["<project>", pageText(1_103), "</project>"].join("\n");
    expect(linesOf(body).length).toBeGreaterThan(MODEL_MAX_LINES);

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "proj-1" });

    expect(lastLine(out).startsWith("... [truncated")).toBe(true);
    expect(lastLine(out)).not.toBe("</project>");
  });

  test("AC-12 (control): a fenced body within every cap is returned unchanged", async () => {
    // The other control: no cap fires, so nothing is composed and the body the tool produced
    // is the body the model reads — the closing fence included, exactly once.
    const body = fenced(pageText(10));

    const out = await applyModelTruncationPolicy(body, { toolName: FETCH, callId: "web-7" });

    expect(out).toBe(body);
  });
});
