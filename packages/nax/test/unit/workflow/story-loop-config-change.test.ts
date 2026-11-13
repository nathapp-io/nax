/**
 * US-005 (gate-config-route, #2897/#2898): a BLOCKED or NEEDS_CONTEXT turn is where the advisor may
 * hand back a config change instead of an answer. The loop gathers the red gates' facts for it, applies
 * the change the advisor picks, records what became of it, and ends the turn — the answer *was* the
 * change, so no second implementer turn runs and the round's next gate run reads the reloaded command.
 *
 * Every case drives a node directly (`fixStep`, `implementStep`), so the round, the patch and the
 * ledger are the node's own rather than what the surrounding graph happens to expose.
 */
import { describe, expect, test } from "bun:test";
import { makeStoryLoopAdvisor, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { NaxError } from "@/errors";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { ConfigChangeAnswer, ImplementerQuestionFacts, ImplementerQuestionRequest } from "@/workflow/advisor";
import { CONFIG_CHANGE_ROLLBACK_FAILED, type ConfigChangeOutcome } from "@/workflow/config-change";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import type { StoryLoopState } from "@/workflow/story-loop";
import { runStoryLoop } from "@/workflow/story-loop";
import { fixStep, implementStep, initialStoryState } from "@/workflow/story-steps";
import type { GateName, GateRunResult, WorkflowFinding } from "@/workflow/types";

const { GREEN, SUITE_GREEN, SUITE_RED, OK } = storyLoopFixtures;

/** The command `testScoped` runs today, and the one the package's own `test` script would give it. */
const FROM = "bun test {{files}}";
const TO = "bun test --isolate {{files}}";

/** A gate run whose scoped gate is red — a fix round the advisor may offer a config change in. */
const RED_SCOPED: GateRunResult = {
  red: true,
  states: { lint: "green", typecheck: "green", scoped: "red" },
  findings: [{ kind: "gate", gate: "scoped", severity: "important", issue: "the scoped gate failed" }],
};

/** The open finding a scoped-red pass hands the fix round. */
const OPEN_GATE: WorkflowFinding = {
  id: "F1",
  kind: "gate",
  severity: "important",
  issue: "the scoped gate failed",
};

/** What the implementer says when it cannot write the config itself. */
const BLOCKED: ImplementOutcome = {
  reply: {
    status: "BLOCKED",
    commits: [],
    testSummary: "",
    interrupted: false,
    concerns: "nax config writes are denied to every session",
  },
  autoCommitted: false,
};

/** The change the advisor picks off the menu for a red scoped gate. */
const PICKED: ConfigChangeAnswer = {
  kind: "config-change",
  key: "testScoped",
  to: TO,
  script: "test",
  reason: "matches the package test script",
  decisionId: "D-3",
  needsHumanConfirm: false,
};

const FACTS: ImplementerQuestionFacts = {
  protectedPaths: [".nax/"],
  commands: { testScoped: FROM },
  candidates: [{ key: "testScoped", to: TO, script: "test" }],
};

const APPLIED: ConfigChangeOutcome = { applied: true, key: "testScoped", from: FROM, to: TO, commit: "c1" };

interface ProbeScript {
  /** The implementer's outcome per turn; absent replies BLOCKED to every turn. */
  readonly reply?: (turn: ImplementTurn) => ImplementOutcome;
  /** The advisor's answer; absent answers nothing. */
  readonly answer?: string | ConfigChangeAnswer | null;
  /** The `configFacts` step; absent leaves the env without one. */
  readonly facts?: (redGates: readonly GateName[]) => Promise<ImplementerQuestionFacts>;
  /** The `applyConfigChange` step; absent leaves the env without one. */
  readonly apply?: (change: ConfigChangeAnswer) => Promise<ConfigChangeOutcome>;
}

/** A harness plus the three seams US-005 is observed through: the question, its facts and the apply. */
function makeProbe(script: ProbeScript = {}) {
  const requests: ImplementerQuestionRequest[] = [];
  const factsCalls: (readonly GateName[])[] = [];
  const applies: ConfigChangeAnswer[] = [];
  const facts = script.facts;
  const apply = script.apply;
  const h = makeStoryLoopHarness(
    { implement: script.reply ?? (() => BLOCKED) },
    {
      advisor: makeStoryLoopAdvisor({
        answerQuestion: async (request) => {
          requests.push(request);
          return script.answer ?? null;
        },
      }),
      steps: {
        ...(facts === undefined
          ? {}
          : {
              configFacts: async (redGates: readonly GateName[]) => {
                factsCalls.push([...redGates]);
                return facts(redGates);
              },
            }),
        ...(apply === undefined
          ? {}
          : {
              applyConfigChange: async (change: ConfigChangeAnswer) => {
                applies.push(change);
                return apply(change);
              },
            }),
      },
    },
  );
  return { h, requests, factsCalls, applies };
}

/** One fix round: the gate run the pass left behind, and an implementer that replies BLOCKED in it. */
async function runFixRound(
  script: ProbeScript & { gates: GateRunResult; suite?: GateRunResult; concerns?: readonly string[] },
) {
  const { gates, suite, concerns, ...probe } = script;
  const made = makeProbe({ reply: (turn) => (turn.kind === "fix" ? BLOCKED : OK), ...probe });
  const state: StoryLoopState = {
    ...initialStoryState(made.h.env),
    step: "fix",
    open: [OPEN_GATE],
    gates,
    suite: suite ?? SUITE_GREEN,
    ...(concerns === undefined ? {} : { concerns: [...concerns] }),
  };
  const result = await fixStep(made.h.env, state);
  return { ...made, result };
}

/** The story's first implement turn, before any gate has run. */
async function runFirstTurn(script: ProbeScript = {}) {
  const made = makeProbe(script);
  const result = await implementStep(made.h.env, initialStoryState(made.h.env));
  return { ...made, result };
}

/** Whether the question carries a `facts` key at all — an absent step must leave it off, not undefined. */
const carriesFacts = (question: ImplementerQuestionRequest | undefined): boolean =>
  question !== undefined && Object.hasOwn(question, "facts");

/** The turns the loop asked the implementer for, by kind. */
const turnKinds = (turns: readonly ImplementTurn[]): string[] => turns.map((turn) => turn.kind);

describe("the implementer's question carries the red gates' facts (US-005)", () => {
  test("AC-1: a scoped-red fix round asks configFacts for exactly ['scoped']", async () => {
    const { factsCalls } = await runFixRound({ gates: RED_SCOPED, answer: null, facts: async () => FACTS });
    expect(factsCalls).toEqual([["scoped"]]);
  });

  test("AC-2: the facts it returns are handed to answerQuestion", async () => {
    const { requests } = await runFixRound({ gates: RED_SCOPED, answer: null, facts: async () => FACTS });
    expect(requests[0]?.facts).toEqual(FACTS);
  });

  test("AC-3: a suite-only red asks the question with no facts key", async () => {
    const { requests } = await runFixRound({ gates: GREEN, suite: SUITE_RED, answer: null, facts: async () => FACTS });
    expect(requests[0]).toEqual({
      storyId: "US-001",
      status: "BLOCKED",
      concerns: "nax config writes are denied to every session",
    });
    expect(carriesFacts(requests[0])).toBe(false);
  });

  test("AC-4: a suite-only red never asks for config facts", async () => {
    const { factsCalls } = await runFixRound({
      gates: GREEN,
      suite: SUITE_RED,
      answer: null,
      facts: async () => FACTS,
    });
    expect(factsCalls).toEqual([]);
  });

  test("AC-5: before any gate run the question is exactly { storyId, status, concerns }", async () => {
    const { requests } = await runFirstTurn({ answer: null });
    expect(requests[0]).toEqual({
      storyId: "US-001",
      status: "BLOCKED",
      concerns: "nax config writes are denied to every session",
    });
    expect(carriesFacts(requests[0])).toBe(false);
  });

  test("AC-6: before any gate run configFacts is never called, even when it is wired", async () => {
    const { factsCalls } = await runFirstTurn({ answer: null, facts: async () => FACTS });
    expect(factsCalls).toEqual([]);
  });
});

describe("an applied config change ends the turn (US-005)", () => {
  const appliedRound = () =>
    runFixRound({
      gates: RED_SCOPED,
      answer: PICKED,
      facts: async () => FACTS,
      apply: async () => APPLIED,
      concerns: ["DONE: an earlier concern"],
    });

  test("AC-7: the implementer runs once in that round, with no answer turn after it", async () => {
    const { h } = await appliedRound();
    expect(turnKinds(h.turns)).toEqual(["fix"]);
  });

  test("AC-8: the round records no new concern for the applied change", async () => {
    const { result } = await appliedRound();
    expect(result.patch.concerns).toEqual(["DONE: an earlier concern"]);
  });

  test("AC-9: the patch's lastTurn keeps BLOCKED and says the config was applied", async () => {
    const { result } = await appliedRound();
    expect(result.patch.lastTurn).toEqual({ status: "BLOCKED", fallback: false, stepUps: 0, configApplied: true });
  });

  test("AC-10: the ledger names the key, both values and the advisor decision", async () => {
    const { h } = await appliedRound();
    expect(h.ledger).toContain(`config change applied: quality.commands.testScoped "${FROM}" -> "${TO}" (advisor D-3)`);
  });

  test("AC-11: the sink records the change with its round, both values and the decision", async () => {
    const { h, applies } = await appliedRound();
    expect(applies).toEqual([PICKED]);
    expect(h.configRecords).toEqual([
      { round: 1, key: "testScoped", from: FROM, to: TO, applied: true, decisionId: "D-3" },
    ]);
  });

  test("an applied change with no previous command names no value it replaced", async () => {
    const { h } = await runFixRound({
      gates: RED_SCOPED,
      answer: PICKED,
      facts: async () => FACTS,
      apply: async () => ({ applied: true, key: "testScoped", from: undefined, to: TO, commit: "c1" }),
    });
    expect(h.ledger).toContain(`config change applied: quality.commands.testScoped -> "${TO}" (advisor D-3)`);
    expect(h.configRecords).toEqual([{ round: 1, key: "testScoped", to: TO, applied: true, decisionId: "D-3" }]);
  });

  test("the loop re-runs the gates after an applied change, without a second implementer turn", async () => {
    let gateRuns = 0;
    const queue = [RED_SCOPED];
    const h = makeStoryLoopHarness(
      { implement: (turn) => (turn.kind === "fix" ? BLOCKED : OK) },
      {
        advisor: makeStoryLoopAdvisor({ answerQuestion: async () => PICKED }),
        steps: {
          gates: async () => {
            gateRuns += 1;
            return queue.shift() ?? GREEN;
          },
          configFacts: async () => FACTS,
          applyConfigChange: async () => APPLIED,
        },
      },
    );
    const out = await runStoryLoop(h.env);
    expect(gateRuns).toBe(2);
    expect(turnKinds(h.turns)).toEqual(["implement", "fix"]);
    expect(out.state).toBe("complete");
  });
});

describe("a refused config change keeps the loop's existing path (US-005)", () => {
  const refusedRound = (apply: (change: ConfigChangeAnswer) => Promise<ConfigChangeOutcome>) =>
    runFixRound({ gates: RED_SCOPED, answer: PICKED, facts: async () => FACTS, apply, concerns: [] });

  test("AC-12: the ledger names the refusal reason and the value that was not applied", async () => {
    const { h } = await refusedRound(async () => ({ applied: false, key: "testScoped", to: TO, reason: "untracked" }));
    expect(h.ledger).toContain(
      `config change refused (untracked): quality.commands.testScoped -> "${TO}" (advisor D-3)`,
    );
  });

  test("AC-13: the implementer's recorded concern names the command it proposed", async () => {
    const { result } = await refusedRound(async () => ({
      applied: false,
      key: "testScoped",
      to: TO,
      reason: "untracked",
    }));
    expect(result.patch.concerns?.join(" ")).toContain(TO);
  });

  test("AC-14: the sink records the refusal with its reason", async () => {
    const { h } = await refusedRound(async () => ({ applied: false, key: "testScoped", to: TO, reason: "untracked" }));
    expect(h.configRecords).toEqual([
      { round: 1, key: "testScoped", to: TO, applied: false, reason: "untracked", decisionId: "D-3" },
    ]);
  });

  test("AC-15/AC-16: a throwing transaction is a write-failed refusal, and fixStep still resolves", async () => {
    const round = refusedRound(async () => {
      throw new Error("git commit exited 1");
    });
    const { h, result } = await round;
    expect(h.configRecords).toEqual([
      { round: 1, key: "testScoped", to: TO, applied: false, reason: "write-failed", decisionId: "D-3" },
    ]);
    expect(result.patch.lastTurn).toEqual({ status: "BLOCKED", fallback: false, stepUps: 0 });
  });

  // B2: `CONFIG_CHANGE_ROLLBACK_FAILED` says the tree may still hold the attempted change. Reading it
  // as an ordinary write-failed refusal recorded a clean state the run does not have, and let the loop
  // keep spending rounds on a config it cannot trust; it must reach the story's error containment.
  test("B2: a rollback that did not complete propagates instead of reading as a refusal", async () => {
    const rollback = new NaxError(
      "Config change rollback could not restore the config file's original bytes: .nax/mono/apps/admin/config.json",
      CONFIG_CHANGE_ROLLBACK_FAILED,
      { stage: "workflow" },
    );
    const made = makeProbe({
      reply: (turn) => (turn.kind === "fix" ? BLOCKED : OK),
      answer: PICKED,
      facts: async () => FACTS,
      apply: async () => {
        throw rollback;
      },
    });
    const state: StoryLoopState = {
      ...initialStoryState(made.h.env),
      step: "fix",
      open: [OPEN_GATE],
      gates: RED_SCOPED,
      suite: SUITE_GREEN,
    };

    await expect(fixStep(made.h.env, state)).rejects.toBe(rollback);
    // Nothing was recorded as a refusal, and no ledger line claims the tree is clean.
    expect(made.h.configRecords).toEqual([]);
    expect(made.h.ledger.filter((line) => line.includes("config change"))).toEqual([]);
  });

  test("an env with no applier never reads a picked change as applied", async () => {
    const { h, result } = await runFixRound({ gates: RED_SCOPED, answer: PICKED, facts: async () => FACTS });
    expect(h.configRecords).toEqual([
      { round: 1, key: "testScoped", to: TO, applied: false, reason: "write-failed", decisionId: "D-3" },
    ]);
    expect(result.patch.lastTurn).toEqual({ status: "BLOCKED", fallback: false, stepUps: 0 });
  });
});

describe("the answer paths around a config change (US-005)", () => {
  /** A silent logger sink, so the warn AC-18 asserts is captured without writing to the run's log. */
  function captureLogs(): LogEntry[] {
    const entries: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "silent" });
    addSink((entry) => entries.push(entry));
    return entries;
  }

  test("AC-17/AC-18: a throwing configFacts warns and asks the question without facts", async () => {
    const entries = captureLogs();
    try {
      const { requests } = await runFixRound({
        gates: RED_SCOPED,
        answer: null,
        facts: async () => {
          throw new Error("git show exited 128");
        },
      });
      expect(requests[0]?.facts).toBeUndefined();
      expect(carriesFacts(requests[0])).toBe(false);
      expect(entries.filter((entry) => entry.level === "warn")).toHaveLength(1);
    } finally {
      resetLogger();
    }
  });

  test("AC-19: a string answer still runs one more implementer turn with that text", async () => {
    const { h } = await runFixRound({ gates: RED_SCOPED, answer: "run the suite with --isolate yourself" });
    expect(turnKinds(h.turns)).toEqual(["fix", "answer"]);
    expect(h.turns[1]).toEqual(
      expect.objectContaining({ kind: "answer", text: "run the suite with --isolate yourself" }),
    );
  });

  test("AC-20: a string answer never applies a config change", async () => {
    const { applies } = await runFixRound({
      gates: RED_SCOPED,
      answer: "run the suite with --isolate yourself",
      facts: async () => FACTS,
      apply: async () => APPLIED,
    });
    expect(applies).toEqual([]);
  });

  test("AC-21: an env with no configFacts step still asks the question without facts", async () => {
    const { requests, factsCalls } = await runFixRound({ gates: RED_SCOPED, answer: null });
    expect(factsCalls).toEqual([]);
    expect(requests[0]?.facts).toBeUndefined();
    expect(carriesFacts(requests[0])).toBe(false);
  });
});
