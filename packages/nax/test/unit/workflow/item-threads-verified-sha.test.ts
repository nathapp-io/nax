/**
 * US-011 (branch-review-coverage): a `verified` ruling may name the head it was made at, so a later
 * reader can tell which commit the approval covered. The echo grammar gains `verified in <sha7>`;
 * `fixed` keeps its required sha, and every other disposition still rejects one.
 */
import { describe, expect, test } from "bun:test";
import { withNaxBotMarker } from "@/forge";
import { parseRulingEcho, renderRulingEcho } from "@/workflow/item-threads";

const key = "w-B3.12345678";
const head = "abcdef1234567890abcdef1234567890abcdef12";
const short = head.slice(0, 7);
const verified = { itemKey: key, itemId: "B3", disposition: "verified", reason: "read all", by: "alice" } as const;
const echoOf = (recorded: string, author = "By @alice") =>
  `${recorded}\n${author}\nTo change it, reply on this thread.`;

describe("renderRulingEcho: verified carries the head (US-011)", () => {
  test("AC-1 renders the abbreviated head in a verified echo", () => {
    expect(renderRulingEcho({ ...verified, sha: head }).split("\n")[0]).toBe(
      `Recorded: verified in ${short} — read all`,
    );
  });

  test("AC-2 a verified ruling with no sha renders without one", () => {
    expect(renderRulingEcho(verified).split("\n")[0]).toBe("Recorded: verified — read all");
  });

  test("AC-1 a seven-character sha is already abbreviated", () => {
    expect(renderRulingEcho({ ...verified, sha: "abc1234" }).split("\n")[0]).toBe(
      "Recorded: verified in abc1234 — read all",
    );
  });

  test("AC-1 a verified echo round trips its head through parseRulingEcho", () => {
    // The echo carries the abbreviation, so a reader recovers the short sha, exactly as for `fixed`.
    const value = { ...verified, sha: head };
    expect(
      parseRulingEcho(`wr-verified-${key}`, withNaxBotMarker(renderRulingEcho(value), `wr-verified-${key}`)),
    ).toEqual({ ...value, sha: short });
  });

  test("AC-2 an unstamped verified echo round trips as sha-less", () => {
    const parsed = parseRulingEcho(`wr-verified-${key}`, renderRulingEcho(verified));
    expect(parsed).toMatchObject({ disposition: "verified", reason: "read all" });
    expect(parsed).not.toHaveProperty("sha");
  });

  test("fixed keeps its required sha and abbreviation", () => {
    expect(renderRulingEcho({ ...verified, disposition: "fixed", sha: head }).split("\n")[0]).toBe(
      `Recorded: fixed in ${short} — read all`,
    );
    expect(() => renderRulingEcho({ ...verified, disposition: "fixed" })).toThrow();
  });

  test.each(["waived", "confirmed", "overridden"] as const)("a %s ruling never renders a sha", (disposition) => {
    expect(renderRulingEcho({ ...verified, disposition, sha: head }).split("\n")[0]).toBe(
      `Recorded: ${disposition} — read all`,
    );
  });
});

describe("parseRulingEcho: verified sha grammar (US-011)", () => {
  test("AC-3 reads a verified ruling's head", () => {
    expect(parseRulingEcho(`wr-verified-${key}`, echoOf("Recorded: verified in abc1234 — read all"))).toMatchObject({
      itemKey: key,
      itemId: "B3",
      disposition: "verified",
      sha: "abc1234",
      reason: "read all",
      by: "alice",
    });
  });

  test("AC-4 accepts a legacy verified echo with no head", () => {
    const parsed = parseRulingEcho(`wr-verified-${key}`, echoOf("Recorded: verified — read all"));
    expect(parsed).toMatchObject({ disposition: "verified", reason: "read all" });
    expect(parsed).not.toHaveProperty("sha");
  });

  test("AC-5 rejects a sha on any other disposition", () => {
    expect(parseRulingEcho(`wr-waived-${key}`, echoOf("Recorded: waived in abc1234 — x"))).toBeNull();
    expect(parseRulingEcho(`wr-confirmed-${key}`, echoOf("Recorded: confirmed in abc1234 — x"))).toBeNull();
    expect(parseRulingEcho(`wr-overridden-${key}`, echoOf("Recorded: overridden in abc1234 — x"))).toBeNull();
  });

  test("AC-6 still requires a sha for a fixed echo", () => {
    expect(parseRulingEcho(`wr-fixed-${key}`, echoOf("Recorded: fixed — x"))).toBeNull();
    expect(parseRulingEcho(`wr-fixed-${key}`, echoOf("Recorded: fixed in abc1234 — gone"))).toMatchObject({
      disposition: "fixed",
      sha: "abc1234",
    });
  });

  test("a malformed verified head is not a ruling", () => {
    expect(parseRulingEcho(`wr-verified-${key}`, echoOf("Recorded: verified in abc — read all"))).toBeNull();
    expect(parseRulingEcho(`wr-verified-${key}`, echoOf("Recorded: verified in xyz1234 — read all"))).toBeNull();
  });

  test("a verified head does not make the echo unreadable for a bot attribution", () => {
    expect(
      parseRulingEcho(`wr-verified-${key}`, echoOf("Recorded: verified in abc1234 — read all", "By nax bot")),
    ).toMatchObject({ disposition: "verified", sha: "abc1234", by: null });
  });
});
