import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { Command } from "commander";
import type { AdviceDecision } from "@/advisor";
import { appendDecision, readLabels } from "@/advisor";
import { type AdvisorCliDeps, registerAdvisorCommand } from "@/cli/advisor";

const draft = (over: Partial<AdviceDecision> = {}): Omit<AdviceDecision, "id"> => ({
  questionId: "Q",
  kind: "finish-judgment",
  chosenOptionId: "A",
  action: { type: "fix", instruction: "x" },
  rationale: "plain",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "t",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
  ...over,
});

function harness(outDir: string): { deps: AdvisorCliDeps; out: string[]; err: string[]; codes: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const deps: AdvisorCliDeps = {
    resolveOutputDir: async () => outDir,
    log: (t) => out.push(t),
    logErr: (t) => err.push(t),
    exit: (c) => codes.push(c),
    now: () => "2026-10-10T00:00:00.000Z",
  };
  return { deps, out, err, codes };
}

async function run(deps: AdvisorCliDeps, argv: string[]): Promise<void> {
  const program = new Command();
  registerAdvisorCommand(program, deps);
  await program.parseAsync(["node", "nax", "advisor", ...argv]);
}

describe("nax advisor list", () => {
  test("lists flagged decisions first", async () => {
    await withTempDir(async (dir) => {
      await appendDecision(dir, "feat", draft());
      await appendDecision(
        dir,
        "feat",
        draft({ needsHumanConfirm: true, rationale: "risky", action: { type: "hold", reason: "r" } }),
      );
      const h = harness(join(dir, "out"));
      await run(h.deps, ["list", "-f", "feat", "-d", dir]);
      expect(h.codes).toEqual([0]);
      expect(h.out[0]).toContain("D-2");
      expect(h.out[0]).toContain("needs confirm");
      expect(h.out[1]).toContain("D-1");
    });
  });

  test("--json emits the decisions", async () => {
    await withTempDir(async (dir) => {
      await appendDecision(dir, "feat", draft());
      const h = harness(join(dir, "out"));
      await run(h.deps, ["list", "-f", "feat", "-d", dir, "--json"]);
      expect(JSON.parse(h.out.join("\n")).map((d: AdviceDecision) => d.id)).toEqual(["D-1"]);
    });
  });

  test("without -f it lists every feature that has a ledger", async () => {
    await withTempDir(async (dir) => {
      await appendDecision(dir, "a", draft());
      await appendDecision(dir, "b", draft());
      const h = harness(join(dir, "out"));
      await run(h.deps, ["list", "-d", dir]);
      expect(h.out.join("\n")).toContain("a");
      expect(h.out.join("\n")).toContain("b");
      expect(h.codes).toEqual([0]);
    });
  });
});

describe("nax advisor label", () => {
  test("appends a label under the project output dir", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      const h = harness(outDir);
      await run(h.deps, [
        "label",
        "D-1",
        "disagree",
        "-f",
        "feat",
        "-d",
        dir,
        "--expected",
        "fix",
        "--unsafe-types",
        "waive,defer",
      ]);
      expect(h.codes).toEqual([0]);
      expect(await readLabels(outDir, "feat")).toEqual([
        {
          id: "D-1",
          verdict: "disagree",
          expected: "fix",
          unsafeTypes: ["waive", "defer"],
          labelledAt: "2026-10-10T00:00:00.000Z",
        },
      ]);
    });
  });

  test("rejects a malformed id or verdict with exit 2", async () => {
    await withTempDir(async (dir) => {
      const h = harness(join(dir, "out"));
      await run(h.deps, ["label", "../x", "agree", "-f", "feat", "-d", dir]);
      await run(h.deps, ["label", "D-1", "maybe", "-f", "feat", "-d", dir]);
      expect(h.codes).toEqual([2, 2]);
    });
  });
});
