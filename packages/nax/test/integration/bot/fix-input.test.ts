import { afterEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeScriptedCallOp, makeTempDir } from "@test/helpers";
import * as bot from "@/bot";
import { resolveWorkflowConfig } from "@/config";
import { workflowBranchFixOp } from "@/operations";
import * as workflow from "@/workflow";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});
function temp(): string {
  const dir = makeTempDir("fix-input-");
  dirs.push(dir);
  return dir;
}
function artifact(headSha: string, trusted = true): bot.BotReviewArtifact {
  return {
    version: 1,
    pr: { forge: "github", host: "github.com", repo: "o/r", number: 42 },
    headSha,
    trusted,
    intent: "pass",
    quality: "approved",
    agreed: [],
  };
}
async function writeReview(dir: string, run: string, content: unknown, time: number): Promise<void> {
  const path = join(dir, "bot", "pr-42", run, "bot-review.json");
  await Bun.write(path, typeof content === "string" ? content : JSON.stringify(content));
  await utimes(path, time, time);
}

describe("loadLatestReview", () => {
  test.each([1, 2] as const)("US-007 AC-8/9 loads exact-head version %i with fields intact", async (version) => {
    const dir = temp();
    const review = { ...artifact("h1"), version, ...(version === 2 ? { checks: null, events: [] } : {}) };
    await writeReview(dir, "only", review, 100);
    expect(await bot.loadLatestReview(dir, 42, "h1")).toEqual(review);
    expect(await bot.loadLatestReview(dir, 42, "other")).toBeNull();
  });
  test("AC-1 returns the newest exact-head artifact regardless of trusted", async () => {
    const dir = temp();
    await writeReview(dir, "old", artifact("h1"), 100);
    await writeReview(dir, "new", artifact("h1", false), 200);
    expect(await bot.loadLatestReview(dir, 42, "h1")).toEqual(artifact("h1", false));
  });
  test("AC-2 ignores newer mismatched heads", async () => {
    const dir = temp();
    await writeReview(dir, "old", artifact("h1"), 100);
    await writeReview(dir, "new", artifact("h0"), 200);
    expect(await bot.loadLatestReview(dir, 42, "h1")).toEqual(artifact("h1"));
  });
  test.each([
    ["AC-3 malformed JSON", "{bad"],
    ["AC-4 missing version", { headSha: "h1" }],
    ["US-007 AC-10 unsupported version", { version: 3, headSha: "h1" }],
    ["null JSON", "null"],
  ])("ignores %s", async (_label, content) => {
    const dir = temp();
    await writeReview(dir, "only", content, 100);
    expect(await bot.loadLatestReview(dir, 42, "h1")).toBeNull();
  });
  test("AC-5 returns null without the PR directory", async () => {
    expect(await bot.loadLatestReview(temp(), 42, "h1")).toBeNull();
  });
  test("saved-checks round trip keeps a command list with blank entries", async () => {
    const dir = temp();
    const review: bot.BotReviewArtifact = {
      ...artifact("h1"),
      version: 2,
      checks: {
        source: "config",
        gates: [{ name: "test", command: ["bun run test", ""] }],
        preRun: [],
      },
      events: [],
    };
    await writeReview(dir, "only", review, 100);
    expect(await bot.loadLatestReview(dir, 42, "h1")).toEqual(review);
  });
  test.each([
    ["all entries blank", ["", " "]],
    ["empty list", [] as string[]],
  ])("saved-checks round trip rejects a command list with %s", async (_label, command) => {
    const dir = temp();
    await writeReview(
      dir,
      "only",
      {
        ...artifact("h1"),
        version: 2,
        checks: { source: "config", gates: [{ name: "test", command }], preRun: [] },
        events: [],
      },
      100,
    );
    expect(await bot.loadLatestReview(dir, 42, "h1")).toBeNull();
  });
});

describe("runBranchFix model forwarding", () => {
  test.each([true, false])("AC-13/14 includes model only when supplied: %s", async (supplied) => {
    const dir = temp();
    const config = makeNaxConfig();
    const ctx: workflow.BranchStepContext = {
      callCtx: makeMockCallContext(),
      config,
      workflow: resolveWorkflowConfig(config),
      feature: "bot-pr-42",
      projectDir: dir,
      runDir: dir,
      reportPath: join(dir, "report.md"),
      packageDirs: [],
      dryRun: false,
    };
    _workflowDeps.git = async () => ({ exitCode: 0, stdout: "" });
    const seen: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op).toBe(workflowBranchFixOp);
      seen.push(input);
      return { status: "DONE", commits: [], testSummary: "pass", interrupted: false };
    });
    await workflow.runBranchFix(ctx, { findings: [], ...(supplied ? { model: "fast" as const } : {}) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ timeoutMs: ctx.workflow.timeouts.fixMs, reportPath: ctx.reportPath });
    if (supplied) expect(seen[0]).toHaveProperty("model", "fast");
    else expect(seen[0]).not.toHaveProperty("model");
  });
});
