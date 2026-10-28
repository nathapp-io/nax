import { NaxError } from "@/errors";
import { isNaxBotMarkerKey, markerPattern, parseNaxBotMarker } from "./marker-grammar";

import type { OwnComment, PrComment, PrRef } from "./pr-types";
import { listPrComments, listReviewThreads } from "./threads";
import { readCurrentUser } from "./trust";
import type { ForgeDeps } from "./types";

export { isNaxBotMarkerKey, parseNaxBotMarker } from "./marker-grammar";

export const NAX_BOT_HEADER = "**nax bot**";
export const NAX_WORKFLOW_PR_MARKER = "<!-- nax-workflow:v1 -->";

/** Return whether a PR body contains the exact nax-workflow marker line. */
export function hasNaxWorkflowMarker(body: string): boolean {
  return body.split(/\r?\n/).some((line) => line === NAX_WORKFLOW_PR_MARKER);
}
/** Wrap a comment with a stable visible header and an injection-safe identity marker. */
export function withNaxBotMarker(body: string, key: string): string {
  // Compare the full match: JavaScript's $ also matches before a final newline.
  if (!isNaxBotMarkerKey(key)) {
    throw new NaxError("[forge] Invalid nax bot marker key", "FORGE_MARKER_KEY_INVALID", { stage: "forge", key });
  }
  return `${NAX_BOT_HEADER}\n\n${body}\n\n<!-- nax-bot:v1 key=${key} -->`;
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
