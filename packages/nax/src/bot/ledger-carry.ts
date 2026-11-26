/** Carry only an append-only main-checkout advisor ledger into the PR checkout. */
import { join, relative } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { ledgerPath } from "@/advisor";
import { featureDir, PROJECT_FEATURES_DIR } from "@/config";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { StepResult } from "@/step-graph";
import { ledgerCommitMessage, readHead } from "../workflow/git";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { botGit } from "./git";

export async function readLedgerText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function isLedgerAppend(before: string | null, after: string | null): after is string {
  const prefix = before ?? "";
  return after !== null && after.length > prefix.length && after.startsWith(prefix);
}

export const _ledgerCarryDeps = {
  runGit: botGit,
  readHead,
  readText: readLedgerText,
  writeText: async (path: string, text: string): Promise<void> => {
    await Bun.write(path, text);
  },
  removeFile: async (path: string): Promise<void> => {
    await Bun.file(path).delete();
  },
  getLogger,
};

export function ledgerFeature(env: BotFixEnv): string | undefined {
  const candidates = env.checkout.changedFiles.filter((path) => {
    const parts = path.slice(PROJECT_FEATURES_DIR.length + 1).split("/");
    return path.startsWith(`${PROJECT_FEATURES_DIR}/`) && parts.length === 2 && parts[1] === "prd.json";
  });
  if (candidates.length !== 1) return undefined;
  const feature = candidates[0]?.slice(PROJECT_FEATURES_DIR.length + 1).split("/")[0];
  if (!feature) return undefined;
  // Validate via the canonical feature-path boundary before any ledger I/O.
  return relative(env.repoRoot, join(featureDir(env.repoRoot, feature), "prd.json")) === candidates[0]
    ? feature
    : undefined;
}

async function git(args: string[], cwd: string): Promise<void> {
  const result = await _ledgerCarryDeps.runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new NaxError(`[bot-fix] Advisor ledger git ${args[0]} failed`, "BOT_LEDGER_CARRY_FAILED", {
      stage: "bot-fix",
      cwd,
      args,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
}

function warn(env: BotFixEnv, message: string, error?: unknown): void {
  _ledgerCarryDeps.getLogger()?.warn("bot-fix", message, {
    pr: env.info.number,
    worktree: env.checkout.worktree,
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  });
}

async function restore(env: BotFixEnv, path: string, previous: string | null): Promise<void> {
  try {
    await git(["reset", "-q", "HEAD", "--", relative(env.checkout.worktree, path)], env.checkout.worktree);
  } catch (error) {
    // Still restore the file when the index reset fails; surface both failures independently.
    warn(env, "Advisor ledger rollback could not reset index", error);
  }
  try {
    if (previous === null) await _ledgerCarryDeps.removeFile(path);
    else await _ledgerCarryDeps.writeText(path, previous);
  } catch (error) {
    warn(env, "Advisor ledger rollback could not restore file", error);
  }
}

async function carry(env: BotFixEnv, feature: string): Promise<boolean> {
  const path = ledgerPath(env.checkout.worktree, feature);
  const [main, previous] = await Promise.all([
    _ledgerCarryDeps.readText(ledgerPath(env.repoRoot, feature)),
    _ledgerCarryDeps.readText(path),
  ]);
  if (main === null || main === previous) return false;
  if (!isLedgerAppend(previous, main)) {
    warn(env, "Main checkout ledger does not extend the PR's; not carried");
    return false;
  }
  const rel = relative(env.checkout.worktree, path);
  try {
    await _ledgerCarryDeps.writeText(path, main);
    await git(["add", "-f", "--", rel], env.checkout.worktree);
    await git(["commit", "--no-verify", "-m", ledgerCommitMessage(feature), "--", rel], env.checkout.worktree);
    return true;
  } catch (error) {
    await restore(env, path, previous);
    warn(env, "Advisor ledger not carried", error);
    return false;
  }
}

/** The in-place ledger is authoritative. Never undo an append if Git cannot persist it. */
export async function commitInPlaceAppend(
  env: BotFixEnv,
  appended: NonNullable<BotFixEnv["advisorLedger"]>,
): Promise<boolean> {
  const cwd = env.checkout.worktree;
  const path = ledgerPath(cwd, appended.feature);
  const rel = relative(cwd, path);
  try {
    if ((await _ledgerCarryDeps.readText(path)) !== appended.after) return false;
    await git(["add", "-f", "--", rel], cwd);
    await git(["commit", "--no-verify", "-m", ledgerCommitMessage(appended.feature), "--", rel], cwd);
    return true;
  } catch (error) {
    // A concurrent commit (or one reported as failed) may already contain the decision.
    const committed = await _ledgerCarryDeps.runGit(["show", `HEAD:${rel}`], cwd).catch(() => null);
    if (committed?.exitCode === 0 && committed.stdout === appended.after) return true;
    warn(env, "Advisor ledger append pending persistence", error);
    return false;
  }
}

export async function ledgerStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const patch: { ledgerCarried?: true } = {};
  if (env.checkout.inPlace) {
    // In-place advice was persisted before setup; never stage setup or fixer changes here.
    if (env.advisorLedger) patch.ledgerCarried = true;
  } else {
    try {
      const feature = ledgerFeature(env);
      if (feature && (await carry(env, feature))) patch.ledgerCarried = true;
    } catch (error) {
      warn(env, "Advisor ledger not carried", error);
    }
  }
  try {
    const head = await _ledgerCarryDeps.readHead(env.checkout.worktree);
    return { patch, exit: head !== env.info.headSha ? "push" : "skip" };
  } catch (error) {
    warn(env, "Advisor ledger step could not read HEAD", error);
    // A successful carry committed a new ledger; an unreadable HEAD must not bypass its push.
    return { patch, exit: patch.ledgerCarried ? "push" : "skip" };
  }
}
