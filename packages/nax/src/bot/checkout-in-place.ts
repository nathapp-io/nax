import { join, relative } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { featureDir, PROJECT_FEATURES_DIR } from "@/config";
import { NaxError } from "@/errors";
import type { PrInfo, PrRef } from "@/forge";
import {
  _checkoutDeps,
  botWorktreePath,
  checkoutRefs,
  cleanupCheckout,
  fetchCheckoutRefs,
  type PrCheckout,
} from "./checkout";

function refused(reason: string): never {
  throw new NaxError(`[bot] In-place checkout refused: ${reason}`, "BOT_IN_PLACE_REFUSED", { stage: "bot" });
}

async function runGit(argv: string[], repoRoot: string): Promise<Awaited<ReturnType<typeof _checkoutDeps.runGit>>> {
  try {
    return await _checkoutDeps.runGit(argv, repoRoot);
  } catch (cause) {
    throw new NaxError(`[bot] git ${argv[0]} failed: ${errorMessage(cause)}`, "BOT_CHECKOUT_FAILED", {
      stage: "bot",
      argv,
      repoRoot,
      cause,
    });
  }
}

async function git(argv: string[], repoRoot: string): Promise<string> {
  const result = await runGit(argv, repoRoot);
  if (result.exitCode !== 0) {
    throw new NaxError(`[bot] git ${argv[0]} failed: ${result.stderr}`, "BOT_CHECKOUT_FAILED", {
      stage: "bot",
      argv,
      repoRoot,
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
}

async function checkLocalCheckout(repoRoot: string, info: PrInfo): Promise<void> {
  if (info.crossRepo) refused("PR head is in another repository");
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot);
  if (branch.exitCode !== 0 || branch.stdout.trim() !== info.headRef) refused(`check out ${info.headRef} first`);
  if ((await git(["status", "--porcelain"], repoRoot)).trim()) refused("working tree is not clean");
}

function isFeatureLedger(repoRoot: string, path: string): boolean {
  const prefix = `${PROJECT_FEATURES_DIR}/`;
  if (!path.startsWith(prefix)) return false;
  const parts = path.slice(prefix.length).split("/");
  if (parts.length !== 2 || parts[1] !== "decisions.jsonl") return false;
  try {
    return path === relative(repoRoot, join(featureDir(repoRoot, parts[0] ?? ""), "decisions.jsonl"));
  } catch {
    // Invalid feature IDs cannot grant permission for a local commit.
    return false;
  }
}

async function checkLocalCommits(repoRoot: string, headSha: string): Promise<string> {
  const startHead = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
  const argv = ["merge-base", "--is-ancestor", headSha, "HEAD"];
  const ancestor = await runGit(argv, repoRoot);
  if (ancestor.exitCode === 1) refused("local HEAD does not contain the PR head; pull first");
  if (ancestor.exitCode !== 0) {
    throw new NaxError(`[bot] git merge-base failed: ${ancestor.stderr}`, "BOT_CHECKOUT_FAILED", {
      stage: "bot",
      argv,
      repoRoot,
      exitCode: ancestor.exitCode,
    });
  }
  const paths = (await git(["diff", "--name-only", "-z", "--no-renames", headSha, "HEAD"], repoRoot))
    .split("\0")
    .filter(Boolean);
  // A net tree diff misses source changes reverted by later local commits. Inspect
  // every commit as well; -m includes merge changes against each parent.
  const touched = (
    await git(["log", "--format=", "--name-only", "-z", "--no-renames", "-m", `${headSha}..HEAD`], repoRoot)
  )
    .split("\0")
    .filter(Boolean);
  if ([...paths, ...touched].some((path) => !isFeatureLedger(repoRoot, path)))
    refused("local branch has commits the PR does not have");
  return startHead;
}

/** Admit a clean same-repository PR branch without ever changing the user's checkout. */
export async function prepareInPlaceCheckout(input: {
  repoRoot: string;
  ref: PrRef;
  info: PrInfo;
  suffix: string;
}): Promise<PrCheckout> {
  const { repoRoot, ref, info, suffix } = input;
  await _checkoutDeps.ensureGitExcludes(repoRoot);
  await checkLocalCheckout(repoRoot, info);
  botWorktreePath(repoRoot, ref.number, suffix); // Reuse suffix validation without reserving a worktree.
  const refs = checkoutRefs(ref.number, suffix);
  let snapshotDir: string | undefined;
  try {
    const { baseSha, mergeBase } = await fetchCheckoutRefs({ repoRoot, ref, info, refs });
    const startHead = await checkLocalCommits(repoRoot, info.headSha);
    snapshotDir = await _checkoutDeps.mkdtemp();
    const hasBaseNax = await _checkoutDeps.snapshotBaseNax(repoRoot, baseSha, snapshotDir);
    const changedFiles = (await git(["diff", "--name-only", "-z", "--no-renames", mergeBase, info.headSha], repoRoot))
      .split("\0")
      .filter(Boolean);
    const artifacts = { repoRoot, refs, snapshotDir };
    return {
      worktree: repoRoot,
      inPlace: true,
      startHead,
      baseSha,
      mergeBase,
      snapshotDir,
      hasBaseNax,
      changedFiles,
      dispose: () => cleanupCheckout(artifacts),
    };
  } catch (cause) {
    await cleanupCheckout({ repoRoot, refs, snapshotDir });
    throw cause;
  }
}
