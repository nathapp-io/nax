import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { _resetPluginErrorSink, _setPluginErrorSink, loadPlugins as loadPluginsWithBuiltins } from "@/plugins/loader";

const DISABLE_BUILTIN_PLUGINS = ["nax-curator", "nax-auto-pr"];

function loadPlugins(...args: Parameters<typeof loadPluginsWithBuiltins>): ReturnType<typeof loadPluginsWithBuiltins> {
  const [globalDir, projectDir, configPlugins, projectRoot, disabledPlugins, isTestFile] = args;
  return loadPluginsWithBuiltins(
    globalDir,
    projectDir,
    configPlugins,
    projectRoot,
    [...DISABLE_BUILTIN_PLUGINS, ...(disabledPlugins ?? [])],
    isTestFile,
  );
}

describe("Loader Security (SEC-1, SEC-2)", () => {
  const projectRoot = `/tmp/nax-sec-test-${randomUUID()}`;
  const projectPluginsDir = resolve(projectRoot, ".nax/plugins");
  const globalPluginsDir = resolve(projectRoot, ".nax/global-plugins");

  let capturedErrors: string[] = [];

  beforeEach(async () => {
    await fs.mkdir(projectPluginsDir, { recursive: true });
    await fs.mkdir(globalPluginsDir, { recursive: true });
    capturedErrors = [];
    _setPluginErrorSink((...args: unknown[]) => {
      capturedErrors.push(String(args[0]));
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    _resetPluginErrorSink();
  });

  test("SEC-1: Blocks plugin load from outside allowed roots", async () => {
    // Attempt to load from /etc/passwd (outside project/global roots)
    const configPlugins = [{ module: "/etc/passwd", config: {} }];

    await expect(loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, projectRoot)).rejects.toMatchObject({
      code: "PLUGIN_LOAD_FAILED",
    });
    expect(capturedErrors.some((err) => err.includes('Security: Path "/etc/passwd" is outside allowed roots'))).toBe(
      true,
    );
  });

  test("SEC-1: Allows plugin load from project directory", async () => {
    // Create a dummy plugin in project directory
    const pluginPath = resolve(projectPluginsDir, "test-plugin.ts");
    await fs.writeFile(
      pluginPath,
      `
      export default {
        name: "test-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        setup: async () => {},
        extensions: {
          reporter: {
            name: "test-reporter",
            description: "A test reporter",
            onRunStart: async () => {},
            onStoryComplete: async () => {},
            onRunEnd: async () => {}
          }
        }
      } as any;
    `,
    );

    const registry = await loadPlugins(globalPluginsDir, projectPluginsDir, [], projectRoot);

    if (registry.plugins.length === 0) {
      console.log("Captured Errors:", capturedErrors);
    }
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].name).toBe("test-plugin");
  });

  // SEC-2 (loadCustomStrategy) removed — custom routing strategies deleted in ROUTE-001
});
