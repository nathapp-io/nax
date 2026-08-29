/**
 * Spec lint — do the machine-extracted sections actually extract?
 *
 * `nax plan` reads `### Modifies`, `### Context Files` and `## Out of Scope`
 * out of a spec with the pure parsers in this directory rather than asking the
 * planner for them. Each has a fixed grammar and each **fails silently**: a
 * section the parser cannot see is not an error, it is simply absent from the
 * PRD, and nothing in the plan output says so.
 *
 * That combination is expensive to notice. A spec whose `Modifies` entries were
 * nested inside story bullets with the `**US-00N**` lead-in inline on the same
 * bullet extracted to nothing; `GROUP_LEAD_IN` (./markdown-scan) anchors that
 * lead-in to its own line. The PRD came back with `modifiedFiles: []` on every
 * story and looked healthy on every other axis, so the only way to find out was
 * a full re-plan and a diff.
 *
 * A dropped `Modifies` entry is not cosmetic: it is the only channel that
 * authorises an implementer to update an existing test its own correct change
 * breaks. Without it the implementer meets a red suite it may not touch, and
 * the one move left is to revert the acceptance criterion — the story deadlocks.
 *
 * Every check runs the REAL extractor and compares what came out against what
 * the author appears to have written. Re-implementing the grammar here would
 * create a second source of truth that drifts from the first, and a linter that
 * disagrees with the tool it guards is worse than no linter.
 */

import { existsSync } from "node:fs";
import { extractSpecContextFiles } from "./context-files-extract";
import { extractSpecModifiedFiles, MAX_MODIFIED_FILES } from "./modifies-extract";
import { extractSpecOutOfScope } from "./out-of-scope-extract";

const DEFAULT_MAX_AC_COUNT = 15;
const SOFT_MAX_STORIES = 7;

/** Deprecated AC mechanism tags — file-content assertions, not runtime tests. */
const BANNED_AC_TAGS = /\[(grep|file|verbatim)\]/i;
/** Runtime mechanism tags an AC must carry. */
const VALID_AC_TAG = /\[(unit|integration|cli)\]/i;
/** Shell fragments an implementation session cannot execute. */
const SHELL_IN_AC = /\bgrep\s+-|\bwc\s+-[lc]\b|\bawk\s|\bsed\s|\$\(/;
/** Phrasings that describe a file-content grep rather than a behaviour. */
const FILE_CONTENT_PHRASING =
  /contains the substring|contains exactly|matches the regex|does not contain|no file under/i;

export interface SpecLintFinding {
  readonly level: "error" | "warn";
  readonly code: string;
  readonly message: string;
}

/** Section heading forms the Modifies extractor recognises. */
const MODIFIES_HEADING = /^#{1,6}\s*modifi(?:es|ed\s+files)\b/im;
/** Any backticked token — used only to count author intent, never to extract. */
const BACKTICK_TOKEN = /`([^`]+)`/g;
/**
 * Path-shaped: contains a separator, or ends in a known source extension.
 *
 * A "short trailing segment" heuristic is NOT enough — reasons routinely cite
 * identifiers that pass it (`result.errors[0].reason`, `test.each`), and each
 * one becomes a spurious multi-path error. An explicit extension list is the
 * only form that separates a swallowed `package.json` from a member access.
 */
const PATH_LIKE = /\/|\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|yaml|yml|toml|sh|sql)$/i;

/**
 * Story ids this spec declares.
 *
 * Scans `## Stories` and `## Acceptance Criteria` only, and accepts both forms
 * real specs use: a `### US-001 — title` heading, and a `**US-001 — title**`
 * bold lead-in (retire-dead-cli-config-surface uses the latter throughout, with
 * its `### US-00N` headings appearing only under Acceptance Criteria).
 *
 * The `### Modifies` / `### Context Files` / `### Creates` / `### Seams`
 * subsections are skipped deliberately: their own `**US-00N**` group lead-ins
 * are the thing being validated, so counting them as declarations would make
 * the unknown-story check self-satisfying.
 */
const GROUPED_PATH_SUBSECTION = /^#{1,6}\s*(modifi(?:es|ed\s+files)|context\s+files|creates|seams)\b/i;

function declaredStoryIds(lines: readonly string[]): string[] {
  const ids = new Set<string>();
  let inScope = false;
  let inSkippedSubsection = false;

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inScope = /^##\s+(Stories|Acceptance Criteria)\b/i.test(line);
      inSkippedSubsection = false;
      continue;
    }
    if (!inScope) continue;
    if (/^#{3,6}\s/.test(line)) inSkippedSubsection = GROUPED_PATH_SUBSECTION.test(line);
    if (inSkippedSubsection) continue;

    const heading = /^#{1,6}\s+(US-\d+)\b/i.exec(line);
    if (heading?.[1]) {
      ids.add(heading[1].toUpperCase());
      continue;
    }
    const bold = /^\s*\*\*\s*(US-\d+)\b/i.exec(line);
    if (bold?.[1]) ids.add(bold[1].toUpperCase());
  }
  return [...ids];
}

/** The body lines of the `### Modifies` section, for intent counting. */
function modifiesSectionBody(lines: readonly string[]): string[] {
  const start = lines.findIndex((l) => MODIFIES_HEADING.test(l));
  if (start < 0) return [];
  const level = (/^(#{1,6})/.exec(lines[start]) ?? [])[1]?.length ?? 3;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h && h[1].length <= level) break;
    body.push(lines[i]);
  }
  return body;
}

function checkModifies(
  text: string,
  lines: readonly string[],
  storyIds: readonly string[],
  pathExists: (path: string) => boolean,
): SpecLintFinding[] {
  const out: SpecLintFinding[] = [];
  const extracted = extractSpecModifiedFiles(text);
  const hasHeading = MODIFIES_HEADING.test(text);
  // "Modifies:" appearing in a story bullet is intent even without a heading —
  // that is exactly the shape that silently extracted nothing.
  const mentionsInStory = lines.some((l) => /^\s*[-*]\s*\*{0,2}Modifies\*{0,2}\s*:/i.test(l));

  if ((hasHeading || mentionsInStory) && extracted.length === 0) {
    out.push({
      level: "error",
      code: "modifies-declared-but-empty",
      message:
        "the spec declares Modifies but the extractor found 0 entries. Use a top-level `### Modifies` section with each `**US-00N**` lead-in ALONE on its line and one backticked path per bullet beneath it. Every entry is currently being dropped, so no implementer is authorised to touch those files.",
    });
  }

  for (const entry of extracted) {
    if (entry.storyId === null) {
      out.push({
        level: "error",
        code: "modifies-unattributed",
        message: `\`${entry.path}\` has no \`**US-00N**\` group lead-in above it, so it is attributed to no story and carries no authorisation.`,
      });
      continue;
    }
    if (!storyIds.includes(entry.storyId.toUpperCase())) {
      out.push({
        level: "error",
        code: "modifies-unknown-story",
        message: `\`${entry.path}\` is grouped under ${entry.storyId}, which is not a story in this spec.`,
      });
    }
    if (!pathExists(entry.path)) {
      out.push({
        level: "error",
        code: "modifies-path-missing",
        message: `\`${entry.path}\` does not exist. A path that never resolves authorises nothing and fails silently.`,
      });
    }
    if (entry.reason.trim().length === 0) {
      out.push({
        level: "warn",
        code: "modifies-no-reason",
        message: `\`${entry.path}\` is a bare path. The reason is carried verbatim into the implementer prompt; without it the entry says which file but not which assertion.`,
      });
    }
  }

  // A bullet naming two paths authorises only the first — the rest are swallowed.
  for (const line of modifiesSectionBody(lines)) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    const paths = [...line.matchAll(BACKTICK_TOKEN)].map((m) => m[1]).filter((t) => PATH_LIKE.test(t));
    if (paths.length > 1) {
      out.push({
        level: "error",
        code: "modifies-multi-path-bullet",
        message: `one bullet names ${paths.length} paths (${paths.map((p) => `\`${p}\``).join(", ")}); only the first becomes an entry. Write one file per bullet, repeating the reason.`,
      });
    }
  }

  if (extracted.length >= MAX_MODIFIED_FILES) {
    out.push({
      level: "warn",
      code: "modifies-at-cap",
      message: `${extracted.length} entries hits the ${MAX_MODIFIED_FILES}-entry cap; anything beyond it is truncated.`,
    });
  }
  return out;
}

function checkOutOfScope(text: string, storyIds: readonly string[]): SpecLintFinding[] {
  const out: SpecLintFinding[] = [];
  const hasHeading = /^##\s+Out of Scope\b/im.test(text);
  const extracted = extractSpecOutOfScope(text);
  if (hasHeading && extracted.length === 0) {
    out.push({
      level: "error",
      code: "out-of-scope-not-extractable",
      message:
        "`## Out of Scope` is present but extracts 0 items, so `prd.outOfScope` will be empty and no story will carry the deferrals. Write one self-contained bullet per exclusion.",
    });
  }
  // A story-scoped deferral hoisted feature-level without the prefix is copied
  // onto EVERY story, waiving the property everywhere it was meant to stay local.
  for (const item of extracted) {
    // A hoisted story-scoped deferral LEADS with its story id; the convention is
    // `US-002 only: ...`. A bullet that merely mentions a story mid-sentence is
    // prose -- often citing another document ("US-002 of SPEC-other.md"), whose
    // ids can collide with this spec's. Anchoring to the start is what separates
    // a malformed hoist from a reference.
    const named = /^\s*(US-\d+)\b/.exec(item);
    const isOwnStory = named?.[1] !== undefined && storyIds.includes(named[1].toUpperCase());
    if (isOwnStory && !/^\s*US-\d+\s+only\s*:/i.test(item)) {
      const names = [named?.[1] ?? "US-000"];
      out.push({
        level: "warn",
        code: "out-of-scope-unprefixed-hoist",
        message: `a feature-level bullet names ${names[0]} but does not start with "${names[0]} only:". The feature list is copied onto every story, so this waives the property for all of them.`,
      });
    }
  }
  return out;
}

function checkContextFiles(
  text: string,
  lines: readonly string[],
  pathExists: (path: string) => boolean,
): SpecLintFinding[] {
  const out: SpecLintFinding[] = [];
  const extracted = extractSpecContextFiles(text);
  const mentionsInStory = lines.some((l) => /^\s*[-*]\s*\*{0,2}Context Files\*{0,2}\s*:/i.test(l));
  if (mentionsInStory && extracted.length === 0) {
    out.push({
      level: "warn",
      code: "context-files-not-extractable",
      message:
        "story bullets list Context Files but the extractor found 0, so every `contextFiles` entry in the PRD will be the planner's guess rather than your list. Use a `### Context Files` section with `**US-00N**` lead-ins to have them taken verbatim.",
    });
  }
  for (const entry of extracted) {
    if (!pathExists(entry.path)) {
      out.push({
        level: "warn",
        code: "context-file-missing",
        message: `\`${entry.path}\` does not exist; it will surface at runtime as "Relevant file not found".`,
      });
    }
  }
  return out;
}

function checkAcceptanceCriteria(lines: readonly string[], maxAcCount: number): SpecLintFinding[] {
  const out: SpecLintFinding[] = [];
  let inAcs = false;
  let story: string | null = null;
  let count = 0;

  const flush = () => {
    if (story && count > maxAcCount) {
      out.push({
        level: "error",
        code: "ac-count-over-cap",
        message: `${story} has ${count} ACs, over the project cap of ${maxAcCount}. \`nax plan\` splits compound ACs, so the planned count can exceed this further.`,
      });
    }
  };

  for (const line of lines) {
    if (/^##\s+Acceptance Criteria\b/i.test(line)) {
      inAcs = true;
      continue;
    }
    if (!inAcs) continue;
    if (/^##\s/.test(line)) {
      flush();
      break;
    }
    const heading = /^###\s+(US-\d+)\b/i.exec(line);
    if (heading?.[1]) {
      flush();
      story = heading[1].toUpperCase();
      count = 0;
      continue;
    }
    if (!/^\d+\.\s/.test(line)) continue;
    count++;

    if (BANNED_AC_TAGS.test(line)) {
      out.push({
        level: "error",
        code: "ac-banned-tag",
        message: `${story ?? "?"} AC ${count} uses a deprecated [grep]/[file]/[verbatim] tag; those describe file-content greps, which no implementation session can write as a fail-first test.`,
      });
    } else if (!VALID_AC_TAG.test(line)) {
      out.push({
        level: "error",
        code: "ac-untagged",
        message: `${story ?? "?"} AC ${count} carries no [unit]/[integration]/[cli] mechanism tag.`,
      });
    }
    if (SHELL_IN_AC.test(line)) {
      out.push({
        level: "error",
        code: "ac-shell-command",
        message: `${story ?? "?"} AC ${count} contains a shell fragment; nax has no shell executor, so this is not implementable.`,
      });
    }
    if (FILE_CONTENT_PHRASING.test(line)) {
      out.push({
        level: "error",
        code: "ac-file-content-assertion",
        message: `${story ?? "?"} AC ${count} asserts on file contents rather than behaviour.`,
      });
    }
  }
  flush();
  return out;
}

/** Injectable seam: path existence, so the linter stays pure and testable. */
export interface SpecLintOptions {
  readonly maxAcCount?: number;
  readonly fileExists?: (path: string) => boolean;
}

/**
 * Lint one spec's machine-extracted sections. Pure: no I/O beyond the injected
 * `fileExists`, no LLM. The caller owns reading the file and the nax config.
 */
export function lintSpecContent(text: string, options: SpecLintOptions = {}): SpecLintFinding[] {
  const maxAcCount = options.maxAcCount ?? DEFAULT_MAX_AC_COUNT;
  const pathExists = options.fileExists ?? existsSync;
  const lines = text.split("\n");
  const storyIds = declaredStoryIds(lines);

  const findings = [
    ...checkModifies(text, lines, storyIds, pathExists),
    ...checkOutOfScope(text, storyIds),
    ...checkContextFiles(text, lines, pathExists),
    ...checkAcceptanceCriteria(lines, maxAcCount),
  ];

  if (storyIds.length > SOFT_MAX_STORIES) {
    findings.push({
      level: "warn",
      code: "story-count-over-target",
      message: `${storyIds.length} stories exceeds the ${SOFT_MAX_STORIES}-story ceiling; each story is its own plan/implement/review pass.`,
    });
  }
  return findings;
}
