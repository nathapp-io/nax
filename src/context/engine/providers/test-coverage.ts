/**
 * TestCoverageProvider — minimal stub for test imports
 * Real implementation to follow in subsequent session.
 */

import type { NaxConfig } from "../../../config/types";
import type { UserStory } from "../../../prd/types";
import type { ResolvedTestPatterns } from "../../../test-runners/resolver";
import type { TestScanOptions, TestScanResult } from "../../test-scanner";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "../types";
export const _testCoverageProviderDeps: {
  generateTestCoverageSummary: (opts: TestScanOptions) => Promise<TestScanResult>;
  resolveTestFilePatterns: (config: NaxConfig, workdir: string, packageDir?: string) => Promise<ResolvedTestPatterns>;
} = {
  generateTestCoverageSummary: async (_opts: TestScanOptions) => {
    throw new Error("Not implemented — tests should mock this via _testCoverageProviderDeps");
  },
  resolveTestFilePatterns: async (
    _config: NaxConfig,
    _workdir: string,
    _packageDir?: string,
  ): Promise<ResolvedTestPatterns> => {
    throw new Error("Not implemented — tests should mock this via _testCoverageProviderDeps");
  },
};

export class TestCoverageProvider implements IContextProvider {
  readonly id = "test-coverage" as const;
  readonly kind = "test-coverage" as const;

  constructor(
    private readonly story: UserStory,
    private readonly config: NaxConfig,
  ) {}

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const tcConfig = this.config.context?.testCoverage;
    if (!tcConfig?.enabled) {
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
      const contextFiles = (this.story as UserStory & { contextFiles?: string[] }).contextFiles ?? [];
      const scanOptions: TestScanOptions = {
        workdir: request.packageDir,
        testDir: tcConfig.testDir,
        maxTokens: tcConfig.maxTokens ?? 500,
        detail: tcConfig.detail ?? "names-and-counts",
        scopeToStory: tcConfig.scopeToStory ?? true,
        contextFiles,
        resolvedTestGlobs: resolved.globs,
      };
      const result = await _testCoverageProviderDeps.generateTestCoverageSummary(scanOptions);
      if (!result.summary) {
        return { chunks: [], pullTools: [] };
      }
      return { chunks: [], pullTools: [] };
    } catch {
      return { chunks: [], pullTools: [] };
    }
  }
}
