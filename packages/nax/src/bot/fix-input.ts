import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
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
      (value.version !== 1 && value.version !== 2)
    )
      return null;
    if ("checks" in value && value.checks !== null && !checksSchema.safeParse(value.checks).success) {
      getLogger()?.warn("bot-fix", "Ignoring review artifact with invalid checks; re-run nax bot review", { path });
      return null;
    }
    return value as BotReviewArtifact;
  } catch (cause) {
    // A corrupt or concurrently removed artifact must not hide the other reviews.
    getLogger()?.debug("bot-fix", "Ignoring unreadable review artifact", { path, error: errorMessage(cause) });
    return null;
  }
}

/** Select only exact-head reviews; persisted trust is diagnostic, never authorization. */
export async function loadLatestReview(
  outputDir: string,
  prNumber: number,
  headSha: string,
): Promise<BotReviewArtifact | null> {
  let paths: string[];
  try {
    paths = await _fixInputDeps.glob(join("bot", `pr-${prNumber}`, "*", BOT_REVIEW_FILENAME), outputDir);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
  let latest: BotReviewArtifact | null = null;
  let newest = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    const review = await readReview(path);
    if (review?.headSha !== headSha) continue;
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
