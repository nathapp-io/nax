/**
 * flow-repo.ts — the repository state a flow send reads before the card.
 *
 * koda reads the specs at the sha it is sent, creates a branch per feature and
 * refuses a repository it cannot recognise, so everything it needs is read here
 * first: the checked-out branch, a clean working tree, the head sha, a GitHub
 * origin and every spec path present at HEAD. The first failure is returned, in
 * that order, as one `[chat]` message — nothing is pushed and no card is shown.
 *
 * The tool never commits: a dirty tree is a failure, untracked spec files
 * included. Git is reached only through `_flowRepoDeps`, which tests replace.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { headSha, isDirty } from "@/finish";
import { gitWithTimeout, isPublishableBranch } from "@/utils/git";
import type { FlowSendFeature } from "./flow-input";

/** The message a detached HEAD fails with. */
const DETACHED_MESSAGE = "[chat] nax-flow__send needs a checked-out branch";
/** The message a working tree with changes fails with. */
const DIRTY_MESSAGE = "[chat] commit or stash your changes before sending a flow";
/** The prefix every unreadable repository state is reported with. */
const UNREADABLE_STATE_PREFIX = "[chat] could not read the repository state: ";
/** The message an unborn branch fails with. */
const NO_COMMITS_MESSAGE = "[chat] the branch has no commits";
/** The message a repository without an `origin` remote fails with. */
const NO_ORIGIN_MESSAGE = "[chat] the repository has no origin remote";

/** The three remote forms koda's `parseGitHubUrl` accepts, plus koda's own HTTPS form. */
const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)$/i;
const GITHUB_SCP_RE = /^git@github\.com:([^/?#]+)\/([^/?#]+)$/i;
const GITHUB_SSH_RE = /^ssh:\/\/git@github\.com\/([^/?#]+)\/([^/?#]+)$/i;
const GIT_SUFFIX = ".git";
const GITHUB_WEB_ROOT = "https://github.com";
/** A remote may be pasted with a trailing slash; the path segments never end in one. */
const TRAILING_SLASHES = /\/+$/;

/** koda's own ref rule for a feature branch. The source of truth lives in koda. */
const FLOW_BRANCH_RE = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/@+-]{1,255}$/;
/** The branch prefix koda derives from a feature name. */
const FEATURE_BRANCH_PREFIX = "feat/";

/** One git answer, trimmed to the fields the repository checks read. */
export interface FlowGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** One git call: argv without a leading `git`, and the directory it runs in. */
export type FlowGit = (args: string[], workdir: string) => Promise<FlowGitResult>;

/**
 * The seam every git and working-tree read goes through. The defaults are nax's
 * own helpers, so no raw spawn happens here and `check-git-spawn-env` holds.
 */
export const _flowRepoDeps: {
  git: FlowGit;
  isDirty: (repoRoot: string) => Promise<boolean>;
  headSha: (repoRoot: string) => Promise<string | null>;
} = { git: gitWithTimeout, isDirty, headSha };

/** The repository state a flow send may push from. */
export interface FlowRepoReady {
  readonly ok: true;
  /** The checked-out branch, as `symbolic-ref --short HEAD` names it. */
  readonly branch: string;
  /** The commit koda reads the specs at. */
  readonly sha: string;
  /** The origin remote in koda's one accepted form, `https://github.com/<owner>/<repo>`. */
  readonly remoteUrl: string;
}

/** Why a flow send cannot push from this repository. */
export interface FlowRepoFailure {
  readonly ok: false;
  /** A user-facing `[chat]` message naming the check that failed. */
  readonly message: string;
}

/** The repository state, or the first check that failed. */
export type FlowRepoState = FlowRepoReady | FlowRepoFailure;

/** The one thing the branch check reads from each feature: its name. */
export type FlowBranchFeature = Pick<FlowSendFeature, "feature">;

/** `segment` lower-cased and without a `.git` suffix — the repository of a remote. */
function repoName(segment: string): string {
  const name = segment.toLowerCase();
  return name.endsWith(GIT_SUFFIX) ? name.slice(0, -GIT_SUFFIX.length) : name;
}

/**
 * The origin remote in the one form koda accepts, or `null` for any other host
 * or shape. Lower-cased, without a `.git` suffix and without a trailing slash.
 *
 * @param url - The remote URL as `git remote get-url origin` prints it
 */
export function normalizeGitHubRemote(url: string): string | null {
  const trimmed = url.trim().replace(TRAILING_SLASHES, "");
  const match = trimmed.match(GITHUB_HTTPS_RE) ?? trimmed.match(GITHUB_SCP_RE) ?? trimmed.match(GITHUB_SSH_RE);
  if (match === null) return null;
  const owner = (match[1] ?? "").toLowerCase();
  const repo = repoName(match[2] ?? "");
  if (owner.length === 0 || repo.length === 0) return null;
  return `${GITHUB_WEB_ROOT}/${owner}/${repo}`;
}

/**
 * One git call, or `null` when it did not answer with exit 0. A rejection is the
 * same "git could not answer" as a non-zero exit: both leave the state this check
 * needs unknown, and each caller turns that into its own message.
 */
async function gitAnswer(args: string[], repoRoot: string): Promise<FlowGitResult | null> {
  try {
    const answer = await _flowRepoDeps.git(args, repoRoot);
    return answer.exitCode === 0 ? answer : null;
  } catch {
    return null;
  }
}

/** The branch message, naming it — an empty name is named as what it is. */
function branchMessage(branch: string): string {
  const name = branch.length === 0 ? "an empty branch name" : `branch "${branch}"`;
  return `[chat] cannot send a flow from ${name}; check out your feature branch and commit the specs`;
}

/** The failure message for a working tree, or `undefined` when it is clean and readable. */
async function treeFailure(repoRoot: string): Promise<string | undefined> {
  try {
    return (await _flowRepoDeps.isDirty(repoRoot)) ? DIRTY_MESSAGE : undefined;
  } catch (error) {
    return `${UNREADABLE_STATE_PREFIX}${errorMessage(error)}`;
  }
}

/** The normalised origin remote, or the failure that keeps koda from reading the repo. */
async function remoteOrFailure(repoRoot: string): Promise<string | FlowRepoFailure> {
  const origin = await gitAnswer(["remote", "get-url", "origin"], repoRoot);
  if (origin === null) return { ok: false, message: NO_ORIGIN_MESSAGE };
  const raw = origin.stdout.trim();
  const remoteUrl = normalizeGitHubRemote(raw);
  if (remoteUrl !== null) return remoteUrl;
  return {
    ok: false,
    message: `[chat] the origin remote "${raw}" is not a GitHub remote; koda can only send a flow for a GitHub repository`,
  };
}

/** The failure message for a spec path missing at HEAD, or `undefined` when they are all there. */
async function specFailure(repoRoot: string, specPaths: readonly string[]): Promise<string | undefined> {
  for (const specPath of specPaths) {
    const present = await gitAnswer(["cat-file", "-e", `HEAD:${specPath}`], repoRoot);
    if (present === null) {
      return `[chat] the spec file "${specPath}" is not committed at HEAD; commit it before sending a flow`;
    }
  }
  return undefined;
}

/**
 * Read the repository state a flow is sent from, failing on the first check.
 *
 * @param repoRoot - The chat's repository root
 * @param specPaths - Every spec path the request names, checked at HEAD
 * @returns The branch, sha and normalised remote, or a `[chat]` message
 */
export async function readFlowRepoState(repoRoot: string, specPaths: readonly string[]): Promise<FlowRepoState> {
  const branch = await gitAnswer(["symbolic-ref", "--short", "HEAD"], repoRoot);
  if (branch === null) return { ok: false, message: DETACHED_MESSAGE };
  const name = branch.stdout.trim();
  if (!isPublishableBranch(name)) return { ok: false, message: branchMessage(name) };

  const tree = await treeFailure(repoRoot);
  if (tree !== undefined) return { ok: false, message: tree };

  const sha = await _flowRepoDeps.headSha(repoRoot);
  if (sha === null) return { ok: false, message: NO_COMMITS_MESSAGE };

  const remoteUrl = await remoteOrFailure(repoRoot);
  if (typeof remoteUrl !== "string") return remoteUrl;

  const specs = await specFailure(repoRoot, specPaths);
  if (specs !== undefined) return { ok: false, message: specs };

  return { ok: true, branch: name, sha, remoteUrl };
}

/**
 * Check a branch against koda's rules before the card is shown.
 *
 * koda creates `feat/<feature>` for every feature after the first, so a branch
 * that already has one of those names is a collision koda would refuse.
 *
 * @param branch - The checked-out branch
 * @param features - The request's features, in dependency order
 * @returns The `[chat]` message to show, or `undefined` when koda will accept the branch
 */
export function checkFlowBranch(branch: string, features: readonly FlowBranchFeature[]): string | undefined {
  if (!FLOW_BRANCH_RE.test(branch)) {
    return `[chat] koda will not accept the branch name "${branch}"; rename it to match ${FLOW_BRANCH_RE.source}`;
  }
  const collision = features.find(
    (feature, index) => index >= 1 && `${FEATURE_BRANCH_PREFIX}${feature.feature}` === branch,
  );
  if (collision === undefined) return undefined;
  return (
    `[chat] koda names its branches "${FEATURE_BRANCH_PREFIX}<feature>", so feature "${collision.feature}" ` +
    `would take the checked-out branch "${branch}"; rename the feature or the branch`
  );
}
