/**
 * Deterministic repository analysis for nax setup.
 *
 * Discovers repo shape, packages, package facts, and command availability.
 * All external calls are injected via _analyzeRepoDeps for testability.
 */

import { join } from "node:path";
import { discoverWorkspacePackages } from "@/test-runners/detect";
import type { ProjectProfile } from "../config";
import { detectProjectProfile } from "../project";
import type { DetectionResult } from "../test-runners/detect";
import { detectTestFilePatternsForWorkspace } from "../test-runners/detect";
import type { Orchestrator, PackageFacts, RepoAnalysis, RepoShape } from "./setup-types";

// ─── Canonical script names to audit for presence ────────────────────────────

const CANONICAL_SCRIPTS = ["build", "test", "lint", "type-check", "lint:fix"];

// ─── Dependency injection ─────────────────────────────────────────────────────

export const _analyzeRepoDeps = {
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  readJson: async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      return JSON.parse(await f.text()) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  discoverWorkspacePackages: discoverWorkspacePackages as (workdir: string) => Promise<string[]>,
  detectProjectProfile: detectProjectProfile as (
    workdir: string,
    existing: Partial<ProjectProfile>,
  ) => Promise<ProjectProfile>,
  detectTestFilePatternsForWorkspace: detectTestFilePatternsForWorkspace as (
    workdir: string,
    packageDirs: string[],
  ) => Promise<Record<string, DetectionResult>>,
};

// ─── Package manager detection ────────────────────────────────────────────────

async function detectPackageManager(workdir: string): Promise<{ pmRunPrefix: string; pmDlx: string }> {
  const { fileExists } = _analyzeRepoDeps;
  if (await fileExists(join(workdir, "bun.lock"))) return { pmRunPrefix: "bun run", pmDlx: "bunx" };
  if (await fileExists(join(workdir, "bun.lockb"))) return { pmRunPrefix: "bun run", pmDlx: "bunx" };
  if (await fileExists(join(workdir, "package-lock.json"))) return { pmRunPrefix: "npm run", pmDlx: "npx" };
  if (await fileExists(join(workdir, "yarn.lock"))) return { pmRunPrefix: "yarn", pmDlx: "yarn dlx" };
  if (await fileExists(join(workdir, "pnpm-lock.yaml"))) return { pmRunPrefix: "pnpm run", pmDlx: "pnpx" };
  return { pmRunPrefix: "npm run", pmDlx: "npx" };
}

// ─── Orchestrator detection ───────────────────────────────────────────────────

async function detectOrchestrator(workdir: string): Promise<Orchestrator> {
  const { fileExists } = _analyzeRepoDeps;
  if (await fileExists(join(workdir, "turbo.json"))) return "turbo";
  if (await fileExists(join(workdir, "nx.json"))) return "nx";
  return "none";
}

// ─── Script gap analysis ──────────────────────────────────────────────────────

async function getMissingScripts(packageDir: string): Promise<string[]> {
  const pkg = await _analyzeRepoDeps.readJson(join(packageDir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, unknown> | undefined) ?? {};
  return CANONICAL_SCRIPTS.filter((s) => !(s in scripts));
}

// ─── Per-package facts builder ────────────────────────────────────────────────

async function buildPackageFacts(
  workdir: string,
  relativeDir: string,
  testPatternMap: Record<string, DetectionResult>,
): Promise<PackageFacts> {
  const packageDir = relativeDir === "" ? workdir : join(workdir, relativeDir);
  const [profile, missingScripts] = await Promise.all([
    _analyzeRepoDeps.detectProjectProfile(packageDir, {}),
    getMissingScripts(packageDir),
  ]);
  const detection = testPatternMap[relativeDir] ?? {
    patterns: [] as readonly string[],
    confidence: "empty" as const,
    sources: [] as readonly [],
  };
  return {
    relativeDir,
    testFramework: profile.testFramework,
    testFilePatterns: detection.patterns,
    missingScripts,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run deterministic analysis on the repository at workdir.
 * Returns a RepoAnalysis fact object consumed by the LLM-driven config proposal step.
 */
export async function analyzeRepo(workdir: string): Promise<RepoAnalysis> {
  const { discoverWorkspacePackages: discover, detectTestFilePatternsForWorkspace: detectPatterns } = _analyzeRepoDeps;

  const [pmInfo, orchestrator, packageDirs] = await Promise.all([
    detectPackageManager(workdir),
    detectOrchestrator(workdir),
    discover(workdir),
  ]);

  const shape: RepoShape = packageDirs.length > 0 ? "mono" : "single";
  const dirsToAnalyze = shape === "single" ? [""] : packageDirs;

  const testPatternMap = await detectPatterns(workdir, packageDirs);

  const packages = await Promise.all(dirsToAnalyze.map((dir) => buildPackageFacts(workdir, dir, testPatternMap)));

  return {
    shape,
    packages,
    pmRunPrefix: pmInfo.pmRunPrefix,
    pmDlx: pmInfo.pmDlx,
    orchestrator,
  };
}
