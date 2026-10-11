import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { readAdviceAudit } from "@/advisor";
import { type AdvisorImportDeps, runAdvisorImport } from "@/cli/advisor-import";

const FIXTURES = join(import.meta.dir, "../../fixtures/advisor");

function harness(outDir: string, acceptanceEnabled = true) {
  const out: string[] = [];
  const err: string[] = [];
  let n = 0;
  const deps: AdvisorImportDeps = {
    resolveOutputDir: async () => outDir,
    acceptanceEnabled: async () => acceptanceEnabled,
    newId: () => `Q-${++n}`,
    log: (t) => out.push(t),
    logErr: (t) => err.push(t),
  };
  return { deps, out, err };
}

describe("nax advisor import-finish", () => {
  test("each judgment finding becomes one finish-judgment question artifact", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      const h = harness(outDir);
      const code = await runAdvisorImport(
        { dir, resultPath: join(FIXTURES, "judgment.result.json"), sha: "abc123", allFindings: false },
        h.deps,
      );
      expect(code).toBe(0);
      const rec = await readAdviceAudit(join(outDir, "advisor-audit", "feat", "Q-1.json"));
      expect(rec.question.kind).toBe("finish-judgment");
      expect(rec.question.askedAtSha).toBe("abc123");
      expect(rec.question.dedupeKey).toBe("quality|commit_reindex can lose data|store/sqlite_vec.py");
      expect(rec.question.options.map((o) => o.type)).toEqual(["fix", "waive", "hold"]);
      expect(rec.question.findingSeverity).toBe("HIGH");
      expect(rec.result).toEqual({ decision: null, fallbackReason: "imported" });
      expect(h.out.join("\n")).toContain("imported 1 question(s)");
    });
  });

  test("--all-findings imports every finding (results that predate judgment flags)", async () => {
    await withTempDir(async (dir) => {
      const h = harness(join(dir, "out"));
      await runAdvisorImport(
        { dir, resultPath: join(FIXTURES, "judgment.result.json"), sha: "abc", allFindings: true },
        h.deps,
      );
      expect(h.out.join("\n")).toContain("imported 2 question(s)");
    });
  });

  test("a gap-only escalation is reported as not importable", async () => {
    await withTempDir(async (dir) => {
      const h = harness(join(dir, "out"));
      const code = await runAdvisorImport(
        { dir, resultPath: join(FIXTURES, "gap.result.json"), sha: "abc", allFindings: false },
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.out.join("\n")).toContain("not importable in A1 (evidence-gap escalation)");
    });
  });

  test("a missing sha exits 2", async () => {
    await withTempDir(async (dir) => {
      const h = harness(join(dir, "out"));
      expect(
        await runAdvisorImport(
          { dir, resultPath: join(FIXTURES, "judgment.result.json"), sha: "", allFindings: false },
          h.deps,
        ),
      ).toBe(2);
    });
  });

  test("a post-A4 draft result is skipped; a pre-A4 escalated result still imports", async () => {
    await withTempDir(async (dir) => {
      const h = harness(join(dir, "out"));
      const resultPath = join(FIXTURES, "post-a4-draft.result.json");
      const skipped = await runAdvisorImport({ dir, resultPath, sha: "abc", allFindings: true }, h.deps);
      expect(skipped).toBe(0);
      expect(h.out).toEqual([`skipped ${resultPath}: not a pre-A4 escalation`]);

      const imported = await runAdvisorImport(
        { dir, resultPath: join(FIXTURES, "judgment.result.json"), sha: "abc", allFindings: false },
        h.deps,
      );
      expect(imported).toBe(0);
      expect(h.out.join("\n")).toContain("imported 1 question(s)");
    });
  });

  test("a result with an escalated round but no status is still pre-A4", async () => {
    await withTempDir(async (dir) => {
      const h = harness(join(dir, "out"));
      const resultPath = join(dir, "r.json");
      await Bun.write(
        resultPath,
        JSON.stringify({
          feature: "feat",
          findings: [{ severity: "HIGH", title: "t", problem: "p", judgment: true }],
          rounds: [{ phase: "quality", outcome: "escalated" }],
        }),
      );
      await runAdvisorImport({ dir, resultPath, sha: "abc", allFindings: false }, h.deps);
      expect(h.out.join("\n")).toContain("imported 1 question(s)");
    });
  });
});
