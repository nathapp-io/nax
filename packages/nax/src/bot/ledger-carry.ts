/** Carry only an append-only main-checkout advisor ledger into the PR checkout. */
import { copyFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
  /** Take a lock file the way git does — exclusively — answering false when someone else holds it. */
  createExclusive: async (path: string): Promise<boolean> => {
    try {
      await writeFile(path, "", { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  },
  copyFile: (from: string, to: string): Promise<void> => copyFile(from, to),
  rename: (from: string, to: string): Promise<void> => rename(from, to),
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

/** What git records for one path in a tree or an index entry: the mode and the blob at it. */
interface LedgerEntry {
  readonly mode: string;
  readonly blob: string;
}

/** One row of `git ls-files --stage`: an entry at one of the index's three merge stages. */
interface IndexRow extends LedgerEntry {
  readonly stage: string;
}

/** The real index file and the lock git takes to write it, spelled for this worktree. */
interface IndexPaths {
  readonly index: string;
  readonly lock: string;
}

/**
 * #3057/#B2: what the user's index holds for the ledger.
 *
 * `unmerged` is a conflict the user has not settled: stages 1-3 are the three sides of it, so
 * there is no single entry to compare and nothing of the user's to overwrite. Rewriting a
 * conflicted entry's first row — normally stage 2, the side this branch holds — resolves their
 * conflict to one side without them ever asking, and throws away the other two.
 */
type IndexLedger =
  | { readonly kind: "absent" }
  | { readonly kind: "unmerged" }
  | { readonly kind: "entry"; readonly entry: LedgerEntry };

/** `git ls-files --stage -z` rows: `<mode> <blob> <stage>\t<path>`, one NUL-terminated record each. */
function parseIndexRows(stdout: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode = "", blob = "", stage = ""] = record.slice(0, tab).split(" ");
    rows.push({ mode, blob, stage });
  }
  return rows;
}

/** What `parseIndexRows` rows say about the ledger. More than one row, or a nonzero stage, is a conflict. */
function indexLedger(rows: readonly IndexRow[]): IndexLedger {
  const only = rows.length === 1 ? rows[0] : undefined;
  if (rows.length === 0) return { kind: "absent" };
  if (only === undefined || only.stage !== "0") return { kind: "unmerged" };
  return { kind: "entry", entry: { mode: only.mode, blob: only.blob } };
}

/** The real index's rows for `rel` — all of them, so an unresolved conflict is visible as one. */
async function readIndexRows(cwd: string, rel: string): Promise<IndexRow[]> {
  return parseIndexRows(await git(["ls-files", "--stage", "-z", "--", `:(literal)${rel}`], cwd));
}

/** `git ls-tree -z` rows are `<mode> <type> <blob>\t<path>`; only the first record is the ledger. */
function treeEntry(stdout: string): LedgerEntry | undefined {
  const record = stdout.split("\0")[0] ?? "";
  const tab = record.indexOf("\t");
  if (tab === -1) return undefined;
  const [mode = "", , blob = ""] = record.slice(0, tab).split(" ");
  return { mode, blob };
}

/** The parent commit's mode and blob for `rel`; `undefined` when the parent did not hold the file. */
async function parentLedgerEntry(cwd: string, parent: string, rel: string): Promise<LedgerEntry | undefined> {
  const result = await _ledgerCarryDeps.runGit(["ls-tree", "-z", parent, "--", `:(literal)${rel}`], cwd);
  return result.exitCode === 0 ? treeEntry(result.stdout) : undefined;
}

/** Whether two entries are the same index entry: git records a mode as well as a content hash. */
function sameEntry(a: LedgerEntry | undefined, b: LedgerEntry | undefined): boolean {
  return a !== undefined && b !== undefined && a.mode === b.mode && a.blob === b.blob;
}

/**
 * #3057: whether the index entry holds nothing of the user's — it matches the parent commit or
 * already the blob just committed, or neither the parent nor the index had an entry. A staged mode
 * change is as much the user's as a staged version is, which is why the mode is compared too. An
 * unmerged entry is never one's own to rewrite (#B2).
 */
function refreshIsOurs(held: IndexLedger, parent: LedgerEntry | undefined, committed: LedgerEntry): boolean {
  if (held.kind === "unmerged") return false;
  if (held.kind === "absent") return parent === undefined;
  return sameEntry(held.entry, parent) || sameEntry(held.entry, committed);
}

/** The real index and its lock, honouring `GIT_INDEX_FILE` and a linked worktree's own index. */
async function realIndex(cwd: string): Promise<IndexPaths> {
  const index = resolve(cwd, await git(["rev-parse", "--git-path", "index"], cwd));
  return { index, lock: `${index}.lock` };
}

/**
 * Seed the index lock with the index it is about to replace, so every unrelated staged entry
 * survives. With no index at all there is nothing of the user's to preserve: HEAD's entries are
 * then the base, which is also the state a fresh index would have.
 */
async function seedIndexLock(paths: IndexPaths, cwd: string): Promise<void> {
  try {
    await _ledgerCarryDeps.copyFile(paths.index, paths.lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await git(["read-tree", "HEAD"], cwd, paths.lock);
  }
}

/**
 * Point the ledger's index entry at `entry`, preserving every other entry.
 *
 * The lock file is git's own write protocol: the index is copied into it, updated there through
 * `GIT_INDEX_FILE`, and renamed over the real index. A concurrent git either saw the index before
 * the rename or sees this one after it, never a half-written one, and every other staged entry is
 * carried across untouched.
 */
async function writeIndexEntry(input: {
  paths: IndexPaths;
  cwd: string;
  rel: string;
  entry: LedgerEntry;
}): Promise<void> {
  const { paths, cwd, rel, entry } = input;
  await seedIndexLock(paths, cwd);
  await git(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.blob},${rel}`], cwd, paths.lock);
  await _ledgerCarryDeps.rename(paths.lock, paths.index);
}

/**
 * #3057/#B1: refresh the real index entry only when it held nothing of the user's, and do the
 * comparison and the write while holding the repository's real index lock.
 *
 * The lock is what makes the pair atomic: holding `<index>.lock` is exactly what makes a
 * concurrent `git add` of the ledger fail instead of landing between the read and the write and
 * being discarded by it. Because that lock is the whole guarantee, the refresh is never retried:
 * a second attempt would only be a second window. An index that cannot be read, or is held by
 * someone else, skips the refresh — the append is already committed and must not be undone by it.
 */
async function refreshIndexEntry(input: {
  env: BotFixEnv;
  rel: string;
  parent: LedgerEntry | undefined;
  committed: LedgerEntry;
}): Promise<void> {
  const { env, rel, parent, committed } = input;
  const cwd = env.checkout.worktree;
  let paths: IndexPaths;
  try {
    paths = await realIndex(cwd);
  } catch (error) {
    warn(env, INDEX_LEFT_AS_IS, error);
    return;
  }
  if (!(await _ledgerCarryDeps.createExclusive(paths.lock))) {
    warn(env, INDEX_LEFT_AS_IS);
    return;
  }
  let written = false;
  try {
    const held = indexLedger(await readIndexRows(cwd, rel));
    if (!refreshIsOurs(held, parent, committed)) {
      warn(env, INDEX_LEFT_AS_IS);
      return;
    }
    await writeIndexEntry({ paths, cwd, rel, entry: committed });
    written = true;
  } catch (error) {
    warn(env, INDEX_LEFT_AS_IS, error);
  } finally {
    // The rename consumes the lock; every other way out has to release it here.
    if (!written) await _ledgerCarryDeps.removeFile(paths.lock).catch(() => {});
  }
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
    const parentEntry = await parentLedgerEntry(cwd, parent, rel);
    await git(["update-ref", "-m", `commit: ${message}`, "HEAD", commit, parent], cwd);
    await refreshIndexEntry({ env, rel, parent: parentEntry, committed: { mode, blob } });
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
