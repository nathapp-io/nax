/**
 * The owned-paths port (S3 spec 6.5, arc decision D16): which paths the HOST
 * owns the writes to, and how its refusals read. nax-agent holds no such
 * knowledge itself; nax injects its policy through `buildCodingToolSupport`
 * and `resolveSessionSandbox`, and an embedder that injects nothing gets
 * `EMPTY_OWNED_PATHS_POLICY`: containment and the `.git/` refusal still apply,
 * owned-path refusals do not.
 */

/** One working-directory frame of a raw Bash token, in frame order. */
export interface OwnedBashCandidate {
  /** The token resolved lexically against one working directory, symlinks resolved (`realOrRaw`). */
  readonly lexical: string;
  /** The typed-seam resolver's root-relative, `/`-joined path for that frame; null when it refused or the path is outside the root. */
  readonly rel: string | null;
}

export interface OwnedPathsPolicy {
  /** Refusal for a mutating path tool on a root-relative, `/`-joined path; undefined = not owned. */
  writeRefusal(
    tool: string,
    rel: string,
    ctx: { readonly exemptRel?: string; readonly optIns: ReadonlySet<string> },
  ): string | undefined;
  /**
   * Refusal for ANY tool, reads included, on a symlink-resolved absolute path;
   * undefined = not refused. Non-undefined makes `resolveWithin` refuse the path,
   * and the text completes `outOfRootReason`'s `path "x" <text>` sentence.
   */
  configRefusal(root: string, resolved: string): string | undefined;
  /** Raw Bash screen: full refusal for `token` given its per-frame candidates; undefined = allowed. */
  bashRefusal(
    tool: string,
    token: string,
    candidates: readonly OwnedBashCandidate[],
    ctx: { readonly root: string; readonly verb: "names" | "redirects into"; readonly sandboxWrapped: boolean },
  ): string | undefined;
  /** Top-level project-state entries the sandbox denies writes to, even when absent. */
  readonly deniedEntries: readonly string[];
  /** Root-level file names the sandbox denies writes to. */
  readonly rootWriteDenies: readonly string[];
  /** The one project-state entry agents may always write; never sandbox-denied. */
  readonly scratchpadEntry?: string;
  /** Project-state entries opened for writes by `allowWrite`. */
  writeOptIns(root: string, allowWrite: readonly string[]): ReadonlySet<string>;
}

const NO_OPT_INS: ReadonlySet<string> = new Set();

export const EMPTY_OWNED_PATHS_POLICY: OwnedPathsPolicy = {
  writeRefusal: () => undefined,
  configRefusal: () => undefined,
  bashRefusal: () => undefined,
  deniedEntries: [],
  rootWriteDenies: [],
  writeOptIns: () => NO_OPT_INS,
};
