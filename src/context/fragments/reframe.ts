/**
 * Read-side reframing of a fragment's `## Files touched` list (nax#2072).
 *
 * `renderFragmentBody` (./store.ts) records repo-rooted paths, because a
 * fragment is a cross-story, cross-package artifact and repo-rooted is the
 * only spelling that identifies a file in another package unambiguously.
 * But the story that later CONSUMES the fragment has its file tools
 * contained at its own package dir (`codingToolRoot`, see
 * src/agents/types.ts:186), so `packages/lib/src/util.ts` resolves to
 * `<pkg>/packages/lib/src/util.ts` and fails to read.
 *
 * The reader is the only layer that knows both roots, so the re-spelling
 * happens here rather than at capture. Two outcomes per entry:
 *
 *   - inside the consumer's package -> re-spelled package-relative, readable
 *   - outside it                    -> kept repo-rooted, marked unreadable
 *
 * Adding `--relative` to the capture-side git call instead would be worse,
 * not better: it re-spells AND restricts to cwd, so cross-package entries
 * would vanish and `packages/app/src/util.ts` -- a real, different file --
 * would be read in place of `packages/lib/src/util.ts`. A loud ENOENT
 * traded for a silent misread.
 */

/** Heading emitted by `renderFragmentBody`; the section this module rewrites. */
const FILES_TOUCHED_HEADING = "## Files touched";

/**
 * Appended to an entry outside the consumer's package.
 *
 * ASCII only and no em dash: this string is rendered into agent prompts and
 * asserted byte-for-byte in tests.
 */
const UNREADABLE_MARKER = " (other package - not readable from this story's workdir)";

/** Posix-normalised, trailing separators removed. */
function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The consumer's package path, or undefined when there is nothing to reframe.
 *
 * Undefined covers three real cases, all of which must degrade to a
 * byte-identical body: a single-package repo, a root-package story, and a
 * story whose PRD left `workdir` null (nax#2067).
 */
function normalisePrefix(consumerWorkdir: string | undefined): string | undefined {
  if (!consumerWorkdir) return undefined;
  const prefix = toPosix(consumerWorkdir.trim());
  return !prefix || prefix === "." ? undefined : prefix;
}

/**
 * Reframe one list line. Non-list lines pass through untouched so blank
 * lines and any future prose in the section survive.
 *
 * The prefix test is `${prefix}/` rather than `prefix`, on a segment
 * boundary: consumer `packages/app` against entry `packages/application/...`
 * must be marked, not sliced into the corrupt path `lication/...`.
 */
function reframeEntry(line: string, prefix: string): string {
  if (!line.startsWith("- ")) return line;
  const path = toPosix(line.slice(2).trim());
  if (!path || path === prefix) return line;
  if (path.startsWith(`${prefix}/`)) return `- ${path.slice(prefix.length + 1)}`;
  return `- ${path}${UNREADABLE_MARKER}`;
}

/**
 * Rewrite the `## Files touched` entries of `body` for a consuming story
 * rooted at `consumerWorkdir`.
 *
 * `consumerWorkdir` MUST be the PRD-declared `story.workdir` (repo-relative,
 * schema-guaranteed traversal-free). It must NOT be derived as
 * `relative(repoRoot, packageDir)`: under worktree isolation `packageDir` is
 * `<root>/.nax-wt/<storyId>/<pkg>` while `repoRoot` is the main checkout, so
 * that derivation yields `.nax-wt/<storyId>/<pkg>`, matches nothing, and
 * silently marks every entry cross-package. Same trap as nax#2069.
 *
 * A body with no `## Files touched` heading is returned unchanged, which
 * also future-proofs this against the LLM-backed extractor deferred at
 * ./store.ts:186.
 */
export function reframeFilesTouched(body: string, consumerWorkdir: string | undefined): string {
  const prefix = normalisePrefix(consumerWorkdir);
  if (!prefix) return body;

  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === FILES_TOUCHED_HEADING);
  if (headingIndex === -1) return body;

  const nextHeading = lines.findIndex((line, index) => index > headingIndex && line.startsWith("## "));
  const sectionEnd = nextHeading === -1 ? lines.length : nextHeading;

  return [
    ...lines.slice(0, headingIndex + 1),
    ...lines.slice(headingIndex + 1, sectionEnd).map((line) => reframeEntry(line, prefix)),
    ...lines.slice(sectionEnd),
  ].join("\n");
}
