import { describe, expect, it, spyOn } from "bun:test";
import { makeTestRuntime } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";
import { loadPlugins } from "@/plugins/loader";

describe("built-in plugins", () => {
  it("does not register the removed curator", async () => {
    const registry = await loadPlugins("/nonexistent/nax-global", "/nonexistent/nax-project", []);
    expect(registry.plugins.map((plugin) => plugin.name)).not.toContain("curator");
    expect(registry.plugins.map((plugin) => plugin.name)).not.toContain("nax-curator");
  });

  it("ignores the retired disabled plugin name without logging a skip", async () => {
    const logger = initLogger({ level: "silent" });
    const info = spyOn(logger, "info");
    try {
      const registry = await loadPlugins("/nonexistent/nax-global", "/nonexistent/nax-project", [], undefined, [
        "curator",
        "nax-auto-pr",
      ]);
      expect(info.mock.calls.some(([, message]) => message.startsWith("Skipping disabled plugin: 'nax-auto-pr'"))).toBe(
        true,
      );
      expect(registry.plugins.map((plugin) => plugin.name)).not.toContain("curator");
      expect(info.mock.calls.some(([, message]) => message.startsWith("Skipping disabled plugin: 'curator'"))).toBe(
        false,
      );
    } finally {
      info.mockRestore();
      resetLogger();
    }
  });

  it("does not expose a curator rollup path on the runtime", async () => {
    const runtime = makeTestRuntime();
    expect(Object.hasOwn(runtime, "curatorRollupPath")).toBe(false);
    await runtime.close();
  });
});
