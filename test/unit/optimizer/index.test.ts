/**
 * resolveOptimizer — optimizer resolution.
 *
 * The `rule-based` built-in was removed: introduced 2026-02-23 in a3963d48d, it
 * lost its 24 tests 15 days later to a false positive in report-dead-tests and
 * was never selected by any config in the life of the repo. `noop` and
 * plugin-provided optimizers are the only remaining paths.
 */

import { describe, expect, test } from "bun:test";
import { NoopOptimizer, resolveOptimizer } from "@/optimizer";
import type { IPromptOptimizer } from "@/optimizer";
import { PluginRegistry } from "@/plugins";
import type { NaxPlugin } from "@/plugins";
import { makeNaxConfig } from "@test/helpers";

const passthroughOptimizer: IPromptOptimizer = {
  name: "plugin-opt",
  optimize: async (input) => ({
    prompt: input.prompt,
    originalTokens: 0,
    optimizedTokens: 0,
    savings: 0,
    appliedRules: [],
  }),
};

function registryWithOptimizer(): PluginRegistry {
  const plugin: NaxPlugin = {
    name: "plugin-opt",
    version: "1.0.0",
    provides: ["optimizer"],
    extensions: { optimizer: passthroughOptimizer },
  };
  return new PluginRegistry([plugin]);
}

describe("resolveOptimizer", () => {
  test("returns NoopOptimizer when the optimizer block is absent", () => {
    const config = makeNaxConfig();
    config.optimizer = undefined;

    expect(resolveOptimizer(config)).toBeInstanceOf(NoopOptimizer);
  });

  test("returns NoopOptimizer when optimizer.enabled is false", () => {
    expect(resolveOptimizer(makeNaxConfig({ optimizer: { enabled: false } }))).toBeInstanceOf(NoopOptimizer);
  });

  test("returns NoopOptimizer when enabled with no plugin registry", () => {
    const resolved = resolveOptimizer(makeNaxConfig({ optimizer: { enabled: true } }));

    expect(resolved).toBeInstanceOf(NoopOptimizer);
    expect(resolved.name).toBe("noop");
  });

  test("returns NoopOptimizer when enabled and the registry has no optimizer plugin", () => {
    const resolved = resolveOptimizer(makeNaxConfig({ optimizer: { enabled: true } }), new PluginRegistry([]));

    expect(resolved.name).toBe("noop");
  });

  test("a plugin-provided optimizer wins over the built-in", () => {
    const resolved = resolveOptimizer(makeNaxConfig({ optimizer: { enabled: true } }), registryWithOptimizer());

    expect(resolved.name).toBe("plugin-opt");
  });

  test("a disabled optimizer ignores plugins too", () => {
    const resolved = resolveOptimizer(makeNaxConfig({ optimizer: { enabled: false } }), registryWithOptimizer());

    expect(resolved).toBeInstanceOf(NoopOptimizer);
  });

  test("RuleBasedOptimizer is no longer exported", async () => {
    const mod = await import("@/optimizer");

    expect("RuleBasedOptimizer" in mod).toBe(false);
  });
});
