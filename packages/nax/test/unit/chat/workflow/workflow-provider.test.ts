import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _targetRepoDeps, targetOutputDir } from "@/chat/target-repo";
import { _featureStateDeps, type FeatureStateOptions } from "@/chat/workflow/feature-state";
import { featureDir, featuresDir } from "@/config";
import { buildWorkflowInstructions } from "@/prompts";
import { validateFeatureName } from "@/utils/feature-name";

let options: FeatureStateOptions;
const originalDeps = { ..._featureStateDeps };

beforeEach(() => {
  const repoRoot = makeTempDir("workflow-provider-");
  options = { repoRoot, outputDir: join(repoRoot, "output"), maxIterations: 2 };
});
afterEach(() => {
  Object.assign(_featureStateDeps, originalDeps);
  cleanupTempDir(options.repoRoot);
});

async function provider() {
  const { createWorkflowProvider } = await import("@/chat/workflow/workflow-provider");
  return createWorkflowProvider(options);
}
async function stateTool() {
  const tools = await (await provider()).tools(options.repoRoot);
  const tool = tools[0];
  assertDefined(tool, "state tool");
  return tool;
}
async function run(input: Record<string, unknown>) {
  return (await stateTool()).run(input, {
    root: options.repoRoot,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
  });
}
function features(...names: string[]) {
  for (const name of names) mkdirSync(featureDir(options.repoRoot, name), { recursive: true });
}

describe("createWorkflowProvider", () => {
  test("AC-1 provider id", async () => {
    expect((await provider()).id).toBe("nax-workflow");
  });
  test("AC-2 static kind", async () => {
    expect((await provider()).kind).toBe("static");
  });
  test("AC-3 all stages", async () => {
    expect((await provider()).stages).toEqual(["*"]);
  });
  test("AC-4 exactly one state tool", async () => {
    const tools = await (await provider()).tools(options.repoRoot);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.localName).toBe("state");
  });
  test("AC-5 exact schema", async () => {
    expect((await stateTool()).inputSchema).toEqual({
      type: "object",
      properties: { feature: { type: "string" }, repo: { type: "string" } },
      additionalProperties: false,
    });
  });
  test("AC-6 exact read-only description", async () => {
    expect((await stateTool()).description).toBe(
      "Read where a nax feature stands (spec, PRD, last run, workflow verdict, branch). Omit feature to list recently active features. Read-only; call it before proposing any nax plan/run/bot step.",
    );
  });
  test("AC-7 reads a known feature", async () => {
    features("f1");
    const result = await run({ feature: "f1" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).name).toBe("f1");
    expect(result.content).toBe(JSON.stringify(JSON.parse(result.content), null, 2));
  });
  test.each([
    ["AC-8 absent", {}],
    ["AC-9 whitespace", { feature: "  " }],
    ["AC-10 null", { feature: null }],
    ["empty string", { feature: "" }],
  ])("%s lists features", async (_label, input) => {
    features("f1", "f2");
    const result = await run(input);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).features).toHaveLength(2);
    expect(result.content).toBe(JSON.stringify(JSON.parse(result.content), null, 2));
  });
  describe.each([123, null, false, {}, [], undefined].map((branchName) => ({ branchName })))(
    "malformed PRD %j",
    ({ branchName }) => {
      async function malformedPrd() {
        features("f1", "f2");
        await Bun.write(
          join(featureDir(options.repoRoot, "f1"), "prd.json"),
          JSON.stringify({ branchName, userStories: [] }),
        );
        const git = mock(originalDeps.git);
        _featureStateDeps.git = git;
        return git;
      }
      test("named mode returns null PRD and branch with an unreadable warning", async () => {
        const git = await malformedPrd();
        const result = await run({ feature: "f1" });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({
          name: "f1",
          prd: null,
          branch: null,
          warnings: [expect.stringContaining("prd.json unreadable:")],
        });
        expect(git).not.toHaveBeenCalled();
      });
      test("list mode preserves malformed and healthy features", async () => {
        const git = await malformedPrd();
        const result = await run({});
        expect(result.isError).not.toBe(true);
        const list = JSON.parse(result.content);
        expect(list.omitted).toBe(0);
        expect(list.features).toHaveLength(2);
        expect(list.features).toContainEqual(
          expect.objectContaining({
            name: "f1",
            prd: null,
            branch: null,
            warnings: [expect.stringContaining("prd.json unreadable:")],
          }),
        );
        expect(list.features).toContainEqual(expect.objectContaining({ name: "f2", warnings: [] }));
        expect(git).not.toHaveBeenCalled();
      });
    },
  );
  test("AC-11 unknown feature without feature tree", async () => {
    expect(await run({ feature: "nope" })).toEqual({ isError: true, content: "unknown feature nope; known: (none)" });
  });
  test.each([{ feature: 7 }, { feature: false }, { feature: {} }, { feature: [] }, { feature: undefined }])(
    "AC-12 AC-19 rejects non-string %j",
    async (input) => {
      expect(await run(input)).toEqual({
        isError: true,
        content: "[chat] nax-workflow__state feature must be a string",
      });
    },
  );
  test.each(["../etc", "bad name", "a\\b", "a..b"])(
    "AC-13 AC-14 AC-20 AC-21 validates %s before any reads",
    async (feature) => {
      const git = mock(originalDeps.git);
      const file = mock(originalDeps.file);
      const readdir = mock(originalDeps.readdir);
      Object.assign(_featureStateDeps, { git, file, readdir });
      const { _workflowProviderDeps } = await import("@/chat/workflow/workflow-provider");
      const originalProviderDeps = { ..._workflowProviderDeps };
      const stat = mock(originalProviderDeps.stat);
      const providerReaddir = mock(originalProviderDeps.readdir);
      Object.assign(_workflowProviderDeps, { stat, readdir: providerReaddir });
      try {
        let message = "";
        try {
          validateFeatureName(feature);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).not.toBe("");
        expect(await run({ feature })).toEqual({ isError: true, content: message });
        for (const read of [git, file, readdir, stat, providerReaddir]) expect(read).not.toHaveBeenCalled();
      } finally {
        Object.assign(_workflowProviderDeps, originalProviderDeps);
      }
    },
  );
  test.each([65, 128])(
    "returns a validation ToolResult for a %i-character name, including legacy specs",
    async (length) => {
      const feature = "f".repeat(length);
      validateFeatureName(feature);
      await Bun.write(join(options.repoRoot, ".nax", "specs", `${feature}.md`), "legacy");
      const { _workflowProviderDeps } = await import("@/chat/workflow/workflow-provider");
      const originalProviderDeps = { ..._workflowProviderDeps };
      const stat = mock(originalProviderDeps.stat);
      const readdir = mock(originalProviderDeps.readdir);
      const file = mock(originalDeps.file);
      const git = mock(originalDeps.git);
      Object.assign(_workflowProviderDeps, { stat, readdir });
      Object.assign(_featureStateDeps, { file, git });
      try {
        let message = "";
        try {
          featureDir(options.repoRoot, feature);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).not.toBe("");
        expect(await run({ feature })).toEqual({ isError: true, content: message });
        for (const read of [stat, readdir, file, git]) expect(read).not.toHaveBeenCalled();
      } finally {
        Object.assign(_workflowProviderDeps, originalProviderDeps);
      }
    },
  );
  test("does not suggest directories rejected by the feature path validator", async () => {
    features("f1");
    mkdirSync(join(featuresDir(options.repoRoot), "f".repeat(65)));
    expect(await run({ feature: "nope" })).toEqual({ isError: true, content: "unknown feature nope; known: f1" });
  });
  test("accepts a 64-character feature name at the path limit", async () => {
    const feature = "f".repeat(64);
    features(feature);
    const result = await run({ feature });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).name).toBe(feature);
  });
  test("AC-15 sorts known directory names", async () => {
    features("f2", "f1");
    expect(await run({ feature: "nope" })).toEqual({ isError: true, content: "unknown feature nope; known: f1, f2" });
  });
  test("AC-16 accepts legacy spec-only features but does not list them", async () => {
    await Bun.write(join(options.repoRoot, ".nax", "specs", "f3.md"), "legacy");
    const result = await run({ feature: "f3" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).spec).toBe(".nax/specs/f3.md");
    expect(JSON.parse((await run({})).content)).toEqual({ features: [], omitted: 0 });
  });
  test("AC-17 delegates instructions", async () => {
    expect(await (await provider()).instructions?.(options.repoRoot)).toBe(buildWorkflowInstructions());
  });
  test("AC-18 chat barrel exports provider and options", async () => {
    const { createWorkflowProvider } = await import("@/chat");
    const publicOptions: import("@/chat").FeatureStateOptions = options;
    expect(createWorkflowProvider(publicOptions).id).toBe("nax-workflow");
  });
  test("AC-22 missing feature tree is an empty list", async () => {
    const result = await run({});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual({ features: [], omitted: 0 });
  });
  test("AC-23 bounds valid known directories to 20", async () => {
    const names = Array.from({ length: 22 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`);
    features(...names.reverse());
    mkdirSync(join(options.repoRoot, ".nax", "features", "bad name"));
    const expected = Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`).join(", ");
    expect(await run({ feature: "nope" })).toEqual({
      isError: true,
      content: `unknown feature nope; known: ${expected}, +2 more`,
    });
  });
  describe("repo argument", () => {
    const origLoad = _targetRepoDeps.loadConfig;
    afterEach(() => {
      _targetRepoDeps.loadConfig = origLoad;
    });
    const verdictReads: { root: string; out: string }[] = [];
    beforeEach(() => {
      verdictReads.length = 0;
      _featureStateDeps.loadRunVerdict = async (root, name, resolve) => {
        verdictReads.push({ root, out: await resolve(root) });
        return originalDeps.loadRunVerdict(root, name, resolve);
      };
    });
    function nested() {
      const nestedRoot = join(options.repoRoot, "repos", "nax");
      mkdirSync(join(nestedRoot, ".nax"), { recursive: true });
      _targetRepoDeps.loadConfig = async () => makeNaxConfig({ name: "nested", outputDir: join(nestedRoot, "out") });
      return nestedRoot;
    }
    async function writeVerdict(root: string, url: string) {
      const runDir = join(featureDir(root, "f1"), "workflow", "run-1");
      await Bun.write(
        join(runDir, "result.json"),
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-1",
          feature: "f1",
          stories: {},
          featureWorkflow: {
            step: "done",
            startedAt: "2026-01-01T00:00:00Z",
            seed: null,
            gateFindings: [],
            reviewRan: true,
            rulings: [],
            reviewOpen: [],
            cannotVerify: [],
            flaggedDecisions: [],
            finalGateFindings: [],
            reasons: [],
            storyStates: [],
            url,
          },
        }),
      );
    }
    test("AC-14/17 reads nested feature and its output dir", async () => {
      const nestedRoot = nested();
      mkdirSync(featureDir(nestedRoot, "f1"), { recursive: true });
      const runs = join(await targetOutputDir(nestedRoot), "features", "f1", "runs");
      await Bun.write(join(runs, "2026-run.jsonl"), "{}\n");
      await writeVerdict(nestedRoot, "https://example.test/nested-pr");
      await writeVerdict(options.repoRoot, "https://example.test/outer-pr");
      const result = await run({ feature: "f1", repo: "repos/nax" });
      expect(JSON.parse(result.content).workflow).toMatchObject({
        runId: "run-1",
        url: "https://example.test/nested-pr",
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content)).toMatchObject({ name: "f1" });
      expect(result.content).toContain("2026-run");
      expect(verdictReads).toEqual([{ root: realpathSync(nestedRoot), out: await targetOutputDir(nestedRoot) }]);
    });
    test("AC-18 lists nested features", async () => {
      const nestedRoot = nested();
      mkdirSync(featureDir(nestedRoot, "nf"), { recursive: true });
      const result = await run({ repo: "repos/nax" });
      expect(result.content).toContain("nf");
    });
    test("AC-19/21 rejects non-nax repo without reading", async () => {
      features("f1");
      const touched: string[] = [];
      _featureStateDeps.file = ((path: string) => {
        touched.push(`file ${path}`);
        return originalDeps.file(path);
      }) as typeof originalDeps.file;
      _featureStateDeps.readdir = ((...args: Parameters<typeof originalDeps.readdir>) => {
        touched.push("readdir");
        return originalDeps.readdir(...args);
      }) as typeof originalDeps.readdir;
      _featureStateDeps.git = async (...args) => {
        touched.push("git");
        return originalDeps.git(...args);
      };
      mkdirSync(join(options.repoRoot, "plain"));
      expect(await run({ feature: "f1", repo: "plain" })).toEqual({
        isError: true,
        content: "[chat] repo plain is not a nax project: no .nax directory",
      });
      expect(await run({ feature: "f1", repo: "nope" })).toEqual({
        isError: true,
        content: "[chat] repo nope does not exist",
      });
      expect(verdictReads).toEqual([]);
      expect(touched).toEqual([]);
    });
    test("AC-22 no repo reads original options", async () => {
      features("f1");
      await writeVerdict(options.repoRoot, "https://example.test/outer-pr");
      const result = JSON.parse((await run({ feature: "f1" })).content);
      expect(result.name).toBe("f1");
      expect(result.warnings).toEqual([]);
      expect(result.workflow).toMatchObject({ runId: "run-1", url: "https://example.test/outer-pr" });
      expect(verdictReads).toEqual([{ root: options.repoRoot, out: options.outputDir }]);
    });
    test("AC-20 instructions mention repo", () => {
      expect(buildWorkflowInstructions()).toContain("pass repo with that folder's path");
    });
  });
});
