import { describe, expect, test } from "bun:test";
import { AcceptancePromptBuilder } from "@/prompts";

describe("AcceptancePromptBuilder.buildPathCorrection", () => {
  const target = "/repo/apps/web/.nax/features/foo/.nax-acceptance.test.tsx";

  test("embeds the exact target path", () => {
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt).toContain(target);
  });

  test("instructs the agent not to rename/sanitize and to preserve content", () => {
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt.toLowerCase()).toContain("exact");
    expect(prompt.toLowerCase()).toContain("do not");
    expect(prompt.toLowerCase()).toContain("preserve");
  });
});

describe("AcceptancePromptBuilder.buildGeneratorFromPRDPrompt path anchor", () => {
  const packageStoryPath = "/repo/packages/core/.nax/features/foo/.nax-acceptance.test.ts";

  function renderPackageStoryPrompt(): string {
    return new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
      featureName: "foo",
      criteriaList: "AC-1: does the thing",
      frameworkOverrideLine: "",
      targetTestFilePath: packageStoryPath,
    });
  }

  test("does not derive the package root by walking up from the test file", () => {
    const prompt = renderPackageStoryPrompt();
    expect(prompt).toContain(packageStoryPath);
    expect(prompt).not.toContain("3 levels above");
    expect(prompt).not.toContain("../../../");
    expect(prompt).not.toContain("package root");
  });

  test("frames the path as repo-rooted and orchestrator-computed", () => {
    const prompt = renderPackageStoryPrompt();
    expect(prompt).toContain("repo-rooted");
    expect(prompt).toContain("computed by the orchestrator");
    expect(prompt).toContain("package's own `.nax/features/`");
  });

  test("frames Process cwd as the package's own root (manifest dir)", () => {
    const prompt = renderPackageStoryPrompt();
    expect(prompt).toContain("package's own root");
    expect(prompt).toContain("manifest");
    expect(prompt).not.toContain("join(import.meta.dir");
  });
});
