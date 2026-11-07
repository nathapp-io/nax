import type { ResolvedTestPatterns } from "@/test-runners";

/** Minimal resolved test patterns. Total by construction — pass overrides, never a literal. */
export function makeResolvedTestPatterns(overrides: Partial<ResolvedTestPatterns> = {}): ResolvedTestPatterns {
  return {
    globs: ["test/**/*.test.ts"],
    regex: [/\.test\.ts$/],
    pathspec: [":(exclude)test/**/*.test.ts"],
    testDirs: ["test/unit", "test/integration"],
    resolution: "detected",
    ...overrides,
  };
}
