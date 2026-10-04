/**
 * Paths the HOST owns, which the coding tools and the sandbox must keep the
 * agent away from (S1 spec section 4.2, port 6). Data only: nax builds it
 * from its own path definitions (`naxProtectedPaths`) once per dispatch; an
 * embedder supplies its own.
 */
export interface ProtectedPathsPolicy {
  /** Long-form pathspecs the Git tool appends to its default (no-path) view (nax#2007). */
  readonly gitExcludePathspecs: readonly string[];
  /** Gitignore patterns GitCommit refuses to stage. */
  readonly gitIgnorePatterns: readonly string[];
  /** Project-relative directory whose top-level entries the sandbox policy lists. Absent: the sandbox skips it (S3 spec 6.2). */
  readonly projectStateDir?: string;
  /** Directory whose `credentials*` files the sandbox denies. Absent: the sandbox skips it (S3 spec 6.2). */
  readonly credentialDir?: string;
  /** File the sandbox denies writes to: the trust store deciding whether repository code runs. Absent: the sandbox skips it (S3 spec 6.2). */
  readonly trustStoreFile?: string;
}

/** The Git tool's default excludes; none when the session carries no policy. */
export function gitExcludePathspecsOf(ctx: { readonly protectedPaths?: ProtectedPathsPolicy }): readonly string[] {
  return ctx.protectedPaths?.gitExcludePathspecs ?? [];
}

/** GitCommit's ignore patterns; none when the session carries no policy. */
export function gitIgnorePatternsOf(ctx: { readonly protectedPaths?: ProtectedPathsPolicy }): readonly string[] {
  return ctx.protectedPaths?.gitIgnorePatterns ?? [];
}
