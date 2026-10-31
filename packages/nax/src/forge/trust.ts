import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { hasWriteAccess } from "./access";
import { api, parseReply, readError } from "./api-reply";
import type { CurrentUser, PrInfo, PrRef, PrTrust } from "./pr-types";
import type { ForgeDeps, ForgeRunResult } from "./types";

const MAX_FAILURE_DETAIL_LENGTH = 200;

/**
 * A GitHub App installation token cannot call `/user`, so the login has to come
 * with the token. Fail closed rather than fall back to the ambient CLI login:
 * a half-switched identity would compare a PR against the wrong account.
 */
function missingGithubLogin(): NaxError {
  return new NaxError(
    "[forge] NAX_FORGE_LOGIN is required with NAX_FORGE_TOKEN_FILE on GitHub",
    "FORGE_IDENTITY_LOGIN_REQUIRED",
    { stage: "forge" },
  );
}

/** Read authenticated forge identity without relying on implicit CLI host context. */
export async function readCurrentUser(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<CurrentUser> {
  const identity = deps.identity?.();
  if (identity !== undefined) {
    // The injected login is the answer: asking the forge would return the token's
    // own account, which on GitHub is the App bot under a different name.
    if (identity.login !== undefined) {
      return { login: identity.login, ...(identity.id === undefined ? {} : { id: identity.id }) };
    }
    // GitLab answers `api user` with the token's own account, so only GitHub needs
    // the login supplied up front.
    if (ref.forge === "github") throw missingGithubLogin();
  }
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

function failureDetail(cause: unknown): string {
  const stderr = cause instanceof NaxError ? cause.context?.stderr : undefined;
  return (typeof stderr === "string" && stderr.trim() ? stderr : errorMessage(cause))
    .trim()
    .slice(0, MAX_FAILURE_DETAIL_LENGTH);
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
    const writable = await hasWriteAccess(ref, info.author, deps, cwd);
    return trust(writable, writable ? "author has write access" : "author has no write access");
  } catch (cause) {
    return trust(false, `could not read ${what}: ${failureDetail(cause)}`);
  }
}
