import { afterEach, describe, expect, test } from "bun:test";
import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeStepContext, makeTempDir, makeTestStory } from "@test/helpers";
import { _briefDeps, refreshBrief, specExcerpts, writeBrief } from "@/workflow/brief";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const dirs: string[] = [];
const original = { ..._workflowDeps };
const originalBriefDeps = { ..._briefDeps };
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  Object.assign(_briefDeps, originalBriefDeps);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

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

  test("puts carried instructions from trusted decisions in Rulings in force", async () => {
    const root = makeTempDir("wf-brief-");
    dirs.push(root);
    const runDir = join(root, "run");
    _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
    _workflowDeps.readTrustedDecisions = async () => [
      {
        id: "D-4",
        questionId: "Q",
        kind: "residual",
        storyId: "US-1",
        chosenOptionId: "A",
        appliesTo: ["US-002"],
        action: { type: "carry", instruction: "Keep lock order", toStories: ["US-002"] },
        rationale: "x",
        confidence: "high",
        reversible: true,
        needsHumanConfirm: false,
        decidedAt: "t",
        model: "m",
        memoryMode: "stateless",
        auditRef: "a",
      },
    ];
    const sc = makeStepContext({
      story: makeTestStory({ id: "US-002", acceptanceCriteria: ["pays"] }),
      projectDir: root,
      runDir,
      storyDir: join(runDir, "US-002"),
      briefPath: join(runDir, "US-002", "brief.md"),
      reportPath: join(runDir, "US-002", "report.md"),
    });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).toContain("Rulings in force");
    expect(text).toContain("Carried from US-1 (D-4): Keep lock order");
  });

  test("AC-8: writes the story's out of scope list under its own heading", async () => {
    const root = makeTempDir("wf-brief-scope-");
    dirs.push(root);
    const runDir = join(root, "run");
    _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
    const sc = makeStepContext({
      story: makeTestStory({ id: "US-002", acceptanceCriteria: ["pays"], outOfScope: ["No run lease or lock"] }),
      projectDir: root,
      runDir,
      storyDir: join(runDir, "US-002"),
      briefPath: join(runDir, "US-002", "brief.md"),
      reportPath: join(runDir, "US-002", "report.md"),
    });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text).toContain("## Out of scope");
    expect(text.indexOf("- No run lease or lock")).toBeGreaterThan(text.indexOf("## Out of scope"));
  });
});

/**
 * US-001: the brief is rewritten before each review, so a mid-loop ruling reaches the reviewer.
 * A refresh that fails must not cost the review — the previous brief is still on disk — unless
 * the run is aborting, where the error is the abort's own.
 */
describe("refreshBrief (US-001)", () => {
  /** A step context in a temp dir with a working refresh; `aborted` decides what a failure means. */
  function briefContext(aborted = false): { sc: ReturnType<typeof makeStepContext> } {
    const root = makeTempDir("wf-brief-refresh-");
    dirs.push(root);
    const runDir = join(root, "run");
    const controller = new AbortController();
    if (aborted) controller.abort();
    _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
    return {
      sc: makeStepContext({
        projectDir: root,
        runDir,
        storyDir: join(runDir, "US-001"),
        briefPath: join(runDir, "US-001", "brief.md"),
        reportPath: join(runDir, "US-001", "report.md"),
        runSignal: controller.signal,
      }),
    };
  }

  /** Make the refresh fail where `writeBrief` reads the run's project-context file. */
  function failRefresh(): void {
    _workflowDeps.loadProjectContextOverride = async () => {
      throw new Error("context file gone");
    };
  }

  function brokenRefresh(aborted: boolean): { sc: ReturnType<typeof makeStepContext> } {
    const context = briefContext(aborted);
    failRefresh();
    return context;
  }

  test("AC-16: rethrows the write failure when the run signal is aborted", async () => {
    const { sc } = brokenRefresh(true);
    await expect(refreshBrief(sc)).rejects.toThrow("context file gone");
  });

  test("a write failure without an abort is contained, not thrown at the step", async () => {
    const { sc } = brokenRefresh(false);
    await expect(refreshBrief(sc)).resolves.toBeUndefined();
  });

  test("F2: a brief write that fails part-way leaves the previous brief whole", async () => {
    const { sc } = briefContext();
    await Bun.write(sc.briefPath, "# Brief: the previous one\n");
    const written: string[] = [];
    _briefDeps.write = async (path: string, text: string) => {
      written.push(path);
      // A write that lands a few bytes and then fails — what a full disk or a killed process does.
      await Bun.write(path, text.slice(0, 8));
      throw new Error("disk full");
    };
    await expect(refreshBrief(sc)).resolves.toBeUndefined();
    // The failure never touched the brief itself: it landed on a sibling temporary file...
    expect(written[0]).not.toBe(sc.briefPath);
    expect(await Bun.file(sc.briefPath).text()).toBe("# Brief: the previous one\n");
    // ...which is removed, so a failed refresh leaves nothing half-written behind.
    expect(await readdir(sc.storyDir)).toEqual(["brief.md"]);
  });

  test("F2: a successful refresh replaces the brief and leaves no temporary file", async () => {
    const { sc } = briefContext();
    await refreshBrief(sc);
    expect(await Bun.file(sc.briefPath).text()).toContain("# Brief: US-001");
    expect(await readdir(sc.storyDir)).toEqual(["brief.md"]);
  });
});

describe("US-002 cross-run dependencies", () => {
  test.each(["complete-gate-open", "complete"] as const)("AC-19/20 newest earlier state %s", async (state) => {
    const root = makeTempDir("wf-brief-cross-");
    dirs.push(root);
    for (const [run, priorState] of [
      ["older", state === "complete" ? "complete-gate-open" : "complete"],
      ["earlier", state],
    ] as const) {
      await upsertStoryRecord(
        join(root, run),
        { runId: run, feature: "f" },
        { ...newStoryRecord("US-001", 5, "t"), state: priorState, reason: "dependency reason" },
      );
      const date = new Date(run === "older" ? "2025-01-01" : "2025-01-02");
      await utimes(join(root, run, "result.json"), date, date);
    }
    const runDir = join(root, "now");
    const sc = makeStepContext({
      projectDir: root,
      runDir,
      story: makeTestStory({ id: "US-002", dependencies: ["US-001"] }),
      storyDir: join(runDir, "US-002"),
      briefPath: join(runDir, "US-002", "brief.md"),
    });
    await writeBrief(sc);
    const text = await Bun.file(sc.briefPath).text();
    expect(text.includes("red base")).toBe(state === "complete-gate-open");
    if (state === "complete-gate-open") {
      expect(text).toContain("US-001");
      expect(text).toContain("dependency reason");
    }
  });
});
