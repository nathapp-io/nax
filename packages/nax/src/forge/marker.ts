import { NaxError } from "@/errors";
import type { OwnComment, PrComment, PrRef } from "./pr-types";
import { listPrComments, listReviewThreads } from "./threads";
import { readCurrentUser } from "./trust";
import type { ForgeDeps } from "./types";

export const NAX_BOT_HEADER = "**nax bot**";
const MARKER_KEY_PATTERN = "[A-Za-z0-9._:-]{1,128}";
const markerPattern = () => new RegExp(`<!-- nax-bot:v1 key=(${MARKER_KEY_PATTERN}) -->`, "g");
const MARKER_KEY = new RegExp(`^${MARKER_KEY_PATTERN}$`);

/** Wrap a comment with a stable visible header and an injection-safe identity marker. */
export function withNaxBotMarker(body: string, key: string): string {
  // Compare the full match: JavaScript's $ also matches before a final newline.
  if (MARKER_KEY.exec(key)?.[0] !== key) {
    throw new NaxError("[forge] Invalid nax bot marker key", "FORGE_MARKER_KEY_INVALID", { stage: "forge", key });
  }
  return `${NAX_BOT_HEADER}\n\n${body}\n\n<!-- nax-bot:v1 key=${key} -->`;
}

/** Return the last valid v1 marker; a marker alone does not establish ownership. */
export function parseNaxBotMarker(body: string): { key: string } | null {
  const pattern = markerPattern();
  let result: { key: string } | null = null;
  for (const match of body.matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined) result = { key };
  }
  return result;
}

export function ownComments(comments: readonly PrComment[], login: string, threadId?: string): OwnComment[] {
  return comments.flatMap((comment): OwnComment[] => {
    if (comment.author !== login) return [];
    const marker = parseNaxBotMarker(comment.body);
    if (!marker) return [];
    return [{ comment, key: marker.key, ...(threadId === undefined ? {} : { threadId }) }];
  });
}

/** Discover marked comments by the authenticated user, with threads first in forge order. */
export async function findOwnComments(ref: PrRef, deps: ForgeDeps, cwd: string): Promise<OwnComment[]> {
  const user = await readCurrentUser(ref, deps, cwd);
  const threads = await listReviewThreads(ref, deps, cwd);
  const comments = await listPrComments(ref, deps, cwd);
  return [
    ...threads.flatMap((thread) => ownComments(thread.comments, user.login, thread.id)),
    ...ownComments(comments, user.login),
  ];
}

/** Remove valid identity markers using the same grammar as ownership parsing. */
export function stripNaxBotMarkers(body: string): string {
  return body.replace(markerPattern(), "");
}
