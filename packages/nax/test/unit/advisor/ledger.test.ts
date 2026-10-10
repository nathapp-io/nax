import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AdviceDecision } from "@/advisor";
import { _ledgerDeps, appendDecision, countStoryRulings, findReusable, ledgerPath, readDecisions } from "@/advisor";
import { naxOwnedWriteRefusal } from "@/agents/nax-owned-writes";
import { featureDir } from "@/config";

const original = { ..._ledgerDeps };
afterEach(() => Object.assign(_ledgerDeps, original));

const draft = (over: Partial<AdviceDecision> = {}): Omit<AdviceDecision, "id"> => ({
  questionId: "Q",
  kind: "finish-judgment",
  chosenOptionId: "A",
  action: { type: "fix", instruction: "x" },
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "2026-10-10T00:00:00Z",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
  ...over,
});

describe("ledger", () => {
  test("lives in the feature dir at the repo root", () => {
    expect(ledgerPath("/repo", "feat")).toBe(join(featureDir("/repo", "feat"), "decisions.jsonl"));
  });

  test("appends sequential ids and reads them back", async () => {
    await withTempDir(async (dir) => {
      const a = await appendDecision(dir, "feat", draft());
      const b = await appendDecision(dir, "feat", draft());
      expect([a.id, b.id]).toEqual(["D-1", "D-2"]);
      expect((await readDecisions(dir, "feat")).map((d) => d.id)).toEqual(["D-1", "D-2"]);
    });
  });

  test("concurrent appends never collide (Review Focus 2)", async () => {
    await withTempDir(async (dir) => {
      const all = await Promise.all(Array.from({ length: 8 }, () => appendDecision(dir, "feat", draft())));
      expect(all.map((d) => d.id).sort()).toEqual(["D-1", "D-2", "D-3", "D-4", "D-5", "D-6", "D-7", "D-8"].sort());
      expect(await readDecisions(dir, "feat")).toHaveLength(8);
    });
  });

  test("a corrupt last line is skipped and numbering continues from valid lines (Review Focus 3)", async () => {
    await withTempDir(async (dir) => {
      await appendDecision(dir, "feat", draft());
      await Bun.write(ledgerPath(dir, "feat"), `${await Bun.file(ledgerPath(dir, "feat")).text()}{"id":"D-2","trunc`);
      expect((await readDecisions(dir, "feat")).map((d) => d.id)).toEqual(["D-1"]);
      const next = await appendDecision(dir, "feat", draft());
      expect(next.id).toBe("D-2");
    });
  });

  test("a draft builder receives the assigned id (so the line can reference its own audit file)", async () => {
    await withTempDir(async (dir) => {
      await appendDecision(dir, "feat", draft());
      const d = await appendDecision(dir, "feat", (id) => draft({ auditRef: `advisor-audit/feat/${id}.json` }));
      expect(d.id).toBe("D-2");
      expect(d.auditRef).toBe("advisor-audit/feat/D-2.json");
      expect((await readDecisions(dir, "feat"))[1]?.auditRef).toBe("advisor-audit/feat/D-2.json");
    });
  });

  test("an absent ledger reads as empty", async () => {
    await withTempDir(async (dir) => expect(await readDecisions(dir, "nope")).toEqual([]));
  });

  test("counts only story rulings (kinds 2 + 3) for that story", () => {
    const ds = [
      { ...draft({ kind: "fix-cycle-give-up", storyId: "US-1" }), id: "D-1" },
      { ...draft({ kind: "uncategorised-failure", storyId: "US-1" }), id: "D-2" },
      { ...draft({ kind: "finish-judgment", storyId: "US-1" }), id: "D-3" },
      { ...draft({ kind: "fix-cycle-give-up", storyId: "US-2" }), id: "D-4" },
    ];
    expect(countStoryRulings(ds, "US-1")).toBe(2);
  });

  test("findReusable returns the latest waive/supersede for the key, never a fix", () => {
    const ds = [
      { ...draft({ dedupeKey: "k", action: { type: "waive", reason: "a" } }), id: "D-1" },
      { ...draft({ dedupeKey: "k", action: { type: "fix", instruction: "b" } }), id: "D-2" },
      { ...draft({ dedupeKey: "k", action: { type: "waive", reason: "c" } }), id: "D-3" },
    ];
    expect(findReusable(ds, "k")?.id).toBe("D-3");
    expect(findReusable(ds, "other")).toBeUndefined();
  });

  test("agents can never write the ledger (nax-owned path)", () => {
    for (const tool of ["Write", "Edit", "Delete"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/feat/decisions.jsonl")).toBeString();
    }
  });
});
