import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { _rulesLintDeps, rulesLintCommandDirect } from "@/cli";
import { StaticRulesProvider } from "@/context/engine";
import { parseFrontmatter, RulesFrontmatterError } from "@/context/rules/rules-frontmatter";

const warning = 'Frontmatter key "stages" is ignored — rules apply to every session. Remove it from the frontmatter.';

describe("ignored rule stages", () => {
  test.each(["review", "regression, acceptance-setup"])("delivers rule with stages [%s] at context", async (stages) => {
    const root = makeTempDir("rules-stages-");
    try {
      await Bun.write(join(root, ".nax/rules/example.md"), `---\nstages: [${stages}]\n---\nRule content.\n`);
      const result = await new StaticRulesProvider().fetch({
        storyId: "US-004",
        repoRoot: root,
        packageDir: root,
        stage: "context",
        role: "implementer",
        budgetTokens: 8000,
      });
      expect(result.chunks.map((chunk) => chunk.content).join("\n")).toContain("Rule content.");
      expect(result.scopingReport?.stageFilteredIds).toEqual([]);
    } finally {
      cleanupTempDir(root);
    }
  });

  test.each(["review", "not-a-real-stage, review"])("warns exactly once for stages [%s]", (stages) => {
    const result = parseFrontmatter(`---\nstages: [${stages}]\n---\nBody`, "example.md");
    expect(result.warnings).toEqual([warning]);
  });

  test.each(["review", "[review, 42]", '[" "]', "null"])("rejects invalid stages %s", (stages) => {
    expect(() => parseFrontmatter(`---\nstages: ${stages}\n---\nBody`, "example.md")).toThrow(RulesFrontmatterError);
  });

  test("lint reports ignored stages with the rule file", async () => {
    const root = makeTempDir("rules-lint-stages-");
    const original = _rulesLintDeps.getLogger;
    const logger = makeLogger();
    try {
      await Bun.write(join(root, ".nax/rules/example.md"), "---\nstages: [review]\n---\nRule content.\n");
      _rulesLintDeps.getLogger = () => logger;
      await rulesLintCommandDirect({ dir: root });
      expect(
        logger.calls
          .filter((call) => call.level === "warn" && call.message.includes(warning))
          .map((call) => call.data?.file),
      ).toEqual(["example.md"]);
    } finally {
      _rulesLintDeps.getLogger = original;
      cleanupTempDir(root);
    }
  });
});
