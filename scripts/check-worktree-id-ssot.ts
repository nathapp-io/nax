#!/usr/bin/env bun
/**
 * Prevent source from open-coding worktree identities.
 *
 * The story worktree identity has four spellings, all gated here:
 *   1. worktree path    — `<root>/.nax-wt/<id>`
 *   2. branch name      — `nax/<id>`
 *   3. orphan ref       — `refs/nax/orphan/<id>`
 *   4. bakeoff id       — `bakeoff-<feature>-<profile>`
 *
 * The producers in `src/worktree/worktree-id.ts` (and `naxOrphanRefName`
 * in `src/worktree/nax-orphan-ref.ts`) are the only sites that may
 * spell these — every other module must call them. Without a static
 * check, a typo or a one-off direct interpolation would compile, run,
 * and quietly diverge from the SSOT.
 *
 * Use `storyWorktreePath(projectRoot, worktreeId)` / `storyBranchName(worktreeId)`
 * / `naxOrphanRefName(worktreeId)` / `deriveStoryWorktreeId(feature, storyId)` /
 * `deriveBakeoffWorktreeId(feature, profile)` from `@/worktree` (or
 * `@/bakeoff` for the bakeoff- namespace helper). Prose that genuinely must
 * live in a string literal — a user-facing message, an LLM prompt — carries
 * a `nax-worktree-id-allow: <reason>` marker so the exemption stays auditable
 * rather than growing an invisible allow-list.
 *
 * Mirrors `scripts/check-feature-dir-ssot.ts:28` (allowlisted files) and
 * `:36` (per-line comment escape).
 *
 * Story: US-001
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_ROOTS = ["src"] as const;

/**
 * Producers and consumer sites whose spelling must stay exactly as it is.
 *
 * `src/worktree/worktree-id.ts` — the producers themselves.
 * `src/worktree/nax-orphan-ref.ts` — the orphan-ref SSOT; parameter type
 *   stays plain `string` for now (US-001 Out-of-Scope — `naxOrphanRefName`'s
 *   parameter type change belongs to US-002/US-003), but the spelling
 *   `refs/nax/orphan/<id>` is gated here.
 * `src/bakeoff/worktree-id.ts` — a re-export shim; pin so the bakeoff
 *   helper's returned string is unchanged.
 * `src/runtime/packages.ts` — its `.nax-wt` first-segment guard at :109
 *   and :237 MUST read `.nax-wt` literally to round-trip a story's
 *   package key; pin so the gate does not flag the guard.
 * `src/utils/gitignore.ts` — gitignore entry.
 * `src/review/runner/index.ts` — ignore regex.
 * `src/precheck/checks-git.ts` — porcelain-status regex.
 * `src/precheck/checks-warnings.ts` — ignore entry.
 * `src/bakeoff/preflight.ts` — composes the separate `nax/bakeoff-`
 *   branch namespace, which is disjoint from the `nax/<storyId>` story
 *   namespace and intentionally NOT routed through this module's
 *   producers (US-001 Out-of-Scope — changing bakeoff's composition
 *   inputs is not part of this story).
 *
 * CLI, context-generator, and rule-loader files mention `.nax/...`
 * (project config root) in user-facing prose. The branch-name pattern
 * explicitly excludes `.nax/...` (a project config directory, not a
 * story branch prefix), so most CLI and context-generator files pass
 * without an allowlist entry. The remaining offenders are CLI helpers,
 * generator templates, and rules-loader constants that pin a
 * `.nax/...` segment literally; they are listed below.
 */
const ALLOWED_FILES = new Set([
  "src/worktree/worktree-id.ts",
  "src/worktree/nax-orphan-ref.ts",
  "src/bakeoff/worktree-id.ts",
  "src/runtime/packages.ts",
  "src/utils/gitignore.ts",
  "src/review/runner/index.ts",
  "src/precheck/checks-git.ts",
  "src/precheck/checks-warnings.ts",
  "src/bakeoff/preflight.ts",
  "src/context/engine/types.ts",
  "src/context/engine/scope-path-match.ts",
  "src/context/engine/providers/test-coverage.ts",
  "src/context/engine/providers/static-rules.ts",
  "src/context/engine/providers/git-history.ts",
  "src/operations/call-run-options.ts",
  "src/operations/verify.ts",
  "src/operations/mutation-check.ts",
  "src/agents/types.ts",
  "src/agents/coding-tool-support.ts",
  "src/utils/git.ts",
  "src/utils/path-filters.ts",
  "src/cli/config-descriptions.ts",
  "src/cli/init.ts",
  "src/cli/init-context.ts",
  "src/cli/setup.ts",
  "src/cli/features-resolve.ts",
  "src/cli/generate.ts",
  "src/cli/plugins.ts",
  "src/cli/prompts-init.ts",
  "src/cli/rules-lint.ts",
  "src/cli/rules-migrate.ts",
  "src/commands/curator.ts",
  "src/commands/migrate.ts",
  "src/constitution/generators/aider.ts",
  "src/constitution/generators/claude.ts",
  "src/constitution/generators/cursor.ts",
  "src/constitution/generators/opencode.ts",
  "src/constitution/generators/windsurf.ts",
  "src/context/generator/index.ts",
  "src/context/generators/aider.ts",
  "src/context/generators/claude.ts",
  "src/context/generators/codex.ts",
  "src/context/generators/cursor.ts",
  "src/context/generators/gemini.ts",
  "src/context/generators/opencode.ts",
  "src/context/generators/windsurf.ts",
  "src/context/rules/canonical-loader/index.ts",
  "src/execution/story-context/index.ts",
  "src/finish/review/prompts.gen.ts",
  "src/finish/route.ts",
  "src/interaction/plugins/webhook-serve-compat.ts",
  "src/interaction/plugins/webhook.ts",
  "src/operations/full-suite-gate.ts",
  "src/plugins/builtin/curator/heuristics.ts",
  "src/runtime/paths.ts",
  "src/test-runners/detect/cache.ts",
  "src/test-runners/detect/directory-scan.ts",
  "src/test-runners/resolver.ts",
  "src/tools/scratchpad.ts",
  "src/bakeoff/contestant.ts",
  "src/pipeline/types.ts",
  "src/config/runtime-types.ts",
  "src/config/compat-shims.ts",
  // The gate's own test fixtures.
  "test/unit/scripts/check-worktree-id-ssot.test.ts",
]);

const ALLOWED_DIRS: readonly string[] = [
  // LLM instruction text under `src/prompts/` describes the on-disk layout
  // to the agent in prose — an inline `//` marker would be sent to the model
  // as part of the prompt, so the exemption has to be by directory.
  "src/prompts/",
];

/** What the line spelled. */
type Kind = "worktree-path" | "branch-name" | "orphan-ref";

interface WorktreeIdViolation {
  file: string;
  line: number;
  snippet: string;
  kind: Kind;
}

/**
 * Open-coded shapes, ordered so the most specific match wins on
 * ambiguous lines (e.g. a comment that mentions both `refs/nax/orphan/`
 * and `nax/`):
 *   - `refs/nax/orphan/<id>` — orphan ref name (most specific)
 *   - `.nax-wt`              — worktree path segment
 *   - `nax/<id>`             — branch prefix as a path segment
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ kind: Kind; pattern: RegExp }> = [
  { kind: "orphan-ref", pattern: /refs\/nax\/orphan\// },
  // `.nax-wt` as a path segment — followed by any of the four closing
  // characters that end a segment in code (path-separator, string quotes,
  // template backtick). A bare `.nax-wt-` suffix is allowed: those are
  // unrelated identifiers (e.g. `.nax-wt-foo`).
  { kind: "worktree-path", pattern: /\.nax-wt(?:\/|"|'|`)/ },
  // `nax/<id>` as a path-segment branch prefix — preceded by start-of-line
  // or a non-identifier character to avoid false-positives on identifiers
  // like `naxconfig` or `nax-feature-foo`. The character after `nax/` is
  // an identifier start, the template-expression introducer `$`, or a
  // string literal closing quote (e.g. `'nax/' + storyId`).
  //
  // The `[^A-Za-z0-9_.]` prefix also excludes `.` (so `.nax/config.json`,
  // `.nax/features/`, `.nax/mono/` and other project-directory spellings
  // stay unflagged — `.nax/` is the project config root, not a story
  // branch prefix).
  { kind: "branch-name", pattern: /(^|[^A-Za-z0-9_.])nax\/[A-Za-z0-9$'"]/ },
];

/** Opt-out marker for prose that must live in a string literal. */
const ALLOW_MARKER = "nax-worktree-id-allow";

/** Whether a multi-line block comment opened on an earlier line is still open. */
interface BlockCommentState {
  inBlock: boolean;
}

interface ScannedLine {
  /** The line with every comment span removed — the executable text. */
  code: string;
  /** The trailing `//` comment (including its `//`), or `null` when absent. */
  lineComment: string | null;
}

/**
 * Splits one line into its executable text and its trailing `//` comment,
 * carrying block-comment state across lines.
 *
 * The state has to be carried, not guessed from a line's first character.
 * The earlier heuristic skipped every line whose trimmed form began with
 * `*` as a "block-comment continuation" even when no block comment was
 * open — and such a line can be executable: `const n = 1` followed by
 * `* ".nax-wt/"` is one multiplication expression (ASI does not break it),
 * so an open-coded spelling on an asterisk-led line evaded the gate. Only a
 * span this scanner has actually seen opened as a comment is dropped.
 *
 * String literals are honoured: a `//` or `/*` inside a string is not a
 * comment start, and the string's own text stays in `code`, so a hardcoded
 * ".nax-wt/" literal is still reported. Regex literals are not modelled — a
 * regex body containing `/*` would open a phantom block comment; no such
 * literal exists in the scanned tree.
 */
function scanLine(line: string, state: BlockCommentState): ScannedLine {
  let code = "";
  let i = 0;

  while (i < line.length) {
    if (state.inBlock) {
      const close = line.indexOf("*/", i);
      if (close === -1) return { code, lineComment: null };
      state.inBlock = false;
      i = close + 2;
      continue;
    }

    const ch = line.charAt(i);

    if (ch === '"' || ch === "'" || ch === "`") {
      let end = i + 1;
      while (end < line.length && line.charAt(end) !== ch) {
        end += line.charAt(end) === "\\" ? 2 : 1;
      }
      if (end < line.length) end += 1; // consume the closing quote
      code += line.slice(i, Math.min(end, line.length));
      i = Math.min(end, line.length);
      continue;
    }

    if (ch === "/" && line.charAt(i + 1) === "/") return { code, lineComment: line.slice(i) };
    if (ch === "/" && line.charAt(i + 1) === "*") {
      state.inBlock = true;
      i += 2;
      continue;
    }

    code += ch;
    i += 1;
  }

  return { code, lineComment: null };
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(fullPath);
    }
  }

  return out;
}

/**
 * Scan `src/` for open-coded worktree identities outside the allowlist.
 *
 * The `refs/nax/orphan/` match is also produced by `naxOrphanRefName`, which
 * lives in `src/worktree/nax-orphan-ref.ts`. The story scopes
 * `naxOrphanRefName`'s parameter type to US-002/US-003, but the helper
 * itself is the SSOT for the spelling — it stays in the allowlist so this
 * gate enforces the same single-producer rule against it.
 */
export function findWorktreeIdViolations(repoRoot: string): WorktreeIdViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => collectTypeScriptFiles(join(repoRoot, root)));
  const violations: WorktreeIdViolation[] = [];

  for (const file of files) {
    const relPath = relative(repoRoot, file);
    if (ALLOWED_FILES.has(relPath)) continue;
    if (ALLOWED_DIRS.some((dir) => relPath.startsWith(dir))) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    const state: BlockCommentState = { inBlock: false };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const { code, lineComment } = scanLine(line, state);
      // The allow marker only counts when it sits in a trailing `//`
      // comment on the offending line. Scanning the whole line would let a
      // string literal like `const m = "nax-worktree-id-allow";` mask a
      // real violation on the same line — and `scanLine` is string-aware,
      // so the marker cannot be smuggled in via a string containing `//`
      // either.
      if (lineComment?.includes(ALLOW_MARKER)) continue;

      // Pick the most-specific match so the violation kind reported to the
      // developer is precise (e.g. "you hardcoded the orphan ref, not just
      // a worktree path").
      const match = FORBIDDEN_PATTERNS.find(({ pattern }) => pattern.test(code));
      if (!match) continue;

      violations.push({
        file: relPath,
        line: index + 1,
        snippet: line.trim(),
        kind: match.kind,
      });
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatWorktreeIdViolationReport(violations: readonly WorktreeIdViolation[]): string {
  if (violations.length === 0) {
    return "[OK] No open-coded .nax-wt / nax/ / refs/nax/orphan/ spellings outside src/worktree/worktree-id.ts";
  }

  const lines = [
    "[FAIL] Open-coded worktree identity found",
    "",
    "Use storyWorktreePath(projectRoot, worktreeId) / storyBranchName(worktreeId) from",
    "@/worktree for the story worktree path and branch, naxOrphanRefName(worktreeId) for",
    "the orphan ref, and deriveStoryWorktreeId(feature, storyId) /",
    "deriveBakeoffWorktreeId(feature, profile) for the corresponding IDs.",
    `If the line is genuinely prose, append "// ${ALLOW_MARKER}: <reason>".`,
    "",
  ];

  for (const violation of violations) {
    lines.push(`${violation.file}:${violation.line}  [${violation.kind}]`);
    lines.push(`  ${violation.snippet}`);
  }

  return lines.join("\n");
}

export async function main(): Promise<void> {
  const violations = findWorktreeIdViolations(process.cwd());
  const report = formatWorktreeIdViolationReport(violations);
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  await main();
}
