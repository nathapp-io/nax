/**
 * Opening and maintaining the finish PR: draft-first creation (D7), the
 * terminal promote-or-create, and the non-fatal body write.
 *
 * Ported from `flows/nax-finish/steps/pr.ts` (read-only reference, never
 * imported). Restructured so the forge is a required argument — the flow's
 * `knownForge?` fallback existed because the flow had two independent
 * detection sites; the caller detects once and passes it in, which stops the
 * body and the create command from disagreeing about it — and so I/O arrives
 * as `ForgeDeps` rather than a module-level `_prDeps` seam.
 */
import { NaxError } from "@/errors";
import { extractUrl, hasOpenPr, openPr, viewArgv } from "@/forge";
import type { ForgeDeps, ForgeKind } from "@/forge";

/** `ForgeDeps` carries no `warn` — this is `updatePrBody`'s own injectable seam, so its
 * non-fatal-failure tests can assert a warning fired instead of only "did not throw". */
export const _openDeps = {
  warn: (message: string, details: Record<string, unknown>): void => {
    process.emitWarning(message, { detail: JSON.stringify(details) });
  },
};

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
export function parseView(stdout: string, forge: ForgeKind): { isDraft: boolean; url?: string } {
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

/**
 * Promote the finish's draft PR to ready, or create the PR when the branch
 * has none (the view command failed or the branch's PR/MR is already closed).
 */
export async function openOrPromotePr(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }> {
  const view = await deps.run(viewArgv(args.forge, args.branch, "isDraft,url"), { cwd: args.workdir });

  if (view.exitCode !== 0) {
    const createCmd =
      args.forge === "github"
        ? ["gh", "pr", "create", "--title", args.title, "--body", args.body, "--head", args.branch]
        : ["glab", "mr", "create", "--title", args.title, "--description", args.body, "--source-branch", args.branch];
    const create = await deps.run(createCmd, { cwd: args.workdir });
    if (create.exitCode !== 0) {
      throw new NaxError(
        `Failed to create PR/MR for "${args.branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
        "FINISH_PR_CREATE_FAILED",
        { stage: "finish-pr", branch: args.branch },
      );
    }
    return { status: "opened", url: extractUrl(create.stdout) };
  }

  const { isDraft, url } = parseView(view.stdout, args.forge);
  if (isDraft) {
    const readyCmd =
      args.forge === "github" ? ["gh", "pr", "ready", args.branch] : ["glab", "mr", "update", args.branch, "--ready"];
    const ready = await deps.run(readyCmd, { cwd: args.workdir });
    if (ready.exitCode !== 0) {
      throw new NaxError(
        `Failed to promote PR/MR "${args.branch}" to ready: ${ready.stderr.trim() || `exit ${ready.exitCode}`}`,
        "FINISH_PR_PROMOTE_FAILED",
        { stage: "finish-pr", branch: args.branch },
      );
    }
    await updatePrBody(args, deps);
    return { status: "promoted", url };
  }

  await updatePrBody(args, deps);
  return { status: "already-ready", url };
}

/**
 * Write the finish title/body onto an already-open PR/MR.
 *
 * Non-fatal by design: this runs after the PR exists, so a failed metadata
 * write must not throw away that state — the caller's returned status/url
 * stays valid either way.
 */
export async function updatePrBody(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<void> {
  const editCmd =
    args.forge === "github"
      ? ["gh", "pr", "edit", args.branch, "--title", args.title, "--body", args.body]
      : ["glab", "mr", "update", args.branch, "--title", args.title, "--description", args.body];
  try {
    const res = await deps.run(editCmd, { cwd: args.workdir });
    if (res.exitCode !== 0) {
      _openDeps.warn("[finish-pr] Failed to write PR title/body", { branch: args.branch, error: res.stderr.trim() });
    }
  } catch (error) {
    _openDeps.warn("[finish-pr] Failed to write PR title/body", { branch: args.branch, error });
  }
}

/**
 * Open the draft PR the finish run holds its work in (D7).
 *
 * Returns null on every unhappy path — no open-PR check, a create that
 * failed, a forge CLI that could not answer. The draft is a convenience: the
 * terminal promote creates the PR when none exists, so failing the run here
 * would discard work that is otherwise fine. `hasOpenPr` throws on a non-zero
 * exit by design (a `gh` auth failure must not read as "no PR"); `openPr`'s
 * own `deps.run` can also reject outright (missing binary, a killed
 * subprocess) rather than merely returning a non-zero exit — both are wrapped
 * in the same try/catch so this function's "never throws" contract (D4.5)
 * holds regardless of which step failed.
 */
export async function openDraftFinishPr(
  args: { workdir: string; branch: string; title: string; body: string; forge: ForgeKind },
  deps: ForgeDeps,
): Promise<{ url: string } | null> {
  try {
    if (await hasOpenPr(args.forge, args.branch, deps, args.workdir)) return null;
    const result = await openPr(
      args.forge,
      { title: args.title, body: args.body, branch: args.branch, draft: true },
      deps,
      args.workdir,
    );
    return result.success && result.url ? { url: result.url } : null;
  } catch {
    return null;
  }
}
