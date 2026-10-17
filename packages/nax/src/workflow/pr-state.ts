/**
 * What the forge reports about one PR/MR (SPEC-workflow-record-promote, US-002).
 *
 * `nax workflow record` refuses to record `promoted` or `verified-ready` while the PR is a draft,
 * and `nax workflow promote` (US-004) refuses to act on one that is already ready, so both read the
 * state the same way. GitHub and GitLab name the same three facts differently — `isDraft` /
 * `draft` / `work_in_progress`, `body` / `description`, `url` / `web_url` — and this is the one
 * place that difference is normalised.
 *
 * The command runs through the caller's `ForgeDeps`, so a test stubs the CLI rather than the module.
 */
import { NaxError } from "@/errors";
import { type ForgeDeps, type ForgeKind, viewArgv } from "@/forge";

/** The state of one PR/MR, as the normalized `PrState`. */
export interface PrState {
  readonly isDraft: boolean;
  readonly body: string;
  readonly url?: string;
}

/** The fields `gh pr view` is asked for; GitLab returns its own three regardless. */
const GITHUB_FIELDS = "isDraft,body,url";
const PR_READ_FAILED = "WORKFLOW_PR_READ_FAILED";
/** How much of an unparseable stdout is quoted back, so a huge answer cannot flood a log line. */
const DETAIL_SLICE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function readFailed(prRef: string, detail: string, context: Record<string, unknown>): NaxError {
  return new NaxError(`cannot read PR ${prRef}: ${detail}`, PR_READ_FAILED, {
    stage: "workflow",
    prRef,
    ...context,
  });
}

/** GitHub, GitLab's `draft`, and GitLab's older `work_in_progress` all mean the same thing. */
const DRAFT_FLAGS: Readonly<Record<ForgeKind, readonly string[]>> = {
  github: ["isDraft"],
  gitlab: ["draft", "work_in_progress"],
};

/**
 * The PR/MR's draft state, from the flags its own forge reports. Only a boolean counts, and only a
 * name that forge uses: a missing or malformed flag means the forge did not report readiness, and
 * reading that as "ready" would let a caller record `promoted` — or promote — a PR nobody confirmed.
 * GitLab's older `work_in_progress` is the fallback for an MR that predates `draft`.
 */
function isDraft(fields: Record<string, unknown>, prRef: string, forge: ForgeKind): boolean {
  const names = DRAFT_FLAGS[forge];
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "boolean") return value;
  }
  throw readFailed(prRef, `the forge reported no ${names.join(" or ")} boolean`, { forge });
}

function parseOutput(stdout: string, prRef: string, forge: ForgeKind): Record<string, unknown> {
  const out = stdout.trim();
  let parsed: unknown;
  if (out !== "") {
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = undefined;
    }
  }
  if (!isRecord(parsed)) {
    const detail = out === "" ? "empty output" : `unparseable output: ${out.slice(0, DETAIL_SLICE)}`;
    throw readFailed(prRef, detail, { forge });
  }
  return parsed;
}

/**
 * The PR/MR's draft state, body and url. Throws a `WORKFLOW_PR_READ_FAILED` `NaxError` when the
 * forge CLI exits non-zero, answers something that is not a JSON object, or reports no usable draft
 * flag — a caller must never read a failure as "ready".
 */
export async function readPrState(forge: ForgeKind, prRef: string, deps: ForgeDeps, cwd: string): Promise<PrState> {
  const result = await deps.run(viewArgv(forge, prRef, GITHUB_FIELDS), { cwd });
  if (result.exitCode !== 0) {
    throw readFailed(prRef, result.stderr.trim() || `exit ${result.exitCode}`, {
      forge,
      exitCode: result.exitCode,
    });
  }
  const fields = parseOutput(result.stdout, prRef, forge);
  const url = text(fields.url) ?? text(fields.web_url);
  return {
    isDraft: isDraft(fields, prRef, forge),
    body: text(fields.body) ?? text(fields.description) ?? "",
    ...(url === undefined ? {} : { url }),
  };
}
