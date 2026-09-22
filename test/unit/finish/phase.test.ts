import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { makeTestRuntime, withInfoSpy } from "@test/helpers";
import type { FinishContext, FinishPhaseContext } from "@/finish";
import { _finishPhaseDeps, finishSkipReason, runFinishPhase, shouldRunFinish } from "@/finish";
import { pipelineEventBus } from "@/pipeline";
import type { PipelineEvent } from "@/pipeline/event-bus";

describe("_finishPhaseDeps.snapshotCost", () => {
  test("counts failed-dispatch spend as money the phase spent", () => {
    // The finish phase's reported cost is a before/after delta of this reading.
    // Taking only `totalCostUsd` would report a phase that burned money on
    // dispatches that threw as having cost less than it did.
    const runtime = makeTestRuntime();
    // Capture the real aggregator first: reading `runtime.costAggregator`
    // inside the replacement resolves to the replacement itself and recurses.
    const realAggregator = runtime.costAggregator;
    Object.defineProperty(runtime, "costAggregator", {
      value: {
        ...realAggregator,
        snapshot: () => ({ ...realAggregator.snapshot(), totalCostUsd: 2, totalErrorCostUsd: 3 }),
      },
      writable: true,
    });

    expect(_finishPhaseDeps.snapshotCost(runtime)).toBeCloseTo(5, 5);
  });
});

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

describe("finishSkipReason", () => {
  const base = { enabled: true, branch: "feat/x", storySummary: { completed: 2, failed: 0, paused: 0 } };

  test("a clean run passes with null", () => {
    expect(finishSkipReason(base)).toBeNull();
  });
  test("disabled reports 'enabled'", () => {
    expect(finishSkipReason({ ...base, enabled: false })).toBe("enabled");
  });
  test("zero completed reports 'completed'", () => {
    expect(finishSkipReason({ ...base, storySummary: { completed: 0, failed: 0, paused: 0 } })).toBe("completed");
  });
  test("a failed story reports 'failed'", () => {
    expect(finishSkipReason({ ...base, storySummary: { completed: 2, failed: 1, paused: 0 } })).toBe("failed");
  });
  test("a paused story reports 'paused'", () => {
    expect(finishSkipReason({ ...base, storySummary: { completed: 2, failed: 0, paused: 1 } })).toBe("paused");
  });
  test("main/master report 'branch'", () => {
    expect(finishSkipReason({ ...base, branch: "main" })).toBe("branch");
    expect(finishSkipReason({ ...base, branch: "master" })).toBe("branch");
  });
});

describe("finishSkipReason — dry run (nax#1809)", () => {
  const base = { enabled: true, branch: "feat/x", storySummary: { completed: 2, failed: 0, paused: 0 } };

  test("a dry run skips even when every other gate clause passes", () => {
    expect(finishSkipReason({ ...base, dryRun: true })).toBe("dry-run");
  });

  test("shouldRunFinish mirrors the skip", () => {
    expect(shouldRunFinish({ ...base, dryRun: true })).toBe(false);
  });
});

describe("runFinishPhase — dry run (nax#1809)", () => {
  test("returns null without entering the machine and without recording a finish status", async () => {
    const machineSpy = spyOn(_finishPhaseDeps, "runFinishMachine").mockImplementation(async () => {
      throw new Error("finish machine ran under a dry run");
    });
    let recorded = false;
    const ctx: FinishPhaseContext = {
      runtime: makeTestRuntime({ dryRun: true }),
      config: { finish: { enabled: true, notify: { mode: "escalation" } } },
      feature: "f",
      workdir: "/tmp/finish-phase-test",
      branch: "feat/x",
      runId: "run-1",
      agentName: "claude",
      abortSignal: new AbortController().signal,
      storySummary: { completed: 1, failed: 0, paused: 0 },
      statusWriter: {
        setPostRunPhase: (_phase, _update) => {
          recorded = true;
        },
      },
    };
    try {
      const result = await runFinishPhase(ctx);

      expect(result).toBeNull();
      expect(machineSpy).not.toHaveBeenCalled();
      expect(recorded).toBe(false);
    } finally {
      machineSpy.mockRestore();
    }
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
  emit?: (e: PipelineEvent) => void;
  telegram?: boolean;
  notifyMode?: "escalation" | "always" | "off";
}): FinishPhaseContext {
  const unsubscribers: Array<() => void> = [];
  if (opts?.emit) {
    unsubscribers.push(pipelineEventBus.onAll((e) => opts.emit?.(e)));
  }
  registeredUnsubscribers.push(...unsubscribers);

  const config = {
    finish: {
      enabled: true,
      notify: { mode: opts?.notifyMode ?? "escalation" },
    },
    ...(opts?.telegram ? { interaction: { plugin: "telegram", config: { botToken: "tok", chatId: "chat" } } } : {}),
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
    const costReadings = [1.0, 1.25];
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

  test("a throwing statusWriter never breaks the fail-open contract", async () => {
    const events: Array<{ type: string; passed?: boolean }> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "already-ready" });
    const ctx = {
      ...makeCtx({ emit: (e) => events.push(e) }),
      statusWriter: {
        setPostRunPhase: () => {
          throw new Error("status write failed");
        },
      },
    };
    try {
      const result = await runFinishPhase(ctx);
      expect(result?.status).toBe("already-ready");
      expect(events.map((e) => e.type)).toEqual(["postrun:phase:started", "postrun:phase:completed"]);
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

/**
 * Escalation delivery must reach exactly one channel.
 *
 * `preferTelegram` suppresses the PR/MR comment and makes Telegram the sole
 * channel; `notify()` sends nothing at all when `notify.mode` is "off". Both
 * true at once delivers the escalation nowhere, with no `deliveryError` to
 * show for it — which is what the acpx plugin's three-conjunct guard
 * (`notify.mode !== "off" && escalate.telegram && creds !== null`) prevented.
 */
describe("escalation channel selection", () => {
  function capturePreferTelegram(opts: {
    telegram?: boolean;
    notifyMode?: "escalation" | "always" | "off";
  }): Promise<boolean | undefined> {
    const restore = { ..._finishPhaseDeps };
    let seen: boolean | undefined;
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => "github";
    _finishPhaseDeps.createFinishOps = (deps) => {
      seen = deps.preferTelegram;
      return {
        review: async () => ({ findings: [], gaps: [] }),
        fix: async () => ({}),
        openDraftPr: async () => null,
        promotePr: async () => ({ status: "opened" as const }),
        escalate: async () => ({}),
      };
    };
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "already-ready" });
    return runFinishPhase(makeCtx(opts))
      .then(() => seen)
      .finally(() => Object.assign(_finishPhaseDeps, restore));
  }

  test("credentialed telegram is the sole channel under the default notify mode", async () => {
    expect(await capturePreferTelegram({ telegram: true })).toBe(true);
  });

  test("notify.mode off must NOT suppress the PR comment", async () => {
    // Otherwise: no comment (preferTelegram) and no Telegram (mode off) —
    // the escalation is delivered nowhere and nothing records that.
    expect(await capturePreferTelegram({ telegram: true, notifyMode: "off" })).toBe(false);
  });
});

test("an undelivered escalation is surfaced on the finish status entry", async () => {
  const restore = { ..._finishPhaseDeps };
  const updates: Array<Record<string, unknown>> = [];
  _finishPhaseDeps.loadFinishContext = async () => proceedContext();
  _finishPhaseDeps.detectForge = async () => "github";
  _finishPhaseDeps.runFinishMachine = async () => ({
    feature: "f",
    status: "escalated",
    escalationReason: "needs a human",
    deliveryError: "gh pr comment failed",
  });
  // This test's config carries no `interaction.plugin: "telegram"`, so
  // `telegramCreds()` (src/finish/notify.ts) falls through to ambient
  // NAX_TELEGRAM_TOKEN / TELEGRAM_BOT_TOKEN / NAX_TELEGRAM_CHAT_ID env vars.
  // test/preload.ts scrubs those and sentinels the underlying fetch as a
  // global safety net, but this test must not depend on that for its own
  // hermeticity — mock the seam directly, like every sibling test above does.
  _finishPhaseDeps.sendTelegramNotify = async () => false;
  const ctx = {
    ...makeCtx(),
    statusWriter: {
      setPostRunPhase: (_phase: "finish", update: Record<string, unknown>) => {
        updates.push(update);
      },
    },
  };
  try {
    await runFinishPhase(ctx);
    const terminal = updates[updates.length - 1];
    expect(terminal.deliveryError).toBe("gh pr comment failed");
  } finally {
    Object.assign(_finishPhaseDeps, restore);
  }
});

describe("runFinishPhase — gate skip observability (#1671)", () => {
  test("a failing clause (not disabled) logs the reason and records a skipped status entry", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const ctx = {
      ...makeCtx(),
      storySummary: { completed: 2, failed: 1, paused: 0 },
      statusWriter: {
        setPostRunPhase: (_phase: "finish", update: Record<string, unknown>) => {
          updates.push(update);
        },
      },
    };
    const result = await withInfoSpy(async (infoSpy) => {
      const r = await runFinishPhase(ctx);
      const call = infoSpy.mock.calls.find((c: unknown[]) => c[0] === "finish");
      expect(call).toBeDefined();
      expect((call?.[2] as { reason: string } | undefined)?.reason).toBe("failed");
      return r;
    });
    expect(result).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "skipped", reason: "failed" });
  });

  test("the disabled case is logged but writes no status entry", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const ctx = {
      ...makeCtx(),
      config: { finish: { enabled: false } },
      statusWriter: {
        setPostRunPhase: (_phase: "finish", update: Record<string, unknown>) => {
          updates.push(update);
        },
      },
    };
    const result = await withInfoSpy(async (infoSpy) => {
      const r = await runFinishPhase(ctx);
      const call = infoSpy.mock.calls.find((c: unknown[]) => c[0] === "finish");
      expect(call).toBeDefined();
      expect((call?.[2] as { reason: string } | undefined)?.reason).toBe("enabled");
      return r;
    });
    expect(result).toBeNull();
    expect(updates).toHaveLength(0);
  });
});

/**
 * Each skip reason produces a human-readable line distinct from the others (#2176).
 *
 * The original message was the same for all six reasons ("Finish phase skipped —
 * gate did not pass") and carried the gating field name as `reason`. For three
 * reasons (`enabled` meaning disabled, `completed` meaning zero stories, `branch`
 * meaning non-feature branch) the rendered line read as a contradiction and
 * "gate did not pass" suggested a quality gate had failed when nothing of the
 * kind was evaluated. The machine-readable `reason` value is unchanged for
 * `status.json`; the message and detail payload are the parts that changed.
 */
describe("runFinishPhase — gate skip log wording (#2176)", () => {
  type LogCall = [string, string, Record<string, unknown>];
  function findSkipLog(calls: unknown[][]): LogCall | undefined {
    const found = calls.find(
      (c) => c[0] === "finish" && typeof c[1] === "string" && c[1].startsWith("Finish phase skipped"),
    );
    return found as LogCall | undefined;
  }

  test("disabled config logs a distinct message that names the cause", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({ ...makeCtx(), config: { finish: { enabled: false } } });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Finish phase skipped — finish is disabled in config");
      expect(call?.[1]).not.toContain("gate did not pass");
      expect(call?.[2].reason).toBe("enabled");
    });
  });

  test("dry run logs a distinct message that does not assert a gate failure", async () => {
    const ctx: FinishPhaseContext = {
      ...makeCtx(),
      runtime: makeTestRuntime({ dryRun: true }),
    };
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase(ctx);
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Finish phase skipped — dry run");
      expect(call?.[1]).not.toContain("gate did not pass");
      expect(call?.[2].reason).toBe("dry-run");
    });
  });

  test("zero completed stories logs a distinct message", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({ ...makeCtx(), storySummary: { completed: 0, failed: 0, paused: 0 } });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Finish phase skipped — no stories completed");
      expect(call?.[1]).not.toContain("gate did not pass");
      expect(call?.[2].reason).toBe("completed");
    });
  });

  test("a single failed story logs the count and uses singular", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({
        ...makeCtx(),
        storySummary: { completed: 2, failed: 1, paused: 0 },
      });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Finish phase skipped — 1 story failed");
      expect(call?.[2].reason).toBe("failed");
      expect(call?.[2].failed).toBe(1);
    });
  });

  test("multiple failed stories log the count and use plural", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({
        ...makeCtx(),
        storySummary: { completed: 2, failed: 3, paused: 0 },
      });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Finish phase skipped — 3 stories failed");
      expect(call?.[2].reason).toBe("failed");
      expect(call?.[2].failed).toBe(3);
    });
  });

  test("a paused story logs the count and uses singular", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({
        ...makeCtx(),
        storySummary: { completed: 2, failed: 0, paused: 1 },
      });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe("Finish phase skipped — 1 story paused");
      expect(call?.[2].reason).toBe("paused");
      expect(call?.[2].paused).toBe(1);
    });
  });

  test("a main branch logs the branch name in the message", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({ ...makeCtx(), branch: "main" });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe('Finish phase skipped — "main" is not a feature branch');
      expect(call?.[1]).not.toContain("gate did not pass");
      expect(call?.[2].reason).toBe("branch");
      expect(call?.[2].branch).toBe("main");
    });
  });

  test("a master branch logs the branch name in the message", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runFinishPhase({ ...makeCtx(), branch: "master" });
      const call = findSkipLog(infoSpy.mock.calls);
      expect(call).toBeDefined();
      expect(call?.[1]).toBe('Finish phase skipped — "master" is not a feature branch');
      expect(call?.[2].reason).toBe("branch");
      expect(call?.[2].branch).toBe("master");
    });
  });

  test("no skip log line ever asserts that a gate did not pass", async () => {
    // Belt-and-braces over the per-reason assertions above: the misleading
    // "gate did not pass" phrase must not appear in *any* skip path, since
    // for the disabled and dry-run cases no gate was evaluated at all.
    const variants: Array<Partial<FinishPhaseContext>> = [
      { config: { finish: { enabled: false } } },
      { runtime: makeTestRuntime({ dryRun: true }) },
      { storySummary: { completed: 0, failed: 0, paused: 0 } },
      { storySummary: { completed: 2, failed: 1, paused: 0 } },
      { storySummary: { completed: 2, failed: 3, paused: 0 } },
      { storySummary: { completed: 2, failed: 0, paused: 1 } },
      { branch: "main" },
      { branch: "master" },
    ];
    for (const variant of variants) {
      await withInfoSpy(async (infoSpy) => {
        await runFinishPhase({ ...makeCtx(), ...variant });
        const call = findSkipLog(infoSpy.mock.calls);
        expect(call).toBeDefined();
        expect(call?.[1]).not.toContain("gate did not pass");
      });
    }
  });
});

describe("runFinishPhase — ledger skip observability (#1674 part 1)", () => {
  test("a machine result with skipReason 'already-finished' writes status: skipped, not passed", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "nothing-to-finish",
      skipReason: "already-finished",
      url: "https://forge.example/pr/3",
    });
    const ctx = {
      ...makeCtx(),
      statusWriter: {
        setPostRunPhase: (_phase: "finish", update: Record<string, unknown>) => {
          updates.push(update);
        },
      },
    };
    try {
      const result = await withInfoSpy(async (infoSpy) => {
        const r = await runFinishPhase(ctx);
        const call = infoSpy.mock.calls.find(
          (c: unknown[]) => c[0] === "finish" && (c[1] as string)?.includes("skipped"),
        );
        expect(call).toBeDefined();
        // The reason moved into the log details when #1674 part 2 added a
        // second skip reason ("pr-merged") to the same branch — asserting it
        // here keeps the "which skip was this" claim under test.
        expect((call?.[2] as Record<string, unknown>)?.reason).toBe("already-finished");
        return r;
      });
      expect(result?.status).toBe("nothing-to-finish");
      const terminal = updates[updates.length - 1];
      expect(terminal).toMatchObject({
        status: "skipped",
        reason: "already-finished",
        url: "https://forge.example/pr/3",
      });
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("a machine result with skipReason 'pr-merged' (#1674 part 2) also writes status: skipped", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({
      feature: "f",
      status: "nothing-to-finish",
      skipReason: "pr-merged",
      url: "https://forge.example/pr/7",
    });
    const ctx = {
      ...makeCtx(),
      statusWriter: {
        setPostRunPhase: (_phase: "finish", update: Record<string, unknown>) => {
          updates.push(update);
        },
      },
    };
    try {
      const result = await runFinishPhase(ctx);
      expect(result?.status).toBe("nothing-to-finish");
      expect(updates[updates.length - 1]).toMatchObject({
        status: "skipped",
        reason: "pr-merged",
        url: "https://forge.example/pr/7",
      });
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("a plain nothing-to-finish (no skipReason) still reports passed, not skipped", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const restore = { ..._finishPhaseDeps };
    _finishPhaseDeps.loadFinishContext = async () => proceedContext();
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "nothing-to-finish" });
    const ctx = {
      ...makeCtx(),
      statusWriter: {
        setPostRunPhase: (_phase: "finish", update: Record<string, unknown>) => {
          updates.push(update);
        },
      },
    };
    try {
      await runFinishPhase(ctx);
      const terminal = updates[updates.length - 1];
      expect(terminal).toMatchObject({ status: "passed", result: "nothing-to-finish" });
      expect(terminal?.reason).toBeUndefined();
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });

  test("loadFinishContext receives the branch, audit dir, and finish.rerun setting", async () => {
    const restore = { ..._finishPhaseDeps };
    let seenOpts: unknown;
    _finishPhaseDeps.loadFinishContext = async (_feature, _workdir, opts) => {
      seenOpts = opts;
      return proceedContext();
    };
    _finishPhaseDeps.detectForge = async () => null;
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "already-ready" });
    try {
      await runFinishPhase(makeCtx());
      expect(seenOpts).toMatchObject({ branch: "feat/x", rerun: "on-change" });
      expect((seenOpts as { auditDir: string }).auditDir).toContain("finish-audit/f");
    } finally {
      Object.assign(_finishPhaseDeps, restore);
    }
  });
});
