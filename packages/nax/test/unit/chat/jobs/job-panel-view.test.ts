import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import { decisionBody } from "@/advisor";
import type { AdviceDecision } from "@/advisor/types";
import {
  _jobPanelDeps,
  buildJobPanelView,
  JOB_PANEL_LOG_LINES,
  type JobPanelSources,
  readJobPanelView,
} from "@/chat/jobs/job-panel-view";
import type { ChatJob } from "@/chat/jobs/job-types";
import type { NaxStatusFile } from "@/execution/status-file";
import type { StoryStatus } from "@/prd";

const STARTED_AT = "2026-10-01T10:00:00.000Z";
const NOW = new Date("2026-10-01T10:42:00.000Z");

function jobOf(overrides: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "chat-job-panel",
    argv: ["nax", "run", "-f", "chat-job-panel"],
    cwd: "/fixture/repo",
    pid: 4242,
    startedAt: STARTED_AT,
    state: "running",
    logPath: "/fixture/job.log",
    sessionId: "session-1",
    approvedAt: STARTED_AT,
    ...overrides,
  };
}

interface StatusOptions {
  readonly cost?: number;
  readonly passed?: number;
  readonly total?: number;
  readonly current?: NaxStatusFile["current"];
}

function statusOf(options: StatusOptions = {}): NaxStatusFile {
  const { cost = 3.18, passed = 4, total = 13, current = null } = options;
  return {
    version: 1,
    run: {
      id: "run-1",
      feature: "chat-job-panel",
      startedAt: STARTED_AT,
      status: "running",
      dryRun: false,
      pid: 4242,
    },
    progress: { total, passed, failed: 0, paused: 0, blocked: 0, pending: total - passed },
    cost: { spent: cost, limit: null },
    current,
    iterations: 1,
    updatedAt: STARTED_AT,
    durationMs: 60_000,
  };
}

function currentOf(storyId: string, phase: string): NonNullable<NaxStatusFile["current"]> {
  return {
    storyId,
    title: `${storyId} title`,
    complexity: "medium",
    tddStrategy: "standard",
    model: "m",
    attempt: 1,
    phase,
  };
}

function storyOf(id: string, status: StoryStatus = "pending") {
  return { id, title: `${id} title`, status };
}

function decisionOf(overrides: Partial<AdviceDecision> = {}): AdviceDecision {
  return {
    id: "D-1",
    questionId: "Q-1",
    kind: "implementer-question",
    chosenOptionId: "fix",
    action: { type: "fix", instruction: "pin the fallback" },
    rationale: "the spec says so",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "2026-10-01T10:05:00.000Z",
    model: "claude-opus-4",
    memoryMode: "stateless",
    auditRef: "advisor-audit/chat-job-panel/D-1.json",
    ...overrides,
  };
}

function sourcesOf(overrides: Partial<JobPanelSources> = {}): JobPanelSources {
  return {
    job: jobOf(),
    now: NOW,
    status: null,
    stories: [],
    decisions: [],
    logTail: "",
    ...overrides,
  };
}

describe("buildJobPanelView elapsed", () => {
  test("AC-1 a running job measures elapsed from startedAt to now", () => {
    expect(buildJobPanelView(sourcesOf()).elapsedMs).toBe(2_520_000);
  });

  test("AC-2 an ended job measures elapsed from endedAt, not now", () => {
    const job = jobOf({ state: "succeeded", endedAt: "2026-10-01T10:05:00.000Z" });
    expect(buildJobPanelView(sourcesOf({ job })).elapsedMs).toBe(300_000);
  });

  test("an endedAt before startedAt floors the elapsed time at 0", () => {
    const job = jobOf({ state: "failed", endedAt: "2026-10-01T09:59:00.000Z" });
    expect(buildJobPanelView(sourcesOf({ job })).elapsedMs).toBe(0);
  });
});

describe("buildJobPanelView cost and progress", () => {
  test("AC-3 status cost outranks the job record's cost", () => {
    const view = buildJobPanelView(sourcesOf({ job: jobOf({ cost: 0.5 }), status: statusOf({ cost: 3.18 }) }));
    expect(view.cost).toBe(3.18);
  });

  test("AC-4 no status falls back to the job record's cost", () => {
    expect(buildJobPanelView(sourcesOf({ job: jobOf({ cost: 1.234 }), status: null })).cost).toBe(1.234);
  });

  test("AC-4 a job with neither source has no cost", () => {
    expect(buildJobPanelView(sourcesOf()).cost).toBeUndefined();
  });

  test("AC-5 status progress projects only passed and total", () => {
    const job = jobOf({ progress: { passed: 1, total: 2 } });
    const view = buildJobPanelView(sourcesOf({ job, status: statusOf({ passed: 4, total: 13 }) }));
    expect(view.progress).toEqual({ passed: 4, total: 13 });
  });

  test("AC-5 no status falls back to the job record's progress", () => {
    const job = jobOf({ progress: { passed: 2, total: 9 } });
    expect(buildJobPanelView(sourcesOf({ job })).progress).toEqual({ passed: 2, total: 9 });
  });
});

describe("buildJobPanelView current and stories", () => {
  test("AC-6 a running job takes current from the status file", () => {
    const status = statusOf({ current: currentOf("US-005", "review") });
    expect(buildJobPanelView(sourcesOf({ status })).current).toEqual({ storyId: "US-005", phase: "review" });
  });

  test("AC-7 a succeeded job has no current story", () => {
    const status = statusOf({ current: currentOf("US-005", "review") });
    const view = buildJobPanelView(sourcesOf({ job: jobOf({ state: "succeeded" }), status }));
    expect(view.current).toBeUndefined();
  });

  test("AC-8 stories keep PRD order and mark only the current story", () => {
    const stories = [storyOf("US-001", "passed"), storyOf("US-005", "in-progress"), storyOf("US-007")];
    const status = statusOf({ current: currentOf("US-005", "review") });
    expect(buildJobPanelView(sourcesOf({ stories, status })).stories).toEqual([
      { id: "US-001", title: "US-001 title", status: "passed", current: false },
      { id: "US-005", title: "US-005 title", status: "in-progress", current: true },
      { id: "US-007", title: "US-007 title", status: "pending", current: false },
    ]);
  });

  test("AC-8 an ended job marks no story current", () => {
    const stories = [storyOf("US-005", "passed")];
    const status = statusOf({ current: currentOf("US-005", "review") });
    const view = buildJobPanelView(sourcesOf({ job: jobOf({ state: "failed" }), stories, status }));
    expect(view.stories.map((story) => story.current)).toEqual([false]);
  });
});

describe("buildJobPanelView decisions", () => {
  test("AC-9 drops decisions decided before the job started", () => {
    const before = decisionOf({ id: "D-1", decidedAt: "2026-10-01T09:55:00.000Z" });
    const atStart = decisionOf({ id: "D-2", decidedAt: STARTED_AT });
    const later = decisionOf({ id: "D-3", decidedAt: "2026-10-01T10:20:00.000Z" });
    const lines = buildJobPanelView(sourcesOf({ decisions: [before, atStart, later] })).decisions.map(
      (decision) => decision.line,
    );
    expect(lines).toEqual([decisionBody(later), decisionBody(atStart)]);
  });

  test("AC-9 drops a decision whose decidedAt does not parse", () => {
    const decisions = [decisionOf({ decidedAt: "not a timestamp" })];
    expect(buildJobPanelView(sourcesOf({ decisions })).decisions).toEqual([]);
  });

  test("AC-10 each decision line is decisionBody of the decision, flagged from needsHumanConfirm", () => {
    const decision = decisionOf({ needsHumanConfirm: true });
    const view = buildJobPanelView(sourcesOf({ decisions: [decision] }));
    expect(view.decisions[0]).toEqual({
      line: "[implementer-question] feature: fix: pin the fallback (confidence high)",
      flagged: true,
    });
    expect(view.decisions[0]?.line).toBe(decisionBody(decision));
  });

  test("AC-11 a flagged decision outranks an unflagged one decided later", () => {
    const flagged = decisionOf({ id: "D-1", needsHumanConfirm: true, decidedAt: "2026-10-01T10:01:00.000Z" });
    const later = decisionOf({ id: "D-2", decidedAt: "2026-10-01T10:30:00.000Z" });
    const view = buildJobPanelView(sourcesOf({ decisions: [later, flagged] }));
    expect(view.decisions.map((decision) => decision.line)).toEqual([decisionBody(flagged), decisionBody(later)]);
  });

  test("AC-12 two unflagged decisions list the newest first", () => {
    const older = decisionOf({ id: "D-1", decidedAt: "2026-10-01T10:01:00.000Z" });
    const newer = decisionOf({ id: "D-2", decidedAt: "2026-10-01T10:30:00.000Z" });
    const view = buildJobPanelView(sourcesOf({ decisions: [older, newer] }));
    expect(view.decisions.map((decision) => decision.line)).toEqual([decisionBody(newer), decisionBody(older)]);
  });
});

describe("buildJobPanelView log tail", () => {
  test("AC-13 keeps the last JOB_PANEL_LOG_LINES lines of a twenty line tail", () => {
    const logTail = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const view = buildJobPanelView(sourcesOf({ logTail }));
    expect(JOB_PANEL_LOG_LINES).toBe(12);
    expect(view.logTail).toHaveLength(JOB_PANEL_LOG_LINES);
    expect(view.logTail[0]).toBe("line 9");
    expect(view.logTail.at(-1)).toBe("line 20");
  });

  test("AC-14 drops empty lines before taking the tail", () => {
    const view = buildJobPanelView(sourcesOf({ logTail: "first\n\n  \nsecond\n" }));
    expect(view.logTail).toEqual(["first", "second"]);
  });
});

const REPO_ROOT = "/fixture/repo";
const FEATURE = "chat-job-panel";

type PanelDeps = typeof _jobPanelDeps;
let savedDeps: PanelDeps;

beforeEach(() => {
  savedDeps = { ..._jobPanelDeps };
});

afterEach(() => {
  Object.assign(_jobPanelDeps, savedDeps);
});

function stubDeps(overrides: Partial<PanelDeps>): void {
  Object.assign(_jobPanelDeps, overrides);
}

function logOf(text: string): { logTail: (id: string, lines?: number) => Promise<string> } {
  return { logTail: async () => text };
}

function prdWith(stories: readonly { id: string; title: string; status: StoryStatus }[]) {
  return makePRD({
    userStories: stories.map((story) => makeStory({ id: story.id, title: story.title, status: story.status })),
  });
}

describe("readJobPanelView sources", () => {
  test("AC-15 a run job reads the feature's decisions through _jobPanelDeps", async () => {
    const readDecisions = mock(async () => [decisionOf()]);
    stubDeps({ readDecisions });
    const view = await readJobPanelView(jobOf(), logOf(""), NOW);
    expect(readDecisions).toHaveBeenCalledWith(REPO_ROOT, FEATURE);
    expect(view.decisions).toHaveLength(1);
  });

  test("AC-15 a run job projects its PID-matched status and PRD stories", async () => {
    stubDeps({
      readJobStatus: async () => statusOf({ cost: 3.18, passed: 4, total: 13, current: currentOf("US-005", "review") }),
      exists: async () => true,
      loadPRD: async () => prdWith([storyOf("US-001", "passed"), storyOf("US-005", "in-progress")]),
    });
    const view = await readJobPanelView(jobOf(), logOf(""), NOW);
    expect(view.cost).toBe(3.18);
    expect(view.progress).toEqual({ passed: 4, total: 13 });
    expect(view.current).toEqual({ storyId: "US-005", phase: "review" });
    expect(view.stories.map((story) => [story.id, story.current])).toEqual([
      ["US-001", false],
      ["US-005", true],
    ]);
  });

  test("AC-16 a plan job has no status, stories or decisions", async () => {
    const readDecisions = mock(async () => [decisionOf()]);
    const readJobStatus = mock(async () => statusOf());
    const loadPRD = mock(async () => prdWith([storyOf("US-001")]));
    const exists = mock(async () => true);
    stubDeps({ readDecisions, readJobStatus, loadPRD, exists });
    const job = jobOf({ kind: "plan", id: "plan-1a2b3c4d" });
    const view = await readJobPanelView(job, logOf(""), NOW);
    expect(view.stories).toEqual([]);
    expect(view.decisions).toEqual([]);
    expect(readDecisions).not.toHaveBeenCalled();
    expect(readJobStatus).not.toHaveBeenCalled();
    expect(loadPRD).not.toHaveBeenCalled();
  });

  test("AC-16 a bot job has no status, stories or decisions", async () => {
    const readDecisions = mock(async () => [decisionOf()]);
    stubDeps({ readDecisions });
    const job = jobOf({ kind: "bot_review", id: "bot_review-1a2b3c4d", target: "2936" });
    const view = await readJobPanelView(job, logOf(""), NOW);
    expect(view.decisions).toEqual([]);
    expect(readDecisions).not.toHaveBeenCalled();
  });

  test("AC-17 a rejected decisions read leaves the panel with no decisions", async () => {
    stubDeps({
      readDecisions: async () => {
        throw new Error("decisions.jsonl is not readable");
      },
      readJobStatus: async () => statusOf(),
      exists: async () => true,
      loadPRD: async () => prdWith([storyOf("US-001", "passed")]),
    });
    const view = await readJobPanelView(jobOf(), logOf("hello"), NOW);
    expect(view.decisions).toEqual([]);
    expect(view.stories).toHaveLength(1);
    expect(view.cost).toBe(3.18);
  });

  test("AC-18 no prd.json leaves the panel with no stories and never loads a PRD", async () => {
    const loadPRD = mock(async () => prdWith([]));
    stubDeps({ exists: async () => false, loadPRD, readJobStatus: async () => statusOf() });
    const view = await readJobPanelView(jobOf(), logOf("hello"), NOW);
    expect(view.stories).toEqual([]);
    expect(loadPRD).not.toHaveBeenCalled();
    expect(view.cost).toBe(3.18);
  });

  test("AC-19 a rejected log tail leaves an empty logTail", async () => {
    stubDeps({ readJobStatus: async () => statusOf() });
    const jobs = {
      logTail: async () => {
        throw new Error("log file vanished");
      },
    };
    const view = await readJobPanelView(jobOf(), jobs, NOW);
    expect(view.logTail).toEqual([]);
    expect(view.cost).toBe(3.18);
  });

  test("AC-21 a missing status falls back to the job record and keeps the other sources", async () => {
    stubDeps({
      readJobStatus: async () => null,
      exists: async () => true,
      loadPRD: async () => prdWith([storyOf("US-001", "passed")]),
      readDecisions: async () => [decisionOf()],
    });
    const job = jobOf({ cost: 1.5, progress: { passed: 1, total: 3 } });
    const view = await readJobPanelView(job, logOf("hello"), NOW);
    expect(view.cost).toBe(1.5);
    expect(view.progress).toEqual({ passed: 1, total: 3 });
    expect(view.stories).toHaveLength(1);
    expect(view.decisions).toHaveLength(1);
    expect(view.logTail).toEqual(["hello"]);
  });

  test("AC-21 an unreadable status falls back to the job record too", async () => {
    stubDeps({
      readJobStatus: async () => {
        throw new Error("status.json is not readable");
      },
      exists: async () => true,
      loadPRD: async () => prdWith([storyOf("US-001", "passed")]),
    });
    const job = jobOf({ cost: 2.5, progress: { passed: 2, total: 5 } });
    const view = await readJobPanelView(job, logOf("hello"), NOW);
    expect(view.cost).toBe(2.5);
    expect(view.progress).toEqual({ passed: 2, total: 5 });
    expect(view.stories).toHaveLength(1);
    expect(view.logTail).toEqual(["hello"]);
  });

  test("AC-22 a rejecting PRD load leaves the panel with no stories", async () => {
    stubDeps({
      exists: async () => true,
      loadPRD: async () => {
        throw new Error("prd.json is not readable");
      },
      readJobStatus: async () => statusOf(),
      readDecisions: async () => [decisionOf()],
    });
    const view = await readJobPanelView(jobOf(), logOf("hello"), NOW);
    expect(view.stories).toEqual([]);
    expect(view.cost).toBe(3.18);
    expect(view.decisions).toHaveLength(1);
    expect(view.logTail).toEqual(["hello"]);
  });

  test("AC-23 a missing decisions ledger leaves the panel with no decisions", async () => {
    stubDeps({
      readDecisions: async () => [],
      readJobStatus: async () => statusOf(),
      exists: async () => true,
      loadPRD: async () => prdWith([storyOf("US-001", "passed")]),
    });
    const view = await readJobPanelView(jobOf(), logOf("hello"), NOW);
    expect(view.decisions).toEqual([]);
    expect(view.stories).toHaveLength(1);
    expect(view.cost).toBe(3.18);
    expect(view.logTail).toEqual(["hello"]);
  });

  test("the panel identity mirrors the job record and asks the log for JOB_PANEL_LOG_LINES", async () => {
    const logTail = mock(async () => "");
    const view = await readJobPanelView(jobOf(), { logTail }, NOW);
    expect(view).toMatchObject({
      jobId: "run-1a2b3c4d",
      kind: "run",
      target: FEATURE,
      state: "running",
      elapsedMs: 2_520_000,
    });
    expect(logTail).toHaveBeenCalledWith("run-1a2b3c4d", JOB_PANEL_LOG_LINES);
  });
});
