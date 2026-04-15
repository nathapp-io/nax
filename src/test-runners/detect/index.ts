/**
 * Detection Orchestrator
 *
 * Runs the four-tier detection pipeline for a given workdir:
 *   Tier 1 — Framework config files (high confidence)
 *   Tier 2 — Framework declared in manifests (medium confidence)
 *   Tier 3 — File system scan via git ls-files (low confidence)
 *   Tier 4 — Directory convention fallback (low confidence)
 *
 * Results are cached in `.nax/cache/test-patterns.json` and invalidated
 * when relevant manifest mtimes change.
 *
 * Multiple languages in one project produce a union of patterns.
 * Confidence reflects the strongest tier that yielded patterns.
 */

import { getSafeLogger } from "../../logger";
import type { DetectionResult, DetectionSource } from "./types";
export type { DetectionResult, DetectionSource } from "./types";
import { readCache, writeCache } from "./cache";
import { detectFromDirectoryScan } from "./directory-scan";
import { detectFromFileScan } from "./file-scan";
import { detectFromFrameworkConfigs } from "./framework-configs";
import { detectFromFrameworkDefaults } from "./framework-defaults";

/** Deduplicate patterns while preserving insertion order */
function dedupePatterns(patterns: readonly string[]): readonly string[] {
  return [...new Set(patterns)];
}

/** Map detection source type to confidence level */
function sourceToConfidence(type: DetectionSource["type"]): DetectionResult["confidence"] {
  switch (type) {
    case "framework-config":
      return "high";
    case "manifest":
      return "medium";
    case "file-scan":
    case "directory":
      return "low";
  }
}

/** Merge multiple DetectionSources into a single DetectionResult */
function mergeResults(sources: DetectionSource[]): DetectionResult {
  if (sources.length === 0) {
    return { patterns: [], confidence: "empty", sources: [] };
  }

  const allPatterns: string[] = [];
  for (const source of sources) {
    for (const p of source.patterns) {
      allPatterns.push(p);
    }
  }

  // Confidence = strongest tier found
  const confidenceOrder: DetectionResult["confidence"][] = ["high", "medium", "low", "empty"];
  let confidence: DetectionResult["confidence"] = "empty";
  for (const source of sources) {
    const c = sourceToConfidence(source.type);
    if (confidenceOrder.indexOf(c) < confidenceOrder.indexOf(confidence)) {
      confidence = c;
    }
  }

  return {
    patterns: dedupePatterns(allPatterns),
    confidence,
    sources,
  };
}

/**
 * Detect test file patterns for a single package directory.
 * Runs tiers in order; stops at Tier 1+2 if they yield patterns.
 * Always runs Tier 3 cross-check when Tier 1/2 succeed (logs mismatch warning).
 */
async function detectForDirectory(workdir: string): Promise<DetectionResult> {
  const logger = getSafeLogger();

  // Tier 1: Framework config files
  const tier1Sources = await detectFromFrameworkConfigs(workdir);
  const tier1Patterns = tier1Sources.flatMap((s) => [...s.patterns]);

  // Tier 2: Framework defaults from manifests
  const tier2Sources = await detectFromFrameworkDefaults(workdir);
  const tier2Patterns = tier2Sources.flatMap((s) => [...s.patterns]);

  // Tier 3: File scan (used for cross-check and as fallback)
  const tier3Source = await detectFromFileScan(workdir);
  const tier3Patterns = tier3Source ? [...tier3Source.patterns] : [];

  // Cross-check: if Tier 1/2 found patterns but Tier 3 disagrees, log warning
  if ((tier1Patterns.length > 0 || tier2Patterns.length > 0) && tier3Patterns.length > 0) {
    const tier12Suffixes = new Set(
      [...tier1Patterns, ...tier2Patterns].map((p) => {
        const star = p.lastIndexOf("*");
        return star >= 0 ? p.slice(star + 1) : p;
      }),
    );
    const tier3Suffixes = tier3Patterns.map((p) => {
      const star = p.lastIndexOf("*");
      return star >= 0 ? p.slice(star + 1) : p;
    });
    const unmatched = tier3Suffixes.filter((s) => !tier12Suffixes.has(s));
    if (unmatched.length > 0) {
      logger?.debug("detect", "File scan found test suffixes not in framework config (possible config mismatch)", {
        unmatched,
        workdir,
      });
    }
  }

  // If Tier 1 or 2 found patterns, use them
  if (tier1Patterns.length > 0 || tier2Patterns.length > 0) {
    const sources = [...tier1Sources, ...tier2Sources];
    // Filter empty-pattern sources (config file found but no extractable patterns)
    const meaningful = sources.filter((s) => s.patterns.length > 0);
    if (meaningful.length > 0) {
      const result = mergeResults(meaningful);
      logger?.info("detect", "Test patterns detected", {
        confidence: result.confidence,
        patternCount: result.patterns.length,
        tier: result.sources[0]?.type,
        workdir,
      });
      return result;
    }
  }

  // Tier 3: file scan as primary source
  if (tier3Source && tier3Patterns.length > 0) {
    logger?.info("detect", "Test patterns detected via file scan", {
      confidence: "low",
      patternCount: tier3Patterns.length,
      workdir,
    });
    return mergeResults([tier3Source]);
  }

  // Tier 4: directory convention fallback
  const tier4Source = await detectFromDirectoryScan(workdir);
  if (tier4Source && tier4Source.patterns.length > 0) {
    logger?.info("detect", "Test patterns detected via directory convention", {
      confidence: "low",
      patternCount: tier4Source.patterns.length,
      workdir,
    });
    return mergeResults([tier4Source]);
  }

  return { patterns: [], confidence: "empty", sources: [] };
}

/**
 * Detect test file patterns for the given working directory.
 *
 * Results are cached in `.nax/cache/test-patterns.json`.
 * Cache is invalidated when relevant manifest mtimes change.
 *
 * Exported as the replacement for the Phase 1 stub.
 */
export async function detectTestFilePatterns(workdir: string): Promise<DetectionResult> {
  // Try cache first
  const cached = await readCache(workdir);
  if (cached) {
    getSafeLogger()?.debug("detect", "Cache hit", { workdir });
    return cached;
  }

  const result = await detectForDirectory(workdir);

  // Write to cache (non-blocking, errors are swallowed inside writeCache)
  await writeCache(workdir, result);

  return result;
}

/**
 * Run detection for a monorepo: detect for root + each package directory.
 * Returns a map of packageDir → DetectionResult (root key: "").
 */
export async function detectTestFilePatternsForWorkspace(
  workdir: string,
  packageDirs: string[],
): Promise<Record<string, DetectionResult>> {
  const entries = await Promise.all([
    detectForDirectory(workdir).then((r) => ["", r] as const),
    ...packageDirs.map((dir) => detectForDirectory(`${workdir}/${dir}`).then((r) => [dir, r] as const)),
  ]);

  return Object.fromEntries(entries);
}
