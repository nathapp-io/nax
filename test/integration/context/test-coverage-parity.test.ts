/**
 * test-coverage-parity.test.ts — AC-10 parity gate
 *
 * Integration test proving v1↔v2 byte-equality parity for test coverage summaries.
 *
 * v1 path: addTestCoverageElement in src/context/builder.ts (ContextElement)
 * v2 path: TestCoverageProvider.fetch in src/context/engine/providers/test-coverage.ts (RawChunk)
 *
 * Both paths call generateTestCoverageSummary() with equivalent options.
 * This test asserts chunk.content === v1-element.content (byte-for-byte).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "../../helpers/temp";
import { makeNaxConfig, makeStory } from "../../helpers";
import { generateTestCoverageSummary } from "../../../src/context/test-scanner";
import { TestCoverageProvider, _testCoverageProviderDeps } from "../../../src/context/engine/providers/test-coverage";

const STORY = makeStory({ id: "story-001", title: "Test Story" });
const BASE_CONFIG = makeNaxConfig({
  context: {
    testCoverage: {
      enabled: true,
      maxTokens: 500,
      detail: "names-and-counts",
      scopeToStory: true,
    },
  },
});

function makeRequest(packageDir: string) {
  return {
    storyId: "story-001",
    repoRoot: packageDir,
    packageDir,
    stage: "execution",
    role: "implementer" as const,
    budgetTokens: 8_000,
  };
}

async function writeTestFile(dir: string, filename: string, content: string): Promise<void> {
  Bun.spawnSync(["mkdir", "-p", join(dir, "test")]);
  await Bun.write(join(dir, "test", filename), content);
}



describe("test-coverage-parity", () => {
  let origDeps: typeof _testCoverageProviderDeps;

  beforeEach(() => {
    origDeps = { ..._testCoverageProviderDeps };
  });

  afterEach(() => {
    Object.assign(_testCoverageProviderDeps, origDeps);
  });

  describe("default detail 'names-and-counts'", () => {
    test("v1 and v2 emit byte-equal content", async () => {
      await withTempDir(async (dir) => {
        await writeTestFile(dir,"foo.test.ts", [
          'describe("foo suite", () => {',
          '  test("foo test 1", () => {});',
          '  test("foo test 2", () => {});',
          '});',
        ].join("\n"));

        _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
          ({ globs: ["**/*.test.ts"], patterns: ["**/*.test.ts"], testDirs: ["test"], pathspec: [], regex: [], resolution: "fallback" as const } as any);

        _testCoverageProviderDeps.generateTestCoverageSummary = generateTestCoverageSummary as any;
        _testCoverageProviderDeps.getContextFiles = () => [];

        const v2Provider = new TestCoverageProvider(STORY, BASE_CONFIG);
        const v2Result = await v2Provider.fetch(makeRequest(dir));

        const v1Result = await generateTestCoverageSummary({
          workdir: dir,
          detail: "names-and-counts",
          scopeToStory: true,
          contextFiles: [],
        });

        expect(v2Result.chunks).toHaveLength(1);
        expect(v2Result.chunks[0].content).toBe(v1Result.summary);
      });
    });
  });

  describe("scopeToStory=true with contextFiles filtering", () => {
    test("v1 and v2 emit byte-equal content filtered to matching test files", async () => {
      await withTempDir(async (dir) => {
        await writeTestFile(dir,"foo.test.ts", [
          'describe("foo suite", () => {',
          '  test("foo test", () => {});',
          '});',
        ].join("\n"));
        await writeTestFile(dir,"bar.test.ts", [
          'describe("bar suite", () => {',
          '  test("bar test", () => {});',
          '});',
        ].join("\n"));

        _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
          ({ globs: ["**/*.test.ts"], patterns: ["**/*.test.ts"], testDirs: ["test"], pathspec: [], regex: [], resolution: "fallback" as const } as any);

        _testCoverageProviderDeps.generateTestCoverageSummary = generateTestCoverageSummary as any;
        _testCoverageProviderDeps.getContextFiles = () => ["src/foo.ts"];

        const storyWithContextFiles = makeStory({ id: "story-001", contextFiles: ["src/foo.ts"] });

        const cfgWithScope = makeNaxConfig({
          context: { testCoverage: { enabled: true, maxTokens: 500, detail: "names-and-counts", scopeToStory: true } },
        });

        const v2Provider = new TestCoverageProvider(storyWithContextFiles, cfgWithScope);
        const v2Result = await v2Provider.fetch(makeRequest(dir));

        const v1Result = await generateTestCoverageSummary({
          workdir: dir,
          detail: "names-and-counts",
          scopeToStory: true,
          contextFiles: ["src/foo.ts"],
        });

        expect(v2Result.chunks).toHaveLength(1);
        expect(v2Result.chunks[0].content).toBe(v1Result.summary);
        expect(v1Result.summary).toContain("foo.test.ts");
        expect(v1Result.summary).not.toContain("bar.test.ts");
      });
    });
  });

  describe("scopeToStory=false full scan", () => {
    test("v1 and v2 emit byte-equal content scanning all test files", async () => {
      await withTempDir(async (dir) => {
        await writeTestFile(dir,"alpha.test.ts", [
          'describe("alpha suite", () => {',
          '  test("alpha test 1", () => {});',
          '  test("alpha test 2", () => {});',
          '});',
        ].join("\n"));
        await writeTestFile(dir,"beta.test.ts", [
          'describe("beta suite", () => {',
          '  test("beta test", () => {});',
          '});',
        ].join("\n"));

        _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
          ({ globs: ["**/*.test.ts"], patterns: ["**/*.test.ts"], testDirs: ["test"], pathspec: [], regex: [], resolution: "fallback" as const } as any);

        _testCoverageProviderDeps.generateTestCoverageSummary = generateTestCoverageSummary as any;
        _testCoverageProviderDeps.getContextFiles = () => [];

        const cfgNoScope = makeNaxConfig({
          context: { testCoverage: { enabled: true, maxTokens: 500, detail: "names-and-counts", scopeToStory: false } },
        });

        const v2Provider = new TestCoverageProvider(STORY, cfgNoScope);
        const v2Result = await v2Provider.fetch(makeRequest(dir));

        const v1Result = await generateTestCoverageSummary({
          workdir: dir,
          detail: "names-and-counts",
          scopeToStory: false,
          contextFiles: [],
        });

        expect(v2Result.chunks).toHaveLength(1);
        expect(v2Result.chunks[0].content).toBe(v1Result.summary);
        expect(v1Result.summary).toContain("alpha.test.ts");
        expect(v1Result.summary).toContain("beta.test.ts");
      });
    });
  });

  describe("empty test directory", () => {
    test("v1 returns no element and v2 returns { chunks: [], pullTools: [] }", async () => {
      await withTempDir(async (dir) => {
        Bun.spawnSync(["mkdir", "-p", join(dir, "test")]);

        _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
          ({ globs: ["**/*.test.ts"], patterns: ["**/*.test.ts"], testDirs: ["test"], pathspec: [], regex: [], resolution: "fallback" as const } as any);

        _testCoverageProviderDeps.generateTestCoverageSummary = generateTestCoverageSummary as any;
        _testCoverageProviderDeps.getContextFiles = () => [];

        const v2Provider = new TestCoverageProvider(STORY, BASE_CONFIG);
        const v2Result = await v2Provider.fetch(makeRequest(dir));

        expect(v2Result.chunks).toHaveLength(0);
        expect(v2Result.pullTools).toEqual([]);

        const v1Result = await generateTestCoverageSummary({
          workdir: dir,
          detail: "names-and-counts",
          scopeToStory: true,
          contextFiles: [],
        });

        expect(v1Result.summary).toBe("");
        expect(v1Result.files).toHaveLength(0);
      });
    });
  });
});