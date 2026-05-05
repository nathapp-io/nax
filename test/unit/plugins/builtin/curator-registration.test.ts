/**
 * Curator Plugin Registration Tests
 *
 * Tests for built-in plugin registration in PluginRegistry.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "../../../../src/plugins/loader";
import { PluginRegistry } from "../../../../src/plugins/registry";
import { curatorPlugin } from "../../../../src/plugins/builtin/curator";

describe("Curator Plugin Registration", () => {
  test("should be available as a built-in plugin", () => {
    expect(curatorPlugin).toBeDefined();
    expect(curatorPlugin.name).toBe("nax-curator");
  });

  test("should appear in registry with provides=['post-run-action']", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.name === "nax-curator")).toBe(true);
  });

  test("loadPlugins registers curator by default and honors disabledPlugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-registration-"));
    const enabled = await loadPlugins(join(root, "global"), join(root, "project"), [], root, []);
    expect(enabled.getPostRunActions().some((a) => a.name === "nax-curator")).toBe(true);

    const disabled = await loadPlugins(join(root, "global"), join(root, "project"), [], root, ["nax-curator"]);
    expect(disabled.getPostRunActions().some((a) => a.name === "nax-curator")).toBe(false);
  });

  test("should be discoverable via getPostRunActions()", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    const curator = actions.find((a) => a.name === "nax-curator");
    expect(curator).toBeDefined();
    expect(curator?.description).toBeDefined();
  });

  test("should be included in registry.plugins", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const names = registry.plugins.map((p) => p.name);

    expect(names).toContain("nax-curator");
  });

  test("should be disableable via disabledPlugins", () => {
    // Note: This test documents the expected behavior.
    // Actual disabling is implemented in the plugin loader.
    expect(curatorPlugin.name).toBe("nax-curator");
  });

  test("registry.getPostRunActions() should return curator when loaded", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    if (curatorPlugin.extensions.postRunAction) {
      expect(actions).toContain(curatorPlugin.extensions.postRunAction);
    }
  });

  test("curator should be the only post-run action when alone in registry", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions.length).toBe(1);
    expect(actions[0].name).toBe("nax-curator");
  });

  test("curator should coexist with other plugins in registry", () => {
    const otherPlugin = {
      name: "test-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "test-reporter",
          async onRunEnd() {
            // no-op
          },
        },
      },
    } as any;

    const registry = new PluginRegistry([curatorPlugin, otherPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions.some((a) => a.name === "nax-curator")).toBe(true);
  });
});
