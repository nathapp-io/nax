import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { encodeProjectPath } from "./pr-read";
import type { CurrentUser, PrInfo, PrRef, PrTrust } from "./pr-types";
import type { ForgeDeps, ForgeRunResult } from "./types";

const MAX_FAILURE_DETAIL_LENGTH = 200;
const GITLAB_WRITE_ACCESS_LEVEL = 30;

function readError(what: string, result: ForgeRunResult, cause?: unknown): NaxError {
  return new NaxError(`[forge] Cannot read ${what}: ${result.stderr.trim()}`, "FORGE_RESPONSE_UNPARSEABLE", {
    stage: "forge",
    stderr: result.stderr,
    cause,
  });
}

function parseReply(what: string, result: ForgeRunResult): Record<string, unknown> {
  let reply: unknown;
  try {
    reply = JSON.parse(result.stdout);
  } catch (cause) {
    throw readError(what, result, cause);
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw readError(what, result);
  return reply as Record<string, unknown>;
}

function api(ref: PrRef, endpoint: string): string[] {
  return [ref.forge === "github" ? "gh" : "glab", "api", "--hostname", ref.host, endpoint];
}

/** Read authenticated forge identity without relying on implicit CLI host context. */
export async function readCurrentUser(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<CurrentUser> {
  let result: ForgeRunResult;
  try {
    result = await deps.run(api(ref, "user"), { cwd });
  } catch (cause) {
    throw new NaxError("[forge] Cannot read current user", "FORGE_USER_READ_FAILED", { stage: "forge", cause });
  }
  if (result.exitCode !== 0) {
    throw new NaxError(`[forge] Cannot read current user: ${result.stderr.trim()}`, "FORGE_USER_READ_FAILED", {
      stage: "forge",
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  const reply = parseReply("current user", result);
  const login = reply[ref.forge === "github" ? "login" : "username"];
  if (typeof login !== "string" || !login.trim()) throw readError("current user", result);
  return { login, ...(typeof reply.id === "number" ? { id: reply.id } : {}) };
}

function isCurrentUser(author: PrInfo["author"], user: CurrentUser): boolean {
  return author.id !== undefined && user.id !== undefined ? author.id === user.id : author.login === user.login;
}

async function hasWriteAccess(ref: PrRef, info: PrInfo, deps: ForgeDeps, cwd: string): Promise<boolean> {
  const github = ref.forge === "github";
  if (!github && info.author.id === undefined) {
    throw new NaxError("[forge] Missing author id", "FORGE_RESPONSE_UNPARSEABLE", { stage: "forge" });
  }
  const endpoint = github
    ? `repos/${ref.repo}/collaborators/${encodeURIComponent(info.author.login)}/permission`
    : `projects/${encodeProjectPath(ref.repo)}/members/all/${encodeURIComponent(String(info.author.id))}`;
  const result = await deps.run(api(ref, endpoint), { cwd });
  if (!github && result.exitCode !== 0 && result.stderr.includes("404")) return false;
  if (result.exitCode !== 0) throw readError("author permissions", result);
  const reply = parseReply("author permissions", result);
  if (github) {
    if (typeof reply.permission !== "string" || !reply.permission) throw readError("author permissions", result);
    return reply.permission === "admin" || reply.permission === "write";
  }
  if (typeof reply.access_level !== "number" || !Number.isFinite(reply.access_level)) {
    throw readError("author permissions", result);
  }
  return reply.access_level >= GITLAB_WRITE_ACCESS_LEVEL;
}

function failureDetail(cause: unknown): string {
  const stderr = cause instanceof NaxError ? cause.context?.stderr : undefined;
  return (typeof stderr === "string" ? stderr : errorMessage(cause)).trim().slice(0, MAX_FAILURE_DETAIL_LENGTH);
}

/** Metadata-only, ordered, fail-closed classification. Each call re-reads forge identity and access. */
export async function classifyPrTrust(ref: PrRef, info: PrInfo, deps: ForgeDeps, cwd: string): Promise<PrTrust> {
  const trust = (trusted: boolean, reason: string): PrTrust => ({ trusted, headSha: info.headSha, reasons: [reason] });
  if (info.crossRepo) return trust(false, "head branch is not in the base repository");
  let what = "current user";
  try {
    const user = await readCurrentUser(ref, deps, cwd);
    if (isCurrentUser(info.author, user)) return trust(true, "author is the current user");
    what = "author permissions";
    const writable = await hasWriteAccess(ref, info, deps, cwd);
    return trust(writable, writable ? "author has write access" : "author has no write access");
  } catch (cause) {
    return trust(false, `could not read ${what}: ${failureDetail(cause)}`);
  }
}
