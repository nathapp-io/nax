/**
 * US-002 — `configureRunRules`: run-start validation of the rules override.
 *
 * `initializeAfterLock` hands the plugin registry's loop-handler set to this
 * function instead of the session manager directly, so every run validates the
 * override directory before any story starts. The check is deliberately
 * fail-closed: the operator asked for those rules, and a run that silently
 * proceeded without them would look identical to a run that honoured them.
 *
 * US-005 extends the same call: under workflow mode with
 * `context.rules.delivery: "index"` the native rule-delivery handlers are
 * appended after the plugin entries. `push` — and pipeline mode — still return
 * the registry's own set *by identity*, which is the invariant US-002 pinned.
 *
 * The existence probe is a `_deps` seam, so these tests never touch the disk —
 * the integration file drives it for real through `initializeAfterLock`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { assertNaxError, makeNaxConfig, makeSparseNaxConfig } from "@test/helpers";
import { RULE_DELIVERY_PLUGIN } from "@/context/rules/rule-delivery";
import { _runRulesSetupDeps, configureRunRules } from "@/execution/lifecycle/run-rules-setup";

const REAL_DIR_EXISTS = _runRulesSetupDeps.dirExists;

afterEach(() => {
  _runRulesSetupDeps.dirExists = REAL_DIR_EXISTS;
});

/** A distinguishable handler set — identity is the assertion in several tests. */
const PLUGIN_HANDLERS: LoopHandlerSet = [{ plugin: "seed-note-plugin", event: "before_turn", handler: () => ({}) }];

/** Record which paths the probe saw, and answer with `answer`. */
function stubDirExists(answer: boolean): string[] {
  const asked: string[] = [];
  _runRulesSetupDeps.dirExists = async (path: string) => {
    asked.push(path);
    return answer;
  };
  return asked;
}

function configWithOverrideDir(overrideDir: string | undefined, delivery: "index" | "push" = "index") {
  return makeNaxConfig({ context: { rules: { delivery, overrideDir } } });
}

describe("configureRunRules — passing the plugin set through (US-002)", () => {
  test("delivery 'push' returns the plugin registry's own set by identity", async () => {
    const asked = stubDirExists(true);

    const out = await configureRunRules({
      config: configWithOverrideDir(undefined, "push"),
      workdir: "/repo",
      pluginHandlers: PLUGIN_HANDLERS,
    });

    expect(out).toBe(PLUGIN_HANDLERS);
    expect(asked).toEqual([]);
  });

  test("delivery 'push' returns the plugin registry's own set by identity when the overrideDir exists", async () => {
    stubDirExists(true);

    const out = await configureRunRules({
      config: configWithOverrideDir("/abs/org-rules", "push"),
      workdir: "/repo",
      pluginHandlers: PLUGIN_HANDLERS,
    });

    expect(out).toBe(PLUGIN_HANDLERS);
  });

  test("delivery 'index' appends the rule-delivery handlers after the plugin entries (US-005)", async () => {
    stubDirExists(true);

    const out = await configureRunRules({
      config: configWithOverrideDir(undefined),
      workdir: "/repo",
      pluginHandlers: PLUGIN_HANDLERS,
    });

    expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
    expect(out.slice(PLUGIN_HANDLERS.length).map((entry) => entry.plugin)).toEqual([
      RULE_DELIVERY_PLUGIN,
      RULE_DELIVERY_PLUGIN,
    ]);
  });

  test("probes exactly the configured overrideDir", async () => {
    const asked = stubDirExists(true);

    await configureRunRules({
      config: configWithOverrideDir("/abs/org-rules"),
      workdir: "/repo",
      pluginHandlers: PLUGIN_HANDLERS,
    });

    expect(asked).toEqual(["/abs/org-rules"]);
  });
});

describe("configureRunRules — RULES_OVERRIDE_DIR_NOT_FOUND (US-002)", () => {
  test("AC-21: rejects with error context carrying stage 'run-setup' and the overrideDir", async () => {
    stubDirExists(false);

    try {
      await configureRunRules({
        config: configWithOverrideDir("/missing/org-rules"),
        workdir: "/repo",
        pluginHandlers: PLUGIN_HANDLERS,
      });
      throw new Error("configureRunRules resolved for an unavailable overrideDir");
    } catch (err) {
      assertNaxError(err, "configureRunRules rejection");
      expect(err.code).toBe("RULES_OVERRIDE_DIR_NOT_FOUND");
      expect(err.context).toMatchObject({ stage: "run-setup", overrideDir: "/missing/org-rules" });
    }
  });

  test("the message names the offending directory, so the operator can fix it", async () => {
    stubDirExists(false);

    const err = await configureRunRules({
      config: configWithOverrideDir("/missing/org-rules"),
      workdir: "/repo",
      pluginHandlers: PLUGIN_HANDLERS,
    }).catch((caught: unknown) => caught);

    assertNaxError(err, "configureRunRules rejection");
    expect(err.message).toContain("/missing/org-rules");
  });

  test("delivery 'push' is validated too — the override dir is not a delivery-mode concern", async () => {
    stubDirExists(false);

    const err = await configureRunRules({
      config: configWithOverrideDir("/missing/org-rules", "push"),
      workdir: "/repo",
      pluginHandlers: PLUGIN_HANDLERS,
    }).catch((caught: unknown) => caught);

    assertNaxError(err, "configureRunRules rejection");
    expect(err.code).toBe("RULES_OVERRIDE_DIR_NOT_FOUND");
  });

  test("a sparse config (no context block at all) is accepted, not a crash", async () => {
    const asked = stubDirExists(true);
    const sparse = makeSparseNaxConfig({});

    const out = await configureRunRules({ config: sparse, workdir: "/repo", pluginHandlers: PLUGIN_HANDLERS });

    // An unparsed config still reads as workflow mode with the schema's default
    // delivery, so the plugin entry leads and the two handlers follow it.
    expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
    expect(out).toHaveLength(PLUGIN_HANDLERS.length + 2);
    expect(asked).toEqual([]);
  });
});
