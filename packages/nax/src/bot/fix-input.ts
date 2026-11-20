import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import type { PrRef } from "@/forge";
import { getLogger } from "@/logger";
import type { WorkflowFinding } from "@/operations/workflow-types";
import { buildUntrustedRequestIssue } from "@/prompts";
import { BOT_GIT_NETWORK_TIMEOUT_MS } from "./checkout";
import { botGit } from "./git";
import { type AgreedItem, BOT_REVIEW_FILENAME, type BotReviewArtifact } from "./post";

export const _fixInputDeps = {
  runGit: botGit,
  glob: async (pattern: string, cwd: string): Promise<string[]> =>
    Array.fromAsync(new Bun.Glob(pattern).scan({ cwd, absolute: true, onlyFiles: true })),
  readText: (path: string): Promise<string> => Bun.file(path).text(),
  mtimeMs: async (path: string): Promise<number> => (await Bun.file(path).stat()).mtimeMs,
};

// Validate persisted shell inputs before the fix graph trusts them. Legacy artifacts may omit checks.
// List commands follow the canonical gate semantics: blank members are legal (the quality runner
// drops them at run time) as long as one runnable command remains — see `isConfigured` in gates/quality.ts.
const commandSchema = z.union([
  z.string().trim().min(1),
  z.array(z.string()).refine((entries) => entries.some((entry) => entry.trim().length > 0), {
    message: "list command has no runnable entry",
  }),
]);
const checksSchema = z.object({
  source: z.enum(["config", "agents-md", "claude-md", "detected", "none"]),
  gates: z.array(z.object({ name: z.string().min(1), command: commandSchema, setup: commandSchema.optional() })),
  preRun: z.array(z.object({ command: z.string().trim().min(1), timeoutSeconds: z.number().positive().finite() })),
});

async function readReview(path: string): Promise<BotReviewArtifact | null> {
  try {
    const value: unknown = JSON.parse(await _fixInputDeps.readText(path));
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      (value.version !== 1 && value.version !== 2 && value.version !== 3)
    )
      return null;
    if ("checks" in value && value.checks !== null && !checksSchema.safeParse(value.checks).success) {
      getLogger()?.warn("bot-fix", "Ignoring review artifact with invalid checks; re-run nax bot review", { path });
      return null;
    }
    const review = value as BotReviewArtifact;
    // B3: an artifact whose agreed list is not a list cannot be read as "it found nothing"; skip it whole.
    if (review.agreed !== undefined && !Array.isArray(review.agreed)) {
      getLogger()?.warn("bot-fix", "Ignoring review artifact with an unreadable agreed list; re-run nax bot review", {
        path,
      });
      return null;
    }
    if (review.version < 3 && Array.isArray(review.agreed)) {
      const agreed = review.agreed.filter((item: AgreedItem) => item?.kind === "finding");
      const dropped = review.agreed.length - agreed.length;
      if (dropped > 0)
        getLogger()?.warn(
          "bot-fix",
          "Dropped unchecked thread and comment items from an older review; re-run nax bot review",
          { path, dropped },
        );
      return { ...review, agreed };
    }
    return review;
  } catch (cause) {
    // A corrupt or concurrently removed artifact must not hide the other reviews.
    getLogger()?.debug("bot-fix", "Ignoring unreadable review artifact", { path, error: errorMessage(cause) });
    return null;
  }
}

/**
 * Select only exact-head reviews of *this* PR; persisted trust is diagnostic, never authorization.
 *
 * B4: the run directory is keyed by the PR number alone, so two repositories sharing one output directory
 * collide on `pr-<n>`. The artifact's own `pr` is therefore matched against the whole reference — forge,
 * host, repository and number — before it can be selected; an artifact that records none is skipped,
 * because nothing proves it is this PR's.
 *
 * `codeOnly` skips a conversation-only artifact (US-001): that review read no code because the head was
 * already reviewed, so the head's open findings live in the earlier code review, not in it.
 */
export async function loadLatestReview(
  outputDir: string,
  ref: PrRef,
  headSha: string,
  options: { readonly codeOnly?: boolean } = {},
): Promise<BotReviewArtifact | null> {
  let paths: string[];
  try {
    paths = await _fixInputDeps.glob(join("bot", `pr-${ref.number}`, "*", BOT_REVIEW_FILENAME), outputDir);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
  let latest: BotReviewArtifact | null = null;
  let newest = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    const review = await readReview(path);
    if (review?.headSha !== headSha) continue;
    if (!samePr(review.pr, ref)) continue;
    if (options.codeOnly === true && review.scope === "conversation-only") continue;
    let mtime: number;
    try {
      mtime = await _fixInputDeps.mtimeMs(path);
    } catch (cause) {
      getLogger()?.debug("bot-fix", "Ignoring vanished review artifact", { path, error: errorMessage(cause) });
      continue;
    }
    if (mtime > newest) {
      latest = review;
      newest = mtime;
    }
  }
  return latest;
}

/** B4: every part of the reference must agree; an artifact that names none is not this PR's. */
function samePr(recorded: PrRef | undefined, wanted: PrRef): boolean {
  if (recorded === undefined || recorded === null) return false;
  return (
    recorded.forge === wanted.forge &&
    recorded.host === wanted.host &&
    recorded.repo === wanted.repo &&
    recorded.number === wanted.number
  );
}

export function toFixFindings(items: readonly AgreedItem[]): WorkflowFinding[] {
  return items.map((item) => ({
    id: item.key,
    kind: "quality",
    severity: "severity" in item ? (item.severity ?? "important") : "important",
    issue: item.kind === "finding" ? item.issue : buildUntrustedRequestIssue(item.issue, item.reason),
    ...("file" in item && item.file !== undefined ? { file: item.file } : {}),
    ...("line" in item && item.line !== undefined ? { line: item.line } : {}),
    ...("suggestion" in item && item.suggestion !== undefined ? { suggestion: item.suggestion } : {}),
  }));
}

export async function checkPushAccess(
  worktree: string,
  headRef: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await _fixInputDeps.runGit(
    ["push", "--dry-run", "--no-verify", "origin", `HEAD:refs/heads/${headRef}`],
    worktree,
    BOT_GIT_NETWORK_TIMEOUT_MS,
  );
  return result.exitCode === 0
    ? { ok: true }
    : {
        ok: false,
        reason: result.timedOut
          ? "push access probe timed out"
          : result.stderr.split(/\r?\n/, 1)[0] || `git exited ${result.exitCode}`,
      };
}
