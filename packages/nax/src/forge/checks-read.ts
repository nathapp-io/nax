import { NaxError } from "@/errors";
import { asRecord, readCiListing } from "./ci-failures";
import { encodeProjectPath } from "./pr-read";
import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

export type ForgeCheckStatus = "queued" | "in_progress" | "completed";

export interface ForgeCheck {
  readonly id: string;
  readonly name: string;
  readonly status: ForgeCheckStatus;
  /** Present only when status is completed. */
  readonly conclusion?: string;
  readonly url?: string;
  /** True when readJobLog can read this Actions or GitLab job. */
  readonly hasJobLog: boolean;
}

const GITLAB_COMPLETED = new Set(["success", "failed", "canceled", "skipped"]);

function invalidListing(ref: PrRef, headSha: string): NaxError {
  return new NaxError("[forge] Invalid CI listing response", "FORGE_CI_READ_FAILED", {
    stage: "forge",
    ref,
    headSha,
  });
}

function listingArray(reply: unknown, ref: PrRef, headSha: string): unknown[] {
  if (!Array.isArray(reply)) throw invalidListing(ref, headSha);
  return reply;
}

function normalizeCheck(value: unknown, github: boolean): ForgeCheck | null {
  const run = asRecord(value);
  if (!run || typeof run.id !== "number") return null;
  const rawStatus = typeof run.status === "string" ? run.status : "";
  const completed = github ? rawStatus === "completed" : GITLAB_COMPLETED.has(rawStatus);
  const active = rawStatus === (github ? "in_progress" : "running");
  const status: ForgeCheckStatus = completed ? "completed" : active ? "in_progress" : "queued";
  const conclusion = github ? (typeof run.conclusion === "string" ? run.conclusion : "unknown") : rawStatus;
  const url = github ? run.html_url : run.web_url;
  return {
    id: String(run.id),
    name: typeof run.name === "string" ? run.name : "",
    status,
    ...(completed ? { conclusion } : {}),
    ...(typeof url === "string" && url.length > 0 ? { url } : {}),
    hasJobLog: !github || asRecord(run.app)?.slug === "github-actions",
  };
}

async function gitlabChecks(ref: PrRef, headSha: string, deps: ForgeDeps, cwd: string): Promise<unknown[]> {
  const context = { ref, headSha };
  const project = encodeProjectPath(ref.repo);
  const pipelines = await readCiListing(
    ["glab", "api", "--hostname", ref.host, `projects/${project}/merge_requests/${ref.number}/pipelines?per_page=20`],
    deps,
    cwd,
    context,
  );
  const pipeline = listingArray(pipelines, ref, headSha)
    .map(asRecord)
    .find((item) => item?.sha === headSha);
  if (!pipeline) return [];
  if (typeof pipeline.id !== "number") throw invalidListing(ref, headSha);
  const jobs = await readCiListing(
    ["glab", "api", "--hostname", ref.host, `projects/${project}/pipelines/${pipeline.id}/jobs?per_page=100`],
    deps,
    cwd,
    context,
  );
  return listingArray(jobs, ref, headSha);
}

/** Read only the first page (at most 100 checks/jobs), including queued and running checks. */
export async function listHeadChecks(
  ref: PrRef,
  headSha: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<readonly ForgeCheck[]> {
  const github = ref.forge === "github";
  let runs: unknown[];
  if (github) {
    const endpoint = `repos/${ref.repo}/commits/${headSha}/check-runs?per_page=100&filter=latest`;
    const reply = await readCiListing(["gh", "api", "--hostname", ref.host, endpoint], deps, cwd, { ref, headSha });
    runs = listingArray(asRecord(reply)?.check_runs, ref, headSha);
  } else {
    runs = await gitlabChecks(ref, headSha, deps, cwd);
  }
  return runs.map((run) => normalizeCheck(run, github)).filter((check): check is ForgeCheck => check !== null);
}
