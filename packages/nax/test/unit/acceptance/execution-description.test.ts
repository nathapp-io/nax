import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestContext } from "@test/helpers";
import { resolveAcceptanceExecution } from "@/acceptance/execution-description";
import { TddPromptBuilder } from "@/prompts/builders/tdd-builder";
import { buildAcceptanceExecutionSection } from "@/prompts/sections/acceptance";

function fixture(framework = "jest") {
  const story = makeStory({ id: "US-006", workdir: "apps/api" });
  return makeTestContext({
    story,
    stories: [story],
    projectDir: "/repo",
    workdir: "/repo/apps/api",
    featureDir: "/repo/.nax/features/feature",
    config: makeNaxConfig({
      acceptance: { enabled: true },
      quality: { commands: { testScoped: "bunx jest {{files}} --passWithNoTests" } },
    }),
    acceptanceTestPaths: [
      {
        testPath: "/repo/apps/api/.nax/features/feature/acceptance test.ts",
        packageDir: "/repo/apps/api",
        testFramework: framework,
        commandOverride: "bunx jest --config jest.nax.config.js {{FILE}}",
      },
    ],
  });
}
const mapping = JSON.stringify([
  ...Array.from({ length: 10 }, (_, i) => ({ acId: `AC-${58 + i}`, storyId: "US-006", testable: true })),
  { acId: "AC-68", storyId: "US-007", testable: true },
  { acId: "AC-69", storyId: "US-006", testable: false },
]);
const deps = {
  readFile: async (file: string) => ({
    exists: true,
    text: file.endsWith("acceptance-refined.json") ? mapping : "SOURCE_NOT_EMBEDDED",
  }),
};

describe("story acceptance execution", () => {
  test("keeps Jest override, quotes package-relative command path and exact ID selector", async () => {
    const entries = await resolveAcceptanceExecution(fixture(), deps);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.cwd).toBe("apps/api");
    expect(entry?.testPath).toBe("apps/api/.nax/features/feature/acceptance test.ts");
    expect(entry?.command).toContain(
      "bunx jest --config jest.nax.config.js '.nax/features/feature/acceptance test.ts'",
    );
    expect(entry?.command).not.toContain("passWithNoTests");
    expect(entry?.acIds).toHaveLength(10);
    const pattern = entry?.command.split("--testNamePattern '")[1]?.slice(0, -1);
    expect(pattern).toBeDefined();
    const regex = new RegExp(pattern ?? "");
    expect(regex.test("AC-58: works")).toBe(true);
    expect(regex.test("suite AC-67: works")).toBe(true);
    expect(regex.test("AC-580: unrelated")).toBe(false);
    expect(regex.test("AC-68: sibling")).toBe(false);
    expect(regex.test("prefixAC-58: unrelated")).toBe(false);
  });

  test.each(["pytest", "go-test", "cargo-test", "custom"])(
    "%s uses explicit unfiltered fallback",
    async (framework) => {
      const entries = await resolveAcceptanceExecution(fixture(framework), deps);
      expect(entries[0]?.filtered).toBe(false);
      expect(entries[0]?.command).not.toContain("--testNamePattern");
      expect(buildAcceptanceExecutionSection(entries)).toContain("Unfiltered fallback");
    },
  );

  test.each(["bun", "bun-test", "vitest"])("%s gets its supported selector", async (framework) => {
    const entries = await resolveAcceptanceExecution(fixture(framework), deps);
    expect(entries[0]?.filtered).toBe(true);
    expect(entries[0]?.command).toContain(framework === "vitest" ? "--testNamePattern" : "--test-name-pattern");
  });

  test("missing and disabled acceptance yield no guidance", async () => {
    const ctx = fixture();
    ctx.config.acceptance.enabled = false;
    expect(await resolveAcceptanceExecution(ctx, deps)).toEqual([]);
    ctx.config.acceptance.enabled = true;
    expect(await resolveAcceptanceExecution(ctx, { readFile: async () => ({ exists: false, text: "" }) })).toEqual([]);
    if (ctx.acceptanceTestPaths?.[0]) ctx.acceptanceTestPaths[0].acceptanceEnabled = false;
    expect(await resolveAcceptanceExecution(ctx, deps)).toEqual([]);
  });

  test.each(["{}", "invalid", "[]"])("missing mapping %s is explicit fallback", async (text) => {
    const entries = await resolveAcceptanceExecution(fixture(), { readFile: async () => ({ exists: true, text }) });
    expect(entries[0]?.filtered).toBe(false);
    expect(entries[0]?.acIds).toEqual([]);
  });

  test("worktree execution rebases the original acceptance target without mutating it", async () => {
    const ctx = fixture();
    ctx.workdir = "/repo/.nax-wt/US-006/apps/api";
    const reads: string[] = [];
    const entries = await resolveAcceptanceExecution(ctx, {
      readFile: async (file: string) => {
        reads.push(file);
        return deps.readFile(file);
      },
    });
    expect(entries[0]?.cwd).toBe("apps/api");
    expect(entries[0]?.testPath).toBe("apps/api/.nax/features/feature/acceptance test.ts");
    expect(reads).toContain("/repo/.nax-wt/US-006/apps/api/.nax/features/feature/acceptance test.ts");
    expect(ctx.acceptanceTestPaths?.[0]?.testPath).toBe("/repo/apps/api/.nax/features/feature/acceptance test.ts");
  });

  test("already rebased worktree paths are not double-prefixed", async () => {
    const ctx = fixture();
    ctx.workdir = "/repo/.nax-wt/US-006/apps/api";
    if (ctx.acceptanceTestPaths?.[0]) {
      ctx.acceptanceTestPaths[0].packageDir = ctx.workdir;
      ctx.acceptanceTestPaths[0].testPath = `${ctx.workdir}/acceptance.ts`;
    }
    const entries = await resolveAcceptanceExecution(ctx, deps);
    expect(entries[0]?.cwd).toBe("apps/api");
    expect(entries[0]?.testPath).toBe("apps/api/acceptance.ts");
  });

  test("acceptance Jest override wins over the project's Bun framework", async () => {
    const ctx = fixture();
    ctx.config.project = { language: "typescript", testFramework: "bun" };
    ctx.config.acceptance.testFramework = "jest";
    if (ctx.acceptanceTestPaths?.[0]) ctx.acceptanceTestPaths[0].testFramework = undefined;
    const entries = await resolveAcceptanceExecution(ctx, deps);
    expect(entries[0]?.command).toContain("--testNamePattern");
    expect(entries[0]?.command).not.toContain("--test-name-pattern");
  });

  test("resolved per-package framework wins over the current package's config", async () => {
    const ctx = fixture();
    ctx.config.project = { language: "typescript", testFramework: "bun" };
    ctx.config.acceptance.testFramework = "jest";
    ctx.stories.push(makeStory({ id: "US-007", workdir: "apps/web" }));
    ctx.acceptanceTestPaths?.push({
      testPath: "/repo/apps/web/acceptance.ts",
      packageDir: "/repo/apps/web",
      testFramework: "bun",
      commandOverride: "bun test {{FILE}}",
    });
    const entries = await resolveAcceptanceExecution(ctx, deps);
    expect(entries[0]?.command).toContain("--testNamePattern");
    expect(entries[1]?.command).toContain("--test-name-pattern");
    expect(entries[1]?.command).not.toContain("--testNamePattern");
  });

  test("an override with unknown framework does not guess Bun's selector", async () => {
    const ctx = fixture();
    if (ctx.acceptanceTestPaths?.[0]) ctx.acceptanceTestPaths[0].testFramework = undefined;
    ctx.config.project = { language: "typescript" };
    const entries = await resolveAcceptanceExecution(ctx, deps);
    expect(entries[0]?.filtered).toBe(false);
    expect(entries[0]?.command).not.toContain("--test-name-pattern");
  });

  test("compound command overrides retain the original shell command without guessing a selector", async () => {
    const ctx = fixture();
    if (ctx.acceptanceTestPaths?.[0]) ctx.acceptanceTestPaths[0].commandOverride = "setup && runner {{FILE}}";
    const entries = await resolveAcceptanceExecution(ctx, deps);
    expect(entries[0]?.filtered).toBe(false);
    expect(entries[0]?.command).toContain("setup && runner");
  });

  test("batch selects only each story's own package acceptance", async () => {
    const ctx = fixture();
    ctx.stories.push(makeStory({ id: "US-007", workdir: "apps/web" }));
    ctx.acceptanceTestPaths?.push(
      { testPath: "/repo/apps/web/acceptance.ts", packageDir: "/repo/apps/web", testFramework: "vitest" },
      { testPath: "/repo/apps/other/acceptance.ts", packageDir: "/repo/apps/other" },
    );
    const entries = await resolveAcceptanceExecution(ctx, deps);
    expect(entries.map((e) => e.storyIds)).toEqual([["US-006"], ["US-007"]]);
    expect(entries[1]?.acIds).toEqual(["AC-68"]);
  });

  test.each(["test-writer", "implementer", "verifier"] as const)(
    "%s receives short immutable acceptance guidance",
    async (role) => {
      const ctx = fixture();
      const acceptanceExecution = await resolveAcceptanceExecution(ctx, deps);
      const prompt = await TddPromptBuilder.buildForRole(role, ctx.workdir, ctx.config, ctx.story, {
        acceptanceExecution,
      });
      expect(prompt).toContain("AC-58");
      expect(prompt).toContain("jest.nax.config.js");
      expect(prompt).toContain("Do not edit or weaken");
      expect(prompt).not.toContain("SOURCE_NOT_EMBEDDED");
    },
  );
});
