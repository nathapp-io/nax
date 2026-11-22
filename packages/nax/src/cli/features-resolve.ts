import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { featureDir as configFeatureDir, findProjectDir, loadConfig } from "../config";
import { resolveTestFilePatterns } from "../test-runners";
import { validateFeatureName } from "../utils/feature-name";
import { gitWithTimeout } from "../utils/git";
import { resolveRunProfileOverride } from "./resolve-run-profile";

export type ResolveStatus = "ok" | "ambiguous" | "missing" | "feature-not-found" | "not-a-nax-repo";

export type SpecSourceKind = "markdown" | "prd";

export interface SpecSource {
  kind: SpecSourceKind;
  path: string; // repo-root-relative
}

/**
 * Test-file classification patterns, in a JSON-portable form.
 *
 * `ResolvedTestPatterns.regex` is `RegExp[]`, which does not survive
 * `JSON.stringify`, so the sources are emitted as strings for a consumer to
 * rebuild with `new RegExp(src)`. Exists so out-of-process consumers — the
 * nax-finish flow, which runs inside acpx and cannot import
 * `resolveTestFilePatterns` — classify paths through the ADR-009 SSOT instead
 * of reinventing `/\.test\.ts$/`.
 *
 * Root-level resolution only: a per-file answer in a polyglot monorepo would
 * need `findPackageDir` per path. Consumers needing that precision must call
 * the resolver directly.
 */
export interface TestPatternResolution {
  /** Regex sources for path classification, e.g. ["\\.test\\.ts$"]. */
  regex: string[];
  /** Which tier resolved them: per-package | root-config | detected | fallback. */
  resolution: string;
}

export interface ResolveResult {
  status: ResolveStatus;
  featureName?: string | null;
  specSource?: SpecSource | null;
  /** Repo-root test-file patterns. Present only on an `ok` result. */
  testPatterns?: TestPatternResolution;
  candidates?: string[];
  checked?: string[];
  /** Set when no name was given and the feature was picked by its PRD `branchName`. */
  matchedBy?: "branch";
  /** The checked-out branch, when it narrowed the auto-discovered candidates (an `ok` match or several matches). */
  branch?: string;
  message: string;
}

/** Injectable dependencies (`_deps` pattern) for tests. */
export const _featuresResolveDeps = {
  /** The checked-out branch; "" on a detached HEAD, outside a git repo, or on any git failure. */
  readCurrentBranch: async (dir: string): Promise<string> => {
    try {
      const { stdout, exitCode } = await gitWithTimeout(["branch", "--show-current"], dir);
      return exitCode === 0 ? stdout.trim() : "";
    } catch {
      // No branch to match on: auto-discovery falls back to listing every candidate.
      return "";
    }
  },
};

/** Profile sources for `resolveFeatureSpec` — mirrors the run's own resolution. */
export interface FeatureSpecResolveOptions {
  /** Profile chain from the CLI `--profile` flag(s); comma-separated or repeated. */
  profile?: string[];
  /** Profile named by the environment. Defaults to `process.env.NAX_PROFILE`. */
  envProfile?: string;
}

/**
 * Resolve the config overrides a feature's resolution must run under.
 *
 * `nax features resolve` has to see the config the run itself would see: a
 * project whose config only validates under the profile its PRD was planned
 * with (the PRD's `routingProfile`) otherwise always fails here while `nax run`
 * succeeds. Precedence is `resolveRunProfileOverride`'s — CLI `--profile` >
 * `NAX_PROFILE` > PRD `routingProfile` — and an empty chain means "let
 * loadConfig resolve on its own".
 */
async function resolveConfigOverrides(
  featureName: string,
  workdir: string,
  repoRoot: string,
  opts?: FeatureSpecResolveOptions,
): Promise<Record<string, unknown> | undefined> {
  let prdPath: string;
  try {
    prdPath = join(configFeatureDir(repoRoot, featureName), "prd.json");
  } catch {
    // configFeatureDir() validates the id (SEC-3). A directory under
    // .nax/features/ that does not look like a feature id (a stray entry
    // auto-discovery still lists) has no PRD to read, so resolution proceeds
    // without one — the same tolerance `nax status --features` shows for such an
    // entry.
    return undefined;
  }
  const chain = await resolveRunProfileOverride({
    prdPath,
    projectRoot: workdir,
    cliProfile: opts?.profile,
    envProfile: opts?.envProfile ?? process.env.NAX_PROFILE,
  });
  return chain && chain.length > 0 ? { profile: chain } : undefined;
}

/**
 * Resolve the repo's test-file patterns for emission in `nax features resolve`.
 *
 * Never throws — this feeds a CLI whose primary job is spec resolution, so a
 * broken/legacy config degrades to omitting the field rather than failing the
 * whole command.
 *
 * @param configOverrides - Extra loadConfig CLI-layer overrides (e.g. `{ profile: [...] }`).
 */
async function resolveTestPatterns(
  workdir: string,
  configOverrides?: Record<string, unknown>,
): Promise<TestPatternResolution | undefined> {
  try {
    const config = await loadConfig(workdir, configOverrides);
    const resolved = await resolveTestFilePatterns(config, workdir);
    return { regex: resolved.regex.map((r) => r.source), resolution: resolved.resolution };
  } catch {
    return undefined;
  }
}

/** Returns true if the file at absolutePath exists and has non-whitespace content. */
async function isNonEmptyFile(absolutePath: string): Promise<boolean> {
  if (!existsSync(absolutePath)) return false;
  const content = await Bun.file(absolutePath).text();
  return content.trim().length > 0;
}

/**
 * Performs the ordered spec-source search for a named feature.
 * Returns the first existing, non-empty match or null.
 * Also returns the full list of checked paths (for "missing" responses).
 */
async function searchSpecSource(
  naxDir: string,
  repoRoot: string,
  name: string,
): Promise<{ source: SpecSource | null; checked: string[] }> {
  const candidates: Array<{ abs: string; kind: SpecSourceKind }> = [
    { abs: join(naxDir, "features", name, "spec.md"), kind: "markdown" },
    { abs: join(naxDir, "specs", `${name}.md`), kind: "markdown" },
  ];

  // docs/specs exact match, then glob fallback
  const docsSpecExact = join(repoRoot, "docs", "specs", `SPEC-${name}.md`);
  candidates.push({ abs: docsSpecExact, kind: "markdown" });

  const checked: string[] = candidates.map((c) => relative(repoRoot, c.abs));

  for (const { abs, kind } of candidates.slice(0, 2)) {
    if (kind === "markdown") {
      const nonEmpty = await isNonEmptyFile(abs);
      if (nonEmpty) {
        return { source: { kind, path: relative(repoRoot, abs) }, checked };
      }
    }
  }

  // Third candidate: docs/specs exact
  if (await isNonEmptyFile(docsSpecExact)) {
    return { source: { kind: "markdown", path: relative(repoRoot, docsSpecExact) }, checked };
  }

  // Glob fallback for docs/specs/*<name>*.md
  const docsSpecsDir = join(repoRoot, "docs", "specs");
  if (existsSync(docsSpecsDir)) {
    const glob = new Bun.Glob(`*${name}*.md`);
    for (const match of glob.scanSync({ cwd: docsSpecsDir, absolute: false })) {
      const abs = join(docsSpecsDir, match);
      if (await isNonEmptyFile(abs)) {
        const relPath = relative(repoRoot, abs);
        if (!checked.includes(relPath)) checked.push(relPath);
        return { source: { kind: "markdown", path: relPath }, checked };
      }
    }
  }

  // Fourth: prd.json
  const prdAbs = join(naxDir, "features", name, "prd.json");
  const prdRel = relative(repoRoot, prdAbs);
  if (!checked.includes(prdRel)) checked.push(prdRel);
  if (existsSync(prdAbs)) {
    return { source: { kind: "prd", path: prdRel }, checked };
  }

  return { source: null, checked };
}

/** Discover candidate feature names: every subdir of .nax/features/ that contains prd.json or spec.md. */
function discoverCandidates(naxDir: string): string[] {
  const featuresDir = join(naxDir, "features");
  if (!existsSync(featuresDir)) return [];
  return readdirSync(featuresDir, { withFileTypes: true })
    .filter((e) => {
      if (!e.isDirectory()) return false;
      const dir = join(featuresDir, e.name);
      return existsSync(join(dir, "prd.json")) || existsSync(join(dir, "spec.md"));
    })
    .map((e) => e.name)
    .sort();
}

/**
 * Resolves featureName + spec source deterministically.
 *
 * @param name - Feature name, explicit spec path, or undefined (auto-discover).
 * @param workdir - Absolute path to the project directory (never process.cwd()).
 * @param opts - Profile sources for config resolution. The run's own chain
 *   (CLI > NAX_PROFILE > PRD `routingProfile`) is adopted so a config that only
 *   validates under that profile resolves here too.
 * @returns ResolveResult with status, specSource, candidates, checked, message.
 */
export async function resolveFeatureSpec(
  name: string | undefined,
  workdir: string,
  opts?: FeatureSpecResolveOptions,
): Promise<ResolveResult> {
  // Step 1: Resolve repo root
  const naxDir = findProjectDir(workdir);
  if (!naxDir) {
    return {
      status: "not-a-nax-repo",
      message: `not a nax repo: no .nax/config.json found from ${workdir}`,
    };
  }
  // naxDir is the .nax/ directory — parent is repoRoot
  const repoRoot = join(naxDir, "..");

  // Step 2: Explicit path (starts with ./ or / or ends in .md)
  if (name !== undefined && (name.startsWith("./") || name.startsWith("/") || name.endsWith(".md"))) {
    const abs = name.startsWith("/") ? name : join(workdir, name);
    if (!existsSync(abs)) {
      return {
        status: "missing",
        featureName: null,
        specSource: null,
        checked: [name],
        message: `spec file not found: ${name}`,
      };
    }
    const content = await Bun.file(abs).text();
    if (content.trim().length === 0) {
      return {
        status: "missing",
        featureName: null,
        specSource: null,
        checked: [name],
        message: `spec file is empty at ${name}`,
      };
    }
    return {
      status: "ok",
      featureName: null,
      specSource: { kind: "markdown", path: relative(repoRoot, abs) },
      message: `resolved spec: ${relative(repoRoot, abs)}`,
    };
  }

  // Step 3: Named feature
  if (name !== undefined && name.trim() !== "") {
    validateFeatureName(name); // throws with descriptive message on invalid name

    const { source, checked } = await searchSpecSource(naxDir, repoRoot, name);

    if (source) {
      const configOverrides = await resolveConfigOverrides(name, workdir, repoRoot, opts);
      return {
        status: "ok",
        featureName: name,
        specSource: source,
        testPatterns: await resolveTestPatterns(workdir, configOverrides),
        message: `resolved spec: ${source.path}`,
      };
    }

    // Check if the feature dir exists at all
    const featureDir = join(naxDir, "features", name);
    if (existsSync(featureDir)) {
      return {
        status: "missing",
        featureName: name,
        specSource: null,
        checked,
        message: `no spec found for feature "${name}"`,
      };
    }

    // Feature dir does not exist — list all candidates
    const candidates = discoverCandidates(naxDir);
    return {
      status: "feature-not-found",
      featureName: name,
      specSource: null,
      checked,
      candidates,
      message: `feature "${name}" not found`,
    };
  }

  // Step 4: Empty name — auto-discover
  const candidates = discoverCandidates(naxDir);
  if (candidates.length === 0) {
    return {
      status: "feature-not-found",
      candidates: [],
      message: "no features found in .nax/features/", // nax-feature-dir-allow: user-facing message
    };
  }
  if (candidates.length > 1) {
    return resolveByBranch(candidates, { naxDir, repoRoot, workdir, opts });
  }
  return resolveDiscovered(candidates[0], { naxDir, repoRoot, workdir, opts });
}

interface DiscoverContext {
  naxDir: string;
  repoRoot: string;
  workdir: string;
  opts?: FeatureSpecResolveOptions;
}

/** The PRD's `branchName`, or undefined when there is no PRD or it cannot be read. */
async function readPrdBranch(naxDir: string, name: string): Promise<string | undefined> {
  // Plain join, not configFeatureDir(): that throws on a directory name that is not a valid
  // feature id, and auto-discovery lists such stray directories as candidates.
  const prdPath = join(naxDir, "features", name, "prd.json");
  try {
    const prd: unknown = JSON.parse(await Bun.file(prdPath).text());
    if (typeof prd !== "object" || prd === null || !("branchName" in prd)) return undefined;
    return typeof prd.branchName === "string" ? prd.branchName : undefined;
  } catch {
    // A missing or unreadable PRD cannot claim the branch; the feature stays an unmatched candidate.
    return undefined;
  }
}

/**
 * Several candidates: pick the one whose PRD `branchName` is the branch checked out in `workdir`.
 * No match (or a detached HEAD) keeps every candidate; several matches narrow the list to them.
 */
async function resolveByBranch(candidates: string[], ctx: DiscoverContext): Promise<ResolveResult> {
  const branch = await _featuresResolveDeps.readCurrentBranch(ctx.workdir);
  const branches = branch ? await Promise.all(candidates.map((c) => readPrdBranch(ctx.naxDir, c))) : [];
  const matches = candidates.filter((_, i) => branches[i] === branch);
  if (matches.length === 1) {
    const result = await resolveDiscovered(matches[0], ctx);
    return {
      ...result,
      matchedBy: "branch",
      branch,
      message: `${result.message} (feature on current branch ${branch})`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: matches,
      branch,
      message: `multiple features on current branch ${branch} — pass one explicitly: ${matches.join(", ")}`,
    };
  }
  return {
    status: "ambiguous",
    candidates,
    message: `multiple features found — pass one explicitly: ${candidates.join(", ")}`,
  };
}

/** Resolve the spec source of an auto-discovered feature. */
async function resolveDiscovered(name: string, ctx: DiscoverContext): Promise<ResolveResult> {
  const { source, checked } = await searchSpecSource(ctx.naxDir, ctx.repoRoot, name);
  if (source) {
    const configOverrides = await resolveConfigOverrides(name, ctx.workdir, ctx.repoRoot, ctx.opts);
    return {
      status: "ok",
      featureName: name,
      specSource: source,
      testPatterns: await resolveTestPatterns(ctx.workdir, configOverrides),
      message: `resolved spec: ${source.path}`,
    };
  }
  return {
    status: "missing",
    featureName: name,
    specSource: null,
    checked,
    message: `no spec found for feature "${name}"`,
  };
}
