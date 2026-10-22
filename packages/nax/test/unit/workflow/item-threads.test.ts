import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { withNaxBotMarker } from "@/forge";
import type { OpenItem } from "@/workflow/types";

const formats = () => import("@/workflow/item-threads");
const item = { id: "B3", kind: "finding", severity: "important", issue: "x" } satisfies OpenItem;
const key = "w-B3.12345678";
const head = "a".repeat(40);
const base = "b".repeat(40);
const ruling = { itemKey: key, itemId: "B3", disposition: "waived", reason: "ok", by: "alice" } as const;
const echo = "Recorded: waived — ok\nBy @alice\nTo change it, reply on this thread.";
describe("itemKey", () => {
  test("AC-1 hashes kind and issue", async () => {
    expect((await formats()).itemKey({ id: "_run:cv1", kind: "cannot-verify", issue: "x" })).toBe(
      `w-_run:cv1.${createHash("sha256").update("cannot-verify\nx").digest("hex").slice(0, 8)}`,
    );
  });
  test("AC-2 changes with issue text", async () => {
    const { itemKey } = await formats();
    expect(itemKey(item)).not.toBe(itemKey({ ...item, issue: "y" }));
  });
});
describe("isPostable", () => {
  test("AC-3 rejects spaces", async () => {
    expect((await formats()).isPostable({ ...item, id: "bad id" })).toBe(false);
  });
  test("AC-4 reserves longest ask key", async () => {
    const { isPostable } = await formats();
    expect(isPostable({ ...item, id: "a".repeat(94) })).toBe(false);
    expect(isPostable({ ...item, id: "a".repeat(93) })).toBe(true);
    expect(isPostable({ ...item, id: "bad\n" })).toBe(false);
    expect(isPostable({ ...item, id: "" })).toBe(false);
  });
});
describe("renderItemOpener", () => {
  test("AC-5 renders first line", async () => {
    expect((await formats()).renderItemOpener(item).split("\n")[0]).toBe("Open item **B3** (finding): x");
  });
  test("AC-6 ends with instructions", async () => {
    expect(
      (await formats())
        .renderItemOpener(item)
        .endsWith(
          "Rule on it by replying: fixed <sha>, waive: <reason>, confirm, override: <reason>, or verified. Any other reply from a collaborator is read as a ruling only when its meaning is clear.",
        ),
    ).toBe(true);
  });
  test("AC-7 renders suggestion", async () => {
    expect((await formats()).renderItemOpener({ ...item, suggestion: "try this" })).toContain(
      "\nSuggestion: try this\n",
    );
  });
  test("AC-8 renders advisor", async () => {
    expect((await formats()).renderItemOpener({ ...item, ruling: { action: "waive", why: "acceptable" } })).toContain(
      "\nAdvisor: waive — acceptable\n",
    );
  });
  test("neutralises untrusted text", async () => {
    const body = (await formats()).renderItemOpener({ ...item, issue: "x\n@alice #123 <!-- injected -->" });
    expect(body).not.toContain("<!-- injected -->");
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("#123");
    expect(body.split("\n")).toHaveLength(2);
  });
});
describe("parseItemOpener", () => {
  test("AC-9 recovers identity", async () => {
    const { parseItemOpener, renderItemOpener, itemKey } = await formats();
    expect(parseItemOpener(renderItemOpener(item))).toEqual({ id: "B3", kind: "finding", issue: item.issue });
    expect(parseItemOpener(withNaxBotMarker(renderItemOpener(item), itemKey(item)))).toEqual({
      id: "B3",
      kind: "finding",
      issue: item.issue,
    });
    expect(parseItemOpener("Open item **B3** (unknown): x")).toBeNull();
  });
});
describe("renderRulingEcho", () => {
  test("AC-10 renders collaborator echo", async () => {
    expect((await formats()).renderRulingEcho(ruling)).toBe(echo);
  });
  test("shortens fixed sha", async () => {
    expect((await formats()).renderRulingEcho({ ...ruling, disposition: "fixed", sha: head, by: null })).toBe(
      "Recorded: fixed in aaaaaaa — ok\nBy nax bot\nTo change it, reply on this thread.",
    );
  });
});
describe("parseRulingEcho", () => {
  test("AC-11 recovers ruling", async () => {
    expect((await formats()).parseRulingEcho(`wr-waived-${key}`, echo)).toEqual(ruling);
  });
  test("AC-12 reads fixed sha", async () => {
    expect(
      (await formats()).parseRulingEcho(
        `wr-fixed-${key}`,
        "Recorded: fixed in abc1234 — gone\nBy @alice\nTo change it, reply on this thread.",
      ),
    ).toEqual({ ...ruling, disposition: "fixed", sha: "abc1234", reason: "gone" });
  });
  test("AC-13 reads bot attribution", async () => {
    const { parseRulingEcho, renderRulingEcho } = await formats();
    expect(
      parseRulingEcho(
        `wr-waived-${key}`,
        withNaxBotMarker(renderRulingEcho({ ...ruling, by: null }), `wr-waived-${key}`),
      ),
    ).toEqual({ ...ruling, by: null });
  });
  test.each(["wr-fixed-w-B3.12345678", "wr-unknown-w-B3.12345678", "wr-waived-bad"])(
    "rejects malformed key or mismatched echo %s",
    async (echoKey) => {
      expect((await formats()).parseRulingEcho(echoKey, echo)).toBeNull();
    },
  );
});
describe("askKey", () => {
  test("AC-14 derives reply key", async () => {
    expect((await formats()).askKey(key, "99")).toBe(`wq-${key}-99`);
  });
});
describe("renderRulingAsk", () => {
  test("renders clarification", async () => {
    expect((await formats()).renderRulingAsk()).toBe(
      "I could not read a ruling from that reply. Start a reply with fixed <sha>, waive: <reason>, confirm, override: <reason> or verified.",
    );
  });
});
describe("closed formats", () => {
  test("renders closure without a ruling", async () => {
    const { closedKey, renderItemClosed } = await formats();
    expect(closedKey(key)).toBe(`wc-${key}`);
    expect(renderItemClosed(head)).toBe("No longer open in the run at aaaaaaa.");
  });
});
describe("renderItemIndex", () => {
  test("AC-15 renders ordered index", async () => {
    expect(
      (await formats()).renderItemIndex({ reviewedHead: head, reviewedBase: base, keys: [key, "w-other.abcdef12"] }),
    ).toBe(`nax workflow open items: 2\nReviewed head: ${head}\nReviewed base: ${base}\n- ${key}\n- w-other.abcdef12`);
  });
  test("retains unpostable keys and omits base without head", async () => {
    expect((await formats()).renderItemIndex({ reviewedBase: base, keys: ["w-bad id.12345678"] })).toBe(
      "nax workflow open items: 1\nReviewed head: none\n- w-bad id.12345678",
    );
  });
});
describe("parseItemIndex", () => {
  test("AC-16 round trips raw and marked indices", async () => {
    const { parseItemIndex, renderItemIndex } = await formats();
    const index = { reviewedHead: head, reviewedBase: base, keys: [key, "w-bad id.12345678"] };
    expect(parseItemIndex(renderItemIndex(index))).toEqual(index);
    expect(parseItemIndex(withNaxBotMarker(renderItemIndex(index), "w-index"))).toEqual(index);
  });
  test("AC-17 leaves none head absent", async () => {
    expect((await formats()).parseItemIndex("nax workflow open items: 0\nReviewed head: none")).toEqual({ keys: [] });
  });
  test("AC-18 leaves invalid sha absent", async () => {
    expect(
      (await formats()).parseItemIndex(`nax workflow open items: 0\nReviewed head: abc1234\nReviewed base: ${base}`),
    ).toEqual({ keys: [] });
  });
  test("rejects incomplete indices", async () => {
    expect(
      (await formats()).parseItemIndex("nax workflow open items: 2\nReviewed head: none\n- w-B3.12345678"),
    ).toBeNull();
    expect((await formats()).parseItemIndex("unrelated")).toBeNull();
  });
});

test("fixed echoes require a durable SHA", async () => {
  const { renderRulingEcho } = await formats();
  expect(() => renderRulingEcho({ ...ruling, disposition: "fixed" })).toThrow();
});

test("GitLab dotted logins round-trip", async () => {
  const f = await formats();
  const value = { ...ruling, by: "john.doe" };
  expect(f.parseRulingEcho(`wr-waived-${key}`, f.renderRulingEcho(value))).toEqual(value);
});
