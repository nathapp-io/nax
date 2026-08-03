/**
 * `nax rules` CLI Commands (Phase 5.1)
 *
 * Provides commands for managing the canonical rules store (.nax/rules/):
 *
 *   nax rules export --agent=<id>
 *     One-way generation of per-agent shim files (CLAUDE.md, AGENTS.md,
 *     GEMINI.md) from the canonical store. Generation is canonical → shim only;
 *     manual edits to shims are not read back by the engine.
 *
 *   nax rules migrate
 *     Reads CLAUDE.md + .claude/rules/*.md and writes a .nax/rules/ draft
 *     with basic neutralization applied (removes Claude-specific phrasing).
 *     The operator reviews the diff before committing. Existing .nax/rules/
 *     files are preserved unless --force is passed.
 *
 *   nax rules lint
 *     Validates neutrality/frontmatter for canonical rules in the repo root
 *     and any package overlays.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Canonical rules delivery
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { globToRegex, normalizePath } from "../context/engine";
import { CANONICAL_RULES_DIR, NEUTRALITY_RULES, loadCanonicalRules } from "../context/rules/canonical-loader";
import type { CanonicalRule } from "../context/rules/canonical-loader";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { errorMessage } from "../utils/errors";

/** Cap on the dead-glob validation scan — mirrors MAX_CANONICAL_RULE_GLOB_FILES below. */
const MAX_DEAD_GLOB_SCAN_FILES = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

/** Cap on the package-overlay glob scan (monorepo-awareness.md §6). */
const MAX_CANONICAL_RULE_GLOB_FILES = 500;

/** Directories that never legitimately contain a `.nax/rules` overlay root. */
const CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS = ["/node_modules/", "/.git/"];

export const _rulesCLIDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  globInDir: (dir: string): string[] => {
    try {
      return [...new Bun.Glob("*.md").scanSync({ cwd: dir })].sort().map((f) => join(dir, f));
    } catch {
      return [];
    }
  },
  mkdir: async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true });
  },
  globCanonicalRuleFiles: (workdir: string): string[] => {
    try {
      const found: string[] = [];
      for (const file of new Bun.Glob("**/.nax/rules/**/*.md").scanSync({ cwd: workdir, absolute: false, dot: true })) {
        if (found.length >= MAX_CANONICAL_RULE_GLOB_FILES) break;
        const normalized = `/${file}/`;
        if (CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS.some((seg) => normalized.includes(seg))) continue;
        found.push(file);
      }
      return found.sort();
    } catch {
      return [];
    }
  },
  // Matches via globToRegex/normalizePath — the SAME matcher ruleMatchesTouchedFiles uses
  // at runtime (static-rules.ts) — rather than Bun.Glob's own semantics, so a pattern that
  // lints as "has matches" is guaranteed to actually match at runtime, and vice versa.
  globHasMatch: (pattern: string, cwd: string): boolean => {
    try {
      const regex = globToRegex(normalizePath(pattern));
      let scanned = 0;
      for (const file of new Bun.Glob("**/*").scanSync({ cwd, absolute: false, dot: true })) {
        if (scanned >= MAX_DEAD_GLOB_SCAN_FILES) break;
        scanned++;
        if (regex.test(normalizePath(file))) return true;
      }
      return false;
    } catch {
      return false;
    }
  },
  loadCanonicalRules,
  getLogger,
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent → shim file mapping
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_SHIM_FILES: Record<string, string> = {
  codex: "AGENTS.md",
  gemini: "GEMINI.md",
  cursor: ".cursorrules",
};

/**
 * Agents that read a rules DIRECTORY natively rather than a single shim file.
 *
 * Claude Code loads `.claude/rules/*.md` itself and path-scopes each file via
 * `paths:` frontmatter, so exporting rules into CLAUDE.md was wrong twice over:
 * CLAUDE.md is the *context* file `nax generate` owns (the two commands
 * whole-file-overwrote each other, issue #1442), and folding every rule into
 * one blob discards the per-file scoping Claude would otherwise honour.
 */
const AGENT_RULE_DIRS: Record<string, string> = {
  claude: ".claude/rules",
};

const SUPPORTED_AGENTS = [...Object.keys(AGENT_RULE_DIRS), ...Object.keys(AGENT_SHIM_FILES)].sort();

// ─────────────────────────────────────────────────────────────────────────────
// nax rules export
// ─────────────────────────────────────────────────────────────────────────────

export interface RulesExportOptions {
  /** Project working directory (default: process.cwd()) */
  dir?: string;
  /** Target agent: claude, codex, gemini, cursor */
  agent: string;
  /** Preview output without writing any files */
  dryRun?: boolean;
  /**
   * Verify only: regenerate in memory and fail if the on-disk output differs.
   * Writes nothing. Intended for a CI gate — without it the generated copy can
   * drift from the canonical store silently, which is the whole failure mode
   * this directory export exists to prevent.
   */
  check?: boolean;
}

/**
 * `nax rules export --agent=<id>`
 *
 * Reads the canonical rules store (.nax/rules/*.md) and generates a
 * per-agent shim file at the project root. This is one-way — manual
 * edits to the shim are never read back by the engine.
 *
 * Throws NaxError when canonical store is empty or agent is unsupported.
 */
/**
 * Rebuild an agent-facing frontmatter block from a canonical rule.
 *
 * The key means different things in each store: nax's `appliesTo:` is the FILE
 * glob and its `paths:` is PACKAGE scope, whereas Claude's `paths:` is the file
 * glob. `nax rules migrate` translates Claude `paths:` -> nax `appliesTo:` on
 * the way in (see translateLegacyFrontmatter); this is the same translation on
 * the way out. Canonical `paths:` has no Claude equivalent and is dropped.
 *
 * Returns "" for an unscoped rule so no empty block is emitted.
 */
function claudeFrontmatter(rule: CanonicalRule): string {
  const globs = rule.appliesTo ?? [];
  if (globs.length === 0) return "";
  const lines = globs.map((g) => `  - "${g}"`).join("\n");
  return `---\npaths:\n${lines}\n---\n`;
}

/**
 * Write one file per canonical rule under the agent's native rules directory.
 *
 * Relative paths are mirrored (`.nax/rules/<rel>` -> `<ruleDir>/<rel>`) so two
 * rules with the same basename in different subdirectories cannot overwrite
 * each other.
 *
 * The generated-by notice is an HTML comment and MUST come after the
 * frontmatter: frontmatter is only recognised at byte 0, so emitting the
 * comment first silently demotes the whole block to body text and the rule
 * loses its scoping. That is exactly the bug `withReviewNotice` was written to
 * fix on the migrate path.
 */
async function exportRuleDirectory(input: {
  workdir: string;
  agent: string;
  ruleDir: string;
  rules: CanonicalRule[];
  dryRun: boolean;
  check: boolean;
}): Promise<void> {
  const { workdir, agent, ruleDir, rules, dryRun, check } = input;
  const notice = `<!-- AUTO-GENERATED by nax rules export --agent=${agent} -->\n<!-- Do not edit manually — re-run this command to regenerate. -->\n<!-- Source of truth: ${CANONICAL_RULES_DIR}/ -->\n\n`;

  const drifted: string[] = [];
  for (const rule of rules) {
    const rel = rule.path ?? rule.fileName;
    const target = join(workdir, ruleDir, rel);
    const content = `${claudeFrontmatter(rule)}${notice}${rule.content.trim()}\n`;

    if (check) {
      const actual = await _rulesCLIDeps.readFile(target).catch(() => "");
      if (actual !== content) drifted.push(rel);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] Would write ${target} (${content.length} bytes)`);
      continue;
    }
    await _rulesCLIDeps.writeFile(target, content);
  }

  if (check) {
    if (drifted.length > 0) {
      throw new NaxError(
        `${ruleDir}/ is out of date with ${CANONICAL_RULES_DIR}/: ${drifted.join(", ")}. Run \`nax rules export --agent=${agent}\` to regenerate.`,
        "RULES_EXPORT_DRIFT",
        { stage: "rules-export", agent, drifted },
      );
    }
    console.log(`[OK] ${ruleDir}/ is up to date with ${CANONICAL_RULES_DIR}/ (${rules.length} rule file(s)).`);
    return;
  }

  if (!dryRun) {
    console.log(`[OK] Wrote ${rules.length} rule file(s) to ${ruleDir}/ from ${CANONICAL_RULES_DIR}/`);
  }
}

export async function rulesExportCommand(options: RulesExportOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const agent = options.agent.toLowerCase();

  const ruleDir = AGENT_RULE_DIRS[agent];
  const shimFileName = AGENT_SHIM_FILES[agent];
  if (!ruleDir && !shimFileName) {
    throw new NaxError(
      `Unsupported agent "${agent}". Supported: ${SUPPORTED_AGENTS.join(", ")}`,
      "RULES_EXPORT_UNSUPPORTED_AGENT",
      { stage: "rules-export", agent },
    );
  }

  const rules = await _rulesCLIDeps.loadCanonicalRules(workdir);
  if (rules.length === 0) {
    throw new NaxError(
      `No canonical rules found in ${CANONICAL_RULES_DIR}. Run \`nax rules migrate\` first.`,
      "RULES_EXPORT_NO_CANONICAL_RULES",
      { stage: "rules-export", workdir },
    );
  }

  if (ruleDir) {
    await exportRuleDirectory({
      workdir,
      agent,
      ruleDir,
      rules,
      dryRun: options.dryRun === true,
      check: options.check === true,
    });
    return;
  }

  const header = `<!-- AUTO-GENERATED by nax rules export --agent=${agent} -->
<!-- Do not edit manually — re-run this command to regenerate. -->
<!-- Source of truth: ${CANONICAL_RULES_DIR}/ -->

`;
  const body = rules.map((r) => `## ${r.fileName}\n\n${r.content}`).join("\n\n---\n\n");
  const shimContent = `${header + body}\n`;
  const shimPath = join(workdir, shimFileName);

  if (options.dryRun) {
    console.log(`[dry-run] Would write ${shimPath} (${shimContent.length} bytes)`);
    return;
  }

  await _rulesCLIDeps.writeFile(shimPath, shimContent);
  console.log(`[OK] Wrote ${shimFileName} (${rules.length} rule file(s) from ${CANONICAL_RULES_DIR}/)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Neutralization helpers (used by migrate)
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
// Legacy frontmatter translation (used by migrate)
// ─────────────────────────────────────────────────────────────────────────────

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

export interface RulesLintOptions {
  /** Project working directory (default: process.cwd()) */
  dir?: string;
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
 */
export async function rulesMigrateCommand(options: RulesMigrateOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const force = options.force ?? false;

  const sources = await collectMigrationSources(workdir);
  if (sources.length === 0) {
    console.log("[WARN] No source files found (checked CLAUDE.md and .claude/rules/*.md). Nothing to migrate.");
    return;
  }

  const targetDir = join(workdir, CANONICAL_RULES_DIR);

  if (!options.dryRun) {
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

  let written = 0;
  let skipped = 0;

  for (const { sourcePath, targetFileName, content } of sources) {
    const targetPath = join(targetDir, targetFileName);

    if (!force && !options.dryRun && (await _rulesCLIDeps.fileExists(targetPath))) {
      console.log(`[skip] ${targetFileName} already exists (use --force to overwrite)`);
      skipped++;
      continue;
    }

    const { content: scoped } = translateLegacyFrontmatter(content);
    const { content: neutralized, replacements } = neutralizeContent(scoped);
    const output = withReviewNotice(neutralized, replacements);

    if (options.dryRun) {
      console.log(`[dry-run] Would write ${targetFileName} from ${sourcePath} (${replacements} replacements)`);
    } else {
      await _rulesCLIDeps.writeFile(targetPath, output);
      console.log(
        `[OK] ${targetFileName} <- ${sourcePath}${replacements > 0 ? ` (${replacements} replacements)` : ""}`,
      );
    }
    written++;
  }

  if (!options.dryRun) {
    console.log(`\nMigration complete: ${written} file(s) written, ${skipped} skipped.`);
    if (written > 0) {
      console.log(
        `Review ${CANONICAL_RULES_DIR}/ before committing. Run \`nax rules export --agent=claude\` to regenerate CLAUDE.md.`,
      );
    }
  }
}

function collectCanonicalRuleRoots(workdir: string): string[] {
  const roots = new Set<string>([workdir]);
  const files = _rulesCLIDeps.globCanonicalRuleFiles(workdir);
  for (const rel of files) {
    const normalized = rel.replaceAll("\\", "/");
    const marker = "/.nax/rules/";
    const idx = normalized.indexOf(marker);
    if (idx <= 0) continue; // root rules stay mapped to workdir
    const packageRel = normalized.slice(0, idx);
    if (!packageRel) continue;
    roots.add(join(workdir, packageRel));
  }
  return [...roots].sort();
}

/**
 * `nax rules lint`
 *
 * Validates canonical rules neutrality/frontmatter for the repository root
 * and any package-local `.nax/rules/` stores found under the workdir.
 */
export async function rulesLintCommand(options: RulesLintOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const roots = collectCanonicalRuleRoots(workdir);
  const logger = _rulesCLIDeps.getLogger();

  let totalRuleFiles = 0;
  for (const root of roots) {
    const rules = await _rulesCLIDeps.loadCanonicalRules(root);
    totalRuleFiles += rules.length;
    for (const rule of rules) {
      for (const pattern of rule.appliesTo ?? []) {
        if (_rulesCLIDeps.globHasMatch(pattern, root)) continue;
        logger.warn("rules-lint", "Canonical rule appliesTo glob matches no files in the linted repository", {
          file: rule.path ?? rule.fileName,
          pattern,
          root,
        });
      }
    }
  }

  const scopeLabel = roots.length === 1 ? "repo root" : `${roots.length} rule roots`;
  console.log(`[OK] Canonical rules lint passed (${totalRuleFiles} file(s) across ${scopeLabel}).`);
}
