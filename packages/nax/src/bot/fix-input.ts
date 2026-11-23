import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import type { PrRef } from "@/forge";
import { getLogger } from "@/logger";
import type { WorkflowFinding } from "@/operations/workflow-types";
import { buildUntrustedRequestIssue } from "@/prompts";
import { type CarriedRead, carriedFromArtifact, NO_CARRY } from "./carried-findings";
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
/** US-002: the persisted install choice is validated like the rest of the checks it travels with. */
const installSchema = z.object({
  lockfile: z.string().trim().min(1),
  reason: z.enum(["package-manager", "lockfile-order"]),
  fallbacks: z.array(z.object({ command: z.string().trim().min(1), timeoutSeconds: z.number().positive().finite() })),
});
const checksSchema = z.object({
  source: z.enum(["config", "agents-md", "claude-md", "detected", "none"]),
  gates: z.array(z.object({ name: z.string().min(1), command: commandSchema, setup: commandSchema.optional() })),
  preRun: z.array(z.object({ command: z.string().trim().min(1), timeoutSeconds: z.number().positive().finite() })),
  install: installSchema.optional(),
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
    return value as BotReviewArtifact;
  } catch (cause) {
    // A corrupt or concurrently removed artifact must not hide the other reviews.
    getLogger()?.debug("bot-fix", "Ignoring unreadable review artifact", { path, error: errorMessage(cause) });
    return null;
  }
}

function fixReview(review: BotReviewArtifact, path: string): BotReviewArtifact | null {
  if (review.checks !== undefined && review.checks !== null && !checksSchema.safeParse(review.checks).success) {
    getLogger()?.warn("bot-fix", "Ignoring review artifact with invalid checks; re-run nax bot review", { path });
    return null;
  }
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
}

interface ReviewSearch<T> {
  readonly outputDir: string;
  readonly ref: PrRef;
  readonly headSha: string;
  readonly codeOnly: boolean;
  readonly select: (review: BotReviewArtifact, path: string) => T | null;
}

async function reviewPaths({ outputDir, ref }: Pick<ReviewSearch<unknown>, "outputDir" | "ref">): Promise<string[]> {
  try {
    return await _fixInputDeps.glob(join("bot", `pr-${ref.number}`, "*", BOT_REVIEW_FILENAME), outputDir);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

/** Check identity and usability before letting a candidate compete on modification time. */
async function selectReview<T>(input: ReviewSearch<T>): Promise<{ latest: T | null; matched: boolean }> {
  let latest: T | null = null;
  let newest = Number.NEGATIVE_INFINITY;
  let matched = false;
  for (const path of await reviewPaths(input)) {
    const review = await readReview(path);
    if (review?.headSha !== input.headSha || !samePr(review.pr, input.ref)) continue;
    if (input.codeOnly && review.scope === "conversation-only") continue;
    matched = true;
    const usable = input.select(review, path);
    if (usable === null) continue;
    try {
      const mtime = await _fixInputDeps.mtimeMs(path);
      if (mtime > newest) {
        latest = usable;
        newest = mtime;
      }
    } catch (cause) {
      getLogger()?.debug("bot-fix", "Ignoring vanished review artifact", { path, error: errorMessage(cause) });
    }
  }
  return { latest, matched };
}

/** Exact-head fix inputs, optionally excluding reviews that read only the conversation. */
export async function loadLatestReview(
  outputDir: string,
  ref: PrRef,
  headSha: string,
  options: { readonly codeOnly?: boolean } = {},
): Promise<BotReviewArtifact | null> {
  const { latest } = await selectReview({
    outputDir,
    ref,
    headSha,
    codeOnly: options.codeOnly === true,
    select: fixReview,
  });
  return latest;
}

/** Prefer the newest usable code artifact; an unusable match is not the same as no bot review. */
export async function loadLatestCarry(outputDir: string, ref: PrRef, headSha: string): Promise<CarriedRead> {
  const { latest, matched } = await selectReview({
    outputDir,
    ref,
    headSha,
    codeOnly: true,
    select(review) {
      const carry = carriedFromArtifact(review.agreed);
      return carry.widen ? null : carry;
    },
  });
  return latest ?? (matched ? { findings: [], widen: true } : NO_CARRY);
}

/** B4: every part of the reference must agree; an artifact that names none is not this PR's. */
function samePr(recorded: PrRef | undefined, wanted: PrRef): boolean {
  if (recorded === undefined || recorded === null) return false;
  return (
    recorded.forge === wanted.forge &&
    recorded.host === wanted.host &&
    recorded.number === wanted.number &&
    typeof recorded.repo === "string" &&
    (wanted.forge === "github"
      ? recorded.repo.toLowerCase() === wanted.repo.toLowerCase()
      : recorded.repo === wanted.repo)
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
