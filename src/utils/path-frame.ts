import { join } from "node:path";

/**
 * Path-frame SSOT (nax#2067, #2071, #2074).
 *
 * nax holds relative file paths in two frames:
 *   - REPO-ROOTED     "packages/app/src/index.ts"
 *   - PACKAGE-RELATIVE "src/index.ts"
 *
 * The convention: every nax-internal path set is REPO-ROOTED. Package-relative
 * spelling appears only where a path crosses into a package-contained agent's
 * prompt, because agent file tools are rooted at `codingToolRoot` = the package
 * dir (src/agents/types.ts:182-197).
 *
 * `workdir` is always a string here. "." means the repo root. null, undefined
 * and "" are normalised away so no consumer has to invent its own spelling for
 * "absent" — three different spellings are what nax#2067 was.
 *
 * Pure by contract: no I/O, no config, no logging. Ambiguity that needs the
 * filesystem to resolve is handled at PRD write time, not here.
 *
 * See docs/superpowers/specs/2026-09-16-path-frame-convention-design.md.
 */

/**
 * Appended to a path that lies outside the consuming story's workdir.
 *
 * ASCII only and no em dash: rendered into agent prompts and asserted
 * byte-for-byte. Originally defined in src/context/fragments/reframe.ts for
 * nax#2072; moved here so nax#2074 marks cross-package neighbours with the
 * identical string.
 */
export const UNREADABLE_MARKER = " (other package - not readable from this story's workdir)";

/**
 * Remove a trailing UNREADABLE_MARKER from a rendered path.
 *
 * The marker is prompt text, not part of the path. Consumers that use a
 * rendered path as an identity key -- `RawChunk.scopePaths` attribution, for
 * one -- must strip it, or the same file is attributed under two different
 * strings depending on which story rendered it.
 */
export function stripUnreadableMarker(value: string): string {
  return value.endsWith(UNREADABLE_MARKER) ? value.slice(0, -UNREADABLE_MARKER.length) : value;
}

/** Posix separators, no leading "./", no trailing "/". */
function toPosix(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

/**
 * Collapse every spelling of "absent" or "root" to ".".
 *
 * This is the rule that lets the rest of nax stop branching on truthiness.
 */
export function normalizeWorkdir(workdir: string | null | undefined): string {
  if (!workdir) return ".";
  const normalized = toPosix(workdir);
  return normalized === "" || normalized === "." ? "." : normalized;
}

/** True when the workdir denotes the repo root. */
export function isRootWorkdir(workdir: string | null | undefined): boolean {
  return normalizeWorkdir(workdir) === ".";
}

/**
 * Re-spell a package-relative path into the canonical repo-rooted frame.
 *
 * A path already prefixed by `${workdir}/` on a SEGMENT boundary is treated as
 * already repo-rooted and returned unchanged. The boundary matters: consumer
 * "packages/app" against "packages/application/..." must not be read as
 * already-framed.
 *
 * The one ambiguous input is a package-relative path that itself begins with
 * the package's own name (a real "packages/app/..." directory located INSIDE
 * packages/app). It is pathological, and it cannot arise for a PRD written
 * after nax#2067's plan-time canonicalization. No mechanism is built for it.
 */
export function toRepoFrame(path: string, workdir: string | null | undefined): string {
  const prefix = normalizeWorkdir(workdir);
  const normalized = toPosix(path);
  if (prefix === ".") return normalized;
  if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return normalized;
  return `${prefix}/${normalized}`;
}

/**
 * Re-spell a repo-rooted path for a consumer contained at `workdir`.
 *
 * Returns null when the path is not reachable from that root — callers render
 * those with UNREADABLE_MARKER rather than emitting a path that would resolve
 * to a real but WRONG file under the consumer's root.
 *
 * The package directory itself returns null: it is not a file within itself.
 */
export function toPackageFrame(path: string, workdir: string | null | undefined): string | null {
  const prefix = normalizeWorkdir(workdir);
  const normalized = toPosix(path);
  if (prefix === ".") return normalized;
  if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1);
  return null;
}

/**
 * Structural shape of the one field these accessors read.
 *
 * Deliberately NOT `UserStory` from @/prd/types: src/utils/ must not
 * value-import from src/prd/, and check:import-cycles guards that. A
 * structural type keeps this module a leaf.
 */
export interface StoryWorkdirLike {
  readonly workdir?: string;
}

/**
 * The story's workdir, always a string. "." means the repo root.
 *
 * Use this wherever a workdir is needed as a value or a map key. Grouping on
 * the raw field produced "" and "." as distinct keys for the same root.
 */
export function storyWorkdir(story: StoryWorkdirLike): string {
  return normalizeWorkdir(story.workdir);
}

/**
 * The story's package dir, or undefined at the repo root.
 *
 * This is what every API taking "the monorepo package, if any" wants. Passing
 * a raw workdir instead re-introduces nax#2067: "." is truthy, so a root story
 * takes the monorepo branch.
 */
export function storyPackageDir(story: StoryWorkdirLike): string | undefined {
  const workdir = storyWorkdir(story);
  return workdir === "." ? undefined : workdir;
}

/** Absolute working directory for a story beneath `root`. */
export function storyAbsWorkdir(root: string, story: StoryWorkdirLike): string {
  const packageDir = storyPackageDir(story);
  return packageDir ? join(root, packageDir) : root;
}

/**
 * Re-spell a list of declared files for a package-contained consumer.
 *
 * Repo-rooted paths (canonical on-disk PRDs, nax#2067) are converted to the
 * package frame `workdir` is relative to; paths already in the package frame
 * (pre-canonicalization PRDs) or outside it pass through unchanged. Mirrors
 * the v1 reframe in `src/context/builder.ts` — keep the two in sync.
 */
export function toPackageFrameFiles(files: readonly string[], workdir: string | null | undefined): string[] {
  return files.map((file) => toPackageFrame(file, workdir) ?? file);
}
