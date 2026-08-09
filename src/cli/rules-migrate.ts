/**
 * `nax rules migrate` — neutralization, translation, and the migrate command.
 *
 * Split from rules.ts so each file fits under the 600-line source-file limit.
 * Pure helpers (`neutralizeContent`, `translateLegacyFrontmatter`,
 * `withReviewNotice`) live here because they exist ONLY to feed the migrate
 * pipeline; the lint path uses the same `NEUTRALITY_RULES` table directly and
 * never touches them.
 *
 * The actual write-or-skip decision lives in `rules-migrate-plan.ts` (US-001).
 * Both dry-run and real-run call `planMigration` and consume the same plan, so
 * the preview describes the same work the real run does.
 */

import { basename, join } from "node:path";
import { CANONICAL_RULES_DIR, NEUTRALITY_RULES } from "../context/rules/canonical-loader";
import { NaxError } from "../errors";
import { errorMessage } from "../utils/errors";
import { _rulesCLIDeps } from "./rules";
import { planMigration } from "./rules-migrate-plan";
import type { MigrationPlanEntry } from "./rules-migrate-plan";

// ─────────────────────────────────────────────────────────────────────────────
// Neutralization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply basic neutralization to source content, driven by the SAME
 * `NEUTRALITY_RULES` table the lint command validates against
 * (src/context/rules/canonical-loader.ts). Migrate and lint previously kept
 * two independent pattern lists that drifted — migrated content could still
 * fail lint (missing AGENTS.md/GEMINI.md/.codex//.gemini//<ide_diagnostics>
 * handling, case-sensitive tool-phrasing). A single table makes that
 * impossible by construction.
 *
 * Returns the neutralized content and a count of replacements made.
 */
export function neutralizeContent(content: string): { content: string; replacements: number } {
  let result = content;
  let replacements = 0;

  for (const rule of NEUTRALITY_RULES) {
    for (const { pattern, replacement } of rule.neutralizeSteps ?? []) {
      const matches = [...result.matchAll(pattern)].length;
      if (matches > 0) {
        result = result.replace(pattern, replacement);
        replacements += matches;
      }
    }
  }

  return { content: result.trim(), replacements };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy frontmatter translation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a scalar YAML value into a single-element flow-sequence literal, e.g.
 * `src/agents/**` or `"src/agents/**"` -> `["src/agents/**"]`. Always emits a
 * double-quoted element (via JSON.stringify) regardless of the source
 * quoting, since an unquoted glob starting with `*` would otherwise be
 * misparsed as a YAML alias inside the new flow sequence.
 */
function toYamlListLiteral(scalar: string): string {
  const trimmed = scalar.trim();
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  return `[${JSON.stringify(unquoted)}]`;
}

/**
 * Rewrite a legacy `paths:` scope block to nax's `appliesTo:`.
 *
 * The two stores spell the key the same way and mean different things. In a
 * per-agent rules directory `paths:` is a FILE glob — "load this rule when the
 * story touches these files". In nax `paths:` is PACKAGE scope, matched against
 * the story's package dir, and `ruleMatchesPackage` short-circuits to `true`
 * whenever `packageDir === repoRoot`.
 *
 * So copying the key across verbatim silently produces config that reads as
 * scoped and has no effect at all — in every single-package repo, for every
 * migrated rule. `appliesTo:` is the key with the source's actual semantics.
 *
 * Only the leading frontmatter block is considered; a `paths:` mentioned in
 * prose is left alone. A file that already declares `appliesTo:` is returned
 * untouched rather than given two competing scope keys, which also makes a
 * re-run of `nax rules migrate --force` idempotent.
 */
export function translateLegacyFrontmatter(content: string): { content: string; translated: boolean } {
  const fm = /^---(\r?\n)([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!fm?.[2]) return { content, translated: false };

  const eol = fm[1] ?? "\n";
  const block = fm[2];
  // Top-level keys only: an indented `paths:` belongs to a nested mapping.
  if (!/^paths:/m.test(block) || /^appliesTo:/m.test(block)) return { content, translated: false };

  // `paths` accepts a bare scalar string (canonical-loader.ts), but `appliesTo` only
  // accepts a list (spec AC US-004.2) — so a scalar `paths: "src/agents/**"` must become
  // a single-element list, not a scalar `appliesTo:`, or loadCanonicalRules rejects the
  // migrated file with RulesFrontmatterError on every subsequent run.
  const scalarMatch = /^paths:[ \t]*(\S.*)$/m.exec(block);
  const isInlineList = scalarMatch?.[1]?.trim().startsWith("[") ?? false;
  const rewritten =
    scalarMatch && !isInlineList
      ? block.replace(/^paths:[ \t]*(\S.*)$/m, `appliesTo: ${toYamlListLiteral(scalarMatch[1])}`)
      : block.replace(/^paths:/m, "appliesTo:");
  const head = content.slice(0, fm.index);
  const tail = content.slice(fm.index + fm[0].length);
  return { content: `${head}---${eol}${rewritten}${eol}---${eol}${tail}`, translated: true };
}

/**
 * Prepend the review notice, placing it AFTER any frontmatter block.
 *
 * The notice is an HTML comment, and frontmatter is only recognised at byte 0
 * (`/^---\n/`). Emitting the notice first therefore pushes the block out of
 * position and the whole thing is read as body text — so a migrated file that
 * both needed neutralizing and carried a scope key silently lost its scope.
 * That combination is not hypothetical: it is every rule with both.
 */
export function withReviewNotice(content: string, replacements: number): string {
  if (replacements <= 0) return content;
  const notice = `<!-- NOTE: ${replacements} neutralization(s) applied — review before committing -->\n\n`;
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  if (!fm) return notice + content;
  return content.slice(0, fm[0].length) + notice + content.slice(fm[0].length).replace(/^(?:\r?\n)+/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// nax rules migrate
// ─────────────────────────────────────────────────────────────────────────────

export interface RulesMigrateOptions {
  /** Project working directory (default: process.cwd()) */
  dir?: string;
  /** Overwrite existing .nax/rules/ files (default: false) */
  force?: boolean;
  /** Preview output without writing any files */
  dryRun?: boolean;
}

/**
 * Observable outcome of a migrate invocation.
 *
 * `written` and `skipped` are target file names (basenames) in source order.
 * The same shape is returned for both dry-run and real-run, so a caller can
 * compare the two without parsing stdout.
 */
export interface MigrationOutcome {
  written: string[];
  skipped: string[];
}

interface MigrateSource {
  sourcePath: string;
  targetFileName: string;
  content: string;
}

/**
 * Collect source files to migrate: CLAUDE.md + .claude/rules/*.md
 */
async function collectMigrationSources(workdir: string): Promise<MigrateSource[]> {
  const sources: MigrateSource[] = [];

  // CLAUDE.md at root
  const claudeMdPath = join(workdir, "CLAUDE.md");
  if (await _rulesCLIDeps.fileExists(claudeMdPath)) {
    const content = await _rulesCLIDeps.readFile(claudeMdPath);
    if (content.trim()) {
      sources.push({ sourcePath: claudeMdPath, targetFileName: "project-conventions.md", content });
    }
  }

  // .claude/rules/*.md
  const rulesDir = join(workdir, ".claude", "rules");
  const ruleFiles = _rulesCLIDeps.globInDir(rulesDir);
  for (const filePath of ruleFiles) {
    try {
      const content = await _rulesCLIDeps.readFile(filePath);
      if (content.trim()) {
        sources.push({ sourcePath: filePath, targetFileName: basename(filePath), content });
      }
    } catch {
      // skip unreadable files
    }
  }

  return sources;
}

/**
 * `nax rules migrate`
 *
 * Reads CLAUDE.md + .claude/rules/*.md from the project and writes a
 * .nax/rules/ draft with basic neutralization applied. The operator
 * reviews the result before committing.
 *
 * Existing .nax/rules/ files are not overwritten unless --force is passed.
 *
 * Both dry-run and real-run go through {@link planMigration} so the preview
 * and the actual run describe the same work — writes and skips, in source
 * order. The returned `MigrationOutcome` exposes the same lists so callers
 * can compare the two without parsing stdout.
 */
export async function rulesMigrateCommand(options: RulesMigrateOptions): Promise<MigrationOutcome> {
  const workdir = options.dir ?? process.cwd();
  const force = options.force ?? false;
  const dryRun = options.dryRun === true;

  const sources = await collectMigrationSources(workdir);
  if (sources.length === 0) {
    console.log("[WARN] No source files found (checked CLAUDE.md and .claude/rules/*.md). Nothing to migrate.");
    return { written: [], skipped: [] };
  }

  const targetDir = join(workdir, CANONICAL_RULES_DIR);

  const planEntries: MigrationPlanEntry[] = sources.map((source) => ({
    sourcePath: source.sourcePath,
    targetFileName: source.targetFileName,
    targetPath: join(targetDir, source.targetFileName),
    content: source.content,
  }));

  const plan = await planMigration(planEntries, {
    targetDir,
    force,
    fileExists: _rulesCLIDeps.fileExists,
  });

  if (!dryRun) {
    try {
      await _rulesCLIDeps.mkdir(targetDir);
    } catch (err) {
      throw new NaxError(
        `Failed to create ${CANONICAL_RULES_DIR}: ${errorMessage(err)}`,
        "RULES_MIGRATE_MKDIR_FAILED",
        { stage: "rules-migrate", targetDir },
      );
    }
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const entry of plan.writes) {
    const { content: scoped } = translateLegacyFrontmatter(entry.content);
    const { content: neutralized, replacements } = neutralizeContent(scoped);
    const output = withReviewNotice(neutralized, replacements);

    if (dryRun) {
      console.log(
        `[dry-run] Would write ${entry.targetFileName} from ${entry.sourcePath} (${replacements} replacements)`,
      );
    } else {
      await _rulesCLIDeps.writeFile(entry.targetPath, output);
      console.log(
        `[OK] ${entry.targetFileName} <- ${entry.sourcePath}${replacements > 0 ? ` (${replacements} replacements)` : ""}`,
      );
    }
    written.push(entry.targetFileName);
  }

  for (const entry of plan.skips) {
    console.log(`[skip] ${entry.targetFileName} already exists (use --force to overwrite)`);
    skipped.push(entry.targetFileName);
  }

  console.log(`\nMigration complete: ${written.length} written, ${skipped.length} skipped.`);
  if (!dryRun && written.length > 0) {
    console.log(
      `Review ${CANONICAL_RULES_DIR}/ before committing. Run \`nax rules export --agent=claude\` to regenerate CLAUDE.md.`,
    );
  }

  return { written, skipped };
}
