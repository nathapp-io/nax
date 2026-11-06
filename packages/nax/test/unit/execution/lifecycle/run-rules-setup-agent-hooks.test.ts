/**
 * US-007 — a run loads agent hooks only through an explicit opt-in.
 *
 * `configureRunRules` is shared by two callers: `initializeAfterLock` (this
 * run's own repository, where the operator's `.nax/hooks.json` is theirs) and
 * `nax bot`, which configures a PR worktree that may come from a fork. Loading
 * hooks for the second would execute a stranger's shell commands as the bot's
 * user, so the loader is reachable only by passing `agentHooks: "run"` — which
 * exactly one caller does.
 *
 * Ordering at the seam is plugin handlers, then agent hooks, then rule
 * delivery: rule delivery answers `before_tool` with the last nudge, and the
 * rule text is what the operator configured, so nothing may be appended after
 * it. The `agent-hooks` handlers must therefore be merged into `pluginHandlers`
 * BEFORE `withRuleDeliveryHandlers` sees the set.
 *
 * Every hook-related assertion here stubs `_runRulesSetupDeps.loadAgentHookHandlers`,
 * so these tests never spawn a hook process. The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, type Mock, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoopHandlerEntry, LoopHandlerSet } from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  assertNaxError,
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { RULE_DELIVERY_PLUGIN } from "@/context/rules/rule-delivery";
import { _runRulesSetupDeps, configureRunRules } from "@/execution/lifecycle/run-rules-setup";
import type { InitializeAfterLockDeps, InitializeAfterLockResult } from "@/execution/lifecycle/run-setup-init";
import { initializeAfterLock } from "@/execution/lifecycle/run-setup-init";
import type { AgentHookSurface } from "@/hooks";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const WORKDIR = "/repo";

/** The `loop-handlers` entries the plugin registry contributed. */
const PLUGIN_HANDLERS: LoopHandlerSet = [{ plugin: "seed-note-plugin", event: "before_turn", handler: () => ({}) }];

/**
 * What the stubbed loader returns. A distinct plugin name so an assertion can
 * tell it apart from both the plugin registry's entries and rule delivery's.
 */
const SENTINEL: LoopHandlerEntry = { plugin: "sentinel-agent-hook", event: "before_tool", handler: () => ({}) };

const REAL_DIR_EXISTS = _runRulesSetupDeps.dirExists;
const REAL_LOAD_AGENT_HOOK_HANDLERS = _runRulesSetupDeps.loadAgentHookHandlers;

afterEach(() => {
  _runRulesSetupDeps.dirExists = REAL_DIR_EXISTS;
  _runRulesSetupDeps.loadAgentHookHandlers = REAL_LOAD_AGENT_HOOK_HANDLERS;
});

type LoaderStub = Mock<
  (input: { readonly surface: AgentHookSurface; readonly repoRoot: string }) => Promise<LoopHandlerSet>
>;

/** Replace the loader with a stub returning `set`, keeping its call log. */
function stubLoader(set: LoopHandlerSet): LoaderStub {
  const stub = mock(async (_input: { readonly surface: AgentHookSurface; readonly repoRoot: string }) => set);
  _runRulesSetupDeps.loadAgentHookHandlers = stub;
  return stub;
}

/** The overrideDir probe, answering `answer` for every path. */
function stubDirExists(answer: boolean): void {
  _runRulesSetupDeps.dirExists = async () => answer;
}

interface ConfigShape {
  delivery?: "index" | "push";
  overrideDir?: string;
}

function testConfig({ delivery = "index", overrideDir }: ConfigShape = {}) {
  return makeNaxConfig({
    context: { rules: { delivery, overrideDir } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1, AC-2 — the run surface is the one whose hooks are loaded, ordered last
// ─────────────────────────────────────────────────────────────────────────────

describe("US-007 — configureRunRules with agentHooks: 'run'", () => {
  test("AC-1: calls the loader once with { surface: 'run', repoRoot: workdir }", async () => {
    stubDirExists(true);
    const loader = stubLoader([SENTINEL]);

    await configureRunRules({
      config: testConfig(),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
      agentHooks: "run",
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]).toEqual([{ surface: "run", repoRoot: WORKDIR }]);
  });

  test("AC-2: returns plugin handlers, then the sentinel, then the rule-delivery entries", async () => {
    stubDirExists(true);
    stubLoader([SENTINEL]);

    const out = await configureRunRules({
      config: testConfig(),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
      agentHooks: "run",
    });

    expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
    expect(out[1]).toBe(SENTINEL);
    const tail = out.slice(PLUGIN_HANDLERS.length + 1);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((entry) => entry.plugin === RULE_DELIVERY_PLUGIN)).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-3, AC-4 — rule delivery skipped: hooks still load, identity when empty
  // ───────────────────────────────────────────────────────────────────────────

  test("AC-3: with push delivery (rule delivery skipped) returns the plugin handlers then the sentinel", async () => {
    stubDirExists(true);
    const loader = stubLoader([SENTINEL]);

    const out = await configureRunRules({
      config: testConfig({ delivery: "push" }),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
      agentHooks: "run",
    });

    // opted in, so the loader runs even though rule delivery did not apply
    expect(loader).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(PLUGIN_HANDLERS.length + 1);
    expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
    expect(out[1]).toBe(SENTINEL);
  });

  test("AC-4: an empty hook set returns the plugin set itself (same array)", async () => {
    stubDirExists(true);
    stubLoader([]);

    const out = await configureRunRules({
      config: testConfig({ delivery: "push" }),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
      agentHooks: "run",
    });

    expect(out).toBe(PLUGIN_HANDLERS);
  });

  test("AC-4 (boundary): an empty hook set leaves the delivery-on result exactly as it is today", async () => {
    stubDirExists(true);
    stubLoader([]);

    const out = await configureRunRules({
      config: testConfig(),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
      agentHooks: "run",
    });

    // No hook entry is spliced in: the plugin entry leads and every later
    // entry is rule delivery's.
    expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
    const tail = out.slice(PLUGIN_HANDLERS.length);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((entry) => entry.plugin === RULE_DELIVERY_PLUGIN)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5, AC-6 — no opt-in means no hooks, and today's set by identity
// ─────────────────────────────────────────────────────────────────────────────

describe("US-007 — configureRunRules without agentHooks", () => {
  test("AC-5: never calls the loader, even with workflow mode and delivery 'index'", async () => {
    stubDirExists(true);
    const loader = stubLoader([SENTINEL]);

    await configureRunRules({ config: testConfig(), workdir: WORKDIR, pluginHandlers: PLUGIN_HANDLERS });

    expect(loader).not.toHaveBeenCalled();
  });

  test("AC-6: returns the plugin handler set by identity when rule delivery is skipped", async () => {
    stubDirExists(true);
    stubLoader([SENTINEL]);

    const out = await configureRunRules({
      config: testConfig({ delivery: "push" }),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
    });

    expect(out).toBe(PLUGIN_HANDLERS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — the overrideDir check still fails the run before any hook runs
// ─────────────────────────────────────────────────────────────────────────────

describe("US-007 — configureRunRules validation precedes hook loading", () => {
  test("AC-7: a missing overrideDir rejects with RULES_OVERRIDE_DIR_NOT_FOUND and loads no hooks", async () => {
    stubDirExists(false);
    const loader = stubLoader([SENTINEL]);

    const err = await configureRunRules({
      config: testConfig({ overrideDir: "/missing/org-rules" }),
      workdir: WORKDIR,
      pluginHandlers: PLUGIN_HANDLERS,
      agentHooks: "run",
    }).catch((caught: unknown) => caught);

    assertNaxError(err, "configureRunRules rejection");
    expect(err.code).toBe("RULES_OVERRIDE_DIR_NOT_FOUND");
    expect(loader).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8, AC-9 — initializeAfterLock is the caller that opts in
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "agent-hooks-run";
const RUN_ID = "run-us-007";
const LOOP_HANDLER_PLUGIN = "seed-note-plugin";

/**
 * A plugin that stages exactly one `before_turn` handler. Written as source
 * because the loader imports it from the temp workdir — that import is what
 * makes the "right after the registry's entries" assertion meaningful, since
 * the registry set is non-empty only when a real plugin contributes to it.
 */
const LOOP_HANDLER_PLUGIN_SOURCE = `
export default {
  name: "${LOOP_HANDLER_PLUGIN}",
  version: "1.0.0",
  provides: ["loop-handlers"],
  extensions: {
    loopHandlers: {
      register(on) {
        on("before_turn", () => ({ seed: [{ role: "user", content: "SEED-NOTE" }] }));
      },
    },
  },
};
`;

const DEPS: InitializeAfterLockDeps = {
  // Nothing here is about profile detection or transcript sweeping; both are
  // closed so the hook load and its delivery are the only run-start work.
  detectProjectProfile: async () => ({}),
  sweepFeatureTranscripts: async () => 0,
};

let workdir = "";

afterEach(() => {
  if (workdir !== "") cleanupTempDir(workdir);
  workdir = "";
});

type ConfigureSpy = Mock<(set: LoopHandlerSet) => void>;

/** Run the real post-lock initialization over a temp workdir with one plugin. */
async function runInitializeAfterLock(): Promise<{
  configure: ConfigureSpy;
  result: InitializeAfterLockResult;
}> {
  workdir = makeTempDir("nax-run-rules-agent-hooks-");
  const pluginsDir = join(workdir, ".nax", "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await Bun.write(join(pluginsDir, "seed-note-plugin.ts"), LOOP_HANDLER_PLUGIN_SOURCE);

  const prdPath = join(workdir, ".nax", "features", FEATURE, "prd.json");
  await fs.mkdir(dirname(prdPath), { recursive: true });
  const prd = makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-007" })] });
  await Bun.write(prdPath, JSON.stringify(prd, null, 2));

  const configure: ConfigureSpy = mock((_set: LoopHandlerSet) => {});
  const result = await initializeAfterLock({
    config: makeNaxConfig(),
    workdir,
    feature: FEATURE,
    dryRun: true,
    runtime: makeMockRuntime({ workdir, sessionManager: makeSessionManager({ configureLoopHandlers: configure }) }),
    prdPath,
    prd,
    interactionChain: null,
    runId: RUN_ID,
    statusWriter: makeStatusWriter(),
    deps: DEPS,
  });
  return { configure, result };
}

/** The set the run handed to its session manager, or a failed test. */
function deliveredSet(configure: ConfigureSpy): LoopHandlerSet {
  const call = configure.mock.calls[0];
  assertDefined(call, "the runtime.sessionManager.configureLoopHandlers(...) call");
  return call[0];
}

describe("US-007 — initializeAfterLock loads the run surface's agent hooks", () => {
  test("AC-8: delivers the sentinel right after the plugin entries and before rule delivery", async () => {
    // The loader itself is stubbed — these tests are about the wiring, not the
    // config read (`load.test.ts` owns that).
    stubLoader([SENTINEL]);

    const { configure, result } = await runInitializeAfterLock();

    expect(configure).toHaveBeenCalledTimes(1);
    const set = deliveredSet(configure);
    const pluginSet = result.pluginRegistry.getLoopHandlers();
    assertDefined(pluginSet[0], "the plugin registry's own entry");

    // plugin entries first, in order and by identity ...
    for (const [index, entry] of pluginSet.entries()) {
      expect(set[index]).toBe(entry);
    }
    // ... then the agent hooks ...
    expect(set[pluginSet.length]).toBe(SENTINEL);
    // ... then rule delivery, which must stay last.
    const tail = set.slice(pluginSet.length + 1);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((entry) => entry.plugin === RULE_DELIVERY_PLUGIN)).toBe(true);
  });

  test("AC-9: calls the loader with { surface: 'run', repoRoot: workdir }", async () => {
    const loader = stubLoader([SENTINEL]);

    await runInitializeAfterLock();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]).toEqual([{ surface: "run", repoRoot: workdir }]);
  });
});
