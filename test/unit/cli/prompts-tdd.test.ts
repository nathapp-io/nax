import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir, makeTestContext, makeTestStory } from "@test/helpers";
import { handleThreeSessionTddPrompts } from "@/cli/prompts-tdd";

describe("handleThreeSessionTddPrompts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-tdd-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("writes one prompt file per session role, plus a context file, to outputDir", async () => {
    const story = makeTestStory({ id: "US-010", title: "TDD story" });
    const ctx = makeTestContext({ story, workdir: tempDir, contextMarkdown: "# Context\nsome context" });
    const logger = makeLogger();
    const outputDir = join(tempDir, "out");

    await handleThreeSessionTddPrompts(story, ctx, outputDir, logger);

    for (const role of ["test-writer", "implementer", "verifier"]) {
      const promptFile = join(outputDir, `${story.id}.${role}.md`);
      expect(existsSync(promptFile)).toBe(true);
      const content = readFileSync(promptFile, "utf-8");
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain(`storyId: ${story.id}`);
      expect(content).toContain(`role: ${role}`);
    }

    const contextFile = join(outputDir, `${story.id}.context.md`);
    expect(existsSync(contextFile)).toBe(true);
    expect(readFileSync(contextFile, "utf-8")).toContain("some context");

    expect(logger.calls.filter((c) => c.message === "Written TDD prompt file")).toHaveLength(3);
  });

  test("prints to stdout with separators when outputDir is not provided", async () => {
    const story = makeTestStory({ id: "US-011", title: "Stdout story" });
    const ctx = makeTestContext({ story, workdir: tempDir });
    const logger = makeLogger();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await handleThreeSessionTddPrompts(story, ctx, undefined, logger);

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain("US-011");
      expect(printed).toContain("[test-writer]");
      expect(printed).toContain("[implementer]");
      expect(printed).toContain("[verifier]");
      expect(logger.calls.filter((c) => c.message === "Written TDD prompt file")).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("does not write a context file when contextMarkdown is absent, even with outputDir", async () => {
    const story = makeTestStory({ id: "US-012" });
    const ctx = makeTestContext({ story, workdir: tempDir, contextMarkdown: undefined });
    const logger = makeLogger();
    const outputDir = join(tempDir, "out2");

    await handleThreeSessionTddPrompts(story, ctx, outputDir, logger);

    expect(existsSync(join(outputDir, `${story.id}.context.md`))).toBe(false);
  });
});
