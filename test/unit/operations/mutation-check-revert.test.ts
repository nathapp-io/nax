import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";
import type { MutationCheckDeps } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const FAKE_STORY = { id: "US-004", title: "mutation-check op" } as any;

function ctxWithConfig(execution: Record<string, unknown> = {}, runtime: Partial<NaxRuntime> = {}): any {
  const config = { execution, quality: { commands: { test: "bun test" } } } as any;
  return {
    runtime: { mutationSummaries: new Map(), ...runtime },
    storyId: "US-004",
    packageView: {
      packageDir: "packages/agent",
      repoRoot: "/repo",
      hasOverride: false,
      config,
      select: (s: any) => s.select(config),
    },
  } as any;
}

const originalMutationCheckDeps = { ..._mutationCheckDeps };
afterEach(() => Object.assign(_mutationCheckDeps, originalMutationCheckDeps));

function fakeDeps(overrides: Partial<MutationCheckDeps> = {}): MutationCheckDeps {
  return {
    detectLanguage: async () => "typescript" as any,
    getChangedNonTestFiles: async () => [],
    getChangedLineRanges: async () => new Map(),
    getGitRoot: async () => null,
    selectScopedTests: async () => ({
      effectiveCommand: "bun test",
      isFullSuite: true,
      thresholdFallback: false,
      isMonorepoOrchestrator: false,
    }),
    regression: async () => ({
      status: "SUCCESS" as const,
      success: true,
      countsTowardEscalation: true,
      output: "",
    }),
    ...overrides,
  };
}

describe("mutationCheckOp — AC9: regression throw still reverts and reports success", () => {
  test("restores file when regression throws and returns success=true", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      const originalLine = "if (a == b) { return 1; }";
      await Bun.write(file, `${originalLine}\n`);

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => {
          throw new Error("subprocess exploded");
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      // File must be restored to its original contents after the throw.
      const after = await Bun.file(file).text();
      expect(after).toBe(`${originalLine}\n`);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
