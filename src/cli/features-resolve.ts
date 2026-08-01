import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { findProjectDir, loadConfig } from "../config";
import { resolveTestFilePatterns } from "../test-runners";
import { validateFeatureName } from "../utils/feature-name";
import { type AcceptanceResolution, resolveFeatureAcceptance } from "./features-acceptance";

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
  /** Acceptance test target(s) for the feature. Present only on an `ok` result with a known featureName. */
  acceptance?: AcceptanceResolution;
  /** Repo-root test-file patterns. Present only on an `ok` result. */
  testPatterns?: TestPatternResolution;
  candidates?: string[];
  checked?: string[];
  message: string;
}

/**
 * Resolve the repo's test-file patterns for emission in `nax features resolve`.
 *
 * Never throws — this feeds a CLI whose primary job is spec resolution, so a
 * broken/legacy config degrades to omitting the field rather than failing the
 * whole command (the same rule `resolveFeatureAcceptance` follows).
 */
async function resolveTestPatterns(workdir: string): Promise<TestPatternResolution | undefined> {
  try {
    const config = await loadConfig(workdir);
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
 * @returns ResolveResult with status, specSource, candidates, checked, message.
 */
export async function resolveFeatureSpec(name: string | undefined, workdir: string): Promise<ResolveResult> {
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
      return {
        status: "ok",
        featureName: name,
        specSource: source,
        acceptance: await resolveFeatureAcceptance(name, workdir),
        testPatterns: await resolveTestPatterns(workdir),
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
      message: "no features found in .nax/features/",
    };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      candidates,
      message: `multiple features found — pass one explicitly: ${candidates.join(", ")}`,
    };
  }

  // Exactly one — resolve its spec source
  const onlyName = candidates[0];
  const { source, checked } = await searchSpecSource(naxDir, repoRoot, onlyName);
  if (source) {
    return {
      status: "ok",
      featureName: onlyName,
      specSource: source,
      acceptance: await resolveFeatureAcceptance(onlyName, workdir),
      testPatterns: await resolveTestPatterns(workdir),
      message: `resolved spec: ${source.path}`,
    };
  }
  return {
    status: "missing",
    featureName: onlyName,
    specSource: null,
    checked,
    message: `no spec found for feature "${onlyName}"`,
  };
}
