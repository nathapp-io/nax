import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { auditGaps, buildReviewPrompt } from "@/finish";
import type { ReviewReport } from "@/finish";
import { finishReviewOp } from "@/operations";
import { _gitDeps } from "@/utils/git";
import { withTempDir } from "@test/helpers";

const BASE = "origin/main";
const originalGitSpawn = _gitDeps.spawn;

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    findings: [],
    touchpoints: [{ path: "none", note: "no external definitions required" }],
    walk: ["src/a.ts — reviewed"],
    sawNoFindings: true,
    sawTouchpointsSection: true,
    sawWalkSection: true,
    ...overrides,
  };
}

function gitProcess(stdout: string, exitCode = 0) {
  return {
    stdout: new Blob([stdout]).stream(),
    stderr: new Blob().stream(),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

function stubChangedFiles(stdout: string, exitCode = 0) {
  const spawn = mock(() => gitProcess(stdout, exitCode));
  _gitDeps.spawn = spawn as unknown as typeof _gitDeps.spawn;
  return spawn;
}

async function gapsFor(
  workdir: string,
  changedFiles: string[],
  walk: string[],
  overrides: Partial<ReviewReport> = {},
  phase: "spec" | "quality" = "quality",
) {
  stubChangedFiles(changedFiles.join("\n"));
  return auditGaps(report({ walk, ...overrides }), workdir, { base: BASE, head: "HEAD" }, phase);
}

async function writePaths(workdir: string, paths: string[]) {
  await Promise.all(paths.map((path) => Bun.write(join(workdir, path), "export {};\n")));
}

afterEach(() => {
  _gitDeps.spawn = originalGitSpawn;
});

describe("finish-quality-walk-bounding acceptance", () => {
  test("AC-1: quality prompts require one line per file, not one line per function", () => {
    const prompt = buildReviewPrompt("quality", { base: BASE, specPath: "spec.md" });
    expect(prompt).toContain("one line per file");
    expect(prompt).not.toContain("one line per function");
  });

  test("AC-2: spec prompts retain one line per AC", () => {
    expect(buildReviewPrompt("spec", { base: BASE, specPath: "spec.md" })).toContain("one line per AC");
  });

  test("AC-3: quality prompts retain the private write-yourself function walk", () => {
    expect(buildReviewPrompt("quality", { base: BASE, specPath: "spec.md" })).toContain("write yourself");
  });

  test("AC-4: fresh quality prompts omit the spec path", () => {
    const specPath = ".nax/features/x/spec.md";
    expect(buildReviewPrompt("quality", { base: BASE, specPath })).not.toContain(specPath);
  });

  test("AC-5: incremental quality prompts omit the spec path", () => {
    const specPath = ".nax/features/x/spec.md";
    const prompt = buildReviewPrompt("quality", {
      base: BASE,
      specPath,
      since: "abc123",
      priorFindings: [{ severity: "HIGH", title: "finding", problem: "problem", fix: "fix" }],
    });
    expect(prompt).not.toContain(specPath);
  });

  test("AC-6: fresh and incremental spec prompts include the spec path", () => {
    const specPath = ".nax/features/x/spec.md";
    expect(buildReviewPrompt("spec", { base: BASE, specPath })).toContain(specPath);
    expect(buildReviewPrompt("spec", { base: BASE, specPath, since: "abc123" })).toContain(specPath);
  });

  test("AC-7: quality prompts retain all three reply sections", () => {
    const prompt = buildReviewPrompt("quality", { base: BASE, specPath: "spec.md" });
    expect(prompt).toContain("## TOUCHPOINTS");
    expect(prompt).toContain("## WALK");
    expect(prompt).toContain("## FINDINGS");
  });

  test("AC-8: a quality WALK covering every changed file has no unwalked gap", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"]);
      expect(gaps.some((gap) => /unwalked|src\/a\.ts|src\/b\.ts/i.test(gap))).toBe(false);
    });
  });

  test("AC-9: a quality WALK names each changed file that remains unwalked", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts", "src/b.ts"], ["src/a.ts"]);
      expect(gaps.some((gap) => gap.includes("src/b.ts"))).toBe(true);
    });
  });

  test("AC-10: a WALK's leading path token counts despite its explanatory text", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts"], ["src/a.ts — earns its place"]);
      expect(gaps.some((gap) => /src\/a\.ts.*unwalked|unwalked.*src\/a\.ts/i.test(gap))).toBe(false);
    });
  });

  test("AC-11: .nax artifacts are excluded from required quality WALK files", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts", "packages/core/.nax/config.json"], ["src/a.ts"]);
      expect(gaps.some((gap) => /unwalked/i.test(gap) && /\.nax\/|packages\/core\/\.nax\/config\.json/i.test(gap))).toBe(false);
    });
  });

  test("AC-12: lockfiles are excluded from required quality WALK files", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts", "bun.lock"], ["src/a.ts"]);
      expect(gaps.some((gap) => /unwalked/i.test(gap) && /bun\.lock|lock/i.test(gap))).toBe(false);
    });
  });

  test("AC-13: a failed changed-file lookup adds no unwalked-files gap", async () => {
    await withTempDir(async (workdir) => {
      stubChangedFiles("", 1);
      const gaps = await auditGaps(report({ walk: ["src/a.ts"] }), workdir, { base: BASE, head: "HEAD" }, "quality");
      expect(gaps.some((gap) => /unwalked[ -]files/i.test(gap))).toBe(false);
    });
  });

  test("AC-14: a failed changed-file lookup retains exactly the touchpoints shape gap", async () => {
    await withTempDir(async (workdir) => {
      stubChangedFiles("", 1);
      const gaps = await auditGaps(
        report({ touchpoints: undefined, sawTouchpointsSection: false, walk: ["src/a.ts"] }),
        workdir,
        { base: BASE, head: "HEAD" },
        "quality",
      );
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatch(/touchpoints?.*(section|shape)|no.*touchpoints?/i);
    });
  });

  test("AC-15: spec review WALK coverage is never gated against changed files", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts"], ["src/b.ts"], {}, "spec");
      expect(gaps.some((gap) => /unwalked[ -]files/i.test(gap))).toBe(false);
    });
  });

  test("AC-16: mostly missing touchpoint paths produce a named touchpoint gap", async () => {
    await withTempDir(async (workdir) => {
      await writePaths(workdir, ["one.ts"]);
      const gaps = await gapsFor(workdir, [], ["src/a.ts"], {
        touchpoints: ["one.ts", "two.ts", "three.ts", "four.ts"].map((path) => ({ path, note: "opened" })),
      });
      const touchpointGap = gaps.find((gap) => /touchpoint/i.test(gap));
      expect(touchpointGap).toBeDefined();
      expect(["two.ts", "three.ts", "four.ts"].filter((path) => touchpointGap?.includes(path)).length).toBeGreaterThanOrEqual(3);
    });
  });

  test("AC-17: mostly existing touchpoint paths do not produce a touchpoint gap", async () => {
    await withTempDir(async (workdir) => {
      await writePaths(workdir, ["one.ts", "two.ts", "three.ts"]);
      const gaps = await gapsFor(workdir, [], ["src/a.ts"], {
        touchpoints: ["one.ts", "two.ts", "three.ts", "four.ts"].map((path) => ({ path, note: "opened" })),
      });
      expect(gaps.some((gap) => /touchpoint/i.test(gap))).toBe(false);
    });
  });

  test("AC-18: an absent or empty WALK yields exactly one missing-WALK gap", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, [], [], { sawWalkSection: false });
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatch(/no.*walk|walk.*(missing|absent|no)/i);
    });
  });

  test("AC-19: a diff made only of noise files has no unwalked-files gap", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, [".nax/config.json", "bun.lock", "package.json"], ["src/a.ts"]);
      expect(gaps.some((gap) => /unwalked[ -]files/i.test(gap))).toBe(false);
    });
  });

  test("AC-20: malformed and blank WALK lines do not cover another changed file", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts", "src/b.ts"], ["— some comment without file path", "   ", "src/a.ts"]);
      expect(gaps.some((gap) => gap.includes("src/b.ts"))).toBe(true);
    });
  });

  test("AC-21: WALK paths outside the changed set do not create an unwalked gap", async () => {
    await withTempDir(async (workdir) => {
      const gaps = await gapsFor(workdir, ["src/a.ts"], ["src/a.ts", "src/c.ts"]);
      expect(gaps.some((gap) => /unwalked/i.test(gap))).toBe(false);
    });
  });

  test("AC-22: finishReviewOp.verify passes the review range to the git seam", async () => {
    await withTempDir(async (workdir) => {
      const spawn = stubChangedFiles("src/a.ts");
      const verify = finishReviewOp.verify;
      if (!verify) throw new Error("finishReviewOp.verify must be defined");
      await verify(report(), { phase: "quality", base: BASE, specPath: "spec.md", workdir }, {} as never);
      expect(spawn).toHaveBeenCalled();
      expect(spawn.mock.calls[0][0]).toContain(`${BASE}...HEAD`);
    });
  });
});