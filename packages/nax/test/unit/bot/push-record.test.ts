import { describe, expect, test } from "bun:test";
import {
  type BotPushEntry,
  MAX_LEDGER_CHARS,
  MAX_PUSH_ENTRIES,
  pushRecordBody,
  pushRecordKey,
  readPushLedger,
  withPushLedger,
} from "@/bot/push-ledger";
import { ownLedgerEntries } from "@/bot/push-record";
import { MAX_FORGE_COMMENT_CHARS, type OwnComment, withNaxBotMarker } from "@/forge";

const sha = (index: number): string => index.toString(16).padStart(40, "0");

function entry(index: number, items: BotPushEntry["items"] = []): BotPushEntry {
  return { base: sha(index - 1), sha: sha(index), at: "2026-01-01T00:00:00.000Z", items };
}

function summaryOwn(entries: readonly BotPushEntry[]): OwnComment {
  const body = withPushLedger(withNaxBotMarker("summary", "fix-summary"), entries);
  return { key: "fix-summary", comment: { id: "1", kind: "comment", author: "bot", body, createdAt: "" } };
}

function recordOwn(value: BotPushEntry): OwnComment {
  return {
    key: pushRecordKey(value.sha),
    comment: { id: `r-${value.sha}`, kind: "comment", author: "bot", body: pushRecordBody(value), createdAt: "" },
  };
}

describe("pushRecordBody (D-2)", () => {
  test("an oversized entry is budgeted exactly like the summary's copy, so the forge accepts the record", () => {
    const items = Array.from({ length: 400 }, (_unused, index) => ({
      key: `f-${index}`.padEnd(100, "k"),
      generation: index,
      issue: "x".repeat(120),
    }));
    const body = pushRecordBody(entry(1, items));
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    const block = body.split("\n").find((line) => line.startsWith("<!-- nax-bot:pushes v1 ")) ?? "";
    expect(block.length).toBeLessThanOrEqual(MAX_LEDGER_CHARS);
    const read = readPushLedger(body);
    expect(read.unreadable).toBe(false);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.sha).toBe(sha(1));
    expect(read.entries[0]?.items.length).toBeGreaterThan(0);
  });

  test("an entry within the budget is recorded unchanged", () => {
    const small = entry(1, [{ key: "f-1", generation: 0, issue: "lock leaks" }]);
    expect(readPushLedger(pushRecordBody(small)).entries).toEqual([small]);
  });
});

describe("ownLedgerEntries retention (D-5)", () => {
  test("never returns more than the entry cap, newest kept", () => {
    const all = Array.from({ length: MAX_PUSH_ENTRIES + 1 }, (_unused, index) => entry(index + 1));
    const own = [summaryOwn(all.slice(1)), ...all.map(recordOwn)];
    const out = ownLedgerEntries(own);
    expect(out).toHaveLength(MAX_PUSH_ENTRIES);
    expect(out.map(({ sha: s }) => s)).not.toContain(all[0]?.sha);
    expect(out.at(-1)?.sha).toBe(all.at(-1)?.sha);
  });

  test("never returns more than the encoded budget", () => {
    const fat = (index: number): BotPushEntry =>
      entry(
        index,
        Array.from({ length: 40 }, (_unused, item) => ({ key: `k-${item}`, generation: 0, issue: "y".repeat(120) })),
      );
    const all = Array.from({ length: 20 }, (_unused, index) => fat(index + 1));
    const out = ownLedgerEntries(all.map(recordOwn));
    expect(out.length).toBeLessThan(all.length);
    expect(readPushLedger(withPushLedger("body", out)).entries).toEqual(out);
    expect(withPushLedger("", out).length).toBeLessThanOrEqual(MAX_LEDGER_CHARS);
    expect(out.at(-1)?.sha).toBe(all.at(-1)?.sha);
  });

  test("still recovers a push the stale summary lost while it is within retention", () => {
    const all = [1, 2, 3].map((index) => entry(index));
    const stale = all.filter((_unused, index) => index !== 1);
    const out = ownLedgerEntries([summaryOwn(stale), ...all.map(recordOwn)]);
    expect(out.map(({ sha: s }) => s)).toEqual(all.map(({ sha: s }) => s));
  });
});
