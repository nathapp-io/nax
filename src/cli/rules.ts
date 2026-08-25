/**
 * `nax rules` CLI Commands (Phase 5.1)
 *
 * Provides commands for managing the canonical rules store (.nax/rules/):
 *
 *   nax rules export --agent=<id>
 *     One-way generation from the canonical store. Agents with a native rules
 *     directory (claude → .claude/rules/) get one file per rule with its scope
 *     preserved; the rest get a single shim file (AGENTS.md, GEMINI.md,
 *     .cursorrules). Generation is canonical → output only; manual edits to
 *     generated files are not read back by the engine.
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
import { join, resolve, sep } from "node:path";
import type { CanonicalRule } from "../context/rules/canonical-loader";
import { CANONICAL_RULES_DIR, loadCanonicalRules } from "../context/rules/canonical-loader";
import { NaxError } from "../errors";
import { getLogger } from "../logger";

export {
  _rulesLintDeps,
  CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS,
  collectCanonicalRuleRoots,
  DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS,
  MAX_CANONICAL_RULE_GLOB_FILES,
  MAX_DEAD_GLOB_SCAN_FILES,
  MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES,
  type RulesLintOptions,
} from "./rules-lint";

import { rulesLintCommand as _rulesLintCommandImpl, _rulesLintDeps } from "./rules-lint";

export {
  type MigrationOutcome,
  neutralizeContent,
  type RulesMigrateOptions,
  rulesMigrateCommand,
  translateLegacyFrontmatter,
  withReviewNotice,
} from "./rules-migrate";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

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
  // Delegate lazily (not a value-copy) so overriding _rulesLintDeps.* is
  // observed here too — a plain field copy at module-eval time would silently
  // diverge from whatever `nax rules lint` actually runs.
  globCanonicalRuleFiles: (workdir: string): string[] => _rulesLintDeps.globCanonicalRuleFiles(workdir),
  globHasMatch: (pattern: string, cwd: string): boolean => _rulesLintDeps.globHasMatch(pattern, cwd),
  loadCanonicalRules,
  getLogger,
  // US-002: forward the workspace resolver so the `nax rules lint` entry
  // point keeps the same injectable seam as the inner implementation.
  discoverWorkspacePackages: (workdir: string): Promise<string[]> => _rulesLintDeps.discoverWorkspacePackages(workdir),
};

// ─────────────────────────────────────────────────────────────────────────────
// rules lint command (uses _rulesCLIDeps for testability)
// ─────────────────────────────────────────────────────────────────────────────

export async function rulesLintCommand(options: Parameters<typeof _rulesLintCommandImpl>[0]): Promise<void> {
  return _rulesLintCommandImpl(options, {
    globCanonicalRuleFiles: _rulesCLIDeps.globCanonicalRuleFiles,
    loadCanonicalRules: _rulesCLIDeps.loadCanonicalRules,
    globHasMatch: _rulesCLIDeps.globHasMatch,
    getLogger: _rulesCLIDeps.getLogger,
    discoverWorkspacePackages: _rulesCLIDeps.discoverWorkspacePackages,
  });
}

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
 * Read a canonical PACKAGE-scope glob as a Claude FILE glob.
 *
 * `ruleMatchesPackage` (static-rules.ts) tests each canonical pattern against a
 * package directory path relative to the repo root, so the faithful file-glob
 * reading is "every file beneath a directory this pattern selects". A trailing
 * `/*` or `/**` is part of how the package form spells "this directory", not an
 * extra level, so it is normalised away before the file-matching `/**` is added
 * — otherwise `packages/api/**` would become `packages/api/**\/**` and match
 * strictly less than it did.
 */
function packageGlobToFileGlob(pattern: string): string {
  // Trailing slashes come off FIRST: `packages/api/*/` and `packages/api/*`
  // name the same directory, but a star-strip anchored at end-of-string sees
  // only the second, so the order below is what keeps them from diverging.
  const base = pattern
    .replace(/\/+$/, "")
    .replace(/\/+\*{1,2}$/, "")
    .replace(/\/+$/, "");
  // A pattern that selects every package maps to every file.
  if (base === "" || base === "**") return "**";
  return `${base}/**`;
}

/**
 * Rebuild an agent-facing frontmatter block from a canonical rule.
 *
 * The key means different things in each store: nax's `appliesTo:` is the FILE
 * glob and its `paths:` is PACKAGE scope, whereas Claude's `paths:` is the file
 * glob. `nax rules migrate` translates Claude `paths:` -> nax `appliesTo:` on
 * the way in (see translateLegacyFrontmatter); this is the same translation on
 * the way out. Canonical `paths:` is read as a file glob via
 * {@link packageGlobToFileGlob} so a package-scoped rule keeps its scope.
 *
 * When the rule carries a `description`, it is emitted FIRST in the block so
 * the agent prompt sees the rule's purpose ahead of any scope — both fields
 * are serialized through `JSON.stringify` for the same reason globs are:
 * a description containing `:`, `#`, `"`, or `\` would otherwise produce
 * invalid YAML. This block is read by Claude's own frontmatter loader, a
 * separate implementation from nax's `Bun.YAML.parse` (used only for
 * canonical `.nax/rules/*.md`) — escaping guards the emitted YAML's grammar
 * itself, not compatibility between the two parsers.
 *
 * Returns "" for a rule that has neither description nor scope, so an empty
 * block is never emitted.
 */
function claudeFrontmatter(rule: CanonicalRule): string {
  const fileGlobs = rule.appliesTo ?? [];
  const packageGlobs = rule.paths ?? [];

  // nax applies `appliesTo` AND `paths` as a conjunction, but Claude's single
  // `paths:` list is a disjunction — emitting both would WIDEN the rule rather
  // than narrow it, which is the opposite of what either scope asked for. Keep
  // the file glob, the more specific of the two, and report the package scope
  // instead of quietly unioning it in. `description` is metadata, not scope,
  // so it is preserved alongside the warning so the operator can identify the
  // affected rule when several files share a name.
  if (fileGlobs.length > 0 && packageGlobs.length > 0) {
    _rulesCLIDeps.getLogger().warn("rules-export", "Dropping package scope — Claude cannot express both scopes", {
      rule: rule.path ?? rule.fileName,
      description: rule.description,
      droppedPaths: packageGlobs,
      keptAppliesTo: fileGlobs,
    });
  }

  const globs = fileGlobs.length > 0 ? fileGlobs : [...new Set(packageGlobs.map(packageGlobToFileGlob))];
  const description = rule.description;
  if (globs.length === 0 && description === undefined) return "";
  // JSON.stringify escapes quotes/backslashes — a raw interpolation would
  // emit invalid YAML for any value containing either (cf. toYamlListLiteral).
  const descLine = description !== undefined ? `description: ${JSON.stringify(description)}\n` : "";
  const globLines = globs.length > 0 ? `paths:\n${globs.map((g) => `  - ${JSON.stringify(g)}`).join("\n")}\n` : "";
  return `---\n${descLine}${globLines}---\n`;
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
    const target = resolve(workdir, ruleDir, rel);
    // The real loader derives `rel` from a glob under .nax/rules and cannot
    // produce `..`, but the dep is injectable and this repo has shipped a
    // path-containment bug before (#1449). Cheap insurance.
    if (!target.startsWith(`${resolve(workdir, ruleDir)}${sep}`)) {
      throw new NaxError(`Rule path escapes ${ruleDir}: ${rel}`, "RULES_EXPORT_PATH_ESCAPE", {
        stage: "rules-export",
        rule: rel,
      });
    }
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

  // Files under the rules dir with no canonical counterpart are left alone —
  // deleting hand-written rules would be destructive — but a stale one keeps
  // being loaded forever, so it is surfaced in both modes.
  const expected = new Set(rules.map((r) => resolve(workdir, ruleDir, r.path ?? r.fileName)));
  for (const existing of _rulesCLIDeps.globInDir(join(workdir, ruleDir))) {
    if (!expected.has(resolve(existing))) {
      _rulesCLIDeps.getLogger().warn("rules-export", "Generated rules dir contains a file with no canonical source", {
        file: existing,
        hint: `Delete it, or add the rule to ${CANONICAL_RULES_DIR}/`,
      });
    }
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

/**
 * `nax rules export --agent=<id>`
 *
 * Reads the canonical rules store (.nax/rules/*.md) and writes it out for one
 * agent. Agents with a native rules DIRECTORY (claude -> .claude/rules/) get
 * one file per rule with its scope preserved; the rest get a single shim file
 * at the project root. Either way this is one-way — manual edits to generated
 * output are never read back by the engine.
 *
 * Throws NaxError when the canonical store is empty, the agent is unsupported,
 * or (with `check`) the generated output has drifted from what is on disk.
 */
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
