import { describe, expect, test } from "bun:test";
import { type CallerRuling, planCallerRulings } from "@/bot/caller-rulings";
import type { PrComment, PrThread } from "@/forge/pr-types";
import type { ItemThread, SettledItems } from "@/workflow/item-thread-state";
import type { PrRuling } from "@/workflow/item-threads";

const thread: PrThread = { id: "t", replyTo: "1", resolved: false, outdated: false, comments: [] };
const reply = (body: string, createdAt: string): PrComment => ({
  id: "r",
  kind: "thread",
  author: "alice",
  body,
  createdAt,
});
const item = (id: string, hash = "12345678"): ItemThread => ({
  key: `w-${id}.${hash}`,
  itemId: id,
  kind: "finding",
  thread,
  replies: [],
});
const open = (id: string, kept: PrComment[] = []): SettledItems["open"][number] => ({ ...item(id), kept });
const settledItem = (id: string): SettledItems["settled"][number] => ({
  ...item(id),
  ruling: { itemKey: `w-${id}.12345678`, itemId: id, disposition: "waived", reason: "x", by: "alice" } as PrRuling,
});
const call = (over: Partial<CallerRuling> & { item: string }): CallerRuling => ({
  ruling: "waive: accepted",
  by: "orch",
  at: "2026-01-02T00:00:00Z",
  ...over,
});
const plan = (rulings: CallerRuling[], state: SettledItems) => planCallerRulings(rulings, state);

describe("planCallerRulings", () => {
  test("an open item gets a candidate carrying caller provenance", () => {
    const state = { settled: [], open: [open("D-1")] };
    const out = plan([call({ item: "D-1", key: "w-D-1.12345678" })], state);
    expect(out.skipped).toEqual([]);
    expect(out.candidates.get(state.open[0] as never)).toEqual({
      itemKey: "w-D-1.12345678",
      itemId: "D-1",
      disposition: "waived",
      reason: "accepted",
      by: null,
      callerBy: "orch",
    });
  });
  test("fixed keeps its sha", () => {
    const state = { settled: [], open: [open("D-1")] };
    const out = plan([call({ item: "D-1", ruling: "fixed 4f2e1aa - patched" })], state);
    expect([...out.candidates.values()][0]).toMatchObject({ disposition: "fixed", sha: "4f2e1aa", reason: "patched" });
  });
  test("unknown item and stale key are skipped", () => {
    const state = { settled: [], open: [open("D-1")] };
    const out = plan([call({ item: "D-9" }), call({ item: "D-1", key: "w-D-1.deadbeef" })], state);
    expect(out.candidates.size).toBe(0);
    expect(out.skipped).toEqual([
      { item: "D-9", reason: "unknown-item" },
      { item: "D-1", reason: "stale-key" },
    ]);
  });
  test("an already settled item is not re-recorded", () => {
    const out = plan([call({ item: "D-2" })], { settled: [settledItem("D-2")], open: [] });
    expect(out.candidates.size).toBe(0);
    expect(out.skipped).toEqual([{ item: "D-2", reason: "already-settled" }]);
  });
  test("a writer ruling after the caller ruling wins", () => {
    const state = { settled: [], open: [open("D-1", [reply("confirm", "2026-01-03T00:00:00Z")])] };
    const out = plan([call({ item: "D-1" })], state);
    expect(out.candidates.size).toBe(0);
    expect(out.skipped).toEqual([{ item: "D-1", reason: "superseded-by-writer" }]);
  });
  test("an older writer reply or a later non-ruling comment does not block the caller", () => {
    const older = { settled: [], open: [open("D-1", [reply("confirm", "2026-01-01T00:00:00Z")])] };
    expect(plan([call({ item: "D-1" })], older).candidates.size).toBe(1);
    const chatter = { settled: [], open: [open("D-1", [reply("thanks", "2026-01-03T00:00:00Z")])] };
    expect(plan([call({ item: "D-1" })], chatter).candidates.size).toBe(1);
  });
  test("an unparsable reply timestamp fails closed to the writer", () => {
    const state = { settled: [], open: [open("D-1", [reply("confirm", "garbage")])] };
    expect(plan([call({ item: "D-1" })], state).skipped).toEqual([{ item: "D-1", reason: "superseded-by-writer" }]);
  });
});
