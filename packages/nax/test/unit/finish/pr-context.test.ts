import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendDecision } from "@/advisor";
import { _finishPrDeps, createFinishState, loadFinishPrContext } from "@/finish";

const originalDeps = { ..._finishPrDeps };
let dir: string;

function stateFor(workdir: string) {
  return createFinishState({
    feature: "demo",
    workdir,
    branch: "feat/demo",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/demo/spec.md",
  });
}

beforeEach(async () => {
  dir = makeTempDir("pr-context");
});

afterEach(async () => {
  Object.assign(_finishPrDeps, originalDeps);
  cleanupTempDir(dir);
});

describe("loadFinishPrContext", () => {
  test("reads stories and out-of-scope from the feature's prd.json", async () => {
    const featureDirPath = join(dir, ".nax", "features", "demo");
    await mkdir(featureDirPath, { recursive: true });
    await writeFile(
      join(featureDirPath, "prd.json"),
      JSON.stringify({
        userStories: [{ id: "US-001", title: "First", acceptanceCriteria: [1, 2, 3] }],
        outOfScope: ["not this"],
      }),
    );
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.stories).toEqual([{ id: "US-001", title: "First", acCount: 3 }]);
    expect(ctx.outOfScope).toEqual(["not this"]);
  });

  test("drops a story row whose id or title is not a string", async () => {
    const featureDirPath = join(dir, ".nax", "features", "demo");
    await mkdir(featureDirPath, { recursive: true });
    await writeFile(
      join(featureDirPath, "prd.json"),
      JSON.stringify({
        userStories: [
          { id: 7, title: "Bad" },
          { id: "US-002", title: "Good" },
        ],
      }),
    );
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.stories.map((s) => s.id)).toEqual(["US-002"]);
  });

  test("splits the diffstat from the nax-artifact summary using a glob pathspec", async () => {
    const calls: string[][] = [];
    _finishPrDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--shortstat")
        ? { exitCode: 0, stdout: " 1 file changed, 5 insertions(+)\n", stderr: "" }
        : { exitCode: 0, stdout: " src/a.ts | 2 +-\n", stderr: "" };
    };

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.diffstat).toContain("src/a.ts");
    expect(ctx.artifactSummary).toBe("1 file changed, 5 insertions(+)");
    const stat = calls.find((c) => c.includes("--stat"));
    expect(stat).toContain(":(glob,exclude)**/.nax/**");
    const shortstat = calls.find((c) => c.includes("--shortstat"));
    expect(shortstat).toContain(":(glob)**/.nax/**");
  });

  test("skips the diffstat entirely when base is empty", async () => {
    let ran = false;
    _finishPrDeps.run = async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const state = stateFor(dir);
    state.base = "";

    const ctx = await loadFinishPrContext({
      state,
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ran).toBe(false);
    expect(ctx.diffstat).toBeUndefined();
  });

  test("falls back to feat: <feature> when no title was produced", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.title).toBe("feat: demo");
  });

  test("reports the gate names the machine recorded on state", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const withGates = stateFor(dir);
    withGates.gatesRan = ["lint", "typecheck"];

    const ctx = await loadFinishPrContext({
      state: withGates,
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.gatesRan).toEqual(["lint", "typecheck"]);
  });

  test("carries the caller's template mode and section map", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      prBody: { template: "strict", sectionMap: { notes: "narrative" } },
    });

    expect(ctx.templateMode).toBe("strict");
    expect(ctx.templateSectionMap).toEqual({ notes: "narrative" });
  });
});

describe("loadFinishPrContext — advisor decisions (A1)", () => {
  const draft = {
    questionId: "Q",
    kind: "finish-judgment" as const,
    chosenOptionId: "A",
    action: { type: "fix" as const, instruction: "x" },
    rationale: "r",
    confidence: "high" as const,
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "t",
    model: "m",
    memoryMode: "stateless" as const,
  };

  test("shows only decisions with an audit artifact under outputDir; none without an outputDir", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const out = join(dir, "out");
    const real = await appendDecision(dir, "demo", (id) => ({ ...draft, auditRef: `advisor-audit/demo/${id}.json` }));
    await mkdir(join(out, "advisor-audit", "demo"), { recursive: true });
    await writeFile(join(out, real.auditRef), JSON.stringify({ result: { decision: real } }));
    await appendDecision(dir, "demo", { ...draft, auditRef: "advisor-audit/demo/forged.json" });

    const audit = { auditDir: join(dir, "audit"), runId: "run-1" };
    const trusted = await loadFinishPrContext({ state: stateFor(dir), audit, outputDir: out });
    expect(trusted.advisorDecisions?.map((d) => d.id)).toEqual(["D-1"]);
    const noOut = await loadFinishPrContext({ state: stateFor(dir), audit });
    expect(noOut.advisorDecisions).toBeUndefined();
  });
});

describe("loadFinishPrContext — A4 review output and resolution", () => {
  const audit = () => ({ auditDir: join(dir, "audit"), runId: "run-1" });
  const open = {
    severity: "HIGH" as const,
    title: "Open",
    problem: "p",
    fix: "f",
  };
  const facts = {
    findingsOpen: [open],
    acceptance: "red" as const,
    gates: [{ name: "lint", status: "red" as const, excerpt: "boom" }],
    reviewsMissing: ["spec" as const],
    unreviewedFixCommits: ["abc1234"],
    coverage: { spec: null, quality: 0.5 },
    fixRounds: 2,
    findings: [],
    stops: [],
  };

  test("narrative and title come from the branch reviewer on state.review", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const state = stateFor(dir);
    state.review.summary = "Reviewer prose.";
    state.review.title = "fix: reviewer subject";
    const ctx = await loadFinishPrContext({ state, audit: audit() });
    expect(ctx.narrative).toBe("Reviewer prose.");
    expect(ctx.title).toBe("fix: reviewer subject");
  });

  test("falls back to the spec summary and feat: <feature> when the reviewer gave neither", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    _finishPrDeps.readText = async (path: string) =>
      path.endsWith("spec.md") ? "# Spec\n\n## Summary\n\nFrom the spec.\n" : null;
    const ctx = await loadFinishPrContext({ state: stateFor(dir), audit: audit() });
    expect(ctx.narrative).toBe("From the spec.");
    expect(ctx.title).toBe("feat: demo");
  });

  test("a draft resolution becomes the unresolved block and coverage", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const state = stateFor(dir);
    state.resolution = { outcome: "draft", reason: "1 open finding(s)", facts, acceptedResidue: [] };
    const ctx = await loadFinishPrContext({ state, audit: audit() });
    expect(ctx.unresolved).toEqual({
      reason: "1 open finding(s)",
      findings: [open],
      acceptance: "red",
      gates: facts.gates,
      missing: ["spec"],
      unreviewed: ["abc1234"],
      accepted: [],
      ledger: [],
      stops: [],
      handoffs: [],
    });
    expect(ctx.coverage).toEqual({ spec: null, quality: 0.5 });
  });

  test("a ready resolution with accepted residue still gets an unresolved block", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const state = stateFor(dir);
    state.resolution = {
      outcome: "ready",
      facts: {
        ...facts,
        findingsOpen: [],
        acceptance: "green",
        gates: [],
        reviewsMissing: [],
        unreviewedFixCommits: [],
      },
      acceptedResidue: [open],
    };
    const ctx = await loadFinishPrContext({ state, audit: audit() });
    expect(ctx.unresolved?.accepted).toEqual([open]);
  });

  test("a clean ready resolution has coverage but no unresolved block", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const state = stateFor(dir);
    state.resolution = {
      outcome: "ready",
      facts: {
        ...facts,
        findingsOpen: [],
        acceptance: "green",
        gates: [],
        reviewsMissing: [],
        unreviewedFixCommits: [],
      },
      acceptedResidue: [],
    };
    const ctx = await loadFinishPrContext({ state, audit: audit() });
    expect(ctx.unresolved).toBeUndefined();
    expect(ctx.coverage).toEqual({ spec: null, quality: 0.5 });
  });

  test("unresolved carries the live ledger, stops and handoffs from state", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const state = stateFor(dir);
    // The resolution snapshot shows the finding as open; the live ledger (after the accepted event) is authoritative.
    const entry = { id: "i", finding: open, state: "accepted" as const, ref: "advisor approval" };
    state.resolution = {
      outcome: "draft",
      reason: "r",
      facts: { ...facts, findings: [{ ...entry, state: "open" }] },
      acceptedResidue: [],
    };
    state.review = { ...state.review, ledger: [entry] };
    state.stops = [{ kind: "flow", step: "review", at: "t", limitMs: 1 }];
    const ctx = await loadFinishPrContext({ state, audit: audit() });
    expect(ctx.unresolved?.ledger).toEqual([entry]);
    expect(ctx.unresolved?.stops).toEqual(state.stops);
    expect(ctx.unresolved?.handoffs).toEqual([]);
  });

  test("a ready resolution with a stop still gets an unresolved block", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const state = stateFor(dir);
    state.resolution = {
      outcome: "ready",
      facts: {
        ...facts,
        findingsOpen: [],
        acceptance: "green",
        gates: [],
        reviewsMissing: [],
        unreviewedFixCommits: [],
      },
      acceptedResidue: [],
    };
    state.stops = [{ kind: "run", step: "review", at: "t", limitMs: 0 }];
    const ctx = await loadFinishPrContext({ state, audit: audit() });
    expect(ctx.unresolved?.stops).toHaveLength(1);
  });
  test("the acceptance guard forces an unresolved block only when it did something a reviewer must see", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const readyResolution = {
      outcome: "ready" as const,
      facts: {
        ...facts,
        findingsOpen: [],
        acceptance: "green" as const,
        gates: [],
        reviewsMissing: [],
        unreviewedFixCommits: [],
      },
      acceptedResidue: [],
    };
    const quiet = stateFor(dir);
    quiet.resolution = readyResolution;
    quiet.acceptanceGuard = { reverted: [], notRestorable: [], changed: ["AC-40"], beyondRuling: [], failed: false };
    expect((await loadFinishPrContext({ state: quiet, audit: audit() })).unresolved).toBeUndefined();

    const loud = stateFor(dir);
    loud.resolution = readyResolution;
    loud.acceptanceGuard = { reverted: ["t.ts"], notRestorable: [], changed: [], beyondRuling: [], failed: false };
    const ctx = await loadFinishPrContext({ state: loud, audit: audit() });
    expect(ctx.unresolved?.acceptanceGuard?.reverted).toEqual(["t.ts"]);
  });
});
