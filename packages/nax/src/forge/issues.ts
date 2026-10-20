import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { encodeProjectPath } from "./pr-read";
import type { PrRef } from "./pr-types";
import type { ForgeDeps, ForgeRunResult } from "./types";

export const MAX_LINKED_ISSUES = 5;

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
}

/** Same-repository closing references only, excluding template comments. */
export function parseClosingRefs(body: string): number[] {
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const pattern = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b:?\s+#(\d+)/gi;
  const numbers = new Set<number>();
  for (const match of visible.matchAll(pattern)) {
    numbers.add(Number(match[1]));
    if (numbers.size === MAX_LINKED_ISSUES) break;
  }
  return [...numbers];
}

function responseError(ref: PrRef, number: number, cause?: unknown): NaxError {
  return new NaxError(`[forge] Invalid issue response for ${ref.repo}#${number}`, "FORGE_RESPONSE_UNPARSEABLE", {
    stage: "forge",
    ref,
    number,
    cause,
  });
}

function parseReply(ref: PrRef, number: number, stdout: string): LinkedIssue | null {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch (cause) {
    throw responseError(ref, number, cause);
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw responseError(ref, number);
  if (ref.forge === "github" && "pull_request" in reply) return null;
  const body =
    ref.forge === "github" ? ("body" in reply ? reply.body : null) : "description" in reply ? reply.description : null;
  if (!("title" in reply) || typeof reply.title !== "string" || (body != null && typeof body !== "string")) {
    throw responseError(ref, number);
  }
  return { number, title: reply.title, body: body ?? "" };
}

/** Read one issue with explicit host and cwd, never implicit CLI repository context. */
export async function readIssue(ref: PrRef, number: number, deps: ForgeDeps, cwd: string): Promise<LinkedIssue | null> {
  const github = ref.forge === "github";
  const endpoint = github
    ? `repos/${ref.repo}/issues/${number}`
    : `projects/${encodeProjectPath(ref.repo)}/issues/${number}`;
  let result: ForgeRunResult;
  try {
    result = await deps.run([github ? "gh" : "glab", "api", "--hostname", ref.host, endpoint], { cwd });
  } catch (cause) {
    throw new NaxError(`[forge] Cannot read issue ${ref.repo}#${number}`, "FORGE_ISSUE_READ_FAILED", {
      stage: "forge",
      ref,
      number,
      cause,
    });
  }
  if (result.exitCode !== 0) {
    throw new NaxError(
      `[forge] Cannot read issue ${ref.repo}#${number}: ${result.stderr.trim()}`,
      "FORGE_ISSUE_READ_FAILED",
      {
        stage: "forge",
        ref,
        number,
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
    );
  }
  return parseReply(ref, number, result.stdout);
}

/** Bounded, ordered, best-effort intent reads; one unreadable issue cannot abort review. */
export async function readLinkedIssues(ref: PrRef, body: string, deps: ForgeDeps, cwd: string): Promise<LinkedIssue[]> {
  const issues = await Promise.all(
    parseClosingRefs(body).map(async (number) => {
      const context = { host: ref.host, repo: ref.repo, number };
      try {
        const issue = await readIssue(ref, number, deps, cwd);
        if (issue) return issue;
        getLogger()?.warn("forge", "Skipping linked reference: number is a pull request", context);
      } catch (cause) {
        getLogger()?.warn("forge", "Skipping unreadable linked issue", { ...context, error: errorMessage(cause) });
      }
      return null;
    }),
  );
  return issues.filter((issue): issue is LinkedIssue => issue !== null);
}
