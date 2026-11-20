import { describe, expect, test } from "bun:test";
import {
  type CarriedEntry,
  type CarriedRecord,
  carriedRecordBody,
  carriedRecordKey,
  MAX_CARRIED_CHARS,
  MAX_CARRIED_ENTRIES,
  parseCarriedRecord,
} from "@/bot/carried-record";
import { withNaxBotMarker } from "@/forge";

const head = "a".repeat(40);
const leak: CarriedEntry = {
  key: "f-1234",
  severity: "critical",
  issue: "Token cache entries are shared across users",
  file: "src/auth/cache.ts",
  line: 41,
  suggestion: "Key the cache by user",
};
const rename: CarriedEntry = { key: "f-5678", severity: "important", issue: "Rename the collector" };

/** The record's payload as the block decoder sees it, so a case can rewrite it. */
function withPayload(body: string, encode: (payload: unknown) => string): string {
  return body.replace(
    /<!-- nax-bot:carried v1 (.*?) -->/,
    (_match, _payload) => `<!-- nax-bot:carried v1 ${encode(_payload)} -->`,
  );
}

describe("the carried findings record", () => {
  test("round trips every field of every finding", () => {
    const record: CarriedRecord = { headSha: head, findings: [leak, rename] };
    expect(parseCarriedRecord(carriedRecordBody(record).body)).toEqual(record);
  });

  test("reads back a body that carries the bot's identity marker", () => {
    const record: CarriedRecord = { headSha: head, findings: [leak] };
    const body = withNaxBotMarker(carriedRecordBody(record).body, carriedRecordKey(head));
    expect(parseCarriedRecord(body)).toEqual(record);
  });

  test("an empty record round trips, so a review with nothing to carry still records its head", () => {
    const record: CarriedRecord = { headSha: head, findings: [] };
    expect(parseCarriedRecord(carriedRecordBody(record).body)).toEqual(record);
  });

  test("rejects a body with no record block", () => {
    expect(parseCarriedRecord("Carried blocking findings at aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 0")).toBeNull();
  });

  test("rejects a payload that is not canonical base64, so damage never reads as an empty record", () => {
    const body = carriedRecordBody({ headSha: head, findings: [leak] }).body;
    expect(parseCarriedRecord(withPayload(body, () => "W10=!"))).toBeNull();
  });

  test("rejects a count that disagrees with the payload, so a truncated record is not half trusted", () => {
    const body = carriedRecordBody({ headSha: head, findings: [leak, rename] }).body;
    const tampered = body.replace(": 2", ": 1");
    expect(parseCarriedRecord(tampered)).toBeNull();
  });

  test("rejects a heading that names another head than the payload does", () => {
    const body = carriedRecordBody({ headSha: head, findings: [leak] }).body;
    expect(parseCarriedRecord(body.replace(head, "b".repeat(40)))).toBeNull();
  });

  test.each([
    ["a finding with no key", { severity: "critical", issue: "Leak" }],
    ["a finding with no issue", { key: "f-1", severity: "critical" }],
    ["a finding with an unknown severity", { key: "f-1", severity: "blocker", issue: "Leak" }],
    ["a finding that is not an object", "leak"],
  ])("rejects a record holding %s", (_label, entry) => {
    const payload = Buffer.from(JSON.stringify({ headSha: head, findings: [entry] }), "utf8").toString("base64");
    expect(
      parseCarriedRecord(`Carried blocking findings at ${head}: 1\n<!-- nax-bot:carried v1 ${payload} -->`),
    ).toBeNull();
  });

  test("keeps the leading findings that fit the entry cap and reports what it dropped", () => {
    const findings = Array.from({ length: MAX_CARRIED_ENTRIES + 3 }, (_unused, index) => ({
      key: `f-${index}`,
      severity: "critical" as const,
      issue: `Leak ${index}`,
    }));
    const { body, dropped } = carriedRecordBody({ headSha: head, findings });
    expect(dropped).toBe(3);
    expect(parseCarriedRecord(body)?.findings).toHaveLength(MAX_CARRIED_ENTRIES);
  });

  test("keeps the leading findings that fit the character budget and reports what it dropped", () => {
    const findings = Array.from({ length: 30 }, (_unused, index) => ({
      key: `f-${index}`,
      severity: "critical" as const,
      issue: `${index}${"x".repeat(5_000)}`,
    }));
    const { body, dropped } = carriedRecordBody({ headSha: head, findings });
    expect(body.length).toBeLessThanOrEqual(MAX_CARRIED_CHARS);
    expect(dropped).toBeGreaterThan(0);
    expect(parseCarriedRecord(body)?.findings).toHaveLength(30 - dropped);
  });
});
