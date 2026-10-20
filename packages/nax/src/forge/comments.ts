import { NaxError } from "@/errors";
import { encodeProjectPath } from "./pr-read";
import type { PostedComment, PrInfo, PrRef } from "./pr-types";
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

export interface InlineCommentInput {
  readonly path: string;
  readonly line: number;
  readonly body: string;
  readonly headSha: string;
  readonly diffRefs?: PrInfo["diffRefs"];
}

function inlineArgv(ref: PrRef, input: InlineCommentInput): string[] {
  const { path, line, body, headSha, diffRefs } = input;
  if (ref.forge === "github") {
    return [
      "-X",
      "POST",
      `repos/${ref.repo}/pulls/${ref.number}/comments`,
      "-f",
      `body=${body}`,
      "-f",
      `commit_id=${headSha}`,
      "-f",
      `path=${path}`,
      "-F",
      `line=${line}`,
      "-f",
      "side=RIGHT",
    ];
  }
  if (!diffRefs) {
    throw new NaxError("[forge] GitLab inline comments require diff refs", "FORGE_DIFF_REFS_REQUIRED", {
      stage: "forge",
      forge: ref.forge,
    });
  }
  // glab does not nest bracketed field names; GitLab merges query and body parameters.
  const query = new URLSearchParams({
    "position[position_type]": "text",
    "position[base_sha]": diffRefs.baseSha,
    "position[start_sha]": diffRefs.startSha,
    "position[head_sha]": diffRefs.headSha,
    "position[old_path]": path,
    "position[new_path]": path,
    "position[new_line]": String(line),
  });
  return [
    "-X",
    "POST",
    `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions?${query}`,
    "-f",
    `body=${body}`,
  ];
}

function hasCommentId(value: unknown): value is { id: string | number } {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    (typeof value.id === "string" || typeof value.id === "number")
  );
}

function inlineReply(ref: PrRef, reply: unknown): PostedComment {
  if (!hasCommentId(reply)) throw responseError(ref);
  if (ref.forge === "github") {
    const url = "html_url" in reply ? reply.html_url : undefined;
    return { id: String(reply.id), ...(typeof url === "string" ? { url } : {}) };
  }
  const notes = "notes" in reply ? reply.notes : undefined;
  if (!Array.isArray(notes) || !hasCommentId(notes[0])) throw responseError(ref);
  return { id: String(notes[0].id), threadId: String(reply.id) };
}

/** Post a new-side single-line comment, never retrying the shared write. */
export async function postInlineComment(
  ref: PrRef,
  input: InlineCommentInput,
  deps: ForgeDeps,
  cwd: string,
): Promise<PostedComment> {
  assertCommentBody(input.body);
  if (!input.path || !Number.isInteger(input.line) || input.line <= 0) {
    throw new NaxError(
      "[forge] Inline comment requires a path and positive integer line",
      "FORGE_COMMENT_TARGET_INVALID",
      {
        stage: "forge",
        forge: ref.forge,
        path: input.path,
        line: input.line,
      },
    );
  }
  const reply = await runForgeWrite(ref, inlineArgv(ref, input), deps, cwd);
  return inlineReply(ref, reply);
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
