/**
 * Acceptance Helpers
 *
 * Extracted from acceptance-loop.ts for file size compliance.
 * Contains: fix-target resolution, stub detection, test-level failure detection,
 * test content loading, result building, and test regeneration.
 */

import path from "node:path";
import { isStubTestContent, substituteAcceptanceTestPath } from "@/acceptance";
import type { NaxConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD } from "@/prd/types";
import { filterNaxInternalPaths, resolveNaxIgnorePatterns } from "@/utils/path-filters";
import type { AcceptanceLoopResult, AcceptanceTestPathEntry } from "./acceptance-loop";

// ─── Fix-target resolution ───────────────────────────────────────────────────

/**
 * Resolve which acceptance test a fix cycle targets and the runnable command to
 * re-run it. `config.quality.commands.test` is the FULL suite (`bun run test` in
 * this repo) — handing a fix role the whole suite instead of the one failing
 * acceptance test burns the session timeout and violates the never-run-the-bare-
 * full-suite rule (#1939). `testScoped` — already the SSOT for "one file, not the
 * suite" in src/test-runners/scoped-selection.ts — is tried first, and only when
 * a real `acceptanceTestPath` exists to plug into its `{{files}}` placeholder;
 * with neither a commandOverride nor a scoped template, the full suite is the
 * last resort. Every candidate but that last resort supports {{files}}/{{file}}/
 * {{FILE}}, substituted here so the returned command is runnable as-is — never a
 * template a caller must remember to resolve itself.
 */
export function resolveAcceptanceFixTarget(
  acceptanceTestPaths: AcceptanceTestPathEntry[] | undefined,
  failedPackage: { testPath: string; packageDir: string; commandOverride?: string } | undefined,
  config: NaxConfig,
): {
  acceptanceTestPath: string;
  testCommand: string | undefined;
  scopedCommandName: string | undefined;
} {
  const matchedEntry = failedPackage
    ? acceptanceTestPaths?.find(
        (entry) => entry.testPath === failedPackage.testPath || entry.packageDir === failedPackage.packageDir,
      )
    : undefined;
  const selectedPathEntry = matchedEntry ?? acceptanceTestPaths?.[0];
  // `||`, not `??`: a synthetic failed-package carries `testPath: ""`, and an
  // empty path is absent for every purpose here — it would otherwise skip the
  // scoped candidate and render an empty path into the prompt.
  const acceptanceTestPath = failedPackage?.testPath || selectedPathEntry?.testPath || "";

  const substituted = (candidate: string | undefined): string | undefined =>
    candidate && acceptanceTestPath ? substituteAcceptanceTestPath(candidate, acceptanceTestPath) : candidate;
  // A scoped template can carry `{{package}}` as well, which only
  // resolveQualityTestCommands can fill — it reads package.json asynchronously
  // (src/quality/command-resolver.ts) and this resolver is synchronous. A
  // candidate still holding any placeholder after substitution is therefore not
  // runnable, so it is dropped rather than rendered into a prompt as a template.
  // For a turbo/nx orchestrator that is also the right answer: its scoped form
  // is deliberately never file-expanded, so falling through to the suite
  // command beats handing over syntax the runner would reject.
  const runnable = (candidate: string | undefined): string | undefined =>
    candidate !== undefined && !candidate.includes("{{") ? candidate : undefined;

  const scopedTemplate = acceptanceTestPath ? config.quality?.commands?.testScoped : undefined;
  const scopedCommand = runnable(substituted(scopedTemplate));
  const overrideCommand =
    runnable(substituted(failedPackage?.commandOverride)) ??
    runnable(substituted(matchedEntry?.commandOverride)) ??
    runnable(substituted(config.acceptance.command));

  return {
    acceptanceTestPath,
    // The last resort is substituted too: `quality.commands.test` may itself
    // carry a placeholder, and the invariant above admits no exceptions. It is
    // NOT passed through `runnable()` — a residual placeholder there leaves
    // nothing else to fall back to, so a template beats returning undefined.
    testCommand: overrideCommand ?? scopedCommand ?? substituted(config.quality?.commands?.test),
    // Named for the prompt ONLY when the scoped template is the candidate that
    // actually won and `{{files}}` is its sole placeholder. RunCommand resolves
    // a declared key by exact placeholder match, so naming `testScoped` when a
    // `{{package}}` template was dropped, or when the template takes `{{file}}`
    // or no placeholder at all, hands the agent a tool call that can only
    // answer `placeholder {{package}} has no value` or `value "files" is not a
    // placeholder in this command`.
    scopedCommandName:
      overrideCommand === undefined && scopedCommand !== undefined && scopedTemplate?.includes("{{files}}") === true
        ? "testScoped"
        : undefined,
  };
}

// ─── Stub detection ─────────────────────────────────────────────────────────

/** @alias isStubTestContent — preserved for callers within this subsystem. */
export function isStubTestFile(content: string): boolean {
  return isStubTestContent(content);
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
  skippedPackages?: string[],
): AcceptanceLoopResult {
  return { success, prd, totalCost, iterations, storiesCompleted, prdDirty, failedACs, retries, skippedPackages };
}

/** Failure shortcut — keeps the bare-fail call site on one line. */
export function buildFailureResult(
  prd: PRD,
  totalCost: number,
  iterations: number,
  storiesCompleted: number,
  failedACs: string[] | undefined,
  retries: number | undefined,
  skippedPackages: string[] | undefined,
): AcceptanceLoopResult {
  return {
    success: false,
    prd,
    totalCost,
    iterations,
    storiesCompleted,
    prdDirty: false,
    failedACs,
    retries,
    skippedPackages,
  };
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
    const { acceptanceSetupStage } = await import("@/pipeline/stages");
    await acceptanceSetupStage.execute(ctx);
  },
  getLogger: () => getSafeLogger(),
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
 * 6. Check for stub content and report failure if regenerated content is a stub
 */
export async function regenerateAcceptanceTest(testPath: string, acceptanceContext: PipelineContext): Promise<boolean> {
  const logger = _regenerateDeps.getLogger();
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
  } = {
    ...acceptanceContext,
    ...(implementationContext ? { implementationContext } : {}),
  };

  await _regenerateDeps.acceptanceSetupExecute(contextForSetup as PipelineContext);

  // Check if the file exists after regeneration
  if (!(await Bun.file(testPath).exists())) {
    logger?.error("acceptance", "Acceptance test regeneration failed — file not created");
    return false;
  }

  // Check if the regenerated content is a stub (US-003)
  const regeneratedContent = await _regenerateDeps.readFile(testPath);
  if (isStubTestFile(regeneratedContent)) {
    logger?.error(
      "acceptance",
      "Acceptance test regeneration produced stub content — regenerator unable to generate real tests",
    );
    return false;
  }

  logger?.info("acceptance", "Acceptance test regenerated successfully");
  return true;
}
