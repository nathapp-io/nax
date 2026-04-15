/**
 * `nax detect` command
 *
 * Runs the four-tier test-file pattern detection for the project and reports
 * what patterns were found (and from which tier).
 *
 * Flags:
 *   --apply          Write detected patterns to .nax/config.json (and per-package configs)
 *   --json           Machine-readable JSON output
 *   --package <dir>  Restrict detection to a single package directory
 *   --force          With --apply: overwrite even when testFilePatterns is already set explicitly
 *   -d, --dir <path> Explicit project directory
 *
 * Exit codes:
 *   0 — Detection successful
 *   1 — Detection empty (no signals found)
 *   2 — Write failed (--apply only)
 */

import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config";
import { initLogger } from "../logger";
import type { DetectionResult } from "../test-runners/detect";
import { detectTestFilePatternsForWorkspace } from "../test-runners/detect";
import { discoverWorkspacePackages } from "../test-runners/detect/workspace";
import { resolveProject } from "./common";

/** Options passed from commander */
export interface DetectOptions {
  /** Write detected patterns to .nax/ configs */
  apply?: boolean;
  /** Machine-readable JSON output */
  json?: boolean;
  /** Restrict to a single package directory (relative, e.g. "packages/api") */
  package?: string;
  /** With --apply: overwrite even when testFilePatterns is already set explicitly */
  force?: boolean;
  /** Explicit project directory */
  dir?: string;
}

/** Per-package detection output */
interface PackageDetectionEntry {
  packageDir: string;
  detected: DetectionResult;
  effective: readonly string[] | undefined;
  resolution: "config" | "detected" | "none";
}

/** Resolve detected vs. effective patterns for a package */
function resolveEffective(
  detected: DetectionResult,
  configPatterns: readonly string[] | undefined,
): PackageDetectionEntry["resolution"] {
  if (configPatterns !== undefined) return "config";
  if (detected.confidence !== "empty") return "detected";
  return "none";
}

/** Load raw config JSON for a path (returns {} on missing) */
async function loadRawConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return {};
    return JSON.parse(await f.text()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write raw config JSON to a path (creates parent dirs) */
async function writeRawConfig(path: string, data: Record<string, unknown>): Promise<void> {
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Deep-set a nested key (e.g. "execution.smartTestRunner.testFilePatterns") */
function deepSet(obj: Record<string, unknown>, keyPath: string, value: unknown): Record<string, unknown> {
  const keys = keyPath.split(".");
  const result = { ...obj };
  let cur: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    cur[key] = { ...(cur[key] as Record<string, unknown> ?? {}) };
    cur = cur[key] as Record<string, unknown>;
  }
  const lastKey = keys.at(-1)!;
  cur[lastKey] = value;
  return result;
}

/** Get a nested key from a raw config object */
function deepGet(obj: Record<string, unknown>, keyPath: string): unknown {
  const keys = keyPath.split(".");
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const TEST_PATTERNS_KEY = "execution.smartTestRunner.testFilePatterns";

/**
 * Apply detected patterns to config file for a package.
 * Returns "written" | "skipped" | "forced".
 */
async function applyToConfig(
  configPath: string,
  patterns: readonly string[],
  force: boolean,
): Promise<"written" | "skipped" | "forced"> {
  const raw = await loadRawConfig(configPath);
  const existing = deepGet(raw, TEST_PATTERNS_KEY);

  if (existing !== undefined && !force) return "skipped";

  const updated = deepSet(raw, TEST_PATTERNS_KEY, [...patterns]);
  await writeRawConfig(configPath, updated);

  return existing !== undefined ? "forced" : "written";
}

/** Format patterns for display */
function fmtPatterns(patterns: readonly string[]): string {
  if (patterns.length === 0) return chalk.dim("(none)");
  return `[${patterns.map((p) => `"${p}"`).join(", ")}]`;
}

/** Format source tier for display */
function fmtSource(result: DetectionResult): string {
  const first = result.sources[0];
  if (!first) return "";
  const name = first.path.split("/").at(-1) ?? first.path;
  return chalk.dim(`(${result.confidence}, ${name})`);
}

/**
 * Run the detect command.
 */
export async function detectCommand(options: DetectOptions): Promise<void> {
  // Resolve project directory
  const resolved = resolveProject({ dir: options.dir });
  const workdir = resolved.projectDir;

  // Suppress logger output (use our own console output for detect command)
  initLogger({ level: "error" });

  // Load effective config to compare against
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(workdir);
  } catch {
    config = undefined as unknown as Awaited<ReturnType<typeof loadConfig>>;
  }

  const smartRunner = config?.execution?.smartTestRunner;
  const rootConfigPatterns =
    typeof smartRunner === "object" && smartRunner !== null ? smartRunner.testFilePatterns : undefined;

  // Discover packages (or restrict to single package)
  let packageDirs: string[];
  if (options.package) {
    packageDirs = [options.package];
  } else {
    packageDirs = await discoverWorkspacePackages(workdir);
  }

  // Run detection
  const detectionMap = await detectTestFilePatternsForWorkspace(workdir, packageDirs);
  const rootDetected = detectionMap[""] ?? { patterns: [], confidence: "empty" as const, sources: [] };

  // Build output entries
  const entries: PackageDetectionEntry[] = [
    {
      packageDir: "root",
      detected: rootDetected,
      effective: rootConfigPatterns,
      resolution: resolveEffective(rootDetected, rootConfigPatterns),
    },
    ...packageDirs.map((dir) => {
      const det = detectionMap[dir] ?? { patterns: [], confidence: "empty" as const, sources: [] };
      // Per-package config patterns would come from .nax/mono/<dir>/config.json — simplify for now
      return {
        packageDir: dir,
        detected: det,
        effective: undefined as readonly string[] | undefined,
        resolution: resolveEffective(det, undefined),
      };
    }),
  ];

  // JSON output mode
  if (options.json) {
    const output = {
      workdir,
      root: {
        detected: rootDetected,
        effective: rootConfigPatterns,
      },
      packages: Object.fromEntries(packageDirs.map((dir) => [dir, detectionMap[dir]])),
    };
    console.log(JSON.stringify(output, null, 2));
    const allEmptyJson = entries.every((e) => e.detected.confidence === "empty");
    process.exitCode = allEmptyJson ? 1 : 0;
    return;
  }

  // Human-readable output
  console.log(chalk.bold(`Workdir: ${workdir}`));
  console.log();
  console.log(chalk.bold("Detected patterns:"));

  for (const entry of entries) {
    const label = entry.packageDir === "root" ? chalk.cyan("root") : chalk.blue(entry.packageDir);
    const patterns = fmtPatterns(entry.detected.patterns);
    const source = fmtSource(entry.detected);
    console.log(`  ${label.padEnd(20)} ${patterns}  ${source}`);
  }

  console.log();
  console.log(chalk.bold("Currently effective (from config):"));
  const effectivePatterns = fmtPatterns(rootConfigPatterns ?? []);
  const effectiveSource = rootConfigPatterns !== undefined ? chalk.dim("(config)") : chalk.dim("(fallback)");
  console.log(`  ${chalk.cyan("root").padEnd(20)} ${effectivePatterns}  ${effectiveSource}`);

  // Apply mode
  if (options.apply) {
    console.log();
    console.log(chalk.bold("Applying..."));

    if (rootDetected.confidence === "empty") {
      console.log(chalk.yellow("  root: skipped (empty detection)"));
    } else {
      const rootConfigPath = join(workdir, ".nax", "config.json");
      try {
        const status = await applyToConfig(rootConfigPath, rootDetected.patterns, options.force ?? false);
        if (status === "skipped") {
          console.log(
            chalk.dim(`  root: skipped (testFilePatterns already set; use --force to overwrite)`),
          );
        } else {
          console.log(chalk.green(`  root: ${status} → ${join(".nax", "config.json")}`));
        }
      } catch (err) {
        console.error(chalk.red(`  root: write failed — ${(err as Error).message}`));
        process.exit(2);
      }
    }

    for (const dir of packageDirs) {
      const det = detectionMap[dir];
      if (!det || det.confidence === "empty") {
        console.log(chalk.dim(`  ${dir}: skipped (empty detection)`));
        continue;
      }
      const pkgConfigPath = join(workdir, ".nax", "mono", dir, "config.json");
      try {
        const status = await applyToConfig(pkgConfigPath, det.patterns, options.force ?? false);
        if (status === "skipped") {
          console.log(chalk.dim(`  ${dir}: skipped (already set)`));
        } else {
          console.log(chalk.green(`  ${dir}: ${status} → ${join(".nax", "mono", dir, "config.json")}`));
        }
      } catch (err) {
        console.error(chalk.red(`  ${dir}: write failed — ${(err as Error).message}`));
        process.exit(2);
      }
    }
  } else if (entries.some((e) => e.detected.confidence !== "empty")) {
    console.log();
    console.log(chalk.dim("Run `nax detect --apply` to write detected patterns to .nax/ configs."));
  }

  const allEmpty = entries.every((e) => e.detected.confidence === "empty");
  process.exitCode = allEmpty ? 1 : 0;
}
