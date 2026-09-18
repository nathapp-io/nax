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
 * Split a declared-path list into what a package-contained consumer can read
 * and what it cannot.
 *
 * `canonical: true` asserts the caller's paths came through the plan-time write
 * seam (story.workdirSource is stamped, src/prd/workdir-canonical.ts). That
 * seam stamps EVERY story, and since the single-frame redesign it re-spells
 * every declared path — `contextFiles`, `expectedFiles` and `modifiedFiles`
 * alike — unconditionally into the repo frame (canonicalizeDeclaredPath,
 * src/prd/workdir-canonical.ts). On a PRD written by that seam, then, every
 * path is repo-rooted.
 *
 * This is a property of the seam's current form, not of the flag. A pre-redesign
 * PRD was canonicalized by a seam that re-spelled a declared path only when the
 * path resolved on disk at plan time; a path that existed nowhere was returned
 * UNCHANGED, so its create-intent `expectedFiles`, and any `contextFiles` entry
 * absent at plan time, stayed in the story's workdir-relative frame. Read the
 * paragraphs below in that light: they describe such pre-redesign PRDs only.
 *
 * A toPackageFrame miss is therefore only known out-of-package when the path set
 * genuinely carries repo-rooted paths. Use `canonical: true` ONLY on such sets --
 * the merged `contextFiles`, which carries repo-rooted parent outputs (nax#2089):
 * there a miss is a real out-of-package path that goes to `unreachable` rather
 * than being passed through as a path resolving to a real but WRONG file under
 * the consumer's root, exactly what toPackageFrame's docblock forbids. On a
 * pre-redesign PRD whose create-intent `expectedFiles` are still spelled
 * package-relative, a miss would be wrongly dropped; the flag cannot tell the
 * two frames apart from the string alone.
 *
 * Without the flag every entry lands in `readable` unchanged: a pre-#2067 PRD
 * may hold package-relative paths, and `src/x.ts` is genuinely ambiguous between
 * "already package-framed" and "a repo-root file" with no way to tell from the
 * string alone.
 *
 * The classification is RETURNED, not encoded into the strings. A caller that
 * wants the marker applies UNREADABLE_MARKER itself; a caller that wants to drop
 * uses the other list. Encoding it in the path is what splits one file into two
 * identities downstream (see providers/code-neighbor-chunk.ts).
 */
export function partitionPackageFrame(
  files: readonly string[],
  workdir: string | null | undefined,
  opts?: { readonly canonical?: boolean },
): { readable: string[]; unreachable: string[] } {
  const readable: string[] = [];
  const unreachable: string[] = [];
  for (const file of files) {
    const framed = toPackageFrame(file, workdir);
    if (framed !== null) {
      readable.push(framed);
    } else if (opts?.canonical) {
      unreachable.push(file);
    } else {
      readable.push(file);
    }
  }
  return { readable, unreachable };
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
