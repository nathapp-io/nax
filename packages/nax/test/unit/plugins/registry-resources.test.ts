import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir, withWarnSpy } from "@test/helpers";
import { loadPlugins, type NaxPlugin, PluginRegistry, validatePlugin } from "@/plugins";
import type { PluginSource } from "@/plugins/loader";
import { markTrusted } from "@/trust";

function candidate(resources?: unknown) {
  return {
    name: "kit",
    version: "1.0.0",
    provides: ["resources"],
    extensions: resources === undefined ? {} : { resources },
  };
}

function kit(): NaxPlugin {
  return {
    name: "kit",
    version: "1.0.0",
    provides: ["resources"],
    extensions: { resources: { skills: "skills", commands: "cmds", agents: "agents" } },
  };
}
function registry(source: PluginSource): PluginRegistry {
  return new PluginRegistry([{ plugin: kit(), source }]);
}

describe("getResourceDirs", () => {
  test.each(["global", "project", "config"] as const)("AC-6 resolves %s module-relative directories", (type) => {
    expect(registry({ type, path: "/p/kit/index.ts" }).getResourceDirs()).toEqual([
      { plugin: "kit", skills: "/p/kit/skills", commands: "/p/kit/cmds", agents: "/p/kit/agents" },
    ]);
  });
  test("AC-7 no resource providers yields no directories", () => {
    expect(
      new PluginRegistry([
        { name: "reporter", version: "1", provides: ["reporter"], extensions: { reporter: { name: "reporter" } } },
      ]).getResourceDirs(),
    ).toEqual([]);
  });
  test.each([
    ["AC-8 builtin", { type: "builtin", path: "/p/index.ts" }],
    ["AC-10 npm", { type: "config", path: "@example/kit" }],
  ] satisfies [string, PluginSource][])("%s is skipped; AC-14 warns with plugin name", async (_label, source) => {
    await withWarnSpy(async (warn) => {
      expect(registry(source).getResourceDirs()).toEqual([]);
      expect(warn.mock.calls.some((call) => call[0] === "plugins" && call[1].includes("kit"))).toBe(true);
    });
  });
  test("AC-9 config module records its resolved path through loadPlugins", async () => {
    await withTempDir(async (root) => {
      markTrusted(root);
      await Bun.write(join(root, "plugins/kit.ts"), `export default ${JSON.stringify(kit())};`);
      const loaded = await loadPlugins(
        join(root, "missing-global"),
        join(root, "missing-project"),
        [{ module: "./plugins/kit.ts" }],
        root,
        ["nax-curator", "nax-auto-pr", "nax-auto-route"],
      );
      expect(loaded.getSource("kit")).toEqual({ type: "config", path: join(root, "plugins/kit.ts") });
      expect(loaded.getResourceDirs()).toEqual([
        {
          plugin: "kit",
          skills: join(root, "plugins/skills"),
          commands: join(root, "plugins/cmds"),
          agents: join(root, "plugins/agents"),
        },
      ]);
    });
  });
});

describe("validatePlugin resources", () => {
  test("AC-1 accepts a resources provider", () => {
    const plugin: NaxPlugin = {
      name: "kit",
      version: "1.0.0",
      provides: ["resources"],
      extensions: { resources: { skills: "skills" } },
    };
    expect(validatePlugin(plugin)).toBe(plugin);
  });
  test.each([
    ["AC-2 missing extension", undefined, "resources extension"],
    ["AC-3 absolute skills", { skills: "/abs/skills" }, "resources.skills"],
    ["AC-4 parent commands", { commands: "../outside" }, "resources.commands"],
    ["AC-5 empty agents", { agents: "" }, "resources.agents"],
    ["nested traversal", { skills: "a/../b" }, "resources.skills"],
    ["Windows traversal", { commands: "a\\..\\b" }, "resources.commands"],
    ["Windows absolute", { agents: "C:\\skills" }, "resources.agents"],
    ["whitespace", { skills: "  " }, "resources.skills"],
    ["non-string", { skills: 12 }, "resources.skills"],
    ["array extension", [], "resources extension"],
  ])("rejects %s with a resource-specific warning", async (_label, resources, field) => {
    await withWarnSpy(async (warn) => {
      expect(validatePlugin(candidate(resources))).toBeNull();
      expect(warn.mock.calls.some((call) => call[1].includes(String(field)))).toBe(true);
    });
  });
});
