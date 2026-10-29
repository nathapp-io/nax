import { NaxError } from "@/errors";
import { encodeProjectPath } from "./pr-read";
import type { PostedComment, PrComment, PrInfo, PrRef, PrThread } from "./pr-types";
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

export type ItemCommentInput = Pick<InlineCommentInput, "path" | "body" | "headSha">;

/** Open a resolvable item thread without anchoring to a diff line. */
export async function postItemComment(
  ref: PrRef,
  input: ItemCommentInput,
  deps: ForgeDeps,
  cwd: string,
): Promise<PostedComment> {
  assertCommentBody(input.body);
  if (ref.forge === "github" && !input.path.trim()) {
    throw new NaxError("[forge] Item comment requires a path", "FORGE_COMMENT_TARGET_INVALID", {
      stage: "forge",
      path: input.path,
    });
  }
  const argv =
    ref.forge === "github"
      ? [
          "-X",
          "POST",
          `repos/${ref.repo}/pulls/${ref.number}/comments`,
          "-f",
          `body=${input.body}`,
          "-f",
          `commit_id=${input.headSha}`,
          "-f",
          `path=${input.path}`,
          "-f",
          "subject_type=file",
        ]
      : [
          "-X",
          "POST",
          `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions`,
          "-f",
          `body=${input.body}`,
        ];
  return inlineReply(ref, await runForgeWrite(ref, argv, deps, cwd));
}

const NUMERIC_COMMENT_ID = /^[0-9]+$/;
const GITLAB_DISCUSSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNRESOLVE_REVIEW_THREAD =
  "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }";
const RESOLVE_REVIEW_THREAD =
  "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }";

/** Validate the entire id, including rejecting a final newline matched before JS's $ anchor. */
function endpointId(ref: PrRef, id: string, pattern: RegExp): string {
  if (pattern.exec(id)?.[0] !== id) {
    throw new NaxError(`[forge] Invalid endpoint id for ${ref.repo}#${ref.number}`, "FORGE_ID_INVALID", {
      stage: "forge",
      forge: ref.forge,
      id,
    });
  }
  return encodeURIComponent(id);
}

function postedReply(ref: PrRef, reply: unknown): PostedComment {
  if (!hasCommentId(reply)) throw responseError(ref);
  const url = "html_url" in reply ? reply.html_url : "web_url" in reply ? reply.web_url : undefined;
  return { id: String(reply.id), ...(typeof url === "string" ? { url } : {}) };
}

/** Reply to the reader's reply target, not GitHub's GraphQL thread node id. */
export async function replyToThread(
  ref: PrRef,
  thread: Pick<PrThread, "replyTo">,
  body: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<PostedComment> {
  assertCommentBody(body);
  const id = endpointId(ref, thread.replyTo, ref.forge === "github" ? NUMERIC_COMMENT_ID : GITLAB_DISCUSSION_ID);
  const endpoint =
    ref.forge === "github"
      ? `repos/${ref.repo}/pulls/${ref.number}/comments/${id}/replies`
      : `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions/${id}/notes`;
  return postedReply(ref, await runForgeWrite(ref, ["-X", "POST", endpoint, "-f", `body=${body}`], deps, cwd));
}

/** Resolve a review thread; GitHub node ids are raw GraphQL variables, never path segments. */
export async function resolveThread(
  ref: PrRef,
  thread: Pick<PrThread, "id">,
  deps: ForgeDeps,
  cwd: string,
): Promise<void> {
  const argv =
    ref.forge === "github"
      ? ["graphql", "-f", `query=${RESOLVE_REVIEW_THREAD}`, "-f", `id=${thread.id}`]
      : [
          "-X",
          "PUT",
          `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions/${endpointId(ref, thread.id, GITLAB_DISCUSSION_ID)}`,
          "-f",
          "resolved=true",
        ];
  await runForgeWrite(ref, argv, deps, cwd);
}

/** Reopen a review thread; keep GitHub node ids in raw GraphQL variables. */
export async function unresolveThread(
  ref: PrRef,
  thread: Pick<PrThread, "id">,
  deps: ForgeDeps,
  cwd: string,
): Promise<void> {
  const argv =
    ref.forge === "github"
      ? ["graphql", "-f", `query=${UNRESOLVE_REVIEW_THREAD}`, "-f", `id=${thread.id}`]
      : [
          "-X",
          "PUT",
          `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions/${endpointId(ref, thread.id, GITLAB_DISCUSSION_ID)}`,
          "-f",
          "resolved=false",
        ];
  await runForgeWrite(ref, argv, deps, cwd);
}

/** Edit a REST comment/note by database id; GitHub review summaries are not editable here. */
export async function editComment(
  ref: PrRef,
  comment: Pick<PrComment, "id" | "kind">,
  body: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<void> {
  assertCommentBody(body);
  if (ref.forge === "github" && comment.kind === "review") {
    throw new NaxError("[forge] Editing GitHub review summaries is unsupported", "FORGE_EDIT_UNSUPPORTED", {
      stage: "forge",
      forge: ref.forge,
    });
  }
  const id = endpointId(ref, comment.id, NUMERIC_COMMENT_ID);
  const endpoint =
    ref.forge === "github"
      ? `repos/${ref.repo}/${comment.kind === "thread" ? "pulls" : "issues"}/comments/${id}`
      : `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/notes/${id}`;
  await runForgeWrite(ref, ["-X", ref.forge === "github" ? "PATCH" : "PUT", endpoint, "-f", `body=${body}`], deps, cwd);
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
