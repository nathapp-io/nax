/**
 * US-005 — `configureRunRules` appending the native rule-delivery handlers, as
 * reached from `initializeAfterLock`.
 *
 * The append happens after the plugin registry's entries and only under
 * workflow mode with `context.rules.delivery: "index"`: plugin handlers keep
 * their registration order (a plugin nudging the same call is meant to be
 * superseded by the rule-delivery one — `registry.ts` keeps the last nudge), and
 * `push` restores the plugin set untouched, by identity.
 *
 * `_runRulesSetupDeps.createRuleDeliveryHandlers` is the seam: this file is
 * about what reaches `configureLoopHandlers`, not about what the handlers do
 * (that is `rule-delivery.test.ts` and `rule-delivery-state.test.ts`).
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, type Mock, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoopHandlerEntry, LoopHandlerSet } from "@nathapp/nax-agent/internal";
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
import { RULE_DELIVERY_PLUGIN } from "@/context/rules/rule-delivery";
import { _runRulesSetupDeps } from "@/execution/lifecycle/run-rules-setup";
import { type InitializeAfterLockDeps, initializeAfterLock } from "@/execution/lifecycle/run-setup-init";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "rules-delivery-setup";
const RUN_ID = "run-rule-delivery-setup";
const LOOP_HANDLER_PLUGIN = "seed-note-plugin";

/** The shape of the manager method the assertions read calls off. */
type ConfigureSpy = Mock<(set: LoopHandlerSet) => void>;

/** The plugin whose one `before_turn` entry the delivered set must lead with. */
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

/** A stand-in for the handler set US-005 appends. */
const STUB_ENTRY: LoopHandlerEntry = {
  plugin: RULE_DELIVERY_PLUGIN,
  event: "before_tool",
  handler: async () => ({ kind: "allow" }),
};

const REAL_CREATE = _runRulesSetupDeps.createRuleDeliveryHandlers;

let workdir = "";

afterEach(() => {
  _runRulesSetupDeps.createRuleDeliveryHandlers = REAL_CREATE;
  if (workdir !== "") cleanupTempDir(workdir);
  workdir = "";
});

/** Stub the handler-set factory, and report how many times it was asked. */
function stubRuleDeliveryHandlers(): { readonly calls: number } {
  const counter = { calls: 0 };
  _runRulesSetupDeps.createRuleDeliveryHandlers = (input) => {
    counter.calls += 1;
    expect(input.repoRoot).toBe(workdir);
    return [STUB_ENTRY];
  };
  return counter;
}

const DEPS: InitializeAfterLockDeps = {
  // Nothing here is about profile detection or transcript sweeping; both are
  // closed so the plugin load and its delivery are the only run-start work.
  detectProjectProfile: async () => ({}),
  sweepFeatureTranscripts: async () => 0,
};

async function runInitializeAfterLock(
  config: ReturnType<typeof makeNaxConfig>,
  configureLoopHandlers: (set: LoopHandlerSet) => void,
) {
  const prdPath = join(workdir, ".nax", "features", FEATURE, "prd.json");
  await fs.mkdir(dirname(prdPath), { recursive: true });
  await fs.mkdir(join(workdir, ".nax", "plugins"), { recursive: true });
  await Bun.write(join(workdir, ".nax", "plugins", "seed-note-plugin.ts"), LOOP_HANDLER_PLUGIN_SOURCE);
  const prd = makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-005" })] });
  await Bun.write(prdPath, JSON.stringify(prd, null, 2));

  return initializeAfterLock({
    config,
    workdir,
    feature: FEATURE,
    dryRun: true,
    runtime: makeMockRuntime({ workdir, sessionManager: makeSessionManager({ configureLoopHandlers }) }),
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
// The append
// ─────────────────────────────────────────────────────────────────────────────

describe("initializeAfterLock — the rule-delivery handlers appended to the plugin set", () => {
  test("AC-22: workflow mode with delivery 'index' delivers the plugin entries, then the rule-delivery entry", async () => {
    workdir = makeTempDir("nax-run-rules-delivery-index-");
    stubRuleDeliveryHandlers();
    const configure = mock((_set: LoopHandlerSet) => {});

    const result = await runInitializeAfterLock(
      makeNaxConfig({ context: { rules: { delivery: "index" } } }),
      configure,
    );

    expect(configure).toHaveBeenCalledTimes(1);
    const set = deliveredSet(configure);
    const pluginSet = result.pluginRegistry.getLoopHandlers();
    expect(pluginSet).toHaveLength(1);
    expect(set).toHaveLength(pluginSet.length + 1);
    // The leading entries ARE the registry's own entry objects, in order.
    for (const [index, entry] of pluginSet.entries()) {
      expect(set[index]).toBe(entry);
    }
    expect(set.at(-1)).toBe(STUB_ENTRY);
  });

  test("AC-23: delivery 'push' delivers the plugin registry's own set, with no rule-delivery entry", async () => {
    workdir = makeTempDir("nax-run-rules-delivery-push-");
    const stub = stubRuleDeliveryHandlers();
    const configure = mock((_set: LoopHandlerSet) => {});

    const result = await runInitializeAfterLock(makeNaxConfig({ context: { rules: { delivery: "push" } } }), configure);

    expect(configure).toHaveBeenCalledTimes(1);
    const set = deliveredSet(configure);
    expect(set).toBe(result.pluginRegistry.getLoopHandlers());
    expect(set.some((entry) => entry.plugin === RULE_DELIVERY_PLUGIN)).toBe(false);
    expect(stub.calls).toBe(0);
  });

  test("AC-23: workflow mode with delivery 'push' registers no rule handler at all", async () => {
    workdir = makeTempDir("nax-run-rules-delivery-push-workflow-");
    const configure = mock((_set: LoopHandlerSet) => {});

    await runInitializeAfterLock(makeNaxConfig({ context: { rules: { delivery: "push" } } }), configure);

    const set = deliveredSet(configure);
    expect(set.some((entry) => entry.plugin === RULE_DELIVERY_PLUGIN)).toBe(false);
  });

  test("the configured override directory reaches the handler factory", async () => {
    workdir = makeTempDir("nax-run-rules-delivery-override-");
    const seen: string[] = [];
    _runRulesSetupDeps.createRuleDeliveryHandlers = (input) => {
      seen.push(`${input.overrideMode}:${input.overrideDir ?? "-"}`);
      return [STUB_ENTRY];
    };
    const configure = mock((_set: LoopHandlerSet) => {});
    const overrideDir = join(workdir, "org-rules");
    await fs.mkdir(overrideDir, { recursive: true });

    await runInitializeAfterLock(
      makeNaxConfig({ context: { rules: { overrideDir, overrideMode: "replace" } } }),
      configure,
    );

    expect(seen).toEqual([`replace:${overrideDir}`]);
  });
});
