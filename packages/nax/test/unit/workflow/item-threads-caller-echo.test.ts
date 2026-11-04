import { describe, expect, test } from "bun:test";
import { parseRulingEcho, renderRulingEcho } from "@/workflow/item-threads";

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
});
