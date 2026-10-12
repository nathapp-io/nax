/** Shared real-git fixture for the set-aside integration tests. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _finishGitDeps } from "@/finish/commit";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return new Response(p.stdout).text();
}

export async function repo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "keep.ts"), "export const keep = 1;\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
}

export const now = () => "2026-10-12T00:00:00.000Z";

/** Runs `fn` with a fresh repo and a separate audit dir outside it. */
export async function withRepo(
  fn: (dir: string, audit: { auditDir: string; runId: string }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      await repo(dir);
      await fn(dir, { auditDir: outside, runId: "run-1" });
    });
  });
}

type GitResult = Awaited<ReturnType<typeof _finishGitDeps.git>>;

/** Makes every git call whose argv matches `match` fail (exit 1). Returns the undo. */
export function failGit(match: (args: string[]) => boolean): () => void {
  const real = _finishGitDeps.git;
  _finishGitDeps.git = async (args, cwd, ms) => {
    if (match(args)) return { stdout: "", stderr: "injected", exitCode: 1 } satisfies GitResult;
    return real(args, cwd, ms);
  };
  return () => {
    _finishGitDeps.git = real;
  };
}

export async function commitAll(dir: string, msg: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", msg);
}
