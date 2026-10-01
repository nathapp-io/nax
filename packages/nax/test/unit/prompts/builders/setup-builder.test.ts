/**
 * Render-and-read coverage for SetupPromptBuilder (Task 16, single-frame PR 2).
 *
 * setup-builder.ts is audit-only: it carries no agent path framing. The only
 * path-shaped strings it renders are package *labels* (`relativeDir`) and the
 * config-root JSON schema note. These tests render the full ComposeInput the
 * same way production does (composeSections + join) and read the output for a
 * single-package (root) analysis and a monorepo analysis.
 */

import { describe, expect, test } from "bun:test";
import type { RepoAnalysis } from "@/cli/setup-types";
import { SetupPromptBuilder } from "@/prompts";
import type { ComposeInput } from "@/prompts/compose";
import { composeSections, join } from "@/prompts/compose";

function render(input: ComposeInput): string {
  return join(composeSections(input));
}

function makeSingleAnalysis(): RepoAnalysis {
  return {
    shape: "single",
    packages: [
      {
        relativeDir: "",
        testFramework: "bun",
        testFilePatterns: ["test/**/*.test.ts"],
        missingScripts: ["typecheck"],
      },
    ],
    pmRunPrefix: "bun run",
    pmDlx: "bunx",
    orchestrator: "none",
  };
}

function makeMonoAnalysis(): RepoAnalysis {
  return {
    shape: "mono",
    packages: [
      {
        relativeDir: "packages/app",
        testFramework: "vitest",
        testFilePatterns: ["src/**/*.test.ts"],
        missingScripts: [],
      },
      {
        relativeDir: "packages/lib",
        testFramework: undefined,
        testFilePatterns: [],
        missingScripts: ["lint"],
      },
    ],
    pmRunPrefix: "pnpm run",
    pmDlx: "pnpm dlx",
    orchestrator: "turbo",
  };
}

describe("SetupPromptBuilder.build — render-and-read", () => {
  test("single-package (root) analysis renders the root package label and single-config JSON shape", () => {
    const prompt = render(new SetupPromptBuilder().build(makeSingleAnalysis()));

    expect(prompt).toContain("You are an expert nax configuration generator.");
    expect(prompt).toContain("Generate a nax configuration for this single-package repository.");
    expect(prompt).toContain("- Shape: single");
    expect(prompt).toContain("- Package manager: bun run");
    expect(prompt).toContain("- DLX runner: bunx");
    expect(prompt).toContain("- Orchestrator: none");
    // The root package is labelled "(root)", not an agent containment frame.
    expect(prompt).toContain("Package: (root)");
    expect(prompt).toContain("Test framework: bun");
    expect(prompt).toContain("Test patterns: test/**/*.test.ts");
    expect(prompt).toContain("Missing scripts: typecheck");
    // Single-package output is a bare NaxConfig, not the mono envelope.
    expect(prompt).toContain('Respond with a JSON code block: { "config": <NaxConfig> }');
    expect(prompt).not.toContain("monoConfigs");
  });

  test("monorepo analysis renders each package label and the root+monoConfigs envelope", () => {
    const prompt = render(new SetupPromptBuilder().build(makeMonoAnalysis()));

    expect(prompt).toContain("Generate a nax configuration for this monorepo repository.");
    expect(prompt).toContain("- Shape: mono");
    expect(prompt).toContain("- Package manager: pnpm run");
    expect(prompt).toContain("- Orchestrator: turbo");
    expect(prompt).toContain("Package: packages/app");
    expect(prompt).toContain("Package: packages/lib");
    expect(prompt).toContain("Missing scripts: lint");
    expect(prompt).toContain("Missing scripts: (none — all canonical scripts present)");
    // `relativeDir` is the package's repo-relative label, rendered under the
    // merged root config — no package-containment re-framing of the agent root.
    expect(prompt).toContain('"config": <root NaxConfig>');
    expect(prompt).toContain('"monoConfigs": [{ "relativeDir": "<pkg>", "config": <partial NaxConfig> }]');
  });
});
