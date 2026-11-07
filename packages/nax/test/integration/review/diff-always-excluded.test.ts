/**
 * ALWAYS_EXCLUDED (nax#2112), pinned at the collector seam against real git.
 *
 * `src/review/diff-utils.ts`'s `ALWAYS_EXCLUDED` — spread from
 * `NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS` (`src/utils/nax-owned-paths.ts`) — governs
 * what `collectDiffFileList` ever shows a caller. It had zero test coverage
 * (`grep -rn ALWAYS_EXCLUDED test/` found nothing) despite the pathspecs being
 * subtle: the source comments warn that a leading-doublestar, trailing-slash
 * spelling with no trailing element is INERT in real git, so `:!.nax/` is the
 * only entry that hides the cwd-level `.nax/` directory, and a nested exclude
 * needs its own trailing double-star element. That invariant used to be defended
 * only by a comment.
 *
 * These tests build a REAL git repo (the pathspec semantics are the thing
 * under test — mocking git would defeat the purpose) with both root-level and
 * nested `.nax/` + `.nax-pids` paths changed alongside ordinary tracked files,
 * and assert the real collector never surfaces the four excluded shapes while
 * still surfacing the ordinary changes. Pinned at the collector's OUTPUT, not
 * against `ALWAYS_EXCLUDED`'s literal contents, so a reformulation of the
 * pathspecs (that preserves the four real-git-verified exclusions) stays green.
 *
 * The other collectors this suite used to pin (`collectDiff`, `collectDiffStat`)
 * went with the embedded-diff prompt path in US-003 (pipeline-review-delete);
 * `collectDiffFileList` is the surviving consumer of these pathspecs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { collectDiffFileList } from "@/review";

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
  testDir = makeTempDir("review-diff-always-excluded-");
  repo = join(testDir, "repo");
  mkdirSync(repo, { recursive: true });

  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);

  write("README.md", "# repo\n");
  write("packages/lib/src/util.ts", "export const trim = (s: string) => s.trim();\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  baseSha = await git(["rev-parse", "HEAD"]);

  // One commit touching:
  //   - ordinary tracked files (must survive exclusion), at root and package level
  //   - the cwd-level .nax/ directory (root)
  //   - a nested .nax/ directory (packages/lib/.nax/)
  //   - the cwd-level .nax-pids file (root)
  //   - a nested .nax-pids file (packages/lib/.nax-pids)
  write("README.md", "# repo\n\nUpdated.\n");
  write(
    "packages/lib/src/util.ts",
    "export const trim = (s: string) => s.trim();\nexport const shout = (s: string) => s;\n",
  );
  write(".nax/status.json", '{"phase":"execution"}\n');
  write("packages/lib/.nax/mono/packages/lib/config.json", "{}\n");
  write(".nax-pids", "12345\n");
  write("packages/lib/.nax-pids", "67890\n");
  await git(["add", "."]);
  await git(["commit", "-m", "feat: touch ordinary files and nax-owned paths"]);
});

afterEach(() => {
  cleanupTempDir(testDir);
});

describe("ALWAYS_EXCLUDED at the collectDiffFileList seam (real git)", () => {
  test("excludes nax-owned paths and keeps ordinary files", async () => {
    const files = await collectDiffFileList(repo, baseSha);

    expect(files).toBeDefined();
    expect(files).toContain("README.md");
    expect(files).toContain("packages/lib/src/util.ts");

    expect(files).not.toContain(".nax/status.json");
    expect(files).not.toContain("packages/lib/.nax/mono/packages/lib/config.json");
    expect(files).not.toContain(".nax-pids");
    expect(files).not.toContain("packages/lib/.nax-pids");
  });
});
