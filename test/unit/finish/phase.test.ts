import { afterEach, describe, expect, test } from "bun:test";
import { _finishPhaseDeps, runFinishPhase, shouldRunFinish } from "@/finish";
import type { FinishPhaseContext } from "@/finish";
import type { FinishContext } from "@/finish";
import { pipelineEventBus } from "@/pipeline";
import { makeTestRuntime } from "@test/helpers";

describe("shouldRunFinish", () => {
  const base = { enabled: true, branch: "feat/x", storySummary: { completed: 2, failed: 0, paused: 0 } };

  test("runs on a feature branch with a clean summary", () => {
    expect(shouldRunFinish(base)).toBe(true);
  });
  test("disabled config never runs", () => {
    expect(shouldRunFinish({ ...base, enabled: false })).toBe(false);
  });
  test("a failed story blocks it", () => {
    expect(shouldRunFinish({ ...base, storySummary: { completed: 2, failed: 1, paused: 0 } })).toBe(false);
  });
  test("a paused story blocks it", () => {
    expect(shouldRunFinish({ ...base, storySummary: { completed: 2, failed: 0, paused: 1 } })).toBe(false);
  });
  test("zero completed stories blocks it", () => {
    expect(shouldRunFinish({ ...base, storySummary: { completed: 0, failed: 0, paused: 0 } })).toBe(false);
  });
  test("main and master are not feature branches", () => {
    expect(shouldRunFinish({ ...base, branch: "main" })).toBe(false);
    expect(shouldRunFinish({ ...base, branch: "master" })).toBe(false);
    expect(shouldRunFinish({ ...base, branch: "" })).toBe(false);
  });
});

/** The `route: "proceed"` `FinishContext` shared by every `runFinishPhase` case below. */
function proceedContext(): FinishContext {
  return {
    base: "origin/main",
    specPath: "spec.md",
    acceptanceStatus: "disabled",
    groups: [],
    testFileRegex: [],
    commitsAhead: 3,
    route: "proceed",
  };
}

/**
 * Builds a `FinishPhaseContext` over a real `makeTestRuntime()` — never a hand-built
 * fake, which would need an unsafe double cast to `NaxRuntime` and grow a baselined ratchet.
 */
function makeCtx(opts?: {
  emit?: (e: { type: string; phase?: string; costUsd?: number; passed?: boolean }) => void;
  telegram?: boolean;
  notifyMode?: "escalation" | "always" | "off";
}): FinishPhaseContext {
  const unsubscribers: Array<() => void> = [];
  if (opts?.emit) {
    unsubscribers.push(pipelineEventBus.onAll((e) => opts.emit?.(e as never)));
  }
  registeredUnsubscribers.push(...unsubscribers);

  const config = {
    finish: {
      enabled: true,
      notify: { mode: opts?.notifyMode ?? "escalation" },
    },
    ...(opts?.telegram
      ? { interaction: { plugin: "telegram", config: { botToken: "tok", chatId: "chat" } } }
      : {}),
  };

  return {
    runtime: makeTestRuntime(),
    config,
    feature: "f",
    workdir: "/tmp/finish-phase-test",
    branch: "feat/x",
    runId: "run-1",
    agentName: "claude",
    abortSignal: new AbortController().signal,
    storySummary: { completed: 1, failed: 0, paused: 0 },
  };
}

let registeredUnsubscribers: Array<() => void> = [];

afterEach(() => {
  for (const unsub of registeredUnsubscribers) unsub();
  registeredUnsubscribers = [];
});

describe("runFinishPhase", () => {
  test("emits started and completed with the cost delta", async () => {
    const events: Array<{ type: string; phase?: string; costUsd?: number; passed?: boolean }> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => ({
      base: "origin/main",
      specPath: "spec.md",
      acceptanceStatus: "disabled",
      groups: [],
      testFileRegex: [],
      commitsAhead: 3,
      route: "proceed",
    });
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "already-ready" });
    let costReadings = [1.0, 1.25];
    _finishPhaseDeps.snapshotCost = () => costReadings.shift() ?? 0;
    try {
      const result = await runFinishPhase(makeCtx({ emit: (e) => events.push(e) }));
      expect(result?.status).toBe("already-ready");
      expect(events.map((e) => e.type)).toEqual(["postrun:phase:started", "postrun:phase:completed"]);
      expect(events[1].phase).toBe("finish");
      expect(events[1].costUsd).toBeCloseTo(0.25);
      expect(events[1].passed).toBe(true);
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("a throw from the machine is swallowed and reported as a failed phase", async () => {
    const events: Array<{ type: string; passed?: boolean }> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => {
      throw new Error("boom");
    };
    try {
      const result = await runFinishPhase(makeCtx({ emit: (e) => events.push(e) }));
      expect(result).toBeNull();
      expect(events[1]).toMatchObject({ type: "postrun:phase:completed", passed: false });
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("an escalated result with telegram configured sends the escalation message", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "escalated",
      escalationReason: "needs a human",
      findings: [{ severity: "HIGH", title: "t", problem: "p", fix: "x" }],
    });
    _finishPhaseDeps.sendTelegramNotify = async (_creds, text) => {
      sent.push(text);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: true }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("needs a human");
      expect(sent[0]).toContain("[HIGH] t");
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("notify.mode 'off' sends nothing even on an escalation", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "escalated",
      escalationReason: "r",
      findings: [],
    });
    _finishPhaseDeps.sendTelegramNotify = async (_c, t) => {
      sent.push(t);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: true, notifyMode: "off" }));
      expect(sent).toEqual([]);
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("notify.mode 'always' notifies a non-escalated terminal outcome", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "opened",
      url: "https://github.com/o/r/pull/9",
    });
    _finishPhaseDeps.sendTelegramNotify = async (_c, t) => {
      sent.push(t);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: true, notifyMode: "always" }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("opened");
      expect(sent[0]).toContain("https://github.com/o/r/pull/9");
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("telegram enabled but uncredentialed sends nothing and does not throw", async () => {
    const sent: string[] = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "escalated", findings: [] });
    _finishPhaseDeps.sendTelegramNotify = async (_c, t) => {
      sent.push(t);
      return true;
    };
    try {
      await runFinishPhase(makeCtx({ telegram: false }));
      expect(sent).toEqual([]);
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });
});
