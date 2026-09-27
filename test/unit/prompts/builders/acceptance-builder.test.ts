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

  test("ends its Requirements with P1 and still names the target path (US-001 AC7)", () => {
    const target = "/r/.nax/features/f/.nax-acceptance.test.ts";
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt).toContain("Keep every acceptance test in this one file; do not create a second test file.");
    expect(prompt).toContain(target);
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

describe("AcceptancePromptBuilder.buildLoadRepairPrompt", () => {
  const target = "/r/t.test.ts";
  const tail = "error: Cannot find module 'x'";
  const G2 =
    "The file must load before the implementation exists. In languages that resolve imports at runtime (TypeScript, JavaScript, Python), import modules this feature adds inside each test rather than at the top of the file, so a missing module fails only the tests that use it.";

  function renderLoadRepairPrompt(): string {
    return new AcceptancePromptBuilder().buildLoadRepairPrompt(target, tail);
  }

  test("names the target path so the repair edits the right file", () => {
    expect(renderLoadRepairPrompt()).toContain(target);
  });

  test("includes the output tail in a fenced block", () => {
    const prompt = renderLoadRepairPrompt();
    expect(prompt).toContain(tail);
    expect(prompt).toContain("```");
  });

  test("asks for the smallest edit that makes the file load while keeping every AC-N test", () => {
    const prompt = renderLoadRepairPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("smallest");
    expect(lower).toContain("load");
    expect(prompt).toContain("AC-N");
  });

  test("repeats G2 verbatim", () => {
    expect(renderLoadRepairPrompt()).toContain(G2);
  });
});
