/**
 * The finish PR diffstat against a real git repository.
 *
 * `pr-context.test.ts` asserts the pathspec *string* the loader passes. That
 * cannot catch the bug this exists for: the string was right in spirit and
 * wrong in behaviour. nax writes run artifacts to a repo-root `.nax/` AND to a
 * per-package `<pkg>/.nax/` in a monorepo, and a root-anchored `:!.nax/**`
 * excludes only the first while reading as though it covers both — on the run
 * that motivated this, the per-package copy it kept was the largest file in
 * the diff.
 *
 * So these tests run real `git diff` over a real repo carrying artifacts at
 * both depths, and pin git's matching semantics rather than our spelling of
 * them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { createFinishState, loadFinishPrContext } from "@/finish";

const ROOT_ARTIFACT = ".nax/features/f/spec.md";
const PACKAGE_ARTIFACT = "packages/api/.nax/features/f/_nax_acceptance_test.py";
const REAL_CODE = "packages/api/src/app.py";

let testDir: string;
let repo: string;
let baseSha: string;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

function write(relPath: string, contents: string): void {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

beforeEach(async () => {
  testDir = makeTempDir("finish-diffstat-");
  repo = join(testDir, "repo");
  mkdirSync(repo, { recursive: true });

  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);

  write("README.md", "# fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  // The base is the SHA, not a branch name: `git init` picks master or main
  // depending on the host's git config, and this test cares about neither.
  baseSha = await git(["rev-parse", "HEAD"]);

  // One commit carrying artifacts at BOTH depths plus genuine source.
  write(ROOT_ARTIFACT, "# spec\n".repeat(20));
  write(PACKAGE_ARTIFACT, "assert True\n".repeat(30));
  write(REAL_CODE, "def readyz():\n    return True\n");
  await git(["add", "."]);
  await git(["commit", "-m", "feat: work plus nax artifacts"]);
});

afterEach(() => {
  cleanupTempDir(testDir);
});

function stateFor(base: string) {
  return createFinishState({
    feature: "f",
    workdir: repo,
    branch: "feat/f",
    runId: "run-1",
    base,
    specPath: ".nax/features/f/spec.md",
  });
}

const load = () =>
  loadFinishPrContext({
    state: stateFor(baseSha),
    audit: { auditDir: join(repo, ".nax", "audit"), runId: "run-1" },
  });

describe("finish PR diffstat — nax artifact exclusion", () => {
  test("excludes the repo-root .nax/ directory", async () => {
    const ctx = await load();
    expect(ctx.diffstat).toBeDefined();
    expect(ctx.diffstat).not.toContain(".nax/features/f/spec.md");
  });

  test("excludes a per-package .nax/ directory — the monorepo case", async () => {
    // The regression that shipped in a downstream PR: a root-anchored
    // pathspec leaves this file in the diffstat.
    const ctx = await load();
    expect(ctx.diffstat).not.toContain("_nax_acceptance_test.py");
    expect(ctx.diffstat).not.toContain("packages/api/.nax");
  });

  test("keeps genuine source that merely sits beside a .nax/ directory", async () => {
    // `packages/api/` contains an artifact dir; excluding the package wholesale
    // would be just as wrong as excluding nothing.
    const ctx = await load();
    expect(ctx.diffstat).toContain("packages/api/src/app.py");
  });

  test("reports the excluded artifacts so the body still reconciles with the diff", async () => {
    const ctx = await load();
    expect(ctx.artifactSummary).toContain("2 files changed");
  });

  test("renders no artifact summary when the branch touched no .nax/ path", async () => {
    write("packages/api/src/other.py", "x = 1\n");
    await git(["add", "."]);
    await git(["commit", "-m", "code only"]);
    const onlyCode = await loadFinishPrContext({
      state: stateFor(await git(["rev-parse", "HEAD~1"])),
      audit: { auditDir: join(repo, ".nax", "audit"), runId: "run-1" },
    });
    expect(onlyCode.diffstat).toContain("other.py");
    expect(onlyCode.artifactSummary).toBeUndefined();
  });
});
