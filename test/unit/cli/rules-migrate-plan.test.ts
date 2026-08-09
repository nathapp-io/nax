/**
 * rules-migrate-plan.ts — US-001 planMigration pure function tests
 *
 * Covers AC-1 through AC-6: the pure planner that decides per-source write
 * vs. skip. The function must take its `fileExists` dependency via injection
 * (no module-level glob/fstat), and every source must land in EXACTLY ONE of
 * writes/skips — never both, never neither.
 */

import { describe, expect, test } from "bun:test";
import { planMigration, type MigrationPlanEntry, type PlanMigrationOptions } from "@/cli";

const TARGET_DIR = "/target";

function makeEntry(overrides: Partial<MigrationPlanEntry> = {}): MigrationPlanEntry {
  return {
    sourcePath: "/source/rule.md",
    targetFileName: "rule.md",
    targetPath: "/target/rule.md",
    content: "# Rule",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<PlanMigrationOptions> = {}): PlanMigrationOptions {
  return {
    targetDir: TARGET_DIR,
    force: false,
    fileExists: async () => false,
    ...overrides,
  };
}

describe("planMigration", () => {
  test("AC-1: existing target without force is planned as skipped", async () => {
    const plan = await planMigration([makeEntry()], makeOptions({ force: false, fileExists: async () => true }));
    expect(plan.skips.map((e) => e.targetFileName)).toContain("rule.md");
  });

  test("AC-2: existing target without force has no planned writes", async () => {
    const plan = await planMigration([makeEntry()], makeOptions({ force: false, fileExists: async () => true }));
    expect(plan.writes).toEqual([]);
  });

  test("AC-3: existing target with force is planned for one write", async () => {
    const plan = await planMigration([makeEntry()], makeOptions({ force: true, fileExists: async () => true }));
    expect(plan.writes.map((e) => e.targetFileName)).toEqual(["rule.md"]);
  });

  test("AC-4: existing target with force has no planned skips", async () => {
    const plan = await planMigration([makeEntry()], makeOptions({ force: true, fileExists: async () => true }));
    expect(plan.skips).toEqual([]);
  });

  test("AC-5: absent target without force is planned for one write", async () => {
    const plan = await planMigration([makeEntry()], makeOptions({ force: false, fileExists: async () => false }));
    expect(plan.writes.map((e) => e.targetFileName)).toEqual(["rule.md"]);
  });

  test("AC-6: absent target with force is planned for one write", async () => {
    const plan = await planMigration([makeEntry()], makeOptions({ force: true, fileExists: async () => false }));
    expect(plan.writes.map((e) => e.targetFileName)).toEqual(["rule.md"]);
  });

  test("every source lands in exactly one of writes or skips", async () => {
    // Parity safety: a source that lands in neither would be silently dropped;
    // a source that lands in both would be written and reported skipped in the
    // same run. The planner must always pick one — both for the four
    // existing/absent × force on/off combinations and for mixed inputs.
    const entries = [
      makeEntry({ sourcePath: "/s/a.md", targetFileName: "a.md", targetPath: "/t/a.md" }),
      makeEntry({ sourcePath: "/s/b.md", targetFileName: "b.md", targetPath: "/t/b.md" }),
      makeEntry({ sourcePath: "/s/c.md", targetFileName: "c.md", targetPath: "/t/c.md" }),
    ];
    const fileExists = async (p: string): Promise<boolean> => p === "/t/a.md";
    const plan = await planMigration(entries, makeOptions({ force: false, fileExists }));
    expect(plan.writes.map((e) => e.targetFileName).sort()).toEqual(["b.md", "c.md"]);
    expect(plan.skips.map((e) => e.targetFileName)).toEqual(["a.md"]);
    expect(plan.writes.length + plan.skips.length).toBe(entries.length);
  });

  test("plan entries preserve source order in writes and skips", async () => {
    // Source order is what determines the output written: list — preserve it
    // so a re-run is deterministic and the dry-run preview matches the real
    // run entry-for-entry.
    const entries = [
      makeEntry({ sourcePath: "/s/a.md", targetFileName: "a.md", targetPath: "/t/a.md" }),
      makeEntry({ sourcePath: "/s/b.md", targetFileName: "b.md", targetPath: "/t/b.md" }),
      makeEntry({ sourcePath: "/s/c.md", targetFileName: "c.md", targetPath: "/t/c.md" }),
    ];
    const fileExists = async (p: string): Promise<boolean> => p === "/t/b.md";
    const plan = await planMigration(entries, makeOptions({ force: false, fileExists }));
    expect(plan.writes.map((e) => e.targetFileName)).toEqual(["a.md", "c.md"]);
    expect(plan.skips.map((e) => e.targetFileName)).toEqual(["b.md"]);
  });

  test("an empty source list produces an empty plan", async () => {
    const plan = await planMigration([], makeOptions());
    expect(plan.writes).toEqual([]);
    expect(plan.skips).toEqual([]);
  });
});
