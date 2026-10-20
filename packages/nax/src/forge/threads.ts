import { NaxError } from "@/errors";
import { encodeProjectPath } from "./pr-read";
import type { PrRef, PrThread } from "./pr-types";
import type { ForgeDeps } from "./types";

export const MAX_FORGE_PAGES = 50;
const FORGE_PAGE_SIZE = 100;
type ReadFailureCode = "FORGE_THREADS_READ_FAILED" | "FORGE_COMMENTS_READ_FAILED";
interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasNextPage: boolean;
}
interface ReadContext {
  ref: PrRef;
  deps: ForgeDeps;
  cwd: string;
  failureCode: ReadFailureCode;
}

function responseError(ref: PrRef, cause?: unknown): NaxError {
  return new NaxError(`[forge] Invalid response for ${ref.repo}#${ref.number}`, "FORGE_RESPONSE_UNPARSEABLE", {
    stage: "forge",
    ref,
    cause,
  });
}

/** Shared explicit page loop. Decoders map a complete page before any items are returned. */
async function collectForgePages<T>(
  context: ReadContext,
  request: (page: number, cursor?: string) => string[],
  decode: (reply: unknown) => Page<T>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_FORGE_PAGES; page++) {
    const result = await context.deps.run(request(page, cursor), { cwd: context.cwd });
    if (result.exitCode !== 0) {
      throw new NaxError(
        `[forge] Cannot read ${context.ref.repo}#${context.ref.number}: ${result.stderr.trim()}`,
        context.failureCode,
        { stage: "forge", ref: context.ref, page, exitCode: result.exitCode },
      );
    }
    let decoded: Page<T>;
    try {
      decoded = decode(JSON.parse(result.stdout));
    } catch (cause) {
      throw responseError(context.ref, cause);
    }
    items.push(...decoded.items);
    if (!decoded.hasNextPage) return items;
    cursor = decoded.nextCursor;
  }
  throw new NaxError(
    `[forge] Pagination limit for ${context.ref.repo}#${context.ref.number}`,
    "FORGE_PAGINATION_LIMIT",
    { stage: "forge", ref: context.ref },
  );
}

/** Internal seam for comment readers: same loop and a caller-selected read-failure code. */
export async function readForgeRestPages<T>(context: ReadContext, endpoint: string): Promise<T[]> {
  const { ref } = context;
  return collectForgePages(
    context,
    (page) => [
      ref.forge === "github" ? "gh" : "glab",
      "api",
      "--hostname",
      ref.host,
      `${endpoint}?per_page=${FORGE_PAGE_SIZE}&page=${page}`,
    ],
    (reply) => {
      if (!Array.isArray(reply)) throw responseError(ref);
      return { items: reply as T[], hasNextPage: reply.length === FORGE_PAGE_SIZE };
    },
  );
}

interface GithubThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: { nodes: { databaseId: number; author: { login: string } | null; body: string; createdAt: string }[] };
}
interface GithubReply {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: GithubThread[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
  };
}
export interface GitlabDiscussion {
  id: string;
  individual_note: boolean;
  notes: {
    id: number;
    system: boolean;
    resolved?: boolean;
    author: { username: string };
    body: string;
    created_at: string;
    position?: {
      new_path?: string | null;
      old_path?: string | null;
      new_line?: number | null;
      old_line?: number | null;
    };
  }[];
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

function githubThread(node: GithubThread): PrThread {
  const first = node.comments.nodes[0];
  if (!first)
    throw new NaxError("[forge] Review thread has no reply target", "FORGE_RESPONSE_UNPARSEABLE", { stage: "forge" });
  return {
    id: node.id,
    replyTo: String(first.databaseId),
    path: node.path,
    line: node.line ?? node.originalLine ?? undefined,
    resolved: node.isResolved,
    outdated: node.isOutdated,
    comments: node.comments.nodes.map((comment) => ({
      id: String(comment.databaseId),
      kind: "thread",
      author: comment.author?.login ?? "ghost",
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  };
}

function readGithubThreads(context: ReadContext): Promise<PrThread[]> {
  const { ref } = context;
  const slash = ref.repo.indexOf("/");
  return collectForgePages(
    context,
    (_page, cursor) => [
      "gh",
      "api",
      "--hostname",
      ref.host,
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${ref.repo.slice(0, slash)}`,
      "-f",
      `name=${ref.repo.slice(slash + 1)}`,
      "-F",
      `number=${ref.number}`,
      ...(cursor === undefined ? [] : ["-f", `endCursor=${cursor}`]),
    ],
    (reply) => {
      const connection = (reply as GithubReply).data.repository.pullRequest.reviewThreads;
      const { hasNextPage, endCursor } = connection.pageInfo;
      if (typeof hasNextPage !== "boolean" || (hasNextPage && !endCursor)) throw responseError(ref);
      return { items: connection.nodes.map(githubThread), hasNextPage, nextCursor: endCursor ?? undefined };
    },
  );
}

function gitlabThread(discussion: GitlabDiscussion): PrThread {
  const first = discussion.notes[0];
  const position = first?.position;
  return {
    id: discussion.id,
    replyTo: discussion.id,
    path: position?.new_path ?? position?.old_path ?? undefined,
    line: position?.new_line ?? position?.old_line ?? undefined,
    resolved: first?.resolved === true,
    outdated: false,
    comments: discussion.notes
      .filter((note) => !note.system)
      .map((note) => ({
        id: String(note.id),
        kind: "thread",
        author: note.author.username,
        body: note.body,
        createdAt: note.created_at,
      })),
  };
}

/** Read review threads in forge order, using explicit host and bounded, observable page requests. */
export async function listReviewThreads(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<PrThread[]> {
  const context: ReadContext = { ref, deps, cwd, failureCode: "FORGE_THREADS_READ_FAILED" };
  if (ref.forge === "github") return readGithubThreads(context);
  const endpoint = `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions`;
  const discussions = await readForgeRestPages<GitlabDiscussion>(context, endpoint);
  try {
    return discussions.filter((discussion) => discussion.individual_note === false).map(gitlabThread);
  } catch (cause) {
    throw responseError(ref, cause);
  }
}
