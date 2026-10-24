import type { PrComment, WriterCheck } from "@/forge";

export { type WriterCheck, writerCheck } from "@/forge";

/** A review exposed to non-writer text cannot settle workflow items as fixed. */
export async function hasNonWriterAuthor(
  comments: readonly PrComment[],
  login: string,
  check: WriterCheck,
): Promise<boolean> {
  const allowed = await Promise.all(
    comments
      .filter((comment) => comment.author !== login)
      .map((comment) => check({ login: comment.author, id: comment.authorId })),
  );
  return allowed.some((writer) => !writer);
}

/** Only authorized authors become writers; preserve forge-specific author ids. */
export async function readWriters(comments: readonly PrComment[], check: WriterCheck): Promise<ReadonlySet<string>> {
  const allowed = await Promise.all(
    comments.map(async (comment) =>
      (await check({ login: comment.author, id: comment.authorId })) ? comment.author : null,
    ),
  );
  return new Set(allowed.filter((login): login is string => login !== null));
}
