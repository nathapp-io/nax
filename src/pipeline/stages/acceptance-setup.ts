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
import { acceptanceTestFilename, buildAcceptanceRunCommand } from "../../acceptance/generator";
import type { RefinedCriterion } from "../../acceptance/types";
import { getAgent } from "../../agents/registry";
import { resolveModel } from "../../config";
import { getSafeLogger } from "../../logger";
import type { UserStory } from "../../prd/types";
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
  getAgent,
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
    await unlink(filePath);
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
    return refineAcceptanceCriteria(_criteria, _context);
  },
  generate: async (
    _stories: UserStory[],
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

    const language = (ctx.effectiveConfig ?? ctx.config).project?.language;
    const metaPath = path.join(ctx.featureDir, "acceptance-meta.json");

    // All criteria from original stories only — fix stories (US-FIX-*) are excluded
    // so that the fingerprint remains stable when fix stories are added during the
    // acceptance loop. This prevents unnecessary test regeneration on re-runs.
    const allCriteria: string[] = ctx.prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria);

    // US-001: Group non-fix stories by story.workdir.
    // Each group gets its own test file at <package-root>/.nax-acceptance.test.ts.
    const nonFixStories = ctx.prd.userStories.filter((s) => !s.id.startsWith("US-FIX-"));
    const workdirGroups = new Map<string, { stories: UserStory[]; criteria: string[] }>();

    for (const story of nonFixStories) {
      const wd = story.workdir ?? "";
      if (!workdirGroups.has(wd)) {
        workdirGroups.set(wd, { stories: [], criteria: [] });
      }
      const group = workdirGroups.get(wd);
      if (group) {
        group.stories.push(story);
        group.criteria.push(...story.acceptanceCriteria);
      }
    }

    // Fallback: always have at least the root group so RED gate runs
    if (workdirGroups.size === 0) {
      workdirGroups.set("", { stories: [], criteria: [] });
    }

    // Build test paths for each workdir group
    const testPaths: Array<{ testPath: string; packageDir: string }> = [];
    for (const [workdir] of workdirGroups) {
      const packageDir = workdir ? path.join(ctx.workdir, workdir) : ctx.workdir;
      const testPath = path.join(packageDir, acceptanceTestFilename(language));
      testPaths.push({ testPath, packageDir });
    }

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
      for (const { testPath } of testPaths) {
        if (await _acceptanceSetupDeps.fileExists(testPath)) {
          await _acceptanceSetupDeps.copyFile(testPath, `${testPath}.bak`);
          await _acceptanceSetupDeps.deleteFile(testPath);
        }
      }
      shouldGenerate = true;
    } else {
      // Fingerprint matches — reuse existing tests. If the file is missing (e.g.,
      // overwritten by TDD cycle then deleted in a crash), the existing tests are
      // still valid: skip generation and let the RED gate decide whether to run.
      getSafeLogger()?.info("acceptance-setup", "Reusing existing acceptance tests (fingerprint match)");
    }

    if (shouldGenerate) {
      totalCriteria = allCriteria.length;

      const { getAgent } = await import("../../agents");
      const agent = (ctx.agentGetFn ?? _acceptanceSetupDeps.getAgent)(ctx.config.autoMode.defaultAgent);

      // Refine criteria per-story (preserves storyId association for per-group filtering)
      let allRefinedCriteria: RefinedCriterion[];

      if (ctx.config.acceptance.refinement) {
        allRefinedCriteria = [];
        for (const story of nonFixStories) {
          const storyRefined = await _acceptanceSetupDeps.refine(story.acceptanceCriteria, {
            storyId: story.id,
            featureName: ctx.prd.feature,
            workdir: ctx.workdir,
            codebaseContext: "",
            config: ctx.config,
            testStrategy: ctx.config.acceptance.testStrategy,
            testFramework: ctx.config.acceptance.testFramework,
          });
          allRefinedCriteria = allRefinedCriteria.concat(storyRefined);
        }
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
      for (const [workdir, group] of workdirGroups) {
        const packageDir = workdir ? path.join(ctx.workdir, workdir) : ctx.workdir;
        const testPath = path.join(packageDir, acceptanceTestFilename(language));

        // Filter refined criteria to this group's stories
        const groupStoryIds = new Set(group.stories.map((s) => s.id));
        const groupRefined = allRefinedCriteria.filter((r) => groupStoryIds.has(r.storyId));

        const result = await _acceptanceSetupDeps.generate(group.stories, groupRefined, {
          featureName: ctx.prd.feature,
          workdir: packageDir,
          featureDir: ctx.featureDir,
          codebaseContext: "",
          modelTier: ctx.config.acceptance.model ?? "fast",
          modelDef: resolveModel(ctx.config.models[ctx.config.acceptance.model ?? "fast"]),
          config: ctx.config,
          testStrategy: ctx.config.acceptance.testStrategy,
          testFramework: ctx.config.acceptance.testFramework,
          adapter: agent ?? undefined,
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
    }

    // Store per-package test paths in context for the acceptance runner (US-002)
    ctx.acceptanceTestPaths = testPaths;

    if (ctx.config.acceptance.redGate === false) {
      ctx.acceptanceSetup = { totalCriteria, testableCount, redFailCount: 0 };
      return { action: "continue" };
    }

    // BUG-084: Use testFramework-aware single-file command (not quality.commands.test which runs full suite)
    // Run RED gate for each per-package test file from its package directory
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;
    let redFailCount = 0;
    for (const { testPath, packageDir } of testPaths) {
      const runCmd = buildAcceptanceRunCommand(
        testPath,
        effectiveConfig.project?.testFramework,
        effectiveConfig.acceptance.command,
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
