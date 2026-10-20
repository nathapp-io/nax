import type { ForgeKind } from "./types";

/** One PR on one forge. `repo` is owner/name on GitHub, the full project path on GitLab. */
export interface PrRef {
  readonly forge: ForgeKind;
  /** Forge host from origin, passed as --hostname on every call. */
  readonly host: string;
  readonly repo: string;
  readonly number: number;
}

export type PrState = "open" | "closed" | "merged";

export interface PrInfo {
  readonly number: number;
  readonly title: string;
  /** Empty when the PR has no description. */
  readonly body: string;
  readonly url: string;
  readonly state: PrState;
  readonly draft: boolean;
  readonly author: { readonly login: string; readonly id?: number };
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  /** True when the head lives outside the base repo, or its location is unknown. */
  readonly crossRepo: boolean;
  /** GitLab only: the shas an inline comment's position needs. */
  readonly diffRefs?: { readonly baseSha: string; readonly startSha: string; readonly headSha: string };
}

export interface PrTrust {
  readonly trusted: boolean;
  /** The classified head sha; a later push needs a new classification. */
  readonly headSha: string;
  /** Why, in order of the rules applied. Never empty. */
  readonly reasons: readonly string[];
}

export type PrCommentKind = "thread" | "comment" | "review";

export interface PrComment {
  /** GitHub comment/review id or GitLab note id, as a string. */
  readonly id: string;
  readonly kind: PrCommentKind;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface PrThread {
  /** GitHub review thread node id or GitLab discussion id, for resolveThread. */
  readonly id: string;
  /** GitHub first comment's database id or GitLab discussion id, for replyToThread. */
  readonly replyTo: string;
  readonly path?: string;
  readonly line?: number;
  readonly resolved: boolean;
  /** GitHub isOutdated; always false on GitLab. */
  readonly outdated: boolean;
  readonly comments: readonly PrComment[];
}

export interface PostedComment {
  readonly id: string;
  /** GitLab inline comment: the discussion it opened. */
  readonly threadId?: string;
  readonly url?: string;
}

export interface CurrentUser {
  readonly login: string;
  readonly id?: number;
}

export interface OwnComment {
  readonly comment: PrComment;
  /** Set when the comment sits in a review thread. */
  readonly threadId?: string;
  readonly key: string;
}
