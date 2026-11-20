/**
 * US-005: after publishing, the publish step collects the ids of the feature's trusted ledger
 * decisions that need a human, stores them on the record, and every surface built from the record
 * shows them. These are the machine (ordering, failure) and env (wiring, persistence) regressions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeTempDir } from "@test/helpers";
import { type AdviceDecision, type Advisor, appendDecision } from "@/advisor";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { type FeatureEnv, type FeatureSteps, runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { PublishOutcome } from "@/workflow/finalize";
import { readResult } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";
import type { FeatureOutcome, FlaggedDecision, StorySummary, WorkflowFeatureRecord } from "@/workflow/types";

const originalDeps = { ..._workflowDeps };
const dirs: string[] = [];
let logs: LogEntry[] = [];

beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});

afterEach(async () => {
  resetLogger();
  Object.assign(_workflowDeps, originalDeps);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const noDecisions: Advisor = {
  advise: async () => ({ decision: null, fallbackReason: "off" }),
  recordReuse: async () => null,
  adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
};

const STORIES: readonly StorySummary[] = [
  { id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 },
];
const PUBLISHED: PublishOutcome = { outcome: "local-only", ci: "skipped", reasons: ["no forge"] };

const draft = (over: Partial<AdviceDecision> = {}): Omit<AdviceDecision, "id"> => ({
  questionId: "Q",
  kind: "finish-judgment",
  chosenOptionId: "A",
  action: { type: "fix", instruction: "x" },
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "2026-10-10T00:00:00Z",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
  ...over,
});

const decision = (id: string, needsHumanConfirm: boolean): AdviceDecision => ({
  ...draft({ needsHumanConfirm }),
  id,
});

/** A record parked at `publish`, so driving the machine runs exactly the one step under test. */
const atPublish = (): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  step: "publish",
});

function buildEnv(over: { projectDir?: string; outputDir?: string; feature?: string } = {}): FeatureEnv {
  const runDir = makeTempDir("flag-run-");
  dirs.push(runDir);
  return envFor(
    makeFeatureContext({
      runDir,
      ...(over.projectDir !== undefined ? { projectDir: over.projectDir } : {}),
      ...(over.outputDir !== undefined ? { outputDir: over.outputDir } : {}),
      ...(over.feature !== undefined ? { feature: over.feature } : {}),
    }),
  );
}

/** The env's other steps read an inert advisor; only `createAdvisor` is faked, never the ledger read. */
function envFor(fc: ReturnType<typeof makeFeatureContext>): FeatureEnv {
  _workflowDeps.createAdvisor = () => noDecisions;
  return buildFeatureEnv(
    fc,
    {
      runtime: fc.callCtx.runtime,
      config: fc.config,
      prd: fc.prd,
      feature: fc.feature,
      workdir: fc.projectDir,
      branch: fc.branch,
      runId: fc.runId,
      agentName: "claude",
      statusWriter: { setWorkflowStatus: () => {} },
    },
    {
      stories: STORIES,
      ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
      record: atPublish(),
      meter: startTokenMeter(undefined),
      preflight: null,
      specPath: "",
    },
  );
}

/** A ledger line plus the audit artifact that makes `readTrustedDecisions` trust it. */
async function addDecision(
  repo: string,
  outputDir: string,
  feature: string,
  needsHumanConfirm: boolean,
  audited = true,
  over: Partial<AdviceDecision> = {},
): Promise<AdviceDecision> {
  const entry = await appendDecision(repo, feature, (id) =>
    draft({ needsHumanConfirm, auditRef: `advisor-audit/${feature}/${id}.json`, ...over }),
  );
  if (audited) await Bun.write(join(outputDir, entry.auditRef), JSON.stringify({ result: { decision: entry } }));
  return entry;
}

function flaggedStepOf(env: FeatureEnv): () => Promise<readonly FlaggedDecision[]> {
  const step = env.steps.flaggedDecisions;
  if (!step) throw new Error("buildFeatureEnv must wire steps.flaggedDecisions");
  return step;
}

/** US-002: one flagged decision as the step now reports it — the id and the line that names it. */
const KEEP_LOCK: FlaggedDecision = { id: "D-1", summary: "Keep the lock" };

/** A machine harness whose publish step is stubbed — AC-3..AC-5 drive exactly that step. */
function harness(
  opts: {
    flagged?: () => Promise<readonly FlaggedDecision[]>;
    record?: WorkflowFeatureRecord;
    outcome?: FeatureOutcome;
  } = {},
) {
  const calls: string[] = [];
  const updates: WorkflowFeatureRecord[] = [];
  const flaggedImpl = opts.flagged;
  const published: PublishOutcome = { ...PUBLISHED, ...(opts.outcome ? { outcome: opts.outcome } : {}) };
  const never = async () => {
    throw new Error("step not expected in this test");
  };
  const steps: FeatureSteps = {
    repoGates: never,
    branchReview: never,
    branchFix: never,
    branchReReview: never,
    adjudicate: never,
    publish: async () => {
      calls.push("publish");
      return published;
    },
    head: async () => "h1",
    changedFiles: async () => [],
    ...(flaggedImpl
      ? {
          flaggedDecisions: async (): Promise<readonly FlaggedDecision[]> => {
            calls.push("flaggedDecisions");
            return flaggedImpl();
          },
        }
      : {}),
  };
  const env: FeatureEnv = {
    steps,
    sink: {
      update: async (r) => {
        updates.push(r);
      },
      ledger: async () => {},
      step: () => {},
      artifact: async () => {},
    },
    facts: { stories: STORIES, parked: [], cannotVerify: [] },
    record: opts.record ?? atPublish(),
    aborted: () => false,
    now: () => 0,
  };
  return { env, calls, updates };
}

const warns = (): LogEntry[] => logs.filter((e) => e.level === "warn");

describe("buildFeatureEnv — the flaggedDecisions step (US-005)", () => {
  test("AC-1: keeps only the trusted decisions that need a human, in ledger order", async () => {
    _workflowDeps.readTrustedDecisions = async () => [
      decision("D-1", true),
      decision("D-2", false),
      decision("D-3", true),
    ];
    const env = buildEnv();
    expect(await flaggedStepOf(env)()).toEqual([
      { id: "D-1", summary: "fix — r" },
      { id: "D-3", summary: "fix — r" },
    ]);
  });

  test("AC-2: an empty ledger resolves to an empty list", async () => {
    _workflowDeps.readTrustedDecisions = async () => [];
    const env = buildEnv();
    expect(await flaggedStepOf(env)()).toEqual([]);
  });

  test("a real ledger: only trusted human-confirm decisions, still in ledger order", async () => {
    const repo = makeTempDir("flag-repo-");
    dirs.push(repo);
    const outputDir = join(repo, "out");
    const feature = "f";
    const first = await addDecision(repo, outputDir, feature, true);
    await addDecision(repo, outputDir, feature, false); // trusted, but no human needed
    await addDecision(repo, outputDir, feature, true, false); // flagged, but no audit artifact
    const last = await addDecision(repo, outputDir, feature, true);
    const env = envFor(makeFeatureContext({ projectDir: repo, outputDir, feature }));
    expect(await flaggedStepOf(env)()).toEqual([
      { id: first.id, summary: "fix — r" },
      { id: last.id, summary: "fix — r" },
    ]);
  });
});

/**
 * US-002: the step carries each flagged decision's one-line summary too, so the open item a human
 * reads says what the decision was about instead of pointing at a list.
 */
describe("buildFeatureEnv — the flagged decision summaries (US-002)", () => {
  test("AC-7: a trusted flagged decision carries its ruling title as its summary", async () => {
    const repo = makeTempDir("flag-repo-");
    dirs.push(repo);
    const outputDir = join(repo, "out");
    const feature = "f";
    const trusted = await addDecision(repo, outputDir, feature, true, true, { rulingTitle: "Keep the lock" });
    const env = envFor(makeFeatureContext({ projectDir: repo, outputDir, feature }));
    expect(await flaggedStepOf(env)()).toEqual([{ id: trusted.id, summary: "Keep the lock" }]);
  });

  test("AC-8: a trusted decision that needs no human is omitted", async () => {
    const repo = makeTempDir("flag-repo-");
    dirs.push(repo);
    const outputDir = join(repo, "out");
    const feature = "f";
    const unflagged = await addDecision(repo, outputDir, feature, false, true, { rulingTitle: "Keep the lock" });
    const flagged = await addDecision(repo, outputDir, feature, true, true, { rulingTitle: "Keep the lock" });
    const env = envFor(makeFeatureContext({ projectDir: repo, outputDir, feature }));
    const result = await flaggedStepOf(env)();
    expect(result.map((d) => d.id)).toEqual([flagged.id]);
    expect(result.map((d) => d.id)).not.toContain(unflagged.id);
  });
});

describe("runFeatureMachine — the publish step collects flagged rulings (US-005)", () => {
  test("AC-3: the collected ids land on the record, and only after publish", async () => {
    const h = harness({ flagged: async () => [KEEP_LOCK] });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["publish", "flaggedDecisions"]);
    expect(final.flaggedDecisions).toEqual(["D-1"]);
    expect(final.step).toBe("done");
  });

  test.each(["ready", "draft", "pushed", "local-only"] as const)(
    "the ids are collected whatever publish did: %s",
    async (outcome) => {
      const h = harness({ flagged: async () => [KEEP_LOCK], outcome });
      const final = await runFeatureMachine(h.env);
      expect(final.outcome).toBe(outcome);
      expect(final.flaggedDecisions).toEqual(["D-1"]);
    },
  );

  test("AC-4: an unreadable ledger warns once, persists no ids and never blocks the step", async () => {
    const h = harness({
      flagged: async () => {
        throw new Error("ledger unreadable");
      },
    });
    const final = await runFeatureMachine(h.env);
    expect(final.step).toBe("done");
    expect(final.outcome).toBe("local-only");
    expect(final.ci).toBe("skipped");
    expect("flaggedDecisions" in final).toBe(false);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.data?.storyId).toBe("_run");
  });

  test("AC-5: no step wired, no field on the record", async () => {
    const h = harness();
    const final = await runFeatureMachine(h.env);
    expect(final.step).toBe("done");
    expect("flaggedDecisions" in final).toBe(false);
  });
});

describe("buildFeatureEnv — the collected ids reach result.json (US-005)", () => {
  test("AC-6: the publish step's sink.update persists the trusted flagged id", async () => {
    const repo = makeTempDir("flag-repo-");
    const runDir = makeTempDir("flag-run-");
    dirs.push(repo, runDir);
    const outputDir = join(repo, "out");
    const feature = "f";
    // A real ledger entry with the matching audit artifact: readTrustedDecisions trusts this one.
    const trusted = await appendDecision(repo, feature, (id) =>
      draft({ needsHumanConfirm: true, auditRef: `advisor-audit/${feature}/${id}.json` }),
    );
    await Bun.write(join(outputDir, trusted.auditRef), JSON.stringify({ result: { decision: trusted } }));
    _workflowDeps.createAdvisor = () => noDecisions;
    const fc = makeFeatureContext({ runDir, projectDir: repo, outputDir, feature });
    const env = buildFeatureEnv(
      fc,
      {
        runtime: fc.callCtx.runtime,
        config: fc.config,
        prd: fc.prd,
        feature: fc.feature,
        workdir: fc.projectDir,
        branch: fc.branch,
        runId: fc.runId,
        agentName: "claude",
        statusWriter: { setWorkflowStatus: () => {} },
      },
      {
        stories: STORIES,
        ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
        record: atPublish(),
        meter: startTokenMeter(undefined),
        preflight: null,
        specPath: "",
      },
    );
    env.steps.publish = async () => PUBLISHED;
    const final = await runFeatureMachine(env);
    expect(final.flaggedDecisions).toEqual([trusted.id]);
    expect((await readResult(runDir))?.featureWorkflow?.flaggedDecisions).toEqual([trusted.id]);
  });
});

/**
 * US-002: the publish step splits the one list the step returned into the ids the record already
 * carried and a new id-to-summary map, in one place. The map is what an open item names its
 * decision by; it is written only when there are ids, so an empty ledger leaves no key at all.
 */
describe("runFeatureMachine — publish records the decision summaries (US-002)", () => {
  test("AC-9: the flagged ids land on the record", async () => {
    const h = harness({ flagged: async () => [KEEP_LOCK] });
    const final = await runFeatureMachine(h.env);
    expect(final.flaggedDecisions).toEqual(["D-1"]);
  });

  test("AC-10: their summaries land beside them", async () => {
    const h = harness({ flagged: async () => [KEEP_LOCK] });
    const final = await runFeatureMachine(h.env);
    expect(final.flaggedDecisionSummaries).toEqual({ "D-1": "Keep the lock" });
  });

  test("AC-11: an empty list leaves no summaries key on the record", async () => {
    // An earlier publish had flagged D-9 and recorded its summary; this one flags nothing. The map
    // must be *cleared*, not merely omitted from the patch — a key the patch leaves out keeps what
    // the earlier publish recorded — and it must not turn into the empty `{}` that
    // `Object.fromEntries([])` would give a patch that wrote it unconditionally.
    const h = harness({
      flagged: async () => [],
      record: {
        ...atPublish(),
        flaggedDecisions: ["D-9"],
        flaggedDecisionSummaries: { "D-9": "old summary" },
      },
    });
    const final = await runFeatureMachine(h.env);
    expect(final.flaggedDecisions).toEqual([]);
    expect("flaggedDecisionSummaries" in final).toBe(false);
  });

  // The runner refuses any patched key its node's `produces` does not declare
  // (`STEP_GRAPH_UNDECLARED_OUTPUT`, src/step-graph/run.ts) — so a run that reaches `done` with the
  // map written is the proof the `publish` node declares it.
  test("AC-15: the publish node completes instead of refusing an undeclared summaries key", async () => {
    const h = harness({ flagged: async () => [KEEP_LOCK] });
    const final = await runFeatureMachine(h.env);
    expect(final.step).toBe("done");
    expect(final.flaggedDecisionSummaries).toEqual({ "D-1": "Keep the lock" });
  });
});
