import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { _featureStateDeps, type FeatureStateOptions } from "@/chat/workflow/feature-state";
import { featureDir } from "@/config";
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
      properties: { feature: { type: "string" } },
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
});
