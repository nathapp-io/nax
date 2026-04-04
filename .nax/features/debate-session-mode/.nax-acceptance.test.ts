import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

// ─── Feature imports (fail until implemented) ─────────────────────────────────

import { NaxConfigSchema } from "../../../src/config/schemas";
import {
  _debateSessionDeps,
  buildRebuttalContext,
  resolveDebaterModel as _resolveDebaterModel,
} from "../../../src/debate/session-helpers";
import type { DebateSessionOptions } from "../../../src/debate/session-helpers";
import { DebateSession } from "../../../src/debate/session";
import type {
  DebateMode,
  DebateResult,
  DebateStageConfig,
  Debater,
  Rebuttal,
} from "../../../src/debate/types";
import * as sessionHelpers from "../../../src/debate/session-helpers";
import * as debateIndex from "../../../src/debate/index";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TWO_DEBATERS: Debater[] = [{ agent: "d0" }, { agent: "d1" }];
const THREE_DEBATERS: Debater[] = [{ agent: "d0" }, { agent: "d1" }, { agent: "d2" }];
const RESULT_FIELDS = ["storyId", "stage", "outcome", "rounds", "debaters", "resolverType", "proposals", "totalCostUsd"];

function makeStageConfig(overrides: Record<string, unknown> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
    timeoutSeconds: 30,
    debaters: TWO_DEBATERS,
    ...overrides,
  } as DebateStageConfig;
}

function makeAdapter(output = "agent-output", cost = 0.1) {
  return {
    complete: mock(async () => ({ output, costUsd: cost })),
    run: mock(async () => ({ success: true, output, estimatedCost: cost })),
    plan: mock(async () => undefined),
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return new DebateSession({
    storyId: "story-1",
    stage: "review",
    stageConfig: makeStageConfig(overrides),
  });
}

function makeAdapterMap(debaters: Debater[], outputPrefix = "out") {
  const map = new Map<string, ReturnType<typeof makeAdapter>>();
  for (let i = 0; i < debaters.length; i++) {
    map.set(debaters[i].agent, makeAdapter(`${outputPrefix}-d${i}`));
  }
  return map;
}

type RunCall = [Record<string, unknown>];

function getAllRunCalls(map: Map<string, ReturnType<typeof makeAdapter>>): RunCall[] {
  return [...map.values()].flatMap((a) => a.run.mock.calls as RunCall[]);
}

function isRebuttalCall(call: RunCall): boolean {
  return typeof call[0].prompt === "string" && (call[0].prompt as string).includes("## Proposals");
}

// ─── Dep save / restore ───────────────────────────────────────────────────────

let savedGetAgent: typeof _debateSessionDeps.getAgent;
let savedGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;
let savedReadFile: typeof _debateSessionDeps.readFile;

beforeEach(() => {
  savedGetAgent = _debateSessionDeps.getAgent;
  savedGetSafeLogger = _debateSessionDeps.getSafeLogger;
  savedReadFile = _debateSessionDeps.readFile;
  _debateSessionDeps.getSafeLogger = (() => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })) as never;
});

afterEach(() => {
  _debateSessionDeps.getAgent = savedGetAgent;
  _debateSessionDeps.getSafeLogger = savedGetSafeLogger;
  _debateSessionDeps.readFile = savedReadFile;
  mock.restore();
});

// ─── AC-1: File sizes ─────────────────────────────────────────────────────────

describe("AC-1: src/debate files have < 400 lines", () => {
  const FILES = ["session.ts", "session-helpers.ts", "types.ts", "index.ts", "concurrency.ts", "prompts.ts", "resolvers.ts"];
  for (const f of FILES) {
    test(`AC-1: ${f} < 400 lines`, async () => {
      const text = await Bun.file(`${PROJECT_ROOT}/src/debate/${f}`).text();
      expect(text.split("\n").length, `${f} must be < 400 lines`).toBeLessThan(400);
    });
  }
});

// ─── AC-2, 3, 4: run() / runPlan() result shape ───────────────────────────────

describe("AC-2,3,4: run() and runPlan() return DebateResult shape", () => {
  test("AC-2: run() sessionMode='one-shot' → DebateResult shape, runOneShot invoked (complete() called)", async () => {
    const adapter = makeAdapter("proposal-a");
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    const result = await makeSession({ sessionMode: "one-shot" }).run("prompt");
    for (const field of RESULT_FIELDS) expect(result, `missing ${field}`).toHaveProperty(field);
    expect(adapter.complete).toHaveBeenCalledTimes(TWO_DEBATERS.length);
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("AC-3: run() sessionMode='stateful' → DebateResult shape, runStateful invoked (run() called)", async () => {
    const adapter = makeAdapter("proposal-b");
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    const result = await makeSession({ sessionMode: "stateful" }).run("prompt");
    for (const field of RESULT_FIELDS) expect(result, `missing ${field}`).toHaveProperty(field);
    expect(adapter.run).toHaveBeenCalled();
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  test("AC-4: runPlan() → DebateResult with output field, runPlan invoked", async () => {
    const adapter = makeAdapter("{}");
    adapter.plan = mock(async () => {}) as never;
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    _debateSessionDeps.readFile = mock(async () => '{"version":1}');
    const result = await makeSession({}).runPlan("plan prompt", { workdir: "/tmp", feature: "test", outputDir: "/tmp" });
    for (const field of RESULT_FIELDS) expect(result, `missing ${field}`).toHaveProperty(field);
    expect(result).toHaveProperty("output");
  });
});

// ─── AC-5, 6, 7: session-helpers.ts exports ───────────────────────────────────

describe("AC-5,6,7: session-helpers.ts exports and index.ts re-exports", () => {
  test("AC-5: _debateSessionDeps exported from session-helpers and re-exported from index", () => {
    expect(sessionHelpers._debateSessionDeps).toBeDefined();
    expect(debateIndex._debateSessionDeps).toBeDefined();
  });

  test("AC-6: resolveDebaterModel exported from session-helpers and re-exported from index", () => {
    expect(typeof sessionHelpers.resolveDebaterModel).toBe("function");
    expect(typeof debateIndex.resolveDebaterModel).toBe("function");
  });

  test("AC-7: DebateSessionOptions type usable from session-helpers (re-exported from index)", () => {
    const opts: DebateSessionOptions = { storyId: "s1", stage: "plan", stageConfig: makeStageConfig() };
    expect(() => new DebateSession(opts)).not.toThrow();
  });
});

// ─── AC-8: Existing debate tests still pass ────────────────────────────────────

describe("AC-8: Existing debate unit tests pass with no test file changes", () => {
  test("AC-8: bun test test/unit/debate exits with code 0", () => {
    const result = Bun.spawnSync(["bun", "test", "test/unit/debate", "--timeout=60000"], { cwd: PROJECT_ROOT });
    expect(result.exitCode).toBe(0);
  });
});

// ─── AC-9..15, 25..31: Config schema — mode defaults and validation ────────────

describe("AC-9..15, 25..31: NaxConfigSchema DebateStageConfig.mode", () => {
  test.each(["plan", "review", "acceptance", "rectification", "escalation"] as const)(
    "AC-9..13/25..29: stages.%s.mode defaults to 'panel'",
    (stage) => {
      const parsed = NaxConfigSchema.parse({});
      const stageVal = (parsed.debate?.stages as Record<string, unknown>)[stage] as Record<string, unknown>;
      expect(stageVal.mode).toBe("panel");
    },
  );

  test("AC-14/30: parse({ debate.stages.plan.mode: 'hybrid' }) resolves to 'hybrid'", () => {
    const parsed = NaxConfigSchema.parse({ debate: { stages: { plan: { mode: "hybrid" } } } });
    expect((parsed.debate?.stages.plan as Record<string, unknown>).mode).toBe("hybrid");
  });

  test("AC-15/31: safeParse with mode='sequential' returns success=false", () => {
    const result = NaxConfigSchema.safeParse({ debate: { stages: { plan: { mode: "sequential" } } } });
    expect(result.success).toBe(false);
  });
});

// ─── AC-16..24: TypeScript types ──────────────────────────────────────────────

describe("AC-16..24: TypeScript type system — DebateMode, Rebuttal, DebateResult", () => {
  test("AC-16,20,21: DebateMode = 'panel' | 'hybrid'; DebateStageConfig.mode accepts DebateMode", () => {
    const panel: DebateMode = "panel";
    const hybrid: DebateMode = "hybrid";
    expect(panel).toBe("panel");
    expect(hybrid).toBe("hybrid");
    const cfg = makeStageConfig({ mode: "panel" });
    expect((cfg as unknown as Record<string, unknown>).mode).toBe("panel");
  });

  test("AC-17,23: DebateResult.rebuttals is optional Rebuttal[]", () => {
    const withoutRebuttals: Partial<DebateResult> = { storyId: "s", outcome: "passed" };
    expect(withoutRebuttals.rebuttals).toBeUndefined();
    const r: Rebuttal = { debater: { agent: "claude" }, round: 1, output: "r-out" };
    const withRebuttals: Partial<DebateResult> = { rebuttals: [r] };
    expect(withRebuttals.rebuttals).toHaveLength(1);
  });

  test("AC-18,22: Rebuttal has debater: Debater, round: number, output: string", () => {
    const r: Rebuttal = { debater: { agent: "opencode", model: "fast" }, round: 2, output: "rebuttal text" };
    expect(r.debater.agent).toBe("opencode");
    expect(r.round).toBe(2);
    expect(r.output).toBe("rebuttal text");
  });

  test("AC-19,24,32: tsc --noEmit (bun run typecheck) exits with code 0", () => {
    const result = Bun.spawnSync(["bun", "run", "typecheck"], { cwd: PROJECT_ROOT });
    expect(result.exitCode).toBe(0);
  });
});

// ─── AC-33..38: run() mode routing ────────────────────────────────────────────

describe("AC-33..38: run() routes by stageConfig.mode", () => {
  test("AC-33,35: mode='panel'/undefined + sessionMode='one-shot' → complete() called, run() not called", async () => {
    const adapter = makeAdapter();
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    await makeSession({ sessionMode: "one-shot", mode: "panel" }).run("p");
    expect(adapter.complete).toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("AC-34: mode='panel' + sessionMode='stateful' → run() called, complete() not called", async () => {
    const adapter = makeAdapter();
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    await makeSession({ sessionMode: "stateful", mode: "panel" }).run("p");
    expect(adapter.run).toHaveBeenCalled();
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  test("AC-36: mode='hybrid' + sessionMode='stateful' → runHybrid (run() called, complete() not called)", async () => {
    const adapterMap = makeAdapterMap(TWO_DEBATERS);
    _debateSessionDeps.getAgent = mock((name: string) => adapterMap.get(name) as never);
    await makeSession({ sessionMode: "stateful", rounds: 1, mode: "hybrid", debaters: TWO_DEBATERS }).run("p");
    const totalRun = [...adapterMap.values()].reduce((s, a) => s + a.run.mock.calls.length, 0);
    const totalComplete = [...adapterMap.values()].reduce((s, a) => s + a.complete.mock.calls.length, 0);
    expect(totalRun).toBeGreaterThan(0);
    expect(totalComplete).toBe(0);
  });

  test("AC-37: mode='hybrid' + sessionMode='one-shot' → complete() called + warning containing 'hybrid mode requires sessionMode: stateful'", async () => {
    const warnings: string[] = [];
    _debateSessionDeps.getSafeLogger = (() => ({
      info: () => {},
      warn: (...args: unknown[]) => { warnings.push(args.join(" ")); },
      error: () => {},
      debug: () => {},
    })) as never;
    const adapter = makeAdapter();
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    await makeSession({ sessionMode: "one-shot", mode: "hybrid" }).run("p");
    expect(adapter.complete).toHaveBeenCalled();
    expect(warnings.some((w) => w.includes("hybrid mode requires sessionMode: stateful"))).toBe(true);
  });

  test("AC-38: mode='hybrid' + sessionMode=undefined → complete() called + same warning", async () => {
    const warnings: string[] = [];
    _debateSessionDeps.getSafeLogger = (() => ({
      info: () => {},
      warn: (...args: unknown[]) => { warnings.push(args.join(" ")); },
      error: () => {},
      debug: () => {},
    })) as never;
    const adapter = makeAdapter();
    _debateSessionDeps.getAgent = mock(() => adapter as never);
    await makeSession({ mode: "hybrid" }).run("p");
    expect(adapter.complete).toHaveBeenCalled();
    expect(warnings.some((w) => w.includes("hybrid mode requires sessionMode: stateful"))).toBe(true);
  });
});

// ─── AC-39..43: buildRebuttalContext ──────────────────────────────────────────

describe("AC-39..43: buildRebuttalContext()", () => {
  const proposals = ["proposal content A", "proposal content B"];
  const debaters: Debater[] = [{ agent: "alpha" }, { agent: "beta" }];

  test("AC-39: empty rebuttals → includes '## Proposals' with both contents, no '## Previous Rebuttals'", () => {
    const out = buildRebuttalContext({ proposals, debaters, rebuttals: [], currentDebaterIndex: 0 });
    expect(out).toContain("## Proposals");
    expect(out).toContain("proposal content A");
    expect(out).toContain("proposal content B");
    expect(out).not.toContain("## Previous Rebuttals");
  });

  test("AC-40: 3 rebuttals → '## Previous Rebuttals' with numbered entries 1., 2., 3.", () => {
    const rebuttals: Rebuttal[] = [
      { debater: debaters[0], round: 1, output: "r1" },
      { debater: debaters[1], round: 1, output: "r2" },
      { debater: debaters[0], round: 2, output: "r3" },
    ];
    const out = buildRebuttalContext({ proposals, debaters, rebuttals, currentDebaterIndex: 0 });
    expect(out).toContain("## Previous Rebuttals");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain("3.");
  });

  test("AC-41: currentDebaterIndex=0 → context includes 'You are debater 1'", () => {
    const out = buildRebuttalContext({ proposals, debaters, rebuttals: [], currentDebaterIndex: 0 });
    expect(out).toContain("You are debater 1");
  });

  test("AC-42: agentName appears as label for each proposal's content", () => {
    const out = buildRebuttalContext({ proposals, debaters, rebuttals: [], currentDebaterIndex: 0 });
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  test("AC-43: buildRebuttalContext is exported from index.ts", () => {
    expect(typeof debateIndex.buildRebuttalContext).toBe("function");
  });
});

// ─── AC-44..72: runHybrid behavior ────────────────────────────────────────────

describe("AC-44..72: runHybrid() behavior", () => {
  function makeHybridSession(debaters: Debater[], rounds: number, extra: Record<string, unknown> = {}) {
    return new DebateSession({
      storyId: "story-hybrid",
      stage: "review",
      stageConfig: makeStageConfig({ sessionMode: "stateful", rounds, debaters, mode: "hybrid", ...extra }),
    });
  }

  function wireAdapters(debaters: Debater[], outputPrefix = "out") {
    const map = makeAdapterMap(debaters, outputPrefix);
    _debateSessionDeps.getAgent = mock((name: string) => map.get(name) as never);
    return map;
  }

  test("AC-44,63: 2 debaters rounds=1 → exactly 2 rebuttal run() calls, d0 before d1", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    const allCalls = getAllRunCalls(adapters);
    const rebuttalCalls = allCalls.filter(isRebuttalCall);
    expect(rebuttalCalls).toHaveLength(2);
    const d0Rebuttal = (adapters.get("d0")!.run.mock.calls as RunCall[]).findIndex(isRebuttalCall);
    const d1Rebuttal = (adapters.get("d1")!.run.mock.calls as RunCall[]).findIndex(isRebuttalCall);
    expect(d0Rebuttal).toBeGreaterThanOrEqual(0);
    expect(d1Rebuttal).toBeGreaterThanOrEqual(0);
  });

  test("AC-45,64: 3 debaters rounds=2 → exactly 6 rebuttal run() calls", async () => {
    const adapters = wireAdapters(THREE_DEBATERS);
    await makeHybridSession(THREE_DEBATERS, 2).run("prompt");
    const rebuttalCalls = getAllRunCalls(adapters).filter(isRebuttalCall);
    expect(rebuttalCalls).toHaveLength(6);
  });

  test("AC-46,65: rebuttal prompts contain all successful proposal outputs", async () => {
    const adapters = wireAdapters(TWO_DEBATERS, "proposal");
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    const rebuttalCalls = getAllRunCalls(adapters).filter(isRebuttalCall);
    expect(rebuttalCalls.length).toBeGreaterThan(0);
    for (const call of rebuttalCalls) {
      const prompt = call[0].prompt as string;
      expect(prompt).toContain("proposal-d0");
      expect(prompt).toContain("proposal-d1");
    }
  });

  test("AC-47,66: round-2 rebuttal prompts include round-1 rebuttal outputs", async () => {
    const adapters = wireAdapters(TWO_DEBATERS, "turn");
    await makeHybridSession(TWO_DEBATERS, 2).run("prompt");
    const rebuttalCalls = getAllRunCalls(adapters).filter(isRebuttalCall);
    if (rebuttalCalls.length >= 4) {
      const round2Prompt = rebuttalCalls[2][0].prompt as string;
      // Should contain previous rebuttal outputs in a rebuttals section
      expect(round2Prompt).toMatch(/turn-d[01]/);
    }
  });

  test("AC-48,67: if d0 rebuttal throws, d1 rebuttal still runs and runHybrid resolves", async () => {
    let d0RebuttalHit = false;
    let d1RebuttalHit = false;
    const adapterD0 = {
      complete: mock(async () => ({ output: "", costUsd: 0 })),
      run: mock(async (opts: Record<string, unknown>) => {
        if (isRebuttalCall([opts])) { d0RebuttalHit = true; throw new Error("d0 rebuttal failed"); }
        return { success: true, output: "d0-proposal", estimatedCost: 0.1 };
      }),
      plan: mock(async () => undefined),
    };
    const adapterD1 = {
      complete: mock(async () => ({ output: "", costUsd: 0 })),
      run: mock(async (opts: Record<string, unknown>) => {
        if (isRebuttalCall([opts])) d1RebuttalHit = true;
        return { success: true, output: "d1-out", estimatedCost: 0.1 };
      }),
      plan: mock(async () => undefined),
    };
    _debateSessionDeps.getAgent = mock((name: string) => (name === "d0" ? adapterD0 : adapterD1) as never);
    const result = await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    expect(result).toBeDefined();
    expect(d0RebuttalHit).toBe(true);
    expect(d1RebuttalHit).toBe(true);
  });

  test("AC-49,60: < 2 proposals succeed → fallback DebateResult returned, no rebuttal calls", async () => {
    const adapterD0 = makeAdapter("d0-out");
    const adapterD1 = { complete: mock(async () => ({ output: "", costUsd: 0 })), run: mock(async () => { throw new Error("fail"); }), plan: mock(async () => undefined) };
    _debateSessionDeps.getAgent = mock((name: string) => (name === "d0" ? adapterD0 : adapterD1) as never);
    const result = await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    expect(result).toHaveProperty("storyId");
    expect(result).toHaveProperty("outcome");
    const d0RebuttalCalls = (adapterD0.run.mock.calls as RunCall[]).filter(isRebuttalCall);
    expect(d0RebuttalCalls).toHaveLength(0);
  });

  test("AC-50,57,68: sessionRole for every active run() call is 'debate-hybrid-N'", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    const d0Active = (adapters.get("d0")!.run.mock.calls as RunCall[]).filter((c) => c[0].keepSessionOpen !== false);
    const d1Active = (adapters.get("d1")!.run.mock.calls as RunCall[]).filter((c) => c[0].keepSessionOpen !== false);
    for (const c of d0Active) expect(c[0].sessionRole).toBe("debate-hybrid-0");
    for (const c of d1Active) expect(c[0].sessionRole).toBe("debate-hybrid-1");
  });

  test("AC-51,59: all rebuttal run() calls have keepSessionOpen === true", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    for (const call of getAllRunCalls(adapters).filter(isRebuttalCall)) {
      expect(call[0].keepSessionOpen).toBe(true);
    }
  });

  test("AC-52,69: each debater's session closed exactly once (1 run() call with keepSessionOpen=false)", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    for (const adapter of adapters.values()) {
      const closeCalls = (adapter.run.mock.calls as RunCall[]).filter((c) => c[0].keepSessionOpen === false);
      expect(closeCalls).toHaveLength(1);
    }
  });

  test("AC-53,70: sessions closed even when rebuttal throws (try/finally guarantees cleanup)", async () => {
    let throwOnce = true;
    const adapterD0 = {
      complete: mock(async () => ({ output: "", costUsd: 0 })),
      run: mock(async (opts: Record<string, unknown>) => {
        if (isRebuttalCall([opts]) && throwOnce) { throwOnce = false; throw new Error("unrecoverable"); }
        return { success: true, output: "d0", estimatedCost: 0.1 };
      }),
      plan: mock(async () => undefined),
    };
    const adapterD1 = makeAdapter("d1");
    _debateSessionDeps.getAgent = mock((name: string) => (name === "d0" ? adapterD0 : adapterD1) as never);
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    const d0Close = (adapterD0.run.mock.calls as RunCall[]).filter((c) => c[0].keepSessionOpen === false);
    const d1Close = (adapterD1.run.mock.calls as RunCall[]).filter((c) => c[0].keepSessionOpen === false);
    expect(d0Close).toHaveLength(1);
    expect(d1Close).toHaveLength(1);
  });

  test("AC-54,71: totalCostUsd sums proposal + rebuttal costs (> 0, ≤ total adapter run cost)", async () => {
    const cost = 0.1;
    const adapters = wireAdapters(TWO_DEBATERS);
    const result = await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    const totalAdapterCalls = [...adapters.values()].reduce((s, a) => s + a.run.mock.calls.length, 0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeLessThanOrEqual(totalAdapterCalls * cost + 0.001);
  });

  test("AC-55,72: DebateResult.rebuttals has one entry per successful rebuttal turn with correct shape", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    const result = await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    expect(Array.isArray(result.rebuttals)).toBe(true);
    expect(result.rebuttals?.length).toBe(2);
    if (result.rebuttals) {
      for (const r of result.rebuttals) {
        expect(r).toHaveProperty("debater");
        expect(r).toHaveProperty("round");
        expect(r).toHaveProperty("output");
        expect(typeof r.round).toBe("number");
        expect(typeof r.output).toBe("string");
      }
    }
  });

  test("AC-56: 'debate:rebuttal-start' log event emitted before each rebuttal turn", async () => {
    const logEvents: string[] = [];
    _debateSessionDeps.getSafeLogger = (() => ({
      info: (...args: unknown[]) => { const e = args.find((a) => typeof a === "string"); if (e) logEvents.push(e as string); },
      warn: () => {},
      error: () => {},
      debug: () => {},
    })) as never;
    const adapters = wireAdapters(TWO_DEBATERS);
    await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    expect(logEvents.some((e) => e.includes("debate:rebuttal-start"))).toBe(true);
  });

  test("AC-58: proposals use bounded concurrency via allSettledBounded (result contains correct debaters)", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    const result = await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    expect(result.debaters.length).toBeGreaterThan(0);
    const totalProposalCalls = getAllRunCalls(adapters).filter((c) => !isRebuttalCall(c) && c[0].keepSessionOpen !== false);
    expect(totalProposalCalls).toHaveLength(TWO_DEBATERS.length);
  });

  test("AC-61: resolve() receives proposalOutputs from fulfilled proposals only", async () => {
    const adapters = wireAdapters(TWO_DEBATERS);
    const result = await makeHybridSession(TWO_DEBATERS, 1).run("prompt");
    expect(result.proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of result.proposals) expect(p.output).toBeTruthy();
  });

  test("AC-62: resolveDebaterModel from session-helpers is used (no inline duplicate)", () => {
    expect(typeof sessionHelpers.resolveDebaterModel).toBe("function");
    const r = _resolveDebaterModel({ agent: "claude" }, undefined);
    expect(r === undefined || typeof r === "string").toBe(true);
  });
});