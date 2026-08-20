import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { verifierOp } from "@/operations";

const STORY = { id: "S1", title: "t", workdir: "" } as any;

async function writeVerdict(dir: string, verdict: unknown): Promise<void> {
  await Bun.write(join(dir, ".nax-verifier-verdict.json"), JSON.stringify(verdict));
}

function ctx(packageDir: string, repoRoot?: string) {
  return { packageView: { packageDir, repoRoot } } as any;
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

describe("verifierOp.recover — resolveAbsolutePackageDir (repoRoot join)", () => {
  test("joins repoRoot + relative packageDir to read the verdict from the absolute workdir", async () => {
    const repoRoot = makeTempDir("verify-op-repo-");
    try {
      const relativePackageDir = "packages/api";
      const absolutePackageDir = join(repoRoot, relativePackageDir);
      await Bun.write(join(absolutePackageDir, ".keep"), "");
      await writeVerdict(absolutePackageDir, {
        version: 1,
        approved: true,
        tests: { allPassing: true, passCount: 1, failCount: 0 },
        testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
        acceptanceCriteria: { allMet: true, criteria: [] },
        quality: { rating: "good", issues: [] },
        fixes: [],
        reasoning: "ok",
      });
      const out = await verifierOp.recover!({ story: STORY }, ctx(relativePackageDir, repoRoot));
      expect(out!.success).toBe(true);
    } finally {
      cleanupTempDir(repoRoot);
    }
  });

  test("repo-root package (empty packageDir) with repoRoot set reads the verdict from repoRoot itself", async () => {
    const repoRoot = makeTempDir("verify-op-repo-root-");
    try {
      await writeVerdict(repoRoot, {
        version: 1,
        approved: false,
        tests: { allPassing: false, passCount: 0, failCount: 1 },
        testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
        acceptanceCriteria: { allMet: false, criteria: [] },
        quality: { rating: "acceptable", issues: [] },
        fixes: [],
        reasoning: "1 failure",
      });
      const out = await verifierOp.recover!({ story: STORY }, ctx("", repoRoot));
      expect(out!.success).toBe(false);
      expect(out!.failureCategory).toBe("tests-failing");
    } finally {
      cleanupTempDir(repoRoot);
    }
  });

  test("empty packageDir with no repoRoot fails closed rather than reading the process cwd", async () => {
    // !packageDir && !repoRoot -> resolveAbsolutePackageDir returns "" (the
    // `repoRoot || ""` fallback for callers with no repo root at all). No
    // verdict file exists there, so recover must fail closed, never throw.
    const out = await verifierOp.recover!({ story: STORY }, ctx(""));
    expect(out!.success).toBe(false);
  });
});
