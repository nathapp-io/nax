import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { PrInfo, PrRef } from "@/forge";
import { getSafeLogger } from "@/logger";
import { gitWithTimeout } from "../utils/git";
import { WorktreeManager } from "../worktree/manager";
import { snapshotBaseNax } from "./base-config";

export const BASE_PINNED_PATHS = [
  ".nax/rules",
  ".claude",
  ".cursor",
  ".mcp.json",
  ".github/copilot-instructions.md",
] as const;
export const BASE_PINNED_NAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "codex.md", ".cursorrules"] as const;

export const _checkoutDeps = {
  runGit: gitWithTimeout,
  reserveWorktree: async (path: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path); // Exclusive: an existing checkout (even an empty directory) is never ours.
  },
  ensureGitExcludes: (repoRoot: string): Promise<void> => new WorktreeManager().ensureGitExcludes(repoRoot),
  snapshotBaseNax,
  rm: (path: string): Promise<void> => rm(path, { recursive: true, force: true }),
  mkdtemp: (): Promise<string> => mkdtemp(join(tmpdir(), "nax-bot-checkout-")),
  getLogger: getSafeLogger,
};

export interface PrCheckout {
  readonly worktree: string;
  readonly baseSha: string;
  readonly mergeBase: string;
  readonly snapshotDir: string;
  readonly hasBaseNax: boolean;
  readonly changedFiles: string[];
  /** Keep this checkout as a durable recovery artifact instead of deleting unfinished work. */
  retain?(): void;
  dispose(): Promise<void>;
}

export function botWorktreePath(repoRoot: string, n: number, suffix: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(suffix))
    throw new NaxError("[bot] Invalid checkout suffix", "BOT_CHECKOUT_SUFFIX_INVALID", { stage: "bot", suffix });
  return join(repoRoot, ".nax-wt", `bot-pr-${n}-${suffix}`); // nax-worktree-id-allow: Canonical bot PR path, not a story worktree.
}

async function git(argv: string[], cwd: string): Promise<string> {
  const result = await _checkoutDeps.runGit(argv, cwd);
  if (result.exitCode !== 0) {
    throw new NaxError(`[bot] git ${argv[0]} failed: ${result.stderr}`, "BOT_CHECKOUT_FAILED", {
      stage: "bot",
      cwd,
      argv,
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
}

/** Compare committed trees, not the base-pinned index. Disabling renames keeps both sides of moves. */
export async function changedPaths(cwd: string, from: string): Promise<string[]> {
  return (await git(["diff", "--name-only", "-z", "--no-renames", from, "HEAD"], cwd)).split("\0").filter(Boolean);
}

async function removeSymlinks(worktree: string): Promise<void> {
  const entries = (await git(["ls-files", "-s", "-z"], worktree)).split("\0");
  for (const entry of entries) {
    if (entry.startsWith("120000 ")) await _checkoutDeps.rm(join(worktree, entry.slice(entry.indexOf("\t") + 1)));
  }
}

function instructionPaths(output: string): string[] {
  return output.split("\0").filter((path) => BASE_PINNED_NAMES.some((name) => basename(path) === name));
}

async function removePinnedPath(path: string): Promise<void> {
  try {
    await _checkoutDeps.rm(path);
  } catch (cause) {
    // A head-controlled regular-file parent means this nested path is already absent.
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    )
      return;
    throw cause;
  }
}

async function pinInstructions(worktree: string, baseSha: string): Promise<void> {
  // Remove head links BEFORE any nested path is touched: a PR can make .nax or packages a link.
  await removeSymlinks(worktree);
  for (const path of BASE_PINNED_PATHS) {
    await removePinnedPath(join(worktree, path));
    const names = (await git(["ls-tree", "--name-only", "-z", baseSha, "--", path], worktree)).split("\0");
    if (names.includes(path)) await git(["checkout", baseSha, "--", path], worktree);
  }
  await removeSymlinks(worktree);
  const headFiles = instructionPaths(await git(["ls-files", "-z"], worktree));
  for (const path of headFiles) await _checkoutDeps.rm(join(worktree, path));
  const baseFiles = instructionPaths(await git(["ls-tree", "-r", "--name-only", "-z", baseSha], worktree));
  for (const path of baseFiles) await git(["checkout", baseSha, "--", path], worktree);
  await removeSymlinks(worktree);
}

async function cleanup(input: {
  repoRoot: string;
  worktree?: string;
  snapshotDir?: string;
  failedAdd?: boolean;
}): Promise<void> {
  const { repoRoot, worktree, snapshotDir } = input;
  const actions = [
    ...(worktree ? [() => git(["worktree", "remove", "--force", worktree], repoRoot)] : []),
    // Git may have failed before registering our exclusively reserved empty directory.
    ...(worktree && input.failedAdd ? [() => _checkoutDeps.rm(worktree)] : []),
    ...(snapshotDir ? [() => _checkoutDeps.rm(snapshotDir)] : []),
  ];
  for (const action of actions) {
    try {
      await action();
    } catch (cause) {
      _checkoutDeps.getLogger()?.warn("bot", "Failed to dispose PR checkout artifact", {
        ...input,
        error: errorMessage(cause),
      });
    }
  }
}

async function fetchRefs(input: {
  repoRoot: string;
  ref: PrRef;
  info: PrInfo;
}): Promise<{ baseSha: string; mergeBase: string }> {
  const { repoRoot, ref, info } = input;
  const headSpec = ref.forge === "github" ? `pull/${ref.number}/head` : `merge-requests/${ref.number}/head`;
  await git(["fetch", "origin", headSpec], repoRoot);
  const headSha = (await git(["rev-parse", "FETCH_HEAD"], repoRoot)).trim();
  if (headSha !== info.headSha) {
    throw new NaxError(`[bot] PR ${ref.number} head moved`, "BOT_PR_HEAD_MOVED", {
      stage: "bot",
      expected: info.headSha,
      actual: headSha,
      number: ref.number,
    });
  }
  await git(["fetch", "origin", info.baseRef], repoRoot);
  const baseSha = (await git(["rev-parse", "FETCH_HEAD"], repoRoot)).trim();
  const mergeBase = (await git(["merge-base", baseSha, info.headSha], repoRoot)).trim();
  return { baseSha, mergeBase };
}

/** Prepare an isolated repo-root-contained PR checkout; unwind all owned artifacts on any failure. */
export async function preparePrCheckout(input: {
  repoRoot: string;
  ref: PrRef;
  info: PrInfo;
  suffix: string;
  pinBaseFiles: boolean;
}): Promise<PrCheckout> {
  const { repoRoot, ref, info, suffix, pinBaseFiles } = input;
  const { baseSha, mergeBase } = await fetchRefs(input);
  const worktree = botWorktreePath(repoRoot, ref.number, suffix);
  let created = false;
  let added = false;
  let snapshotDir: string | undefined;
  try {
    await _checkoutDeps.ensureGitExcludes(repoRoot);
    await _checkoutDeps.reserveWorktree(worktree);
    created = true; // Only our exclusive reservation grants cleanup ownership on a failed add.
    await git(["worktree", "add", "--detach", worktree, info.headSha], repoRoot);
    added = true;
    snapshotDir = await _checkoutDeps.mkdtemp();
    const hasBaseNax = await _checkoutDeps.snapshotBaseNax(repoRoot, baseSha, snapshotDir);
    if (pinBaseFiles) await pinInstructions(worktree, baseSha);
    const changedFiles = await changedPaths(worktree, mergeBase);
    const artifacts = { repoRoot, worktree, snapshotDir };
    let retained = false;
    return {
      worktree,
      baseSha,
      mergeBase,
      snapshotDir,
      hasBaseNax,
      changedFiles,
      retain: () => {
        retained = true;
      },
      dispose: () => cleanup({ ...artifacts, worktree: retained ? undefined : worktree }),
    };
  } catch (cause) {
    await cleanup({ repoRoot, worktree: created ? worktree : undefined, snapshotDir, failedAdd: !added });
    throw cause;
  }
}
