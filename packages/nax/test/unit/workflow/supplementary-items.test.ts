/**
 * #2578: the items a finisher rules on that `verdict.openItems` does not hold. Advisor decisions that
 * are not already open items, and the story loops' cannot-verify lines, under ids nax assigns.
 *
 * The fixtures spell the on-disk paths out (`.nax/features/<feature>/decisions.jsonl` and
 * `.nax/features/<feature>/workflow/<runId>/ledger.md`) so a wrong base directory cannot agree with itself.
 */
import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { makeAdviceDecision, withTempDir, writeTrustedDecision } from "@test/helpers";
import type { AdviceDecision } from "@/advisor";
import { loadSupplementaryItems } from "@/workflow/supplementary-items";
import type { OpenItem } from "@/workflow/types";

const FEATURE = "auth";

const featureDir = (dir: string): string => join(dir, ".nax", "features", FEATURE);
const outDir = (dir: string): string => join(dir, "out");

const decision = (over: Partial<AdviceDecision>): AdviceDecision =>
  makeAdviceDecision({ auditRef: `advisor-audit/${FEATURE}/${over.id ?? "D-1"}.json`, ...over });

async function trust(dir: string, decisions: readonly AdviceDecision[]): Promise<void> {
  for (const d of decisions) await writeTrustedDecision(dir, FEATURE, outDir(dir), d);
}

/** One run directory with a `result.json` (so it counts as a run) and, when given, its ledger. */
async function writeRun(dir: string, runId: string, secs: number, ledger: string | null): Promise<string> {
  const runDir = join(featureDir(dir), "workflow", runId);
  await mkdir(runDir, { recursive: true });
  await Bun.write(
    join(runDir, "result.json"),
    JSON.stringify({ schemaVersion: 1, runId, feature: FEATURE, stories: {} }),
  );
  await utimes(join(runDir, "result.json"), secs, secs);
  if (ledger !== null) await Bun.write(join(runDir, "ledger.md"), ledger);
  return runDir;
}

const HELD: OpenItem = { id: "D-1", kind: "advisor", issue: "advisor held: risky" };
const RULED: OpenItem = {
  id: "B1",
  kind: "ruling",
  issue: "B1 is broken",
  ruling: { action: "hold", why: "real", decisionId: "D-3" },
};
const APPROVAL: Partial<AdviceDecision> = {
  kind: "finish-approval",
  action: { type: "approve" },
  rationale: "gates green",
};

describe("loadSupplementaryItems: advisor decisions", () => {
  test("lists each trusted decision that is not an open item, nor the decision behind a ruling item", async () => {
    await withTempDir(async (dir) => {
      await trust(dir, [decision({ id: "D-1" }), decision({ ...APPROVAL, id: "D-2" }), decision({ id: "D-3" })]);
      const items = await loadSupplementaryItems(dir, FEATURE, [HELD, RULED], outDir(dir));
      expect(items).toEqual([{ id: "D-2", kind: "advisor", issue: "finish-approval approve: gates green" }]);
    });
  });

  test("a ledger line with no matching audit artifact is not listed", async () => {
    await withTempDir(async (dir) => {
      await trust(dir, [decision({ ...APPROVAL, id: "D-2" })]);
      await appendFile(join(featureDir(dir), "decisions.jsonl"), `${JSON.stringify(decision({ id: "D-9" }))}\n`);
      const items = await loadSupplementaryItems(dir, FEATURE, [], outDir(dir));
      expect(items.map((i) => i.id)).toEqual(["D-2"]);
    });
  });

  test("an advisor rationale spanning lines becomes one line", async () => {
    await withTempDir(async (dir) => {
      await trust(dir, [decision({ ...APPROVAL, id: "D-4", rationale: "a\n  b\tc" })]);
      const [item] = await loadSupplementaryItems(dir, FEATURE, [], outDir(dir));
      expect(item?.issue).toBe("finish-approval approve: a b c");
    });
  });
});

describe("loadSupplementaryItems: cannot-verify lines", () => {
  test("numbers each story's lines from 1, across runs oldest first, deduped, without the _run scope", async () => {
    await withTempDir(async (dir) => {
      await writeRun(
        dir,
        "r1",
        100,
        ["US-001: cannot-verify: Redis TTL", "US-002: cannot-verify: SMTP relay", "_run: cannot-verify: branch"].join(
          "\n",
        ),
      );
      await writeRun(
        dir,
        "r2",
        200,
        ["US-001: cannot-verify: Redis TTL", "US-001: cannot-verify: cron drift"].join("\n"),
      );
      expect(await loadSupplementaryItems(dir, FEATURE, [], outDir(dir))).toEqual([
        { id: "US-001:cv1", kind: "cannot-verify", issue: "Redis TTL" },
        { id: "US-002:cv1", kind: "cannot-verify", issue: "SMTP relay" },
        { id: "US-001:cv2", kind: "cannot-verify", issue: "cron drift" },
      ]);
    });
  });

  test("a later run appending a line leaves the earlier ids as they were", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, "r1", 100, "US-001: cannot-verify: Redis TTL\n");
      const before = await loadSupplementaryItems(dir, FEATURE, [], outDir(dir));
      await writeRun(dir, "r2", 200, "US-001: cannot-verify: cron drift\n");
      const after = await loadSupplementaryItems(dir, FEATURE, [], outDir(dir));
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.map((i) => i.id)).toEqual(["US-001:cv1", "US-001:cv2"]);
    });
  });
});

describe("loadSupplementaryItems: sources", () => {
  test("lists advisor decisions before cannot-verify lines", async () => {
    await withTempDir(async (dir) => {
      await trust(dir, [decision({ id: "D-2" })]);
      await writeRun(dir, "r1", 100, "US-001: cannot-verify: Redis TTL\n");
      const items = await loadSupplementaryItems(dir, FEATURE, [], outDir(dir));
      expect(items.map((i) => i.id)).toEqual(["D-2", "US-001:cv1"]);
    });
  });

  test("an unreadable run ledger drops only the cannot-verify lines, without throwing", async () => {
    await withTempDir(async (dir) => {
      await trust(dir, [decision({ id: "D-2" })]);
      const runDir = await writeRun(dir, "r1", 100, null);
      await mkdir(join(runDir, "ledger.md"));
      const items = await loadSupplementaryItems(dir, FEATURE, [], outDir(dir));
      expect(items.map((i) => i.id)).toEqual(["D-2"]);
    });
  });

  test("is empty with no advisor ledger and no workflow runs", async () => {
    await withTempDir(async (dir) => {
      expect(await loadSupplementaryItems(dir, FEATURE, [], outDir(dir))).toEqual([]);
    });
  });
});
