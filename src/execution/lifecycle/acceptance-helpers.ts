/**
 * Acceptance Helpers
 *
 * Extracted from acceptance-loop.ts for file size compliance.
 * Contains: stub detection, test-level failure detection, test content loading,
 * result building, and test regeneration.
 */

import path from "node:path";
import { getSafeLogger } from "../../logger";
import type { PipelineContext } from "../../pipeline/types";
import type { PRD } from "../../prd/types";
import { filterNaxInternalPaths, resolveNaxIgnorePatterns } from "../../utils/path-filters";
import type { AcceptanceLoopResult } from "./acceptance-loop";

// ─── Stub detection ─────────────────────────────────────────────────────────

export function isStubTestFile(content: string): boolean {
  // Detect skeleton stubs: expect(true).toBe(false) or expect(true).toBe(true) in test bodies
  return /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*(?:false|true)\s*\)/.test(content);
}

// ─── Test-level failure detection ───────────────────────────────────────────

/**
 * Detect test-level failure (P1-D, D2).
 *
 * Returns true when the failure is likely a test bug rather than implementation gaps:
 * - All semantic verdicts passed (overrides ratio check)
 * - Test crashed with no ACs parsed ("AC-ERROR" sentinel)
 * - More than 80% of total ACs failed
 */
export function isTestLevelFailure(
  failedACs: string[] | number,
  totalACs: number,
  semanticVerdicts?: Array<{ passed: boolean }>,
): boolean {
  if (semanticVerdicts && semanticVerdicts.length > 0 && semanticVerdicts.every((v) => v.passed)) {
    return true;
  }

  const failedCount = typeof failedACs === "number" ? failedACs : failedACs.length;
  const hasACError = Array.isArray(failedACs) && failedACs.includes("AC-ERROR");

  if (hasACError) return true;
  if (totalACs === 0) return false;
  return failedCount / totalACs > 0.8;
}

// ─── Test content loading ───────────────────────────────────────────────────

/** Load spec.md content for AC text */
export async function loadSpecContent(featureDir?: string): Promise<string> {
  if (!featureDir) return "";
  const specPath = path.join(featureDir, "spec.md");
  const specFile = Bun.file(specPath);
  return (await specFile.exists()) ? await specFile.text() : "";
}

/**
 * Load acceptance test file content.
 *
 * When `testPaths` is provided, returns content for each per-package test file.
 * When `testPaths` is omitted, falls back to reading the configured single test file
 * from `featureDir`.
 */
export async function loadAcceptanceTestContent(
  featureDir?: string,
  testPaths?: Array<{ testPath: string; packageDir: string }>,
  configuredTestPath?: string,
): Promise<Array<{ content: string; path: string }>> {
  if (!featureDir) return [];

  if (testPaths && testPaths.length > 0) {
    const results: Array<{ content: string; path: string }> = [];
    for (const { testPath } of testPaths) {
      const testFile = Bun.file(testPath);
      if (await testFile.exists()) {
        const content = await testFile.text();
        results.push({ content, path: testPath });
      }
    }
    return results;
  }

  if (!configuredTestPath) return [];

  const resolvedPath = path.join(featureDir, configuredTestPath);
  const testFile = Bun.file(resolvedPath);
  const content = (await testFile.exists()) ? await testFile.text() : "";
  return [{ content, path: resolvedPath }];
}

// ─── Result builder ─────────────────────────────────────────────────────────

/** Build result object for loop exit */
export function buildResult(
  success: boolean,
  prd: PRD,
  totalCost: number,
  iterations: number,
  storiesCompleted: number,
  prdDirty: boolean,
  failedACs?: string[],
  retries?: number,
): AcceptanceLoopResult {
  return { success, prd, totalCost, iterations, storiesCompleted, prdDirty, failedACs, retries };
}

// ─── Test regeneration ──────────────────────────────────────────────────────

/** Injectable dependencies for regenerateAcceptanceTest */
export const _regenerateDeps = {
  spawnGitDiff: async (workdir: string, gitRef: string): Promise<string> => {
    const proc = Bun.spawn(["git", "diff", "--name-only", gitRef], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return stdout.trim();
  },
  readFile: async (filePath: string): Promise<string> => Bun.file(filePath).text(),
  acceptanceSetupExecute: async (ctx: PipelineContext): Promise<void> => {
    const { acceptanceSetupStage } = await import("../../pipeline/stages/acceptance-setup");
    await acceptanceSetupStage.execute(ctx);
  },
};

/**
 * Back up and regenerate the acceptance test file (P1-D, D2).
 *
 * Steps:
 * 1. Copy configured acceptance test file → <file>.bak
 * 2. Delete the original test file
 * 3. Delete acceptance-meta.json (force regeneration)
 * 4. Collect implementation context from git diff
 * 5. Run acceptance-setup stage to regenerate
 */
export async function regenerateAcceptanceTest(
  testPath: string,
  acceptanceContext: PipelineContext,
  previousFailure?: string,
): Promise<boolean> {
  const logger = getSafeLogger();
  const bakPath = `${testPath}.bak`;

  const content = await Bun.file(testPath).text();
  await Bun.write(bakPath, content);
  logger?.info("acceptance", `Backed up acceptance test -> ${bakPath}`);

  const { unlink } = await import("node:fs/promises");
  await unlink(testPath);

  // Delete acceptance-meta.json so acceptanceSetupExecute cannot reuse the
  // fingerprint of the (now-deleted) test and is forced to regenerate.
  if (acceptanceContext.featureDir) {
    const metaPath = path.join(acceptanceContext.featureDir, "acceptance-meta.json");
    try {
      await unlink(metaPath);
    } catch {
      // missing meta is fine — setup will treat it as not-yet-generated
    }
  }

  // Collect implementation context from git diff when storyGitRef is available
  let implementationContext: Array<{ path: string; content: string }> | undefined;
  const storyGitRef = acceptanceContext.storyGitRef;
  const workdir = acceptanceContext.workdir;

  if (storyGitRef) {
    try {
      const diffOutput = await _regenerateDeps.spawnGitDiff(workdir, storyGitRef);
      const changedFilesRaw = diffOutput
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      const repoRoot = acceptanceContext.projectDir ?? workdir;
      const packageDir =
        acceptanceContext.story.workdir && acceptanceContext.projectDir
          ? path.join(acceptanceContext.projectDir, acceptanceContext.story.workdir)
          : undefined;
      const ignoreMatchers =
        acceptanceContext.naxIgnoreIndex?.getMatchers(packageDir) ??
        (await resolveNaxIgnorePatterns(repoRoot, packageDir));
      const changedFiles = filterNaxInternalPaths(changedFilesRaw, ignoreMatchers);

      const MAX_BYTES = 50 * 1024;
      let totalBytes = 0;
      const entries: Array<{ path: string; content: string }> = [];

      for (const file of changedFiles) {
        if (totalBytes >= MAX_BYTES) break;
        const filePath = path.join(workdir, file);
        try {
          const fileContent = await _regenerateDeps.readFile(filePath);
          const remaining = MAX_BYTES - totalBytes;
          const trimmed = fileContent.length > remaining ? fileContent.slice(0, remaining) : fileContent;
          entries.push({ path: file, content: trimmed });
          totalBytes += trimmed.length;
        } catch {
          // skip unreadable files
        }
      }

      if (entries.length > 0) {
        implementationContext = entries;
      }
    } catch {
      // git diff failed — proceed without implementation context
    }
  }

  const contextForSetup: PipelineContext & {
    implementationContext?: Array<{ path: string; content: string }>;
    previousFailure?: string;
  } = {
    ...acceptanceContext,
    ...(implementationContext ? { implementationContext } : {}),
    ...(previousFailure ? { previousFailure } : {}),
  };

  await _regenerateDeps.acceptanceSetupExecute(contextForSetup as PipelineContext);

  if (!(await Bun.file(testPath).exists())) {
    logger?.error("acceptance", "Acceptance test regeneration failed — manual intervention required");
    return false;
  }

  logger?.info("acceptance", "Acceptance test regenerated successfully");
  return true;
}
