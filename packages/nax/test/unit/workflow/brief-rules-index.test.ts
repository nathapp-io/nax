/**
 * US-003 — the rules index in the story brief.
 *
 * Two seams: `buildWorkflowBrief` (the rendering) and `writeBrief` (which
 * resolves the rule set under `delivery: "index"` and decides the wording from
 * the session's agent). The pure builder functions are covered by
 * `test/unit/prompts/builders/rules-index-builder.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeNaxConfig,
  makeStepContext,
  makeTempDir,
  makeTestStory,
} from "@test/helpers";
import type { ResolvedRule, ResolvedRuleSet } from "@/context/rules/rule-set";
import type { RulesIndexEntry } from "@/prompts";
import { buildWorkflowBrief } from "@/prompts";
import { storyWorkdir } from "@/utils/path-frame";
import { writeBrief } from "@/workflow/brief";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

const dirs: string[] = [];
const original = { ..._workflowDeps };
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const INDEX_ENTRY: RulesIndexEntry = {
  ruleId: "forbidden-patterns-source",
  displayPath: ".nax/rules/forbidden-patterns-source.md",
  source: "repo",
  description: "Forbidden Patterns",
  appliesTo: ["packages/nax/src/**/*.ts"],
  priority: 100,
};

const briefInput = {
  storyId: "US-003",
  title: "Rules index",
  description: "Index the rules.",
  acceptanceCriteria: ["index"],
  contextFiles: ["src/a.ts"],
  expectedFiles: ["src/a.ts"],
  specExcerpts: [] as string[],
  rulings: [] as string[],
  redBaseDependencies: [] as { storyId: string; reason: string }[],
  reportPath: "/out/US-003/report.md",
};

const SAMPLE_RULES: readonly ResolvedRule[] = [
  {
    ruleId: "alpha",
    fileName: "alpha.md",
    path: "alpha.md",
    content: "# Alpha Rule\n\nAlpha body.\n",
    source: "repo",
    displayPath: ".nax/rules/alpha.md",
    priority: 10,
  },
  {
    ruleId: "beta",
    fileName: "beta.md",
    path: "beta.md",
    content: "# Beta Rule\n\nBeta body.\n",
    source: "package",
    displayPath: "packages/api/.nax/rules/beta.md",
    priority: 20,
  },
];

const SAMPLE_SET: ResolvedRuleSet = {
  rules: SAMPLE_RULES,
  repoRulesTotal: 1,
  repoRulesMatchedPaths: 1,
  packageRulesCount: 1,
};

/** A `StepContext` that writes a real brief into a temp project dir. */
function makeBriefContext(
  options: {
    delivery?: "index" | "push";
    agentName?: string;
    overrideDir?: string;
    overrideMode?: "merge" | "replace";
  } = {},
): StepContext {
  const root = makeTempDir("wf-brief-index-");
  dirs.push(root);
  const runDir = join(root, "run");
  return makeStepContext({
    story: makeTestStory({
      id: "US-003",
      acceptanceCriteria: ["indexes rules"],
      workdir: "packages/api",
    }),
    projectDir: root,
    workdir: join(root, "packages/api"),
    runDir,
    outputDir: join(root, "out"),
    storyDir: join(runDir, "US-003"),
    briefPath: join(runDir, "US-003", "brief.md"),
    reportPath: join(runDir, "US-003", "report.md"),
    config: makeNaxConfig({
      context: {
        rules: {
          delivery: options.delivery ?? "index",
          ...(options.overrideDir !== undefined && { overrideDir: options.overrideDir }),
          ...(options.overrideMode !== undefined && { overrideMode: options.overrideMode }),
        },
      },
    }),
    callCtx: makeMockCallContext({ agentName: options.agentName ?? "claude" }),
  });
}

describe("buildWorkflowBrief — the rules index section (seam)", () => {
  test("AC-7: a non-empty rulesIndex renders ## Rules index before ## Feature context", () => {
    const text = buildWorkflowBrief({
      ...briefInput,
      featureContext: "FEATURE",
      rulesIndex: { entries: [INDEX_ENTRY], shownAutomatically: true },
    });
    expect(text).toContain("## Rules index");
    expect(text).toContain("`forbidden-patterns-source`");
    expect(text.indexOf("## Rules index")).toBeGreaterThan(-1);
    expect(text.indexOf("## Rules index")).toBeLessThan(text.indexOf("## Feature context"));
    expect(text).toContain("FEATURE");
  });

  test("AC-8: zero entries emits no ## Rules index heading", () => {
    const withEmpty = buildWorkflowBrief({
      ...briefInput,
      featureContext: "FEATURE",
      rulesIndex: { entries: [], shownAutomatically: true },
    });
    expect(withEmpty).not.toContain("## Rules index");
    expect(withEmpty).toContain("## Feature context");
  });

  test("AC-8: an absent rulesIndex emits no ## Rules index heading", () => {
    expect(buildWorkflowBrief(briefInput)).not.toContain("## Rules index");
  });

  test("AC-13: the constitution section survives a non-empty rulesIndex", () => {
    const text = buildWorkflowBrief({
      ...briefInput,
      featureContext: "FEATURE",
      constitution: "EXISTING-CONSTITUTION",
      rulesIndex: { entries: [INDEX_ENTRY], shownAutomatically: true },
    });
    expect(text).toContain("## Project rules");
    expect(text).toContain("EXISTING-CONSTITUTION");
    expect(text.indexOf("## Project rules")).toBeLessThan(text.indexOf("EXISTING-CONSTITUTION"));
    expect(text).toContain("## Rules index");
  });
});

describe("writeBrief — the rules index section (seam)", () => {
  test("AC-9: delivery push writes no ## Rules index section and resolves no rule set", async () => {
    let calls = 0;
    _workflowDeps.resolveRuleSet = async () => {
      calls += 1;
      return SAMPLE_SET;
    };
    const sc = makeBriefContext({ delivery: "push" });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).not.toContain("## Rules index");
    expect(calls).toBe(0);
  });

  test("AC-10: delivery index writes a ## Rules index listing every rule id", async () => {
    _workflowDeps.resolveRuleSet = async () => SAMPLE_SET;
    const sc = makeBriefContext({ delivery: "index" });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).toContain("## Rules index");
    const lines = text.split("\n").filter((line) => line.startsWith("- `"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("`alpha`");
    expect(lines[1]).toContain("`beta`");
  });

  test("AC-11: the resolver receives packageDir: sc.workdir and storyWorkdir: storyWorkdir(sc.story)", async () => {
    const seen: {
      packageDir?: string;
      repoRoot?: string;
      storyWorkdir?: string;
      overrideDir?: string;
      overrideMode?: string;
    }[] = [];
    _workflowDeps.resolveRuleSet = async (input) => {
      seen.push({
        packageDir: input.packageDir,
        repoRoot: input.repoRoot,
        storyWorkdir: input.storyWorkdir,
        overrideDir: input.overrideDir,
        overrideMode: input.overrideMode,
      });
      return SAMPLE_SET;
    };
    const sc = makeBriefContext({ delivery: "index", overrideDir: "/abs/org-rules", overrideMode: "replace" });
    await writeBrief(sc);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.repoRoot).toBe(sc.projectDir);
    expect(seen[0]?.packageDir).toBe(sc.workdir);
    expect(seen[0]?.storyWorkdir).toBe(storyWorkdir(sc.story));
    expect(seen[0]?.storyWorkdir).toBe("packages/api");
    // The configured override layer reaches the resolver, not just the delivery key.
    expect(seen[0]?.overrideDir).toBe("/abs/org-rules");
    expect(seen[0]?.overrideMode).toBe("replace");
  });

  test("AC-12: claude gets the read-it-yourself wording, native the shown-to-you wording", async () => {
    _workflowDeps.resolveRuleSet = async () => SAMPLE_SET;
    const claude = makeBriefContext({ delivery: "index", agentName: "claude" });
    await writeBrief(claude);
    const claudeText = await Bun.file(claude.briefPath).text();
    expect(claudeText).toContain("Before you write or edit a file a rule applies to, read that rule's file.");
    expect(claudeText).not.toContain("shown to you the first time");

    const native = makeBriefContext({ delivery: "index", agentName: "native" });
    await writeBrief(native);
    const nativeText = await Bun.file(native.briefPath).text();
    expect(nativeText).toContain("Each rule's full text is shown to you the first time");
    expect(nativeText).not.toContain("Before you write or edit a file a rule applies to");
  });

  test("a rule set with no rules writes no section, and an empty index is not an error", async () => {
    _workflowDeps.resolveRuleSet = async () => ({
      rules: [],
      repoRulesTotal: 0,
      repoRulesMatchedPaths: 0,
      packageRulesCount: 0,
    });
    const sc = makeBriefContext({ delivery: "index" });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).not.toContain("## Rules index");
    expect(text).toContain("# Brief: US-003");
  });
});
