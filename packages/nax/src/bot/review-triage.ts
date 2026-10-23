import { ownComments, type PrComment, type PrThread, parseNaxBotMarker, type WriterCheck } from "@/forge";
import { getSafeLogger } from "@/logger";
import type { PostReviewInput } from "./post";
import { _botReviewDeps } from "./review-deps";
import { readWriters, writerCheck } from "./writers";

export async function triage(
  ref: PostReviewInput["ref"],
  cwd: string,
): Promise<
  Required<Pick<PostReviewInput, "threads" | "comments" | "own" | "earlier" | "login" | "writers">> & {
    ownFindingThreads: readonly PrThread[];
    writerCheck: WriterCheck;
    rawThreads: PostReviewInput["threads"];
    rawComments: PostReviewInput["comments"];
  }
> {
  const deps = _botReviewDeps;
  const [user, threads, comments] = await Promise.all([
    deps.readCurrentUser(ref, deps.forge, cwd),
    deps.listReviewThreads(ref, deps.forge, cwd),
    deps.listPrComments(ref, deps.forge, cwd),
  ]);
  const own = [
    ...threads.flatMap((thread) => ownComments(thread.comments, user.login, thread.id)),
    ...ownComments(comments, user.login),
  ];
  const isOwn = (comment: PrComment | undefined): boolean =>
    comment !== undefined && ownComments([comment], user.login).length > 0;
  const keptThreads = threads.filter((thread) => !thread.resolved && !isOwn(thread.comments[0]));
  const keptComments = comments.filter(
    (comment) =>
      (comment.kind === "comment" || comment.kind === "review") && comment.body.trim() !== "" && !isOwn(comment),
  );
  const check = writerCheck({ ref, deps: deps.forge, cwd }, deps.hasWriteAccess, (login, error) =>
    getSafeLogger()?.warn("bot", "Could not check commenter permission", { login, error }),
  );
  const ownFindingThreads = threads.filter(
    (thread) => isOwn(thread.comments[0]) && parseNaxBotMarker(thread.comments[0]?.body ?? "")?.key.startsWith("f-"),
  );
  const writers = await readWriters(
    [...keptThreads.flatMap((thread) => (thread.comments[0] ? [thread.comments[0]] : [])), ...keptComments],
    check,
  );
  return {
    writers,
    ownFindingThreads,
    writerCheck: check,
    rawThreads: threads,
    rawComments: comments,
    own,
    login: user.login,
    earlier: ownFindingThreads.filter((thread) => !thread.resolved),
    threads: keptThreads,
    comments: keptComments,
  };
}
