import { FinishError } from "../errors";
import type { RunFn } from "../types";
import { type Forge, detectForge, extractUrl, viewArgv } from "./forge";
import { _prBodyDeps, loadFinishPrContext } from "./pr-body";

// `loadFinishPrContext` moved to `./pr-body` (the spec's stated module
// boundary); re-exported here so consumers importing from `./pr` (or the
// `steps` barrel, which re-exports `./pr`) keep working.
export { loadFinishPrContext };

// `_prDeps` is deliberately the *same object* as `./pr-body`'s `_prBodyDeps`,
// not a copy — this module's `run` calls (forge CLI) and pr-body's
// `readText`/`warn`/diffstat `run` calls share one injectable seam, so a
// single test stub controls both. Typed to `{ run: RunFn }` here because
// that's the only member this module actually calls.
export const _prDeps: { run: RunFn } = _prBodyDeps;

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
  // Optional so a caller whose own `detectForge` threw still gets the previous
  // behaviour. Passing it in is what stops the body and the create-command from
  // disagreeing about the forge when both would otherwise detect separately.
  knownForge?: Forge,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }> {
  const forge = knownForge ?? (await detectForge(_prDeps.run, repoRoot, "finish-pr"));
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
    await updatePrBody(forge, repoRoot, branch, title, body);
    return { status: "promoted", url };
  }

  await updatePrBody(forge, repoRoot, branch, title, body);
  return { status: "already-ready", url };
}

/**
 * Write the finish title/body onto an already-open PR/MR.
 *
 * Non-fatal by design: this runs after the PR exists, so a failed metadata
 * write must not throw away that state — the caller's returned status/url
 * stays valid either way. Exported because `amend_body` calls it after the
 * narrative node produces prose.
 */
export async function updatePrBody(
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
  try {
    const res = await _prDeps.run(editCmd, { cwd: repoRoot });
    if (res.exitCode !== 0) {
      _prBodyDeps.warn("[finish-pr] Failed to write PR title/body", { path: branch, error: res.stderr.trim() });
    }
  } catch (error) {
    _prBodyDeps.warn("[finish-pr] Failed to write PR title/body", { path: branch, error });
  }
}
