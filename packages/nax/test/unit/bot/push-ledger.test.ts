import { describe, expect, test } from "bun:test";
import {
  addedBy,
  appendPushEntry,
  type BotPushEntry,
  MAX_LEDGER_CHARS,
  MAX_PUSH_ENTRIES,
  mergeLedgerEntries,
  nextLedgerEntries,
  parentIssue,
  pushLedgerChars,
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

  test.each([
    ["not base64 JSON", "not-base64-json-at-all"],
    // `Buffer.from(…, "base64")` skips what it cannot decode, so this once read as `[]`.
    ["a damaged character appended to a decodable payload", `${payload([])}!`],
    ["a payload truncated mid-group", payload([]).slice(0, 3)],
    // B10: decoding discards padding bits, so `W11=` and the canonical `W10=` both read as `[]`.
    ["a payload whose padding bits differ from the canonical encoding", "W11="],
    ["a payload with an internal space", `${payload([])} ${payload([])}`],
  ])("AC-7 rejects a payload that is %s", (_name, body) => {
    expect(readPushLedger(`${PUSHES}${body} -->\n${MARKER}`)).toEqual({ entries: [], unreadable: true });
  });

  test("B10: the canonical empty payload the writer emits still reads", () => {
    expect(payload([])).toBe("W10=");
    expect(readPushLedger(`${PUSHES}W10= -->\n${MARKER}`)).toEqual({ entries: [], unreadable: false });
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

/**
 * B1: the ledger is written by replacing the whole comment, and the forge has no conditional update.
 * These pin the merge that keeps a push recorded by a run whose body this one never saw.
 */
describe("nextLedgerEntries", () => {
  const earlier = entry({ sha: SHA_B });
  const current = `${MARKER}\n<!-- nax-bot:pushes v1 ${payload([earlier])} -->`;

  test("appends this execution's entry to the block the comment holds now", () => {
    const out = nextLedgerEntries({ current, entry: entry({ sha: SHA_A }) });
    expect(out.map(({ sha }) => sha)).toEqual([SHA_B, SHA_A]);
  });

  test("carries over an entry a stale snapshot holds that the current block has lost", () => {
    const stale = `${MARKER}\n<!-- nax-bot:pushes v1 ${payload([entry({ sha: SHA_A })])} -->`;
    const out = nextLedgerEntries({ current: `<!-- nax-bot:pushes v1 ${payload([earlier])} -->`, snapshot: stale });
    // The lost entry is older than the current one, so it is restored ahead of it, once.
    expect(out.map(({ sha }) => sha)).toEqual([SHA_A, SHA_B]);
    // A snapshot the current block already holds adds nothing.
    expect(nextLedgerEntries({ current, snapshot: current })).toEqual([earlier]);
  });

  test("B1: carries over a push only the append-only per-push record still holds", () => {
    const recorded = entry({ sha: SHA_A });
    const out = nextLedgerEntries({ current, records: [recorded] });
    expect(out.map(({ sha }) => sha)).toEqual([SHA_A, SHA_B]);
  });

  test("reads a body with no block as an empty ledger", () => {
    expect(nextLedgerEntries({ current: MARKER })).toEqual([]);
  });
});

/**
 * B13: the two reads are both subsequences of one push history, so an entry only the older read holds
 * keeps its place — and the entry cap then evicts by true age, not by the position of the merge.
 */
describe("mergeLedgerEntries", () => {
  const at = (index: number): string => `2026-01-0${index}T00:00:00.000Z`;
  const sha = (index: number): string => `${index}`.repeat(40).slice(0, 40);
  const chain = (count: number): BotPushEntry[] =>
    Array.from({ length: count }, (_unused, index) => entry({ sha: sha(index + 1), at: at(1) }));

  test("B13: a recovered middle entry keeps its place between its neighbours", () => {
    const [a, b, c] = chain(3);
    if (!a || !b || !c) throw new Error("fixture");
    expect(mergeLedgerEntries([a, c], [a, b]).map(({ sha }) => sha)).toEqual([a.sha, b.sha, c.sha]);
    // The same entry, when it is the oldest, still goes first.
    expect(mergeLedgerEntries([b], [a, b]).map(({ sha }) => sha)).toEqual([a.sha, b.sha]);
  });

  test("B13: under cap pressure the recovered entry survives and the oldest is the one evicted", () => {
    const all = Array.from({ length: MAX_PUSH_ENTRIES }, (_unused, index) =>
      entry({ sha: `${index}`.padStart(40, "f"), at: `2026-01-01T00:00:${`${index}`.padStart(2, "0")}Z` }),
    );
    const oldest = entry({ sha: "1".repeat(40), at: "2025-12-31T00:00:00.000Z" });
    const middle = entry({ sha: "2".repeat(40), at: "2026-01-01T00:00:00.500Z" });
    // The block as the comment holds it now: the oldest entry, the cap's worth of newer ones after it.
    const current = [oldest, ...all.slice(1)];
    const out = nextLedgerEntries({ current: withPushLedger(summary, current), records: [oldest, middle] });
    expect(out).toHaveLength(MAX_PUSH_ENTRIES);
    // The recovered entry is kept, in place, and the oldest is what the cap dropped.
    expect(out.map(({ sha }) => sha)).toContain(middle.sha);
    expect(out.map(({ sha }) => sha)).not.toContain(oldest.sha);
    expect(out.findIndex(({ sha }) => sha === middle.sha)).toBeLessThan(
      out.findIndex(({ sha }) => sha === all[1]?.sha),
    );
  });
});

describe("mergeLedgerEntries ancestry (D-3)", () => {
  const sha = (index: number): string => index.toString(16).padStart(40, "0");
  const linked = (index: number): BotPushEntry => entry({ base: sha(index - 1), sha: sha(index) });

  test("a snapshot that saw only the newer push is ordered after the current entry by its base", () => {
    const a = linked(1);
    const b = linked(2);
    expect(mergeLedgerEntries([a], [b]).map(({ sha: s }) => s)).toEqual([a.sha, b.sha]);
  });

  test("a snapshot entry that is the parent of the current one goes in front of it", () => {
    const a = linked(1);
    const b = linked(2);
    expect(mergeLedgerEntries([b], [a]).map(({ sha: s }) => s)).toEqual([a.sha, b.sha]);
  });

  test("cap pressure on disjoint reads evicts the older push, not the newer", () => {
    const filler = Array.from({ length: MAX_PUSH_ENTRIES - 1 }, (_unused, index) => linked(index + 10));
    const older = linked(1);
    const newer = linked(2);
    // The current block holds the older push beside the filler; the snapshot saw only the newer push.
    const out = nextLedgerEntries({
      current: withPushLedger(summary, [older, ...filler]),
      snapshot: withPushLedger(summary, [newer]),
    });
    expect(out).toHaveLength(MAX_PUSH_ENTRIES);
    expect(out.map(({ sha: s }) => s)).toContain(newer.sha);
    expect(out.map(({ sha: s }) => s)).not.toContain(older.sha);
  });
});

describe("parentIssue", () => {
  test("reads the issue the named push recorded, not another push's for the same key", () => {
    const entries = [
      entry({ sha: SHA_A, items: [{ key: "f-a", generation: 0, issue: "lock leaks" }] }),
      entry({ sha: SHA_B, items: [{ key: "f-a", generation: 1, issue: "claim file leaks" }] }),
    ];
    expect(parentIssue(SHA_A, "f-a", entries)).toBe("lock leaks");
    expect(parentIssue(SHA_B, "f-a", entries)).toBe("claim file leaks");
  });

  test("names no issue for a push the ledger no longer holds", () => {
    expect(parentIssue(SHA_A, "f-a", [entry({ sha: SHA_B })])).toBeUndefined();
  });
});

describe("pushLedgerChars", () => {
  test("is the block line plus its newline, and nothing for an empty ledger", () => {
    expect(pushLedgerChars([])).toBe(0);
    expect(pushLedgerChars([entry()])).toBe((blockIn(withPushLedger(summary, [entry()])) ?? "").length + 1);
  });
});

describe("addedBy (#3069)", () => {
  const SHA = `abcdef1${"0".repeat(33)}`;
  test("names a recorded push as a nax bot fix", () => {
    expect(addedBy(SHA)).toBe("nax bot fix abcdef1");
  });
  test("names an unrecorded push as a commit that nax bot fix did not push", () => {
    expect(addedBy(SHA, true)).toBe("commit abcdef1 (not a nax bot fix push)");
  });
});
