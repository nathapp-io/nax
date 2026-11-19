import { describe, expect, test } from "bun:test";
import {
  appendPushEntry,
  type BotPushEntry,
  MAX_LEDGER_CHARS,
  MAX_PUSH_ENTRIES,
  readPushLedger,
  withPushLedger,
} from "@/bot/push-ledger";
import { parseNaxBotMarker, withNaxBotMarker } from "@/forge";

const PUSHES = "<!-- nax-bot:pushes v1 ";
const MARKER = "<!-- nax-bot:v1 key=fix-summary -->";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** The body a fix summary has when it ends with its identity marker. */
const summary = withNaxBotMarker("Pushed abcdef1: 2 agreed items fixed in one round; gates passed.", "fix-summary");

function entry(overrides: Partial<BotPushEntry> = {}): BotPushEntry {
  return {
    base: "c".repeat(40),
    sha: SHA_A,
    at: "2026-01-01T00:00:00.000Z",
    items: [{ key: "f-1", generation: 0, issue: "the claim file is never released" }],
    ...overrides,
  };
}

/** The base64 payload a hand-built block carries, so a corrupt block can be spelled directly. */
function payload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function blockIn(body: string): string | undefined {
  return body.split("\n").find((line) => line.startsWith(PUSHES));
}

describe("withPushLedger", () => {
  test("AC-1 places exactly one block immediately before the identity marker line", () => {
    const out = withPushLedger(summary, [entry()]);
    const lines = out.split("\n");
    expect(lines.filter((line) => line.startsWith(PUSHES))).toHaveLength(1);
    const markerAt = lines.indexOf(MARKER);
    expect(markerAt).toBeGreaterThan(0);
    expect(lines[markerAt - 1]?.startsWith(PUSHES)).toBe(true);
    // The visible summary the reader sees is untouched.
    expect(out).toContain("Pushed abcdef1: 2 agreed items fixed in one round; gates passed.");
  });

  test("AC-2 keeps the identity marker readable as the fix-summary key", () => {
    expect(parseNaxBotMarker(withPushLedger(summary, [entry()]))).toEqual({ key: "fix-summary" });
  });

  test("AC-4 replaces the block a body already holds, keeping only the new entries", () => {
    const first = withPushLedger(summary, [entry({ sha: SHA_A })]);
    const second = withPushLedger(first, [entry({ sha: SHA_B })]);
    expect(second.split("\n").filter((line) => line.startsWith(PUSHES))).toHaveLength(1);
    expect(readPushLedger(second).entries).toEqual([entry({ sha: SHA_B })]);
  });

  test("AC-5 writes no block for an empty entry list", () => {
    expect(blockIn(withPushLedger(summary, []))).toBeUndefined();
    expect(blockIn(withPushLedger(withPushLedger(summary, [entry()]), []))).toBeUndefined();
    expect(withPushLedger(withPushLedger(summary, [entry()]), [])).toContain("Pushed abcdef1:");
  });

  test("a body with no identity marker still receives a readable block", () => {
    const out = withPushLedger("Nothing to fix.", [entry()]);
    expect(out.startsWith("Nothing to fix.\n")).toBe(true);
    expect(readPushLedger(out)).toEqual({ entries: [entry()], unreadable: false });
  });
});

describe("readPushLedger", () => {
  test("AC-3 returns the entries withPushLedger wrote, deep-equal and readable", () => {
    const entries = [entry({ sha: SHA_A }), entry({ sha: SHA_B, items: [] })];
    expect(readPushLedger(withPushLedger(summary, entries))).toEqual({ entries, unreadable: false });
  });

  test("AC-6 reads a body with no block as an empty, readable ledger", () => {
    expect(readPushLedger(summary)).toEqual({ entries: [], unreadable: false });
  });

  test("AC-7 rejects a payload that is not base64 JSON", () => {
    const body = `${PUSHES}not-base64-json-at-all -->\n${MARKER}`;
    expect(readPushLedger(body)).toEqual({ entries: [], unreadable: true });
  });

  test("AC-8 rejects an entry whose sha is not 40 hex characters", () => {
    const body = `${PUSHES}${payload([entry({ sha: "abc123" })])} -->\n${MARKER}`;
    expect(readPushLedger(body)).toEqual({ entries: [], unreadable: true });
  });

  test.each([
    ["no base", [{ sha: SHA_A, at: "", items: [] }]],
    ["no items", [{ base: SHA_B, sha: SHA_A, at: "" }]],
    ["not an array", { entries: [] }],
  ])("a block with %s is unreadable", (_name, value) => {
    const body = `${PUSHES}${payload(value)} -->\n${MARKER}`;
    expect(readPushLedger(body)).toEqual({ entries: [], unreadable: true });
  });
});

describe("appendPushEntry", () => {
  const entries = Array.from({ length: MAX_PUSH_ENTRIES }, (_, index) => entry({ sha: `${index}`.padStart(40, "0") }));

  test("AC-9 keeps the newest entries and drops the oldest at the entry cap", () => {
    const appended = entry({ sha: "f".repeat(40) });
    const out = appendPushEntry(entries, appended);
    expect(out).toHaveLength(MAX_PUSH_ENTRIES);
    expect(out.at(-1)).toEqual(appended);
    expect(out[0]).toEqual(entries[1]);
  });

  test("AC-19 drops the oldest entries until the encoded block fits the budget", () => {
    const long = (index: number) =>
      entry({
        sha: `${index}`.padStart(40, "0"),
        items: [{ key: `f-${index}`, generation: 1, issue: "x".repeat(120) }],
      });
    const many = Array.from({ length: 120 }, (_, index) => long(index));
    const appended = entry({ sha: "f".repeat(40), items: [{ key: "new", generation: 0, issue: "y".repeat(120) }] });
    const out = appendPushEntry(many, appended);
    expect((blockIn(withPushLedger(summary, out)) ?? "").length).toBeLessThanOrEqual(MAX_LEDGER_CHARS);
    expect(out.at(-1)).toEqual(appended);
    expect(out.length).toBeLessThan(many.length + 1);
    // The budget, not the entry cap, is what dropped these.
    expect(out.length).toBeLessThan(MAX_PUSH_ENTRIES);
  });

  test("AC-19 keeps only the first items of a single entry over the budget", () => {
    const huge = entry({
      sha: "f".repeat(40),
      items: Array.from({ length: 400 }, (_, index) => ({ key: `f-${index}`, generation: 0, issue: "z".repeat(120) })),
    });
    const out = appendPushEntry([], huge);
    expect(out).toHaveLength(1);
    expect((blockIn(withPushLedger(summary, out)) ?? "").length).toBeLessThanOrEqual(MAX_LEDGER_CHARS);
    const kept = out[0];
    expect(kept.items.length).toBeLessThan(400);
    expect(kept.items[0]).toEqual(huge.items[0]);
    expect(kept.items).toEqual(huge.items.slice(0, kept.items.length));
  });
});
