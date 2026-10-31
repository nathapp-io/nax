import { NaxError } from "@/errors";
import { parseNaxBotMarker, TOP_LEVEL_MARKER_KEYS } from "./marker-grammar";
import { encodeProjectPath } from "./pr-read";
import type { PrComment, PrRef, PrThread } from "./pr-types";
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
  comments: {
    pageInfo?: { hasNextPage: boolean };
    nodes: GithubThreadComment[];
  };
}
interface GithubThreadComment {
  databaseId: number;
  author: GithubAuthor | null;
  body: string;
  createdAt: string;
}
/**
 * GitHub GraphQL reports a bot's login without the `[bot]` suffix REST appends,
 * so the type is what tells the two apart. Older replies omit it.
 */
interface GithubAuthor {
  login: string;
  __typename?: string;
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
    author: { username: string; id: number };
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
          comments(first: 100) { pageInfo { hasNextPage } nodes { databaseId author { login __typename } body createdAt } }
        }
      }
    }
  }
}`;

/**
 * The author login as REST reports it. GraphQL drops the `[bot]` suffix a bot's
 * login carries everywhere else, so an unmapped `Bot` never matches the bot's own
 * REST-form login — and a human account named like the bot's slug would.
 */
function githubAuthor(author: GithubAuthor | null | undefined): string {
  if (!author) return "ghost";
  return author.__typename === "Bot" ? `${author.login}[bot]` : author.login;
}

function githubThread(node: GithubThread): PrThread {
  // Authoritative ruling consumers must never authorize from an incomplete conversation.
  // Fail closed at the nested page boundary until a complete comment reader is available.
  if (
    node.comments.pageInfo?.hasNextPage ||
    (!node.comments.pageInfo && node.comments.nodes.length >= FORGE_PAGE_SIZE)
  ) {
    throw new NaxError("[forge] Incomplete review thread conversation", "FORGE_PAGINATION_LIMIT", {
      stage: "forge",
      threadId: node.id,
    });
  }
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
      author: githubAuthor(comment.author),
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

/** Classification only: marker ownership still requires the authenticated login. */
function isRepliedTopLevelNote(discussion: GitlabDiscussion): boolean {
  if (discussion.individual_note !== false) return false;
  const first = discussion.notes.find((note) => !note.system);
  if (!first || first.position != null) return false;
  const marker = parseNaxBotMarker(first.body);
  return marker !== null && TOP_LEVEL_MARKER_KEYS.some((key) => key === marker.key);
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
        authorId: note.author.id,
        body: note.body,
        createdAt: note.created_at,
      })),
  };
}

interface GithubComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
}
interface GithubReview extends Omit<GithubComment, "created_at"> {
  submitted_at: string;
}

async function readGithubComments(context: ReadContext): Promise<PrComment[]> {
  const { ref } = context;
  const issues = await readForgeRestPages<GithubComment>(context, `repos/${ref.repo}/issues/${ref.number}/comments`);
  const reviews = await readForgeRestPages<GithubReview>(context, `repos/${ref.repo}/pulls/${ref.number}/reviews`);
  try {
    return [
      ...issues.map(
        (comment): PrComment => ({
          id: String(comment.id),
          kind: "comment",
          author: comment.user?.login ?? "ghost",
          body: comment.body,
          createdAt: comment.created_at,
        }),
      ),
      ...reviews
        .filter((review) => review.body.length > 0)
        .map(
          (review): PrComment => ({
            id: String(review.id),
            kind: "review",
            author: review.user?.login ?? "ghost",
            body: review.body,
            createdAt: review.submitted_at,
          }),
        ),
    ];
  } catch (cause) {
    throw responseError(ref, cause);
  }
}

/** Read top-level comments, followed by nonempty GitHub review bodies, in endpoint/page order. */
export async function listPrComments(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<PrComment[]> {
  const context: ReadContext = { ref, deps, cwd, failureCode: "FORGE_COMMENTS_READ_FAILED" };
  if (ref.forge === "github") return readGithubComments(context);
  const endpoint = `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions`;
  const discussions = await readForgeRestPages<GitlabDiscussion>(context, endpoint);
  try {
    return discussions
      .filter((discussion) => discussion.individual_note === true || isRepliedTopLevelNote(discussion))
      .flatMap((discussion) =>
        discussion.notes
          .filter((note) => !note.system)
          .map(
            (note): PrComment => ({
              id: String(note.id),
              kind: "comment",
              author: note.author.username,
              authorId: note.author.id,
              body: note.body,
              createdAt: note.created_at,
            }),
          ),
      );
  } catch (cause) {
    throw responseError(ref, cause);
  }
}

/** Read review threads in forge order, using explicit host and bounded, observable page requests. */
export async function listReviewThreads(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<PrThread[]> {
  const context: ReadContext = { ref, deps, cwd, failureCode: "FORGE_THREADS_READ_FAILED" };
  if (ref.forge === "github") return readGithubThreads(context);
  const endpoint = `projects/${encodeProjectPath(ref.repo)}/merge_requests/${ref.number}/discussions`;
  const discussions = await readForgeRestPages<GitlabDiscussion>(context, endpoint);
  try {
    return discussions
      .filter((discussion) => discussion.individual_note === false && !isRepliedTopLevelNote(discussion))
      .map(gitlabThread);
  } catch (cause) {
    throw responseError(ref, cause);
  }
}
