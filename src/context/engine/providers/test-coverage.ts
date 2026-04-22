/**
 * TestCoverageProvider — context engine provider wrapping test-scanner.ts
 *
 * Constructed per-request with story and config bound (same pattern as FeatureContextProviderV2).
 * Reads config.context.testCoverage, short-circuits when disabled or packageDir is empty,
 * resolves test-file globs, scans via generateTestCoverageSummary(), and emits a RawChunk
 * with id prefix 'test-coverage:<hash8>' on non-empty summary.
 */

import { createHash } from "node:crypto";
import type { NaxConfig } from "../../../config/types";
import { getLogger } from "../../../logger";
import { getContextFiles } from "../../../prd";
import type { UserStory } from "../../../prd/types";
import { resolveTestFilePatterns } from "../../../test-runners/resolver";
import type { ResolvedTestPatterns } from "../../../test-runners/resolver";
import { errorMessage } from "../../../utils/errors";
import { generateTestCoverageSummary } from "../../test-scanner";
import type { TestScanOptions, TestScanResult } from "../../test-scanner";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _testCoverageProviderDeps: {
  generateTestCoverageSummary: (opts: TestScanOptions) => Promise<TestScanResult>;
  resolveTestFilePatterns: (config: NaxConfig, workdir: string, packageDir?: string) => Promise<ResolvedTestPatterns>;
  getLogger: () => ReturnType<typeof getLogger>;
  getContextFiles: (story: UserStory) => string[];
} = {
  generateTestCoverageSummary,
  resolveTestFilePatterns,
  getLogger: () => getLogger(),
  getContextFiles,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class TestCoverageProvider implements IContextProvider {
  readonly id = "test-coverage" as const;
  readonly kind = "test-coverage" as const;

  constructor(
    private readonly story: UserStory,
    private readonly config: NaxConfig,
  ) {}

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const tcConfig = this.config.context?.testCoverage;
    if (tcConfig?.enabled === false) {
      return { chunks: [], pullTools: [] };
    }
    if (!request.packageDir) {
      return { chunks: [], pullTools: [] };
    }

    try {
      const resolved = await _testCoverageProviderDeps.resolveTestFilePatterns(
        this.config,
        request.repoRoot,
        request.packageDir,
      );

      const contextFiles = _testCoverageProviderDeps.getContextFiles(this.story);

      const globs =
        (resolved as { globs?: readonly string[]; patterns?: readonly string[] }).patterns ?? resolved.globs;

      const scanOptions: TestScanOptions = {
        workdir: request.packageDir,
        testDir: tcConfig.testDir,
        maxTokens: tcConfig.maxTokens ?? 500,
        detail: tcConfig.detail ?? "names-and-counts",
        scopeToStory: tcConfig.scopeToStory ?? true,
        contextFiles,
        resolvedTestGlobs: globs,
      };

      const result = await _testCoverageProviderDeps.generateTestCoverageSummary(scanOptions);

      if (!result.summary) {
        return { chunks: [], pullTools: [] };
      }

      const hash = contentHash8(result.summary);
      const chunk: RawChunk = {
        id: `test-coverage:${hash}`,
        kind: "test-coverage",
        scope: "story",
        role: ["implementer", "tdd"],
        content: result.summary,
        tokens: result.tokens,
        rawScore: 0.85,
      };

      return { chunks: [chunk], pullTools: [] };
    } catch (err) {
      const logger = _testCoverageProviderDeps.getLogger();
      logger.warn("test-coverage", "Scanner failed — returning empty chunks", {
        storyId: this.story.id,
        packageDir: request.packageDir,
        error: errorMessage(err),
      });
      return { chunks: [], pullTools: [] };
    }
  }
}
