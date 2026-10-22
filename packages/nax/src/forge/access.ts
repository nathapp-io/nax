import { NaxError } from "@/errors";
import { api, parseReply, readError } from "./api-reply";
import { encodeProjectPath } from "./pr-read";
import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

const GITLAB_WRITE_ACCESS_LEVEL = 30;

/** Check repository write access for any commenter, using explicit forge host context. */
export async function hasWriteAccess(
  ref: PrRef,
  who: { login: string; id?: number },
  deps: ForgeDeps,
  cwd: string,
): Promise<boolean> {
  const github = ref.forge === "github";
  if (!github && who.id === undefined) {
    throw new NaxError("[forge] Missing author id", "FORGE_RESPONSE_UNPARSEABLE", { stage: "forge" });
  }
  const endpoint = github
    ? `repos/${ref.repo}/collaborators/${encodeURIComponent(who.login)}/permission`
    : `projects/${encodeProjectPath(ref.repo)}/members/all/${encodeURIComponent(String(who.id))}`;
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
