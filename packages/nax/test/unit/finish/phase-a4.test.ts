/** A4 Task 14: the finish phase's draft/failed reporting, run summary, notify modes and deprecation warning. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeTestRuntime } from "@test/helpers";
import type { FinishContext, FinishPhaseContext, FinishResult } from "@/finish";
import { _finishPhaseDeps, runFinishPhase } from "@/finish";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

const PROCEED: FinishContext = {
  base: "origin/main",
  specPath: "spec.md",
  acceptanceStatus: "disabled",
  groups: [],
  testFileRegex: [],
  commitsAhead: 3,
  route: "proceed",
};

let saved: typeof _finishPhaseDeps;
let entries: LogEntry[];
let updates: Array<Record<string, unknown>>;
let sent: string[];
let completed: boolean[];

beforeEach(() => {
  saved = { ..._finishPhaseDeps };
  entries = [];
  updates = [];
  sent = [];
  completed = [];
  resetLogger();
  initLogger({ level: "info", headless: true, useChalk: false });
  addSink((entry) => entries.push(entry));
  _finishPhaseDeps.loadFinishContext = async () => PROCEED;
  _finishPhaseDeps.detectForge = async () => "github";
  _finishPhaseDeps.sendTelegramNotify = async (_c, text) => {
    sent.push(text);
    return true;
  };
});

afterEach(() => {
  Object.assign(_finishPhaseDeps, saved);
  resetLogger();
});

function stubMachine(result: FinishResult): void {
  _finishPhaseDeps.runFinishMachine = async () => result;
}

function ctxFor(finish: Record<string, unknown> = {}, telegram = true): FinishPhaseContext {
  return {
    runtime: makeTestRuntime(),
    config: {
      finish: { enabled: true, ...finish },
      ...(telegram ? { interaction: { plugin: "telegram", config: { botToken: "tok", chatId: "chat" } } } : {}),
    },
    feature: "f",
    workdir: "/tmp/finish-phase-a4",
    branch: "feat/x",
    runId: "run-1",
    agentName: "claude",
    abortSignal: new AbortController().signal,
    storySummary: { completed: 1, failed: 0, paused: 0 },
    packageDirs: [],
    statusWriter: {
      setPostRunPhase: (_phase, update) => {
        updates.push(update);
      },
    },
  };
}

function terminal(): Record<string, unknown> {
  const last = updates[updates.length - 1];
  assertDefined(last);
  return last;
}

describe("runFinishPhase - outcome keyed status (A4)", () => {
  test("a draft result is not passed and reports status draft with outcome and reason", async () => {
    stubMachine({ feature: "f", status: "draft", outcome: "draft", reason: "gate red", url: "https://x/pr/1" });
    const result = await runFinishPhase(ctxFor());
    expect(result?.status).toBe("draft");
    expect(terminal()).toMatchObject({
      status: "draft",
      result: "draft",
      outcome: "draft",
      reason: "gate red",
      url: "https://x/pr/1",
    });
    expect("escalationReason" in terminal()).toBe(false);
  });

  test("a ready PR that a human had already marked ready, finalized as draft outcome, is not passed", async () => {
    stubMachine({ feature: "f", status: "already-ready", outcome: "draft", reason: "open findings" });
    await runFinishPhase(ctxFor());
    expect(terminal()).toMatchObject({ status: "failed", result: "already-ready", outcome: "draft" });
  });

  test("outcome ready is passed", async () => {
    stubMachine({ feature: "f", status: "promoted", outcome: "ready", url: "https://x/pr/2" });
    await runFinishPhase(ctxFor());
    expect(terminal()).toMatchObject({ status: "passed", result: "promoted", outcome: "ready" });
  });

  test("nothing-to-finish is passed without an outcome", async () => {
    stubMachine({ feature: "f", status: "nothing-to-finish" });
    await runFinishPhase(ctxFor());
    expect(terminal()).toMatchObject({ status: "passed", result: "nothing-to-finish" });
  });

  test("a failed result is failed", async () => {
    stubMachine({ feature: "f", status: "failed", outcome: "failed", reason: "gh: not authenticated" });
    await runFinishPhase(ctxFor());
    expect(terminal()).toMatchObject({ status: "failed", outcome: "failed", reason: "gh: not authenticated" });
  });

  test("postrun:phase:completed carries passed false for a draft", async () => {
    stubMachine({ feature: "f", status: "draft", outcome: "draft", reason: "r" });
    const { pipelineEventBus } = await import("@/pipeline");
    const off = pipelineEventBus.onAll((e) => {
      if (e.type === "postrun:phase:completed") completed.push(e.passed);
    });
    try {
      await runFinishPhase(ctxFor());
    } finally {
      off();
    }
    expect(completed).toEqual([false]);
  });
});

describe("runFinishPhase - run summary line (A-8)", () => {
  test("a ready PR with no reason logs clean", async () => {
    stubMachine({ feature: "f", status: "promoted", outcome: "ready", url: "https://x/pr/3" });
    await runFinishPhase(ctxFor());
    const line = entries.find((e) => e.message === "PR https://x/pr/3 opened (ready): clean");
    assertDefined(line);
    expect(Object.keys(line.data ?? {})[0]).toBe("storyId");
    expect(line.data?.storyId).toBe("_run");
  });

  test("a draft PR logs its reason", async () => {
    stubMachine({
      feature: "f",
      status: "draft",
      outcome: "draft",
      reason: "spec review missing",
      url: "https://x/pr/4",
    });
    await runFinishPhase(ctxFor());
    expect(entries.some((e) => e.message === "PR https://x/pr/4 opened (draft): spec review missing")).toBe(true);
  });

  test("local-only logs local-only", async () => {
    stubMachine({ feature: "f", status: "local-only", outcome: "ready" });
    await runFinishPhase(ctxFor());
    expect(entries.some((e) => e.message === "local-only")).toBe(true);
  });

  test("failed logs failed with the reason", async () => {
    stubMachine({ feature: "f", status: "failed", outcome: "failed", reason: "boom" });
    await runFinishPhase(ctxFor());
    expect(entries.some((e) => e.message === "failed: boom")).toBe(true);
  });
});

describe("runFinishPhase - deprecated narrative config (A-7)", () => {
  const deprecated = () => entries.filter((e) => e.message.includes("are deprecated and ignored (A4)"));

  test("finish.narrative false logs one warning", async () => {
    stubMachine({ feature: "f", status: "promoted", outcome: "ready" });
    await runFinishPhase(ctxFor({ narrative: false }));
    expect(deprecated()).toHaveLength(1);
    expect(deprecated()[0]?.level).toBe("warn");
    expect(deprecated()[0]?.message).toBe(
      "finish.narrative / finish.reviewers.narrative are deprecated and ignored (A4)",
    );
  });

  test("a reviewers.narrative model logs one warning", async () => {
    stubMachine({ feature: "f", status: "promoted", outcome: "ready" });
    await runFinishPhase(ctxFor({ reviewers: { narrative: "fast" } }));
    expect(deprecated()).toHaveLength(1);
  });

  test("the parsed defaults (narrative true, reviewers.narrative null) log nothing", async () => {
    stubMachine({ feature: "f", status: "promoted", outcome: "ready" });
    await runFinishPhase(ctxFor({ narrative: true, reviewers: { narrative: null } }));
    expect(deprecated()).toHaveLength(0);
  });
});

describe("runFinishPhase - notify modes (A4)", () => {
  const results: Record<string, FinishResult> = {
    draft: { feature: "f", status: "draft", outcome: "draft", reason: "gate red", findings: [] },
    failed: { feature: "f", status: "failed", outcome: "failed", reason: "boom" },
    promoted: { feature: "f", status: "promoted", outcome: "ready", url: "https://x/pr/5" },
  };

  test.each([
    ["draft", "draft", true],
    ["draft", "promoted", false],
    ["draft", "failed", true],
    ["escalation", "draft", true],
    ["escalation", "promoted", false],
    ["always", "promoted", true],
    ["off", "draft", false],
  ])("mode %s, status %s -> notified %s", async (mode, status, notified) => {
    const result = results[status];
    assertDefined(result);
    stubMachine(result);
    await runFinishPhase(ctxFor({ notify: { mode } }));
    expect(sent.length > 0).toBe(notified);
  });

  test("a failed message reads as failed, not as a draft", async () => {
    const result = results.failed;
    assertDefined(result);
    stubMachine(result);
    await runFinishPhase(ctxFor({ notify: { mode: "draft" } }));
    expect(sent[0]).toBe("nax-finish failed f: boom");
  });

  test("escalate.telegram false suppresses draft and failed messages", async () => {
    for (const status of ["draft", "failed"]) {
      const result = results[status];
      assertDefined(result);
      stubMachine(result);
      await runFinishPhase(ctxFor({ notify: { mode: "always" }, escalate: { telegram: false } }));
    }
    expect(sent).toEqual([]);
  });

  test("escalate.telegram false does not silence a clean outcome under notify always", async () => {
    const result = results.promoted;
    assertDefined(result);
    stubMachine(result);
    await runFinishPhase(ctxFor({ notify: { mode: "always" }, escalate: { telegram: false } }));
    expect(sent).toHaveLength(1);
  });

  test("a draft message names the feature and reason", async () => {
    const result = results.draft;
    assertDefined(result);
    stubMachine(result);
    await runFinishPhase(ctxFor({ notify: { mode: "draft" } }));
    expect(sent[0]).toContain("nax-finish draft f");
    expect(sent[0]).toContain("gate red");
  });
});
