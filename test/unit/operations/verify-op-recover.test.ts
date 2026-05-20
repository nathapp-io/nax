import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";
import { verifierOp } from "../../../src/operations";

const STORY = { id: "S1", title: "t", workdir: "" } as any;

async function writeVerdict(dir: string, verdict: unknown): Promise<void> {
  await Bun.write(join(dir, ".nax-verifier-verdict.json"), JSON.stringify(verdict));
}

function ctx(packageDir: string) {
  return { packageView: { packageDir } } as any;
}

describe("verifierOp.recover", () => {
  test("returns failureCategory='verifier-rejected' when test mods are illegitimate", async () => {
    const dir = makeTempDir("verify-op-rejected-");
    try {
      await writeVerdict(dir, {
        version: 1,
        approved: false,
        tests: { allPassing: true, passCount: 5, failCount: 0 },
        testModifications: { detected: true, files: ["a.test.ts"], legitimate: false, reasoning: "weakened assertions" },
        acceptanceCriteria: { allMet: true, criteria: [] },
        quality: { rating: "good", issues: [] },
        fixes: [],
        reasoning: "rejected",
      });
      const out = await verifierOp.recover!({ story: STORY }, ctx(dir));
      expect(out).not.toBeNull();
      expect(out!.success).toBe(false);
      expect(out!.failureCategory).toBe("verifier-rejected");
      expect(out!.reviewReason).toContain("a.test.ts");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns failureCategory='tests-failing' when tests fail", async () => {
    const dir = makeTempDir("verify-op-fail-");
    try {
      await writeVerdict(dir, {
        version: 1,
        approved: false,
        tests: { allPassing: false, passCount: 2, failCount: 3 },
        testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
        acceptanceCriteria: { allMet: false, criteria: [] },
        quality: { rating: "acceptable", issues: [] },
        fixes: [],
        reasoning: "3 failures",
      });
      const out = await verifierOp.recover!({ story: STORY }, ctx(dir));
      expect(out!.success).toBe(false);
      expect(out!.failureCategory).toBe("tests-failing");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns success=true with no category when approved", async () => {
    const dir = makeTempDir("verify-op-ok-");
    try {
      await writeVerdict(dir, {
        version: 1,
        approved: true,
        tests: { allPassing: true, passCount: 5, failCount: 0 },
        testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
        acceptanceCriteria: { allMet: true, criteria: [] },
        quality: { rating: "good", issues: [] },
        fixes: [],
        reasoning: "ok",
      });
      const out = await verifierOp.recover!({ story: STORY }, ctx(dir));
      expect(out!.success).toBe(true);
      expect(out!.failureCategory).toBeUndefined();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("cleanupVerdict removes file after recover", async () => {
    const dir = makeTempDir("verify-op-cleanup-");
    try {
      await writeVerdict(dir, {
        version: 1,
        approved: true,
        tests: { allPassing: true, passCount: 1, failCount: 0 },
        testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
        acceptanceCriteria: { allMet: true, criteria: [] },
        quality: { rating: "good", issues: [] },
        fixes: [],
        reasoning: "ok",
      });
      await verifierOp.recover!({ story: STORY }, ctx(dir));
      const exists = await Bun.file(join(dir, ".nax-verifier-verdict.json")).exists();
      expect(exists).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
