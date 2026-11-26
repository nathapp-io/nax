/** Carry only an append-only main-checkout advisor ledger into the PR checkout. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { ledgerPath } from "@/advisor";
import { featureDir, PROJECT_FEATURES_DIR } from "@/config";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { StepResult } from "@/step-graph";
import { gitWithTimeout } from "@/utils/git";
import { ledgerCommitMessage, readHead } from "../workflow/git";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { BOT_GIT_HOOKS_OFF, botGit } from "./git";

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

/** Every line of `text` followed by a newline; an unterminated last line is not a complete line. */
function completeLines(text: string): string[] {
  return text.split("\n").slice(0, -1);
}

/**
 * #3058: the ledger text `carry` commits. A whole-text append is carried verbatim; anything else —
 * a divergent PR ledger, or an append that touches an unterminated last line — merges by line, so
 * the PR keeps its own lines and gains every complete main line it lacks, in main's order.
 *
 * `null` when main holds no complete line the PR lacks: there is nothing to carry.
 */
export function mergedLedgerText(previous: string | null, main: string): string | null {
  const prefix = previous ?? "";
  const terminated = prefix === "" || prefix.endsWith("\n");
  if (terminated && main.endsWith("\n") && isLedgerAppend(previous, main)) return main;
  const held = new Set(prefix.split("\n"));
  const missing = completeLines(main).filter(
    (line, index, lines) => line !== "" && !held.has(line) && lines.indexOf(line) === index,
  );
  if (missing.length === 0) return null;
  return `${terminated ? prefix : `${prefix}\n`}${missing.map((line) => `${line}\n`).join("")}`;
}

/** Git against a throwaway index, so the user's index and working file are never read for the commit. */
function indexGit(args: string[], cwd: string, indexFile: string): ReturnType<typeof gitWithTimeout> {
  // nax-git-env-allow: handed to gitWithTimeout, which hardens it
  const argv = ["git", ...BOT_GIT_HOOKS_OFF, ...args];
  return gitWithTimeout(args, cwd, undefined, undefined, argv, { GIT_INDEX_FILE: indexFile });
}

export const _ledgerCarryDeps = {
  runGit: botGit,
  runIndexGit: indexGit,
  makeTempDir: (prefix: string): Promise<string> => mkdtemp(prefix),
  removeDir: (path: string): Promise<void> => rm(path, { recursive: true, force: true }),
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

async function git(args: string[], cwd: string, indexFile?: string): Promise<string> {
  const result =
    indexFile === undefined
      ? await _ledgerCarryDeps.runGit(args, cwd)
      : await _ledgerCarryDeps.runIndexGit(args, cwd, indexFile);
  if (result.exitCode !== 0) {
    throw new NaxError(`[bot-fix] Advisor ledger git ${args[0]} failed`, "BOT_LEDGER_CARRY_FAILED", {
      stage: "bot-fix",
      cwd,
      args,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return result.stdout.trim();
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
  const merged = mergedLedgerText(previous, main);
  if (merged === null) {
    warn(env, "Main checkout ledger does not extend the PR's; not carried");
    return false;
  }
  const rel = relative(env.checkout.worktree, path);
  try {
    await _ledgerCarryDeps.writeText(path, merged);
    await git(["add", "-f", "--", rel], env.checkout.worktree);
    await git(["commit", "--no-verify", "-m", ledgerCommitMessage(feature), "--", rel], env.checkout.worktree);
    return true;
  } catch (error) {
    await restore(env, path, previous);
    warn(env, "Advisor ledger not carried", error);
    return false;
  }
}

const TEMP_LEDGER_PREFIX = "nax-bot-ledger-";
const DEFAULT_FILE_MODE = "100644";
/** Regular-file modes only: a symlink or gitlink ledger is never rewritten as one. */
const LEDGER_FILE_MODES: ReadonlySet<string> = new Set([DEFAULT_FILE_MODE, "100755"]);

/** `commit-tree` ignores `commit.gpgSign`, so the signing `git commit` would apply is passed explicitly. */
async function signFlag(cwd: string): Promise<string[]> {
  const args = ["config", "--type=bool", "--get", "commit.gpgSign"];
  const result = await _ledgerCarryDeps.runGit(args, cwd);
  // Exit 1 is "not set"; anything else that is not 0 is an unreadable config, which refuses persistence.
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    throw new NaxError("[bot-fix] Advisor ledger git config failed", "BOT_LEDGER_CARRY_FAILED", {
      stage: "bot-fix",
      cwd,
      args,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return result.stdout.trim() === "true" ? ["-S"] : [];
}

async function ledgerMode(cwd: string, rel: string, index: string): Promise<string> {
  const mode = (await git(["ls-files", "-s", "--", `:(literal)${rel}`], cwd, index)).split(" ")[0] || DEFAULT_FILE_MODE;
  if (!LEDGER_FILE_MODES.has(mode)) {
    throw new NaxError("[bot-fix] Advisor ledger is not a regular file", "BOT_LEDGER_CARRY_FAILED", {
      stage: "bot-fix",
      rel,
      mode,
    });
  }
  return mode;
}

/** #3057: an index entry holding the user's own staged version is theirs, never cleared. */
const INDEX_LEFT_AS_IS = "Advisor ledger committed; the staged ledger differs and was left as is";

/** The blob the user's real index holds for `rel`; `undefined` when the path has no entry. */
async function indexEntryBlob(cwd: string, rel: string): Promise<string | undefined> {
  return (await git(["ls-files", "-s", "--", `:(literal)${rel}`], cwd)).split(" ")[1] || undefined;
}

/** The parent commit's blob for `rel`; `undefined` when the parent did not hold the file. */
async function parentLedgerBlob(cwd: string, parent: string, rel: string): Promise<string | undefined> {
  const result = await _ledgerCarryDeps.runGit(["rev-parse", "--verify", "--quiet", `${parent}:${rel}`], cwd);
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

/** The real index entry follows the new HEAD, as `git commit -- <path>` would leave it. */
async function resetIndexToHead(env: BotFixEnv, rel: string): Promise<void> {
  const args = ["reset", "-q", "HEAD", "--", `:(literal)${rel}`];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await git(args, env.checkout.worktree);
      return;
    } catch (error) {
      // A held index.lock (the user's own git or editor) is the likely cause; one retry, then say what to run.
      if (attempt === 1)
        warn(
          env,
          `Advisor ledger committed, but the index still holds the old ledger: run git reset -q HEAD -- ${rel}`,
          error,
        );
    }
  }
}

/**
 * #3057: refresh the real index entry only when it held nothing of the user's — it matched the parent
 * commit or already the new blob, or neither the parent nor the index had an entry. A different
 * version was staged by the user during the run; clearing it would discard their work. An unreadable
 * index skips the refresh too: the append is already committed and must not be undone by it.
 */
async function refreshIndexEntry(input: {
  env: BotFixEnv;
  rel: string;
  parentBlob: string | undefined;
  blob: string;
}): Promise<void> {
  const { env, rel, parentBlob, blob } = input;
  let current: string | undefined;
  try {
    current = await indexEntryBlob(env.checkout.worktree, rel);
  } catch (error) {
    warn(env, INDEX_LEFT_AS_IS, error);
    return;
  }
  if (current !== parentBlob && current !== blob) {
    warn(env, INDEX_LEFT_AS_IS);
    return;
  }
  await resetIndexToHead(env, rel);
}

/**
 * #3047: commit exactly `text` at `rel` on top of HEAD. The blob is hashed from a private copy and the
 * tree is built in a throwaway index, so a concurrent edit to the live file can neither change what
 * is committed nor be overwritten: it stays in the working tree. HEAD moves by compare-and-swap.
 */
async function commitExactText(input: { env: BotFixEnv; rel: string; text: string; message: string }): Promise<void> {
  const { env, rel, text, message } = input;
  const cwd = env.checkout.worktree;
  const dir = await _ledgerCarryDeps.makeTempDir(join(tmpdir(), TEMP_LEDGER_PREFIX));
  try {
    const copy = join(dir, "ledger");
    const index = join(dir, "index");
    await _ledgerCarryDeps.writeText(copy, text);
    const blob = await git(["hash-object", "-w", `--path=${rel}`, "--", copy], cwd);
    const parent = await git(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
    await git(["read-tree", parent], cwd, index);
    const mode = await ledgerMode(cwd, rel, index);
    await git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${rel}`], cwd, index);
    const tree = await git(["write-tree"], cwd, index);
    // Already committed (e.g. by the user): nothing to persist.
    if (tree === (await git(["rev-parse", `${parent}^{tree}`], cwd))) return;
    const sign = await signFlag(cwd);
    const commit = await git(["commit-tree", ...sign, tree, "-p", parent, "-m", message], cwd);
    const parentBlob = await parentLedgerBlob(cwd, parent, rel);
    await git(["update-ref", "-m", `commit: ${message}`, "HEAD", commit, parent], cwd);
    await refreshIndexEntry({ env, rel, parentBlob, blob });
  } finally {
    await _ledgerCarryDeps.removeDir(dir).catch(() => {});
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
    await commitExactText({ env, rel, text: appended.after, message: ledgerCommitMessage(appended.feature) });
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
