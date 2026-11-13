/**
 * US-005: the durable CI waiver record. Marking a PR ready while a check never got a runner is
 * the only escape from a starved CI, so the reason has to survive on the PR itself. The record
 * mirrors `w-coverage` (`src/bot/coverage-record.ts`) — a heading with a declared count and one
 * code-span line per check — and adds a `Reason:` line; a body whose parts disagree reads as no
 * record at all, so `nax workflow status` never reports a waiver nobody wrote.
 */
import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import type { PrComment } from "@/forge";
import { NAX_BOT_HEADER, stripNaxBotMarkers, TOP_LEVEL_MARKER_KEYS, withNaxBotMarker } from "@/forge";
import {
  CI_WAIVER_KEY,
  CI_WAIVER_REASON_MAX,
  type CiWaiver,
  latestCiWaiver,
  parseCiWaiver,
  parseWaiverReason,
  renderCiWaiver,
} from "@/workflow/ci-waiver";

const INVALID = "CI_WAIVER_REASON_INVALID";
const HEAD = "7c98673abc0123456789abcdef0123456789abcd";
const CHECK = "nax-agent: glob (Node 22.19.0, macos-latest)";
const REASON = "runner starvation, re-run passed";
const WAIVER: CiWaiver = { headSha: HEAD, checks: [CHECK], reason: REASON };
const LOGIN = "nax-bot";
/** 43 six-letter words joined by single spaces: exactly CI_WAIVER_REASON_MAX characters. */
const MAX_REASON = Array.from({ length: 43 }, () => "reason").join(" ");

/** The code a reason is rejected with; fails the test when the reason is accepted instead. */
function rejectionCode(raw: string): string {
  try {
    parseWaiverReason(raw);
  } catch (err) {
    assertNaxError(err, "parseWaiverReason rejection");
    return err.code;
  }
  throw new Error(`parseWaiverReason accepted ${JSON.stringify(raw)}`);
}

/** One own comment carrying the waiver record, as the forge lists it. */
function ownComment(id: string, waiver: CiWaiver, createdAt = "2026-01-01T00:00:00Z"): PrComment {
  return { id, kind: "comment", author: LOGIN, body: renderCiWaiver(waiver), createdAt };
}

/** The record's own lines: the visible header is asserted, then dropped with the marker and blanks. */
function recordLines(body: string): string[] {
  const lines = stripNaxBotMarkers(body)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  expect(lines[0]).toBe(NAX_BOT_HEADER);
  return lines.slice(1);
}

describe("parseWaiverReason", () => {
  test("AC-1 returns the trimmed reason", () => {
    expect(parseWaiverReason("  runner starvation  ")).toBe("runner starvation");
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["multi-line", "a\nb"],
    ["marker-holding", "ok <!-- x -->"],
  ])("AC-2/3/4/16 rejects an %s reason", (_label, raw) => {
    expect(rejectionCode(raw)).toBe(INVALID);
  });

  test("AC-5 rejects a 301-character reason and returns a 300-character one", () => {
    expect(rejectionCode("r".repeat(CI_WAIVER_REASON_MAX + 1))).toBe(INVALID);
    const longest = "r".repeat(CI_WAIVER_REASON_MAX);
    expect(parseWaiverReason(longest)).toBe(longest);
  });
});

describe("renderCiWaiver", () => {
  test("AC-6 ends with the w-ci-waiver identity marker", () => {
    expect(renderCiWaiver(WAIVER).endsWith("<!-- nax-bot:v1 key=w-ci-waiver -->")).toBe(true);
  });

  test("AC-7 renders the heading, one check line and the Reason line in order", () => {
    expect(recordLines(renderCiWaiver(WAIVER))).toEqual([
      `CI waiver at ${HEAD}: 1 check(s) never got a runner`,
      `- \`${CHECK}\``,
      `Reason: ${REASON}`,
    ]);
  });

  test("declares one count per check line", () => {
    expect(recordLines(renderCiWaiver({ ...WAIVER, checks: [CHECK, "unit (ubuntu-latest)"] }))[0]).toBe(
      `CI waiver at ${HEAD}: 2 check(s) never got a runner`,
    );
  });
});

describe("parseCiWaiver", () => {
  test("AC-8 round-trips a marked waiver", () => {
    expect(parseCiWaiver(renderCiWaiver(WAIVER))).toEqual(WAIVER);
  });

  test("AC-9 round-trips a maximum-length reason of words", () => {
    const waiver: CiWaiver = { headSha: HEAD, checks: [CHECK], reason: MAX_REASON };
    expect(waiver.reason).toHaveLength(CI_WAIVER_REASON_MAX);
    expect(parseCiWaiver(renderCiWaiver(waiver))).toEqual(waiver);
  });

  test("AC-10 returns null when the Reason line is missing", () => {
    expect(parseCiWaiver(`CI waiver at ${HEAD}: 1 check(s) never got a runner\n- \`${CHECK}\``)).toBeNull();
  });

  test("AC-11 returns null when the declared count disagrees with the check lines", () => {
    const body = withNaxBotMarker(
      `CI waiver at ${HEAD}: 2 check(s) never got a runner\n- \`${CHECK}\`\nReason: ${REASON}`,
      CI_WAIVER_KEY,
    );
    expect(parseCiWaiver(body)).toBeNull();
  });

  test("AC-17 reads an empty check name back as (unnamed check)", () => {
    const waiver = parseCiWaiver(renderCiWaiver({ headSha: HEAD, checks: [""], reason: "r" }));
    expect(waiver?.checks).toEqual(["(unnamed check)"]);
  });

  test("returns null for a body with no heading", () => {
    expect(parseCiWaiver(withNaxBotMarker(`- \`${CHECK}\`\nReason: ${REASON}`, CI_WAIVER_KEY))).toBeNull();
  });

  test("returns null when text follows the Reason line", () => {
    const body = `CI waiver at ${HEAD}: 1 check(s) never got a runner\n- \`${CHECK}\`\nReason: ${REASON}\nedited`;
    expect(parseCiWaiver(body)).toBeNull();
  });

  test("writes a backtick inside a check name as an apostrophe", () => {
    const waiver = parseCiWaiver(renderCiWaiver({ headSha: HEAD, checks: ["a`b"], reason: "r" }));
    expect(waiver?.checks).toEqual(["a'b"]);
  });
});

describe("latestCiWaiver", () => {
  test("AC-12 reads the newest own waiver", () => {
    const newer: CiWaiver = { ...WAIVER, reason: "flaky runner" };
    const comments = [ownComment("1", WAIVER, "2026-01-01T00:00:00Z"), ownComment("2", newer, "2026-01-01T01:00:00Z")];
    expect(latestCiWaiver(comments, LOGIN)).toEqual(newer);
  });

  test("AC-13 falls back to the older own waiver when the newest does not parse", () => {
    const broken: PrComment = {
      ...ownComment("2", WAIVER, "2026-01-01T01:00:00Z"),
      body: withNaxBotMarker(`CI waiver at ${HEAD}: 1 check(s) never got a runner\n- \`${CHECK}\``, CI_WAIVER_KEY),
    };
    expect(latestCiWaiver([ownComment("1", WAIVER), broken], LOGIN)).toEqual(WAIVER);
  });

  test("AC-14 returns null when the only waiver is by another login", () => {
    const comments = [{ ...ownComment("1", WAIVER), author: "someone-else" }];
    expect(latestCiWaiver(comments, LOGIN)).toBeNull();
  });

  test("returns null when there is no waiver comment at all", () => {
    expect(
      latestCiWaiver([{ ...ownComment("1", WAIVER), body: withNaxBotMarker("body", "summary") }], LOGIN),
    ).toBeNull();
  });
});

describe("CI waiver marker key", () => {
  test("AC-15 lists w-ci-waiver last after the five existing top-level keys", () => {
    expect(TOP_LEVEL_MARKER_KEYS).toEqual([
      "summary",
      "w-index",
      "w-evidence",
      "fix-summary",
      "w-coverage",
      "w-ci-waiver",
    ]);
  });

  test("names the marker key the record is posted under", () => {
    expect(CI_WAIVER_KEY).toBe("w-ci-waiver");
  });
});
