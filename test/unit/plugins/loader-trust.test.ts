import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, useUntrustedRegistry } from "@test/helpers";
import { loadPlugins } from "@/plugins";
import { markTrusted } from "@/trust";

const pluginSource = (name: string, marker?: string): string =>
  `${marker ? `await Bun.write(${JSON.stringify(marker)}, "loaded");` : ""}\nexport default { name: ${JSON.stringify(name)}, version: "1.0.0", provides: ["router"], extensions: { router: { name: "test", route: async () => null } } };\n`;

describe("loadPlugins — US-005 trust backstop", () => {
  useUntrustedRegistry();
  let root = "";
  afterEach(() => cleanupTempDir(root));

  async function setupDirs(): Promise<{ project: string; globalDir: string; projectPluginsDir: string }> {
    root = makeTempDir();
    const project = await realpath(join(root, "project")).catch(async () => {
      const path = join(root, "project");
      await mkdir(path, { recursive: true });
      return realpath(path);
    });
    const globalDir = join(root, "global-plugins");
    const projectPluginsDir = join(project, ".nax", "plugins");
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectPluginsDir, { recursive: true });
    return { project, globalDir, projectPluginsDir };
  }

  test("US-005 AC1: rejects project-directory plugins with PROJECT_UNTRUSTED and plugins surface", async () => {
    const { project, globalDir, projectPluginsDir } = await setupDirs();
    await writeFile(join(projectPluginsDir, "sentinel.ts"), pluginSource("sentinel"));
    await expect(loadPlugins(globalDir, projectPluginsDir, [], project)).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
      context: { surface: "plugins" },
    });
  });

  test("US-005 AC2: does not import an untrusted project plugin", async () => {
    const { project, globalDir, projectPluginsDir } = await setupDirs();
    const marker = join(root, "imported.txt");
    await writeFile(join(projectPluginsDir, "sentinel.ts"), pluginSource("sentinel", marker));
    await expect(loadPlugins(globalDir, projectPluginsDir, [], project)).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
    });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("US-005 AC3: loads a global plugin without requiring project trust", async () => {
    const { project, globalDir, projectPluginsDir } = await setupDirs();
    await writeFile(join(globalDir, "global-plugin.ts"), pluginSource("global-plugin"));
    const registry = await loadPlugins(globalDir, projectPluginsDir, [], project);
    expect(registry.plugins.map((plugin) => plugin.name)).toContain("global-plugin");
  });

  test("US-005 AC4: rejects an enabled config plugin when its project is untrusted", async () => {
    const { project, globalDir, projectPluginsDir } = await setupDirs();
    await expect(loadPlugins(globalDir, projectPluginsDir, [{ module: "./p.ts" }], project)).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
      context: { surface: "plugins" },
    });
  });

  test("US-005 AC5: loads a project plugin after its root is trusted", async () => {
    const { project, globalDir, projectPluginsDir } = await setupDirs();
    await writeFile(join(projectPluginsDir, "trusted-plugin.ts"), pluginSource("trusted-plugin"));
    markTrusted(project);
    const registry = await loadPlugins(globalDir, projectPluginsDir, [], project);
    expect(registry.plugins.map((plugin) => plugin.name)).toContain("trusted-plugin");
  });
});
