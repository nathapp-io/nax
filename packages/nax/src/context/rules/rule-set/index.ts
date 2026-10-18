/**
 * Rule-set resolver (US-001) — one shared repo/package/override rule set.
 *
 * Every delivery path (the pipeline's `StaticRulesProvider`, the native
 * rule-delivery handlers, the review maps) resolves rules through here, so that
 * "which rule governs this file" has a single answer.
 *
 * Layers, in order:
 *
 *   1. repo       `<repoRoot>/.nax/rules/`
 *   2. package    `<packageDir>/.nax/rules/` (skipped at the repo root)
 *   3. override   `overrideDir` (an absolute directory laid out like `.nax/rules/`)
 *
 * A later layer REPLACES an earlier rule with the same rule id. In `replace`
 * mode the repo and package layers are not loaded at all and only the override
 * layer is used.
 *
 * Override rules are treated exactly like repo-level rules: filtered by their
 * `paths:` frontmatter through `ruleMatchesPackage`, and their literal
 * `appliesTo:` entries re-spelled for the consuming package through
 * `frameAppliesTo`. Whatever is admitted is then matched against a single file
 * by `ruleMatchesScopeFiles` (`rulesForFile`), the same matcher the provider
 * uses for selection and effectiveness.ts for attribution.
 */

import { join } from "node:path";
// Both of these are nested barrels (`x/index.ts`), imported by exact alias so
// the resolver shares one matcher and one rules cache with the pipeline
// provider instead of copying either. Reaching into the parent
// `@/context/engine` barrel would close a runtime cycle — that barrel
// re-exports StaticRulesProvider, which imports this module.
import { memoizedLoadCanonicalRules } from "@/context/engine/providers/canonical-rules-cache";
import {
  frameAppliesTo,
  normalizePath,
  ruleMatchesPackage,
  ruleMatchesScopeFiles,
} from "@/context/engine/scope-path-match";
import {
  type CanonicalRule,
  FRONTMATTER_PRIORITY_DEFAULT,
  loadCanonicalRulesFromDir,
} from "@/context/rules/canonical-loader";
import { findPackageDir } from "@/test-runners";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Which layer a resolved rule came from. */
export type RuleSource = "repo" | "package" | "override";

/** A canonical rule carrying its layer provenance and its operator-facing path. */
export interface ResolvedRule extends CanonicalRule {
  /** `canonicalRuleId(rule)` — the merge key across layers. */
  readonly ruleId: string;
  readonly source: RuleSource;
  /** ".nax/rules/<rel>", "<storyWorkdir>/.nax/rules/<rel>", or the absolute override path. */
  readonly displayPath: string;
}

export interface ResolveRuleSetInput {
  readonly repoRoot: string;
  /** Absolute; equals repoRoot for the root package. */
  readonly packageDir: string;
  /** Repo-relative package frame. */
  readonly storyWorkdir?: string;
  /** Absolute override directory, laid out like `.nax/rules/`. */
  readonly overrideDir?: string;
  /** Default "merge". */
  readonly overrideMode?: "merge" | "replace";
}

export interface RuleLoaders {
  /**
   * Loads `<workdir>/.nax/rules`, for the repo layer AND the package layer.
   * Default: memoized `loadCanonicalRules` (key: workdir).
   */
  readonly loadRepoRules?: (workdir: string) => Promise<CanonicalRule[]>;
  /** Loads an override directory. Default: memoized `loadCanonicalRulesFromDir` (key: absolute dir). */
  readonly loadDirRules?: (dir: string) => Promise<CanonicalRule[]>;
}

export interface ResolvedRuleSet {
  readonly rules: readonly ResolvedRule[];
  /** Repo rules before the `paths:` filter. */
  readonly repoRulesTotal: number;
  /** Repo rules after the `paths:` filter. */
  readonly repoRulesMatchedPaths: number;
  /** Package-layer rules loaded (0 at the root, and 0 in replace mode). */
  readonly packageRulesCount: number;
}

export interface RulesForFileInput {
  readonly repoRoot: string;
  /** Repo-relative, normalized. */
  readonly path: string;
  readonly overrideDir?: string;
  readonly overrideMode?: "merge" | "replace";
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule identity
// ─────────────────────────────────────────────────────────────────────────────

/** The merge key: an explicit `id:`, else the file name without `.md`. */
export function canonicalRuleId(rule: CanonicalRule): string {
  return rule.id ?? rule.fileName.replace(/\.md$/i, "");
}

/** The rule's path relative to its own rules directory (`.nax/rules/` or the override dir). */
export function canonicalRulePath(rule: CanonicalRule): string {
  return rule.path ?? rule.fileName;
}

/** Effective priority — an absent `priority:` is the frontmatter default. */
export function canonicalRulePriority(rule: CanonicalRule): number {
  return rule.priority ?? FRONTMATTER_PRIORITY_DEFAULT;
}

// Part of this module's declared interface (US-001 § Interfaces): the loader
// behind the override layer, re-exported so a caller that injects its own
// `RuleLoaders.loadDirRules` gets it from the same import site as the resolver.
export { loadCanonicalRulesFromDir };

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Override directories are memoized independently of the repo cache
 * (`canonical-rules-cache`), whose key is a workdir and whose misses must not
 * be confused with override lookups. A rejection is not cached: a transient
 * read failure must not poison every later resolution for the rest of the run.
 */
const DIR_RULES_CACHE = new Map<string, Promise<CanonicalRule[]>>();

function memoizedLoadDirRules(dir: string): Promise<CanonicalRule[]> {
  const cached = DIR_RULES_CACHE.get(dir);
  if (cached) return cached;
  const loaded = loadCanonicalRulesFromDir(dir);
  DIR_RULES_CACHE.set(dir, loaded);
  loaded.catch(() => DIR_RULES_CACHE.delete(dir));
  return loaded;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

function toResolvedRule(rule: CanonicalRule, source: RuleSource, displayPath: string): ResolvedRule {
  return { ...rule, ruleId: canonicalRuleId(rule), source, displayPath };
}

/** Repo-relative display path of a repo-layer rule: ".nax/rules/<rel>". */
function repoDisplayPath(rel: string): string {
  return `.nax/rules/${rel}`;
}

/**
 * Display path of a package-layer rule. The package frame comes from the
 * PRD-declared `storyWorkdir`; when a caller supplies a non-root `packageDir`
 * without it there is no package frame to print, and the repo-root spelling is
 * the honest fallback (same fallback `ruleMatchesPackage` takes).
 */
function packageDisplayPath(rel: string, packageRel: string): string {
  return packageRel === "." ? repoDisplayPath(rel) : `${packageRel}/.nax/rules/${rel}`;
}

function sortRules(rules: ResolvedRule[]): ResolvedRule[] {
  return rules.sort((a, b) => {
    const priorityDiff = canonicalRulePriority(a) - canonicalRulePriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    // CTX-5: code-point comparison, not localeCompare — see digest.ts.
    const idA = canonicalRuleId(a);
    const idB = canonicalRuleId(b);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

/**
 * The override layer, keyed by rule id. A rule whose `paths:` excludes the
 * consuming package is dropped here, before it can replace a repo rule with the
 * same id, and its literal `appliesTo:` is framed for that package.
 */
async function loadOverrideLayer(
  input: ResolveRuleSetInput,
  loadDirRules: (dir: string) => Promise<CanonicalRule[]>,
): Promise<Map<string, ResolvedRule>> {
  const layer = new Map<string, ResolvedRule>();
  const overrideDir = input.overrideDir;
  if (!overrideDir) return layer;

  const isPackage = input.packageDir !== input.repoRoot;
  const packageRel = normalizePath(input.storyWorkdir ?? ".");
  for (const rule of await loadDirRules(overrideDir)) {
    if (!ruleMatchesPackage(rule.paths, input.repoRoot, input.packageDir, input.storyWorkdir)) continue;
    const framed = isPackage ? frameAppliesTo(rule, packageRel) : rule;
    layer.set(canonicalRuleId(rule), toResolvedRule(framed, "override", join(overrideDir, canonicalRulePath(rule))));
  }
  return layer;
}

/**
 * Resolve the repo, package and override layers into one rule set.
 *
 * Never throws for an absent rules directory — each layer loads to `[]`.
 * A loader error (invalid frontmatter under `onInvalidFrontmatter: "throw"`, a
 * neutrality violation) propagates: the caller decides whether to fail the run.
 */
export async function resolveRuleSet(input: ResolveRuleSetInput, loaders: RuleLoaders = {}): Promise<ResolvedRuleSet> {
  const loadRepoRules = loaders.loadRepoRules ?? memoizedLoadCanonicalRules;
  const loadDirRules = loaders.loadDirRules ?? memoizedLoadDirRules;
  const isPackage = input.packageDir !== input.repoRoot;
  const packageRel = normalizePath(input.storyWorkdir ?? ".");

  if ((input.overrideMode ?? "merge") === "replace") {
    const overrideLayer = await loadOverrideLayer(input, loadDirRules);
    // The repo and package layers are not loaded, so every pre-filter count the
    // #558 "rules exist but none apply" branch reads is 0 and it cannot fire.
    return {
      rules: sortRules([...overrideLayer.values()]),
      repoRulesTotal: 0,
      repoRulesMatchedPaths: 0,
      packageRulesCount: 0,
    };
  }

  const repoRulesAll = await loadRepoRules(input.repoRoot);
  const repoRules = repoRulesAll.filter((rule) =>
    ruleMatchesPackage(rule.paths, input.repoRoot, input.packageDir, input.storyWorkdir),
  );

  const merged = new Map<string, ResolvedRule>();
  // Repo-level rules are framed whenever this story is package-contained, not
  // only when the package has rules of its own: a monorepo package with no
  // `.nax/rules/` of its own is the common shape, and its repo-authored
  // package-relative literals must still match (nax#2113's hoist).
  const repoLayer = isPackage ? repoRules.map((rule) => frameAppliesTo(rule, packageRel)) : repoRules;
  for (const rule of repoLayer) {
    merged.set(canonicalRuleId(rule), toResolvedRule(rule, "repo", repoDisplayPath(canonicalRulePath(rule))));
  }

  let packageRulesCount = 0;
  if (isPackage) {
    const packageRules = await loadRepoRules(input.packageDir);
    packageRulesCount = packageRules.length;
    // H8: a package rule's `appliesTo:` literal is package-relative while
    // scopeFiles and the diff are repo-rooted. Frame it with the owning package
    // before selection and attribution both see the repo frame (#2091).
    for (const rule of packageRules) {
      merged.set(
        canonicalRuleId(rule),
        toResolvedRule(
          frameAppliesTo(rule, packageRel),
          "package",
          packageDisplayPath(canonicalRulePath(rule), packageRel),
        ),
      );
    }
  }

  for (const [id, rule] of await loadOverrideLayer(input, loadDirRules)) merged.set(id, rule);

  return {
    rules: sortRules([...merged.values()]),
    repoRulesTotal: repoRulesAll.length,
    repoRulesMatchedPaths: repoRules.length,
    packageRulesCount,
  };
}

/**
 * The rules governing one file.
 *
 * Finds the file's package (`findPackageDir`), resolves that package's rule
 * set, and keeps the rules whose `appliesTo:` matches the file. A rule with no
 * `appliesTo:` governs every file.
 */
export async function rulesForFile(input: RulesForFileInput, loaders: RuleLoaders = {}): Promise<ResolvedRule[]> {
  const packageRel = await findPackageDir(input.path, input.repoRoot);
  const set = await resolveRuleSet(
    {
      repoRoot: input.repoRoot,
      packageDir: packageRel === undefined ? input.repoRoot : join(input.repoRoot, packageRel),
      ...(packageRel !== undefined && { storyWorkdir: packageRel }),
      ...(input.overrideDir !== undefined && { overrideDir: input.overrideDir }),
      ...(input.overrideMode !== undefined && { overrideMode: input.overrideMode }),
    },
    loaders,
  );

  const file = normalizePath(input.path);
  return set.rules.filter((rule) => ruleMatchesScopeFiles(rule.appliesTo, [file]));
}
