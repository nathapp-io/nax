import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AdviceAuditRecord, AdviceDecision } from "@/advisor";
import {
  _auditDeps,
  adviceAuditDir,
  appendLabel,
  captureWorktreePatch,
  readAdviceAudit,
  readLabels,
  writeAdviceAudit,
} from "@/advisor";

const original = { ..._auditDeps };
afterEach(() => Object.assign(_auditDeps, original));

const decision = { id: "D-3" } as AdviceDecision;

function record(over: Partial<AdviceAuditRecord> = {}): AdviceAuditRecord {
  return {
    schemaVersion: 1,
    naxVersion: "0.85.1",
    naxCommit: "abc",
    runId: "run-1",
    question: {
      id: "Q-9",
      kind: "finish-judgment",
      feature: "feat",
      askedAtSha: "s",
      summary: "x",
      evidence: [],
      options: [],
    },
    context: { specPath: "spec.md", specSha256: null, prdSha256: "p", priorDecisions: [] },
    worktree: { sha: "s", patch: "", patchTruncated: false },
    memoryMode: "stateless",
    model: "m",
    prompt: "P",
    rawReply: "R",
    result: { decision },
    costUsd: 0.01,
    headsUp: { sent: false, reason: "no-channel" },
    ...over,
  };
}

/** A git stub answering rev-parse / diff / ls-files / diff --no-index from fixed strings. */
function stubGit(parts: { tracked: string; untracked: Record<string, string> }): void {
  _auditDeps.git = async (args) => {
    if (args[0] === "rev-parse") return { stdout: "sha123\n", exitCode: 0 };
    if (args[0] === "ls-files") return { stdout: Object.keys(parts.untracked).join("\n"), exitCode: 0 };
    if (args[0] === "diff" && args[1] === "--no-index")
      return { stdout: parts.untracked[args[3] ?? ""] ?? "", exitCode: 1 };
    if (args[0] === "diff") return { stdout: parts.tracked, exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
}

describe("advisor audit", () => {
  test("a record round-trips with every field, named after the decision id", async () => {
    await withTempDir(async (dir) => {
      const rel = await writeAdviceAudit(dir, "feat", record());
      expect(rel).toBe(join("advisor-audit", "feat", "D-3.json"));
      expect(await readAdviceAudit(join(dir, rel))).toEqual(record());
    });
  });

  test("a fallback record (no decision) is named after the question id", async () => {
    await withTempDir(async (dir) => {
      const rel = await writeAdviceAudit(
        dir,
        "feat",
        record({ result: { decision: null, fallbackReason: "no-json" } }),
      );
      expect(rel).toBe(join("advisor-audit", "feat", "Q-9.json"));
    });
  });

  test("captureWorktreePatch truncates at the cap and says so", async () => {
    stubGit({ tracked: "x".repeat(300 * 1024), untracked: {} });
    const out = await captureWorktreePatch("/repo");
    expect(out.sha).toBe("sha123");
    expect(out.patch.length).toBe(262_144);
    expect(out.patchTruncated).toBe(true);
  });

  test("captureWorktreePatch includes untracked files", async () => {
    stubGit({ tracked: "TRACKED\n", untracked: { "new.ts": "NEWFILE\n" } });
    const out = await captureWorktreePatch("/repo");
    expect(out.patch).toBe("TRACKED\nNEWFILE\n");
    expect(out.patchTruncated).toBe(false);
  });

  test("labels append and read back in order", async () => {
    await withTempDir(async (dir) => {
      await appendLabel(dir, "feat", { id: "D-1", verdict: "agree", labelledAt: "t1" });
      await appendLabel(dir, "feat", {
        id: "D-2",
        verdict: "disagree",
        expected: "fix",
        unsafeTypes: ["waive"],
        labelledAt: "t2",
      });
      expect((await readLabels(dir, "feat")).map((l) => l.id)).toEqual(["D-1", "D-2"]);
      expect(adviceAuditDir(dir, "feat")).toBe(join(dir, "advisor-audit", "feat"));
    });
  });

  test("reading a missing artifact throws a NaxError", async () => {
    await withTempDir(async (dir) => {
      await expect(readAdviceAudit(join(dir, "nope.json"))).rejects.toThrow("advisor audit not found");
    });
  });
});
