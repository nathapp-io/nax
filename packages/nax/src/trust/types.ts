/**
 * Types for the per-folder trust store (US-001).
 *
 * A trust entry grants the folder it names -- and every descendant of it --
 * the right to have repository-controlled code run on the host: project
 * plugins, context plugin providers, hooks, MCP servers and the quality /
 * test / acceptance / setup commands (#2293). Matching is over
 * realpath-normalized absolute paths; see `match.ts` for the coverage rule
 * and `store.ts` for the on-disk format.
 */

/** One trusted folder, as stored in `trust.json`. */
export interface TrustEntry {
  /** Absolute, normalized path. Exactly the spelling `normalizeTrustPath` produces. */
  path: string;
  /** ISO-8601 timestamp of when the entry was written, from `_trustStoreDeps.now()`. */
  addedAt: string;
  /** `"prompt"` when the entry gate asked; `"cli"` when `nax trust add` wrote it. */
  via: "prompt" | "cli";
}

/** The document stored at `trustStorePath()`. */
export interface TrustStoreFile {
  version: 1;
  folders: TrustEntry[];
}

/**
 * What a `readTrustStore()` call found: no file at all, a file it could parse
 * into the version-1 shape, or a file whose contents are not that shape
 * (invalid JSON, another `version`, a non-array `folders`, a relative `path`,
 * an unknown `via`). `unparseable` is deliberately distinct from `missing`:
 * a caller that writes must fail closed on it rather than treat it as empty.
 */
export type TrustStoreRead =
  | { state: "missing" }
  | { state: "ok"; file: TrustStoreFile }
  | { state: "unparseable"; reason: string };

/** What `addTrustEntry` did. */
export type AddTrustResult =
  | { outcome: "added"; entry: TrustEntry }
  | { outcome: "already-covered"; coveredBy: TrustEntry };

/**
 * What `removeTrustEntry` did. `not-found` still reports the entry that covers
 * the path, so the caller can say "still trusted through X".
 */
export type RemoveTrustResult =
  | { outcome: "removed"; entry: TrustEntry }
  | { outcome: "not-found"; coveredBy: TrustEntry | null };

/** The execution site a trust check is guarding. Used by the registry backstops. */
export type TrustSurface =
  | "plugins"
  | "context-plugin-providers"
  | "hooks"
  | "mcp"
  | "quality-command"
  | "test-command"
  | "acceptance-command"
  | "package-setup"
  | "worktree-setup";

/** What the operator answered at the trust prompt. */
export type TrustChoice = "yes" | "parent" | "no";
