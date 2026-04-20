/**
 * Acceptance Setup Stage
 *
 * Pre-run pipeline stage that generates acceptance tests from PRD criteria
 * and validates them with a RED gate before story execution begins.
 *
 * RED gate behavior:
 * - exit != 0 (tests fail) → valid RED, continue
 * - exit == 0 (all tests pass) → tests are not testing new behavior, warn and skip
 *
 * Stores results in ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount }.
 *
 * P2-A/P2-B: When a test file already exists, checks a SHA-256 fingerprint of the
 * sorted AC strings against acceptance-meta.json. Regenerates (with .bak backup)
 * when the fingerprint has changed or meta is missing.
 *
 * US-001 (ACC-002): Groups stories by story.workdir and generates one acceptance
 * test file per package at <package-root>/.nax-acceptance.test.ts. Stories with no
 * workdir are grouped at the repo root. This fixes module-resolution failures in
 * monorepos where transitive deps live in package-local node_modules/.
 */

import path from "node:path";
import { buildAcceptanceRunCommand } from "../../acceptance/generator";
import { groupStoriesByPackage } from "../../acceptance/test-path";
import type { RefinedCriterion } from "../../acceptance/types";
import type { AgentAdapter } from "../../agents/types";
import { type ModelDef, type ResolvedConfiguredModel, resolveConfiguredModel } from "../../config";
import { getSafeLogger } from "../../logger";
import { autoCommitIfDirty as _autoCommitIfDirty } from "../../utils/git";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Metadata stored alongside the acceptance test file.
 * Used for fingerprint-based staleness detection (P2-B).
 */
export interface AcceptanceMeta {
  /** ISO timestamp when acceptance test was generated */
  generatedAt: string;
  /** SHA-256 fingerprint of sorted, joined AC strings */
  acFingerprint: string;
  /** Number of stories at generation time */
  storyCount: number;
  /** Total AC count at generation time */
  acCount: number;
  /** Generator identifier */
  generator: string;
}

/**
 * Compute SHA-256 fingerprint of the sorted acceptance criteria strings (P2-A).
 *
 * Criteria are sorted before hashing so order changes don't trigger regeneration.
 *
 * @param criteria - All AC strings from the PRD
 * @returns Fingerprint string in the form "sha256:<hex>"
 */
export function computeACFingerprint(criteria: string[]): string {
  const sorted = [...criteria].sort().join("\n");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sorted);
  return `sha256:${hasher.digest("hex")}`;
}

/**
 * Injectable dependencies for acceptance-setup stage.
 * Allows tests to mock bun test execution, file I/O, and LLM calls.
 * @internal
 */
export const _acceptanceSetupDeps = {
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  fileExists: async (_path: string): Promise<boolean> => {
    const f = Bun.file(_path);
    return f.exists();
  },
  writeFile: async (filePath: string, content: string): Promise<void> => {
    await Bun.write(filePath, content);
  },
  copyFile: async (src: string, dest: string): Promise<void> => {
    const content = await Bun.file(src).text();
    await Bun.write(dest, content);
  },
  deleteFile: async (filePath: string): Promise<void> => {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  },
  deleteSemanticVerdicts: async (featureDir: string): Promise<void> => {
    const dir = `${featureDir}/semantic-verdicts`;
    const { readdir, unlink } = await import("node:fs/promises");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const file of files) {
      await unlink(`${dir}/${file}`);
    }
  },
  readMeta: async (metaPath: string): Promise<AcceptanceMeta | null> => {
    const f = Bun.file(metaPath);
    if (!(await f.exists())) return null;
    try {
      return JSON.parse(await f.text()) as AcceptanceMeta;
    } catch {
      return null;
    }
  },
  writeMeta: async (metaPath: string, meta: AcceptanceMeta): Promise<void> => {
    await Bun.write(metaPath, JSON.stringify(meta, null, 2));
  },
  autoCommitIfDirty: _autoCommitIfDirty,
  runTest: async (
    _testPath: string,
    _workdir: string,
    _cmd: string[],
  ): Promise<{ exitCode: number; output: string }> => {
    const cmd = _cmd;
    const proc = Bun.spawn(cmd, {
      cwd: _workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  },
  refine: async (
    _criteria: string[],
    _context: import("../../acceptance/types").RefinementContext,
  ): Promise<RefinedCriterion[]> => {
    const { refineAcceptanceCriteria } = await import("../../acceptance/refinement");
    return (await refineAcceptanceCriteria(_criteria, _context)).criteria;
  },
  generate: async (
    _stories: import("../../prd/types").UserStory[],
    _refined: RefinedCriterion[],
    _options: import("../../acceptance/types").GenerateFromPRDOptions,
  ): Promise<import("../../acceptance/types").AcceptanceTestResult> => {
    const { generateFromPRD } = await import("../../acceptance/generator");
    return generateFromPRD(_stories, _refined, _options);
  },
};

export const acceptanceSetupStage: PipelineStage = {
  name: "acceptance-setup",

  enabled(ctx: PipelineContext): boolean {
    return ctx.config.acceptance.enabled && !!ctx.featureDir;
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    if (!ctx.featureDir) {
      return { action: "fail", reason: "[acceptance-setup] featureDir is not set" };
    }

    const language = ctx.config.project?.language;
    const testPathConfig = ctx.config.acceptance.testPath;
    const metaPath = path.join(ctx.featureDir, "acceptance-meta.json");

    // All criteria from original stories only — fix stories (US-FIX-*) and decomposed
    // parent stories are excluded. Fix stories are excluded so the fingerprint stays
    // stable when fix stories are added during the acceptance loop. Decomposed stories
    // are excluded because their ACs are fully covered by their children, and including
    // them would inflate the fingerprint with duplicate criteria.
    const allCriteria: string[] = ctx.prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-") && s.status !== "decomposed")
      .flatMap((s) => s.acceptanceCriteria);

    // US-001: Group non-fix, non-decomposed stories by story.workdir — one test file per package.
    // groupStoriesByPackage handles workdir grouping, path computation, and root fallback.
    const featureName = ctx.prd.feature ?? (ctx.prd as unknown as Record<string, string>).featureName;
    const groups = groupStoriesByPackage(ctx.prd, ctx.workdir, featureName, testPathConfig, language);
    const nonFixStories = groups.flatMap((g) => g.stories);

    let totalCriteria = 0;
    let testableCount = 0;

    // P2-A: Staleness detection — regenerate if fingerprint changed or meta missing.
    // Fingerprint is the source of truth for AC stability; file existence is secondary.
    // If fingerprint matches the stored meta, reuse existing tests even if the file
    // was lost (e.g., after a crash). If fingerprint mismatches, regenerate with .bak backup.
    const fingerprint = computeACFingerprint(allCriteria);
    const meta = await _acceptanceSetupDeps.readMeta(metaPath);
    getSafeLogger()?.debug("acceptance-setup", "Fingerprint check", {
      currentFingerprint: fingerprint,
      storedFingerprint: meta?.acFingerprint ?? "none",
      match: meta?.acFingerprint === fingerprint,
    });

    let shouldGenerate = false;
    if (!meta || meta.acFingerprint !== fingerprint) {
      if (!meta) {
        getSafeLogger()?.info("acceptance-setup", "No acceptance meta — generating acceptance tests");
      } else {
        getSafeLogger()?.info("acceptance-setup", "ACs changed — regenerating acceptance tests", {
          reason: "fingerprint mismatch",
          currentFingerprint: fingerprint,
          storedFingerprint: meta.acFingerprint,
        });
      }
      // Back up and delete all existing per-package test files
      for (const { testPath } of groups) {
        if (await _acceptanceSetupDeps.fileExists(testPath)) {
          await _acceptanceSetupDeps.copyFile(testPath, `${testPath}.bak`);
          await _acceptanceSetupDeps.deleteFile(testPath);
        }
      }
      // Clear semantic verdicts so stale results don't influence the acceptance loop
      await _acceptanceSetupDeps.deleteSemanticVerdicts(ctx.featureDir);
      shouldGenerate = true;
    } else {
      // Fingerprint matches — reuse existing tests. If the file is missing (e.g.,
      // overwritten by TDD cycle then deleted in a crash), the existing tests are
      // still valid: skip generation and let the RED gate decide whether to run.
      getSafeLogger()?.info("acceptance-setup", "Reusing existing acceptance tests (fingerprint match)");
    }

    if (shouldGenerate) {
      totalCriteria = allCriteria.length;

      const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
      let resolvedAcceptanceModel: ResolvedConfiguredModel | undefined;
      try {
        resolvedAcceptanceModel = resolveConfiguredModel(
          ctx.rootConfig.models,
          ctx.routing.agent ?? defaultAgent,
          ctx.config.acceptance.model ?? "fast",
          defaultAgent,
        );
      } catch {
        resolvedAcceptanceModel = undefined;
      }
      const agentName = resolvedAcceptanceModel?.agent ?? defaultAgent;
      const agent = (ctx.agentGetFn ?? _acceptanceSetupDeps.getAgent)(agentName);

      // Refine criteria per-story (preserves storyId association for per-group filtering)
      let allRefinedCriteria: RefinedCriterion[];

      if (ctx.config.acceptance.refinement) {
        const maxConcurrency = ctx.config.acceptance.refinementConcurrency ?? 3;
        const results: RefinedCriterion[][] = new Array(nonFixStories.length);
        const executing = new Set<Promise<void>>();

        for (let i = 0; i < nonFixStories.length; i++) {
          const story = nonFixStories[i];
          const task = _acceptanceSetupDeps
            .refine(story.acceptanceCriteria, {
              storyId: story.id,
              featureName: ctx.prd.feature,
              workdir: ctx.workdir,
              codebaseContext: "",
              config: ctx.config,
              testStrategy: ctx.config.acceptance.testStrategy,
              testFramework: ctx.config.acceptance.testFramework,
            })
            .then((refined) => {
              results[i] = refined;
            })
            .finally(() => {
              executing.delete(task);
            });
          executing.add(task);

          if (executing.size >= maxConcurrency) {
            await Promise.race(executing);
          }
        }

        await Promise.all(executing);
        allRefinedCriteria = results.flat();
      } else {
        allRefinedCriteria = nonFixStories.flatMap((story) =>
          story.acceptanceCriteria.map((c) => ({
            original: c,
            refined: c,
            testable: true,
            storyId: story.id,
          })),
        );
      }

      testableCount = allRefinedCriteria.filter((r) => r.testable).length;

      // Generate one acceptance test file per workdir group
      for (const group of groups) {
        const { testPath, packageDir } = group;

        // Filter refined criteria to this group's stories
        const groupStoryIds = new Set(group.stories.map((s) => s.id));
        const groupRefined = allRefinedCriteria.filter((r) => groupStoryIds.has(r.storyId));

        let modelDef: ModelDef;
        if (resolvedAcceptanceModel) {
          modelDef = resolvedAcceptanceModel.modelDef;
        } else {
          const selection = ctx.config.acceptance.model ?? "fast";
          modelDef = {
            provider: "unknown",
            model: typeof selection === "string" ? selection : selection.model,
          } as ModelDef;
        }

        const result = await _acceptanceSetupDeps.generate(group.stories, groupRefined, {
          featureName: ctx.prd.feature,
          workdir: packageDir,
          featureDir: ctx.featureDir,
          codebaseContext: "",
          modelTier: resolvedAcceptanceModel?.modelTier ?? "fast",
          modelDef,
          config: ctx.config,
          testStrategy: ctx.config.acceptance.testStrategy,
          testFramework: ctx.config.acceptance.testFramework,
          adapter: agent ?? undefined,
          ...("implementationContext" in ctx && ctx.implementationContext
            ? { implementationContext: ctx.implementationContext as Array<{ path: string; content: string }> }
            : {}),
          ...("previousFailure" in ctx && ctx.previousFailure
            ? { previousFailure: ctx.previousFailure as string }
            : {}),
        });

        await _acceptanceSetupDeps.writeFile(testPath, result.testCode);
      }

      // P2-B: Store acceptance metadata (centralized in featureDir)
      const fingerprint = computeACFingerprint(allCriteria);
      await _acceptanceSetupDeps.writeMeta(metaPath, {
        generatedAt: new Date().toISOString(),
        acFingerprint: fingerprint,
        storyCount: ctx.prd.userStories.length,
        acCount: totalCriteria,
        generator: "nax",
      });

      // Commit the generated acceptance test file(s) and meta before any story's
      // storyGitRef is captured. Without this commit, the acceptance test file lands
      // in the working tree as untracked, the implementer agent may stage it with
      // "git add .", and it then appears in git diff storyGitRef..HEAD — causing the
      // adversarial reviewer to flag future-story ACs as abandonment findings.
      await _acceptanceSetupDeps.autoCommitIfDirty(
        ctx.workdir,
        "acceptance-setup",
        "pre-run",
        ctx.prd.feature ?? "feature",
      );
    }

    // Store per-package test paths in context for the acceptance runner (US-002)
    ctx.acceptanceTestPaths = groups.map((g) => ({ testPath: g.testPath, packageDir: g.packageDir }));

    if (ctx.config.acceptance.redGate === false) {
      ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount: 0 };
      return { action: "continue" };
    }

    // BUG-084: Use testFramework-aware single-file command (not quality.commands.test which runs full suite)
    // Run RED gate for each per-package test file from its package directory
    let redFailCount = 0;
    for (const { testPath, packageDir } of groups) {
      const runCmd = buildAcceptanceRunCommand(
        testPath,
        ctx.config.project?.testFramework,
        ctx.config.acceptance.command,
      );
      getSafeLogger()?.info("acceptance-setup", "Running acceptance RED gate command", {
        cmd: runCmd.join(" "),
        packageDir,
      });
      const { exitCode } = await _acceptanceSetupDeps.runTest(testPath, packageDir, runCmd);
      if (exitCode !== 0) {
        redFailCount++;
      }
    }

    // All tests passing means they are not testing new behavior — skip acceptance gate
    if (redFailCount === 0) {
      ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount: 0 };
      return {
        action: "skip",
        reason:
          "[acceptance-setup] Acceptance tests already pass — they are not testing new behavior. Skipping acceptance gate.",
      };
    }

    ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount };
    return { action: "continue" };
  },
};
