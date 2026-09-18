import { join } from "node:path";

/**
 * Path-frame SSOT (nax#2067, #2071, #2074; single-frame redesign 2026-09-18).
 *
 * nax holds relative file paths in ONE canonical frame, REPO-ROOTED
 * ("packages/app/src/index.ts"), for every nax-internal path set. The earlier
 * package-relative frame — and the translation layer that shuttled paths into
 * it at the agent boundary — is retired: agent file tools are rooted at the
 * story execution root (the repo or worktree root), so a repo-rooted path is
 * directly addressable.
 *
 * `toRepoFrame` is not a mandatory boundary-translation step; it is the
 * canonical-frame normalizer, used only where a package-scoped producer (a
 * rule's package-relative `appliesTo:` literal, keyword auto-detect output,
 * declared package sources) must be brought into the one repo frame. Every
 * other path set is repo-rooted by construction. `isWithinPackage` is a
 * selector-contract primitive: a membership test that never re-spells.
 *
 * `story.workdir` is a SELECTOR, not a frame boundary: it names which package's
 * rules, config, and command cwd apply — surfaced by `storyWorkdir`,
 * `storyPackageDir`, `storyAbsWorkdir`, and `isWithinPackage` — while every
 * path set stays repo-rooted.
 *
 * `workdir` is always a string here. "." means the repo root. null, undefined
 * and "" are normalised away so no consumer has to invent its own spelling for
 * "absent" — three different spellings are what nax#2067 was.
 *
 * Pure by contract: no I/O, no config, no logging. Ambiguity that needs the
 * filesystem to resolve is handled at PRD write time, not here.
 *
 * Current SSOT:
 * docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md.
 * Historical background (superseded):
 * docs/superpowers/specs/2026-09-16-path-frame-convention-design.md.
 */

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
 * True when a repo-rooted `path` lies within the package rooted at `workdir`
 * (segment-boundary match, same boundary rule as toRepoFrame).
 *
 * Selector-contract primitive: answers "is this file inside my package",
 * never re-spells. `workdir` "." (repo root) always matches.
 */
export function isWithinPackage(path: string, workdir: string | null | undefined): boolean {
  const prefix = normalizeWorkdir(workdir);
  if (prefix === ".") return true;
  const normalized = toPosix(path);
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
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
