import { NaxError } from "@/errors";
import { detectForge, remoteHost } from "./detect";
import type { PrInfo, PrRef, PrState } from "./pr-types";
import type { ForgeDeps } from "./types";

/** Repository path of an scp-like or scheme URL origin, without slashes or .git suffix. */
export function repoSlugFromRemoteUrl(remoteUrl: string): string | null {
  const scp = remoteUrl.match(/^[^/]*@[^:/]+:(.*)$/);
  const url = remoteUrl.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^:/]+(?::\d+)?\/(.*)$/i);
  const path = (scp?.[1] ?? url?.[1] ?? "").replace(/^\/+|\/+$/g, "");
  return path.replace(/\.git$/, "").replace(/\/+$/g, "") || null;
}

/** Encode a GitLab project path as one endpoint segment. */
export function encodeProjectPath(repo: string): string {
  return encodeURIComponent(repo);
}

/** Resolve a numbered PR against the checkout's origin, never implicit CLI repo context. */
export async function resolvePrRef(number: number, deps: ForgeDeps, cwd: string): Promise<PrRef> {
  if (!Number.isInteger(number) || number <= 0) {
    throw new NaxError(`[forge] Invalid PR number: ${number}`, "FORGE_PR_REF_UNRESOLVED", { stage: "forge", number });
  }
  const forge = await detectForge(deps, cwd);
  if (!forge) {
    throw new NaxError("[forge] Cannot determine forge from origin", "FORGE_PR_REF_UNRESOLVED", {
      stage: "forge",
      cwd,
    });
  }
  // nax-git-env-allow: ForgeDeps.run hardens every command in production
  const remote = await deps.run(["git", "remote", "get-url", "origin"], { cwd });
  if (remote.exitCode !== 0) {
    throw new NaxError(`[forge] Cannot read origin: ${remote.stderr.trim()}`, "FORGE_PR_REF_UNRESOLVED", {
      stage: "forge",
      cwd,
      exitCode: remote.exitCode,
    });
  }
  const url = remote.stdout.trim();
  const repo = repoSlugFromRemoteUrl(url);
  if (!repo) {
    throw new NaxError("[forge] Origin has no repository path", "FORGE_PR_REF_UNRESOLVED", { stage: "forge", cwd });
  }
  return { forge, host: remoteHost(url), repo, number };
}

interface GithubPrReply {
  title: string;
  body?: string | null;
  html_url: string;
  state: PrState;
  merged_at?: string | null;
  draft: boolean;
  user: { login: string; id?: number };
  base: { ref: string; repo?: unknown };
  head?: { ref: string; sha?: unknown; repo?: unknown };
}

interface GitlabPrReply {
  title: string;
  description?: string | null;
  web_url: string;
  state: string;
  draft: boolean;
  author: { username: string; id?: number };
  target_branch: string;
  source_branch: string;
  sha?: unknown;
  source_project_id?: unknown;
  target_project_id?: unknown;
  diff_refs?: { base_sha: string; start_sha: string; head_sha: string } | null;
}

function responseError(ref: PrRef, cause?: unknown): NaxError {
  return new NaxError(`[forge] Invalid PR response for ${ref.repo}#${ref.number}`, "FORGE_RESPONSE_UNPARSEABLE", {
    stage: "forge",
    ref,
    cause,
  });
}

/** Unknown or deleted repositories must never be classified as same-repository. */
function repositoryName(repo: unknown): string | undefined {
  if (repo && typeof repo === "object" && "full_name" in repo) {
    return typeof repo.full_name === "string" && repo.full_name.length > 0 ? repo.full_name : undefined;
  }
  return undefined;
}

function githubPrInfo(ref: PrRef, reply: GithubPrReply): PrInfo {
  const head = reply?.head;
  if (typeof head?.sha !== "string" || !head.sha) throw responseError(ref);
  const headRepo = repositoryName(head.repo);
  const baseRepo = repositoryName(reply.base?.repo);
  return {
    number: ref.number,
    title: reply.title,
    body: reply.body ?? "",
    url: reply.html_url,
    state: reply.merged_at != null ? "merged" : reply.state,
    draft: reply.draft,
    author: { login: reply.user.login, id: reply.user.id },
    baseRef: reply.base.ref,
    headRef: head.ref,
    headSha: head.sha,
    crossRepo: !headRepo || !baseRepo || headRepo !== baseRepo,
  };
}

function gitlabPrInfo(ref: PrRef, reply: GitlabPrReply): PrInfo {
  if (typeof reply?.sha !== "string" || !reply.sha) throw responseError(ref);
  const diff = reply.diff_refs;
  return {
    number: ref.number,
    title: reply.title,
    body: reply.description ?? "",
    url: reply.web_url,
    state: reply.state === "opened" ? "open" : reply.state === "merged" ? "merged" : "closed",
    draft: reply.draft,
    author: { login: reply.author.username, id: reply.author.id },
    baseRef: reply.target_branch,
    headRef: reply.source_branch,
    headSha: reply.sha,
    crossRepo:
      typeof reply.source_project_id !== "number" ||
      typeof reply.target_project_id !== "number" ||
      reply.source_project_id !== reply.target_project_id,
    ...(diff ? { diffRefs: { baseSha: diff.base_sha, startSha: diff.start_sha, headSha: diff.head_sha } } : {}),
  };
}

/** Read metadata with explicit forge identity; no checkout or implicit CLI repository context. */
export async function readPrInfo(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<PrInfo> {
  const github = ref.forge === "github";
  const endpoint = github
    ? `repos/${ref.repo}/pulls/${ref.number}`
    : `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}`;
  const result = await deps.run([github ? "gh" : "glab", "api", "--hostname", ref.host, endpoint], { cwd });
  if (result.exitCode !== 0) {
    throw new NaxError(
      `[forge] Cannot read ${ref.repo}#${ref.number}: ${result.stderr.trim()}`,
      "FORGE_PR_READ_FAILED",
      {
        stage: "forge",
        ref,
        exitCode: result.exitCode,
      },
    );
  }
  let reply: unknown;
  try {
    reply = JSON.parse(result.stdout);
  } catch (cause) {
    throw responseError(ref, cause);
  }
  return github ? githubPrInfo(ref, reply as GithubPrReply) : gitlabPrInfo(ref, reply as GitlabPrReply);
}
