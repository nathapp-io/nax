import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { groupStoriesByPackage } from "../acceptance";
import { findProjectDir, loadConfig, loadPackageOverride } from "../config";
import { getSafeLogger } from "../logger";
import { loadPRD } from "../prd";
import { errorMessage } from "../utils/errors";

/**
 * One resolved acceptance test target — a single package the feature touches.
 *
 * Reproducing the runtime invocation: spawn `command` with `cwd` as the working
 * directory, substituting any `{{FILE}}` placeholder in `command` with `testPath`
 * made relative to `cwd` (both are repo-root-relative, so a plain `path.relative(cwd,
 * testPath)` suffices). Do NOT spawn from repo root with the repo-root-relative
 * `testPath` substituted verbatim — `command` is resolved per-package and is only
 * valid when run from `cwd`.
 */
export interface AcceptanceGroupResult {
  /** Package directory relative to repo root; "" for the root package. */
  packageDir: string;
  /** Canonical acceptance test path, relative to repo root (portable). */
  testPath: string;
  /** Whether the test file currently exists on disk. */
  exists: boolean;
  /** Resolved acceptance command (per-package override else root); may contain a {{FILE}} placeholder. */
  command?: string;
  /**
   * Working directory `command` must be spawned from, relative to repo root
   * (equal to `packageDir` — see the interface doc for the full reconstruction contract).
   */
  cwd: string;
  /** Per-package detected language (drives the test-file extension). */
  language?: string;
}

export type AcceptanceResolutionStatus = "ok" | "disabled" | "no-prd";

/** Result of resolving a feature's acceptance test targets. */
export interface AcceptanceResolution {
  status: AcceptanceResolutionStatus;
  /** Effective acceptance.enabled for the repo. */
  enabled: boolean;
  groups: AcceptanceGroupResult[];
}

/**
 * Resolve the acceptance test target(s) for a feature, reusing the same SSOT
 * (`groupStoriesByPackage`) that the runtime uses to place and run acceptance
 * tests. Never throws — a missing/malformed PRD or non-nax repo resolves to
 * `no-prd` so callers can branch deterministically.
 *
 * @param featureName - The .nax/features/<name> feature whose acceptance tests to resolve.
 * @param workdir - Absolute path to the project directory (never process.cwd()).
 */
export async function resolveFeatureAcceptance(featureName: string, workdir: string): Promise<AcceptanceResolution> {
  // The whole body is wrapped so this resolver NEVER throws — it is awaited
  // inline inside resolveFeatureSpec, so a throw here would break the entire
  // `nax features resolve` command (including spec resolution). Any failure
  // (invalid/legacy config, malformed PRD, grouping error) degrades to no-prd.
  // `enabled` is hoisted so the catch reports the last-known value.
  let enabled = true;
  try {
    const naxDir = findProjectDir(workdir);
    if (!naxDir) {
      return { status: "no-prd", enabled, groups: [] };
    }
    const repoRoot = join(naxDir, "..");

    const config = await loadConfig(workdir);
    enabled = config.acceptance?.enabled ?? true;
    if (!enabled) {
      return { status: "disabled", enabled: false, groups: [] };
    }

    const prdPath = join(naxDir, "features", featureName, "prd.json");
    if (!existsSync(prdPath)) {
      return { status: "no-prd", enabled, groups: [] };
    }

    const prd = await loadPRD(prdPath);
    const testGroups = await groupStoriesByPackage(
      prd,
      repoRoot,
      featureName,
      config.acceptance?.testPath,
      config.project?.language,
    );

    const groups = await Promise.all(
      testGroups.map(async (g): Promise<AcceptanceGroupResult> => {
        // relative() yields "" for the root package — resolveGroupCommand treats "" as root.
        const packageDir = relative(repoRoot, g.packageDir);
        const command = await resolveGroupCommand(repoRoot, packageDir, config.acceptance?.command);
        return {
          packageDir,
          testPath: relative(repoRoot, g.testPath),
          exists: await Bun.file(g.testPath).exists(),
          command,
          cwd: packageDir,
          language: g.language,
        };
      }),
    );

    return { status: "ok", enabled, groups };
  } catch (err) {
    // Invalid/legacy config, malformed PRD, or grouping failure. Log so a corrupt
    // config/PRD is distinguishable from a feature that genuinely has no PRD.
    getSafeLogger()?.warn("acceptance", "Failed to resolve feature acceptance targets", {
      featureName,
      cause: errorMessage(err),
    });
    return { status: "no-prd", enabled, groups: [] };
  }
}

/**
 * Resolve the acceptance command for a single package: a per-package override
 * (.nax/mono/<packageDir>/config.json) wins over the root command.
 */
async function resolveGroupCommand(
  repoRoot: string,
  packageDir: string,
  rootCommand: string | undefined,
): Promise<string | undefined> {
  if (packageDir === "") return rootCommand;
  const override = await loadPackageOverride(repoRoot, packageDir);
  return override?.acceptance?.command ?? rootCommand;
}
