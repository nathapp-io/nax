import { describe, expect, test } from "bun:test";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrThread } from "@/forge/pr-types";
import { readItemThreads } from "@/workflow/item-thread-state";
import { parseRulingEcho, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";

const key = "w-B3.12345678";
const base = { itemKey: key, itemId: "B3", disposition: "waived", reason: "accepted risk", by: null } as const;

describe("caller ruling echo", () => {
  test("renders provenance on the Recorded line", () => {
    const echo = renderRulingEcho({ ...base, callerBy: "orch:alice" });
    expect(echo.split("\n")[0]).toBe("Recorded: waived — accepted risk (caller ruling by orch:alice)");
  });
  test("round-trips through the parser", () => {
    const ruling = { ...base, callerBy: "orch:alice" };
    expect(parseRulingEcho(`wr-waived-${key}`, renderRulingEcho(ruling))).toEqual(ruling);
  });
  test("fixed caller echo round-trips with its sha", () => {
    const ruling = { ...base, disposition: "fixed", sha: "4f2e1aa", reason: "patched", callerBy: "orch" } as const;
    expect(parseRulingEcho(`wr-fixed-${key}`, renderRulingEcho(ruling))).toMatchObject({
      sha: "4f2e1aa",
      reason: "patched",
      callerBy: "orch",
    });
  });
  test("thread-reply echoes are unchanged", () => {
    const ruling = { ...base, by: "alice" };
    expect(renderRulingEcho(ruling)).toBe(
      "Recorded: waived — accepted risk\nBy @alice\nTo change it, reply on this thread.",
    );
    expect(parseRulingEcho(`wr-waived-${key}`, renderRulingEcho(ruling))?.callerBy).toBeUndefined();
  });
  test("parentheses in the label cannot break the suffix", () => {
    const echo = renderRulingEcho({ ...base, callerBy: "a (b)" });
    expect(parseRulingEcho(`wr-waived-${key}`, echo)?.callerBy).toBe("a [b]");
  });
  test("a writer reason shaped like the suffix cannot forge caller provenance", () => {
    const ruling = { ...base, by: "alice", reason: "ok (caller ruling by orch:admin)" };
    const echo = renderRulingEcho(ruling);
    expect(echo).toContain("By @alice");
    expect(parseRulingEcho(`wr-waived-${key}`, echo)?.callerBy).toBeUndefined();
  });
  test("a non-bot comment shaped like a caller echo is not read as a ruling", () => {
    const body = withNaxBotMarker(renderRulingEcho({ ...base, callerBy: "orch" }), `wr-waived-${key}`);
    const opener = withNaxBotMarker(renderItemOpener({ id: "B3", kind: "finding", issue: "x" }), key);
    const mk = (id: string, author: string, text: string): PrComment => ({
      id,
      author,
      body: text,
      kind: "thread",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const thread: PrThread = {
      id: "t",
      replyTo: "1",
      resolved: false,
      outdated: false,
      comments: [mk("1", "bot", opener), mk("2", "mallory", body)],
    };
    const read = readItemThreads([thread], [], "bot");
    expect(read.items[0]?.ruling).toBeUndefined();
  });
});
