import { NaxError } from "@/errors";
import { encodeProjectPath } from "./pr-read";
import type { PostedComment, PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

export const MAX_FORGE_COMMENT_CHARS = 65_536;

/** Validate without rewriting the body: whitespace and @ prefixes are posted verbatim. */
export function assertCommentBody(body: string): void {
  if (!body.trim()) {
    throw new NaxError("[forge] Comment body must not be empty", "FORGE_COMMENT_EMPTY", { stage: "forge" });
  }
  if (body.length > MAX_FORGE_COMMENT_CHARS) {
    throw new NaxError("[forge] Comment body exceeds the forge limit", "FORGE_COMMENT_TOO_LONG", {
      stage: "forge",
      length: body.length,
      max: MAX_FORGE_COMMENT_CHARS,
    });
  }
}

function responseError(ref: PrRef, cause?: unknown): NaxError {
  return new NaxError(`[forge] Invalid write response for ${ref.repo}#${ref.number}`, "FORGE_RESPONSE_UNPARSEABLE", {
    stage: "forge",
    forge: ref.forge,
    ref,
    cause,
  });
}

/** Execute API arguments after the host prefix exactly once. Never retry a potentially completed write. */
export async function runForgeWrite(ref: PrRef, argv: string[], deps: ForgeDeps, cwd: string): Promise<unknown> {
  const cli = ref.forge === "github" ? "gh" : "glab";
  const result = await deps.run([cli, "api", "--hostname", ref.host, ...argv], { cwd });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new NaxError(`[forge] Cannot write ${ref.repo}#${ref.number}: ${stderr}`, "FORGE_COMMENT_WRITE_FAILED", {
      stage: "forge",
      forge: ref.forge,
      exitCode: result.exitCode,
      stderr,
    });
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw responseError(ref, cause);
  }
}

/** Post one top-level PR/MR comment; string fields must always use raw -f, never file-aware -F. */
export async function postPrComment(ref: PrRef, body: string, deps: ForgeDeps, cwd: string): Promise<PostedComment> {
  assertCommentBody(body);
  const endpoint =
    ref.forge === "github"
      ? `repos/${ref.repo}/issues/${ref.number}/comments`
      : `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/notes`;
  const reply = await runForgeWrite(ref, ["-X", "POST", endpoint, "-f", `body=${body}`], deps, cwd);
  if (
    !reply ||
    typeof reply !== "object" ||
    !("id" in reply) ||
    (typeof reply.id !== "number" && typeof reply.id !== "string")
  ) {
    throw responseError(ref);
  }
  const url = "html_url" in reply ? reply.html_url : "web_url" in reply ? reply.web_url : undefined;
  return { id: String(reply.id), ...(typeof url === "string" ? { url } : {}) };
}
