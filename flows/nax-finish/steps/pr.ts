import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { FinishError } from "../errors";
import { runArgv } from "../exec";
import type { FinishPrContext, FinishPrStory } from "../pr-body";
import type { FinishInput, FinishRound, RunFn } from "../types";
import { type Forge, detectForge, extractUrl, viewArgv } from "./forge";
import { readRounds } from "./result";

export const _prDeps: {
  run: RunFn;
  readText: (path: string) => Promise<string | null>;
  warn: (message: string, details: { path: string; error: unknown }) => void;
} = {
  run: runArgv,
  readText: (path) => readFile(path, "utf8"),
  warn: (message, details) => process.emitWarning(message, { detail: `${details.path}: ${String(details.error)}` }),
};

interface PrdArtifact {
  userStories?: { id: string; title: string; acceptanceCriteria?: unknown[] }[];
  outOfScope?: string[];
}

interface StatusArtifact {
  postRun?: { acceptance?: { status?: string }; regression?: { status?: string } };
  durationMs?: number;
  progress?: { passed?: number; total?: number };
}

async function readJson(path: string): Promise<unknown> {
  let text: string | null;
  try {
    text = await _prDeps.readText(path);
  } catch (error) {
    _prDeps.warn("[finish-pr] Failed to read PR context artifact", { path, error });
    return undefined;
  }
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function storiesFrom(prd: PrdArtifact | undefined): FinishPrStory[] {
  if (!Array.isArray(prd?.userStories)) return [];
  return prd.userStories.map((story) => ({
    id: story.id,
    title: story.title,
    acCount: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0,
  }));
}

/**
 * Run `git diff --stat <base>...HEAD` and return its stdout on success.
 *
 * Fail-open on every non-happy path — a non-zero exit (no commits, divergent
 * branch, base missing), a rejected run promise (forks too slow to start), or
 * any thrown error — returning `undefined`. The PR's Verification block is
 * optional, and a routine empty-branch finish must not lose `open_pr` to a
 * throw that the body can simply skip.
 */
async function runDiffstat(workdir: string, base: string): Promise<string | undefined> {
  try {
    const res = await _prDeps.run(["git", "diff", "--stat", `${base}...HEAD`], { cwd: workdir });
    if (res.exitCode !== 0) return undefined;
    return res.stdout;
  } catch {
    return undefined;
  }
}

export async function loadFinishPrContext(
  input: FinishInput,
  args: { base: string; gatesRan: string[] },
): Promise<FinishPrContext> {
  const inputPrdPath = input.prdPath || "prd.json";
  const prdPath = isAbsolute(inputPrdPath) ? inputPrdPath : join(input.workdir, inputPrdPath);
  // [US-004] The audit trail (`rounds`) and the diffstat are independent of
  // the PRD/status reads — fetching them in parallel keeps the loader's wall
  // clock at max(readRounds, readJson×2, diffstat).
  const [prd, status, rounds, diffstat] = (await Promise.all([
    readJson(prdPath),
    readJson(join(dirname(prdPath), "status.json")),
    readRounds(input),
    runDiffstat(input.workdir, args.base),
  ])) as [PrdArtifact | undefined, StatusArtifact | undefined, FinishRound[], string | undefined];
  return {
    feature: input.feature,
    stories: storiesFrom(prd),
    outOfScope: Array.isArray(prd?.outOfScope) ? prd.outOfScope : [],
    acceptance: status?.postRun?.acceptance?.status,
    regression: status?.postRun?.regression?.status,
    gatesRan: args.gatesRan,
    rounds,
    diffstat,
    run: {
      durationMs: status?.durationMs,
      storiesPassed: status?.progress?.passed,
      storiesTotal: status?.progress?.total,
    },
  };
}

/**
 * Parse `gh pr view --json isDraft,url` / `glab mr view --output json` stdout.
 *
 * GitHub's schema is well-defined: `{ isDraft, url }`. GitLab's `glab mr view --output json`
 * schema is not guaranteed to expose an equivalent boolean under a stable name across
 * versions, so this is best-effort: it checks a few plausible field names for draft status
 * and falls back to treating any successfully-parsed MR as ready (not draft) when none are
 * found — per the task brief, "treat any successful view as already-ready unless you find
 * clear evidence otherwise."
 */
function parseView(stdout: string, forge: Forge): { isDraft: boolean; url?: string } {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (forge === "github") {
      return { isDraft: parsed.isDraft === true, url: typeof parsed.url === "string" ? parsed.url : undefined };
    }
    const isDraft = parsed.isDraft === true || parsed.draft === true || parsed.work_in_progress === true;
    return { isDraft, url: extractUrl(stdout) };
  } catch {
    return { isDraft: false, url: extractUrl(stdout) };
  }
}

export async function openOrPromotePr(
  repoRoot: string,
  branch: string,
  title: string,
  body: string,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }> {
  const forge = await detectForge(_prDeps.run, repoRoot, "finish-pr");
  const view = await _prDeps.run(viewArgv(forge, branch, "isDraft,url"), { cwd: repoRoot });

  if (view.exitCode !== 0) {
    const createCmd =
      forge === "github"
        ? ["gh", "pr", "create", "--title", title, "--body", body, "--head", branch]
        : ["glab", "mr", "create", "--title", title, "--description", body, "--source-branch", branch];
    const create = await _prDeps.run(createCmd, { cwd: repoRoot });
    if (create.exitCode !== 0) {
      throw new FinishError(
        `Failed to create PR/MR for "${branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
        "FINISH_PR_CREATE_FAILED",
        { stage: "finish-pr", branch },
      );
    }
    return { status: "opened", url: extractUrl(create.stdout) };
  }

  const { isDraft, url } = parseView(view.stdout, forge);
  if (isDraft) {
    const readyCmd = forge === "github" ? ["gh", "pr", "ready", branch] : ["glab", "mr", "update", branch, "--ready"];
    const ready = await _prDeps.run(readyCmd, { cwd: repoRoot });
    if (ready.exitCode !== 0) {
      throw new FinishError(
        `Failed to promote PR/MR "${branch}" to ready: ${ready.stderr.trim() || `exit ${ready.exitCode}`}`,
        "FINISH_PR_PROMOTE_FAILED",
        { stage: "finish-pr", branch },
      );
    }
    await writeFinishMetadata(forge, repoRoot, branch, title, body);
    return { status: "promoted", url };
  }

  await writeFinishMetadata(forge, repoRoot, branch, title, body);
  return { status: "already-ready", url };
}

/**
 * Write the finish title/body onto an already-promoted or already-ready PR/MR.
 *
 * Non-fatal by design: this runs after the PR is already open (or already
 * ready), so a failed metadata write must not throw away that state — the
 * caller's returned status/url stays valid either way.
 */
async function writeFinishMetadata(
  forge: Forge,
  repoRoot: string,
  branch: string,
  title: string,
  body: string,
): Promise<void> {
  const editCmd =
    forge === "github"
      ? ["gh", "pr", "edit", branch, "--title", title, "--body", body]
      : ["glab", "mr", "update", branch, "--title", title, "--description", body];
  await _prDeps.run(editCmd, { cwd: repoRoot });
}
