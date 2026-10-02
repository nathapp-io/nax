/**
 * US-004 — run setup hands the loaded plugin loop handlers to the run's session
 * manager.
 *
 * `initializeAfterLock` is where a run's plugins are loaded, so it is also the
 * only place that can give the run's session manager the handlers those plugins
 * registered: `runtime.sessionManager.configureLoopHandlers(registry.getLoopHandlers())`.
 * These tests drive the real function with a REAL plugin loaded from a temp
 * workdir's `.nax/plugins/` (the loader is part of what is being pinned) and
 * close every other side effect through `deps`, so the only thing observed is
 * what reached the manager.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, type Mock, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { InitializeAfterLockDeps, InitializeAfterLockResult } from "@/execution/lifecycle/run-setup-init";
import { initializeAfterLock } from "@/execution/lifecycle/run-setup-init";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "plugin-loop-handlers";
const RUN_ID = "run-us-004";
const LOOP_HANDLER_PLUGIN = "seed-note-plugin";
const REVIEWER_PLUGIN = "unrelated-reviewer-plugin";

/** The shape of the manager method the assertions read calls off. */
type ConfigureSpy = Mock<(set: LoopHandlerSet) => void>;

/**
 * A plugin whose `register` stages one `before_turn` handler. Written as source
 * because the loader imports it from disk — that import is the behaviour under
 * test, so a pre-built object would prove nothing.
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

/** A plugin that provides something else entirely — it contributes no handlers. */
const REVIEWER_PLUGIN_SOURCE = `
export default {
  name: "${REVIEWER_PLUGIN}",
  version: "1.0.0",
  provides: ["reviewer"],
  extensions: {
    reviewer: {
      name: "unrelated-check",
      description: "does nothing this story cares about",
      async check() {
        return { name: "unrelated-check", passed: true, findings: [] };
      },
    },
  },
};
`;

let workdir = "";

afterEach(() => {
  if (workdir !== "") cleanupTempDir(workdir);
  workdir = "";
});

async function writePluginFile(filename: string, source: string): Promise<void> {
  const dir = join(workdir, ".nax", "plugins");
  await fs.mkdir(dir, { recursive: true });
  await Bun.write(join(dir, filename), source);
}

const DEPS: InitializeAfterLockDeps = {
  // Nothing here is about profile detection or transcript sweeping; both are
  // closed so the plugin load and its delivery are the only run-start work.
  detectProjectProfile: async () => ({}),
  sweepFeatureTranscripts: async () => 0,
};

/** Run the real post-lock initialization over the current temp workdir. */
async function runInitializeAfterLock(
  configureLoopHandlers: (set: LoopHandlerSet) => void,
): Promise<InitializeAfterLockResult> {
  const prdPath = join(workdir, ".nax", "features", FEATURE, "prd.json");
  await fs.mkdir(dirname(prdPath), { recursive: true });
  const prd = makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-004" })] });
  await Bun.write(prdPath, JSON.stringify(prd, null, 2));

  return initializeAfterLock({
    config: makeNaxConfig(),
    workdir,
    feature: FEATURE,
    dryRun: true,
    runtime: makeMockRuntime({
      workdir,
      sessionManager: makeSessionManager({ configureLoopHandlers }),
    }),
    prdPath,
    prd,
    interactionChain: null,
    runId: RUN_ID,
    statusWriter: makeStatusWriter(),
    deps: DEPS,
  });
}

/** The set the manager was handed, or a failed test. */
function deliveredSet(configure: ConfigureSpy): LoopHandlerSet {
  const call = configure.mock.calls[0];
  assertDefined(call, "the runtime.sessionManager.configureLoopHandlers(...) call");
  const [set] = call;
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — the load's result reaches the session manager
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — initializeAfterLock: delivering the loaded loop handlers", () => {
  test("AC10: calls configureLoopHandlers once with the loaded plugin's entry", async () => {
    workdir = makeTempDir("nax-run-setup-init-loop-handlers-");
    await writePluginFile("seed-note-plugin.ts", LOOP_HANDLER_PLUGIN_SOURCE);
    const configure = mock((_set: LoopHandlerSet) => {});

    const result = await runInitializeAfterLock(configure);

    expect(configure).toHaveBeenCalledTimes(1);
    const set = deliveredSet(configure);
    // The delivered array IS the registry's own set — not a re-derived one.
    expect(set).toBe(result.pluginRegistry.getLoopHandlers());
    expect(set).toHaveLength(1);
    const delivered = set[0];
    assertDefined(delivered, "the delivered loop-handler entry");
    expect(delivered.plugin).toBe(LOOP_HANDLER_PLUGIN);
    expect(delivered.event).toBe("before_turn");
    expect(typeof delivered.handler).toBe("function");
  });

  test("AC10 (boundary): a plugin providing something else contributes no entry", async () => {
    workdir = makeTempDir("nax-run-setup-init-other-plugin-");
    await writePluginFile("seed-note-plugin.ts", LOOP_HANDLER_PLUGIN_SOURCE);
    await writePluginFile("unrelated-reviewer-plugin.ts", REVIEWER_PLUGIN_SOURCE);
    const configure = mock((_set: LoopHandlerSet) => {});

    await runInitializeAfterLock(configure);

    expect(configure).toHaveBeenCalledTimes(1);
    const set = deliveredSet(configure);
    expect(set.map((entry) => entry.plugin)).toEqual([LOOP_HANDLER_PLUGIN]);
  });
});
