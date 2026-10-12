import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeTempDir, makeTestStory } from "@test/helpers";
import { resolveWorkflowConfig } from "@/config";
import { specExcerpts, writeBrief } from "@/workflow/brief";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

const dirs: string[] = [];
const original = { ..._workflowDeps };
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** Typed StepContext builder: required fields get inert defaults, overrides win. */
function makeStepContext(overrides: Partial<StepContext>): StepContext {
  const config = makeNaxConfig();
  return {
    callCtx: makeMockCallContext(),
    story: makeTestStory(),
    config,
    workflow: resolveWorkflowConfig(config),
    tierOrder: [],
    feature: "f",
    projectDir: "/tmp/test",
    workdir: "/tmp/test",
    runDir: "/tmp/test/run",
    storyDir: "/tmp/test/run/US-001",
    briefPath: "/tmp/test/run/US-001/brief.md",
    reportPath: "/tmp/test/run/US-001/report.md",
    base: "HEAD",
    dryRun: false,
    ...overrides,
  };
}

describe("specExcerpts", () => {
  test("keeps only sections that name the story id", () => {
    const spec = "# Spec\nintro\n## US-001 Login\nA\n## US-002 Logout\nB mentions US-001 too\n## Other\nC\n";
    expect(specExcerpts(spec, "US-001")).toEqual(["## US-001 Login\nA", "## US-002 Logout\nB mentions US-001 too"]);
    expect(specExcerpts(spec, "US-009")).toEqual([]);
  });
});

describe("writeBrief", () => {
  test("writes brief.md with spec excerpts and a red-base warning from this run's result.json", async () => {
    const root = makeTempDir("wf-brief-");
    dirs.push(root);
    const runDir = join(root, "run");
    const specPath = join(root, "spec.md");
    await Bun.write(specPath, "## US-002 Pay\nDo it.\n");
    _workflowDeps.resolveFeatureSpec = async () => ({ specSource: { path: specPath } });
    await upsertStoryRecord(
      runDir,
      { runId: "r", feature: "f" },
      { ...newStoryRecord("US-001", 5, "t"), state: "complete-gate-open", reason: "full-suite red" },
    );
    const story = makeTestStory({ id: "US-002", dependencies: ["US-001"], acceptanceCriteria: ["pays"] });
    const sc = makeStepContext({
      story,
      projectDir: root,
      runDir,
      storyDir: join(runDir, "US-002"),
      briefPath: join(runDir, "US-002", "brief.md"),
      reportPath: join(runDir, "US-002", "report.md"),
      contextMarkdown: "CTX",
    });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).toContain("AC-1: pays");
    expect(text).toContain("## US-002 Pay");
    expect(text).toContain("red base");
    expect(text).toContain("full-suite red");
    expect(text).toContain("CTX");
  });
});
