import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadPlugins, _setPluginErrorSink, _resetPluginErrorSink } from "../../../src/plugins/loader";
import { loadCustomStrategy } from "../../../src/routing/loader";
import { resolve } from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

describe("Loader Security (SEC-1, SEC-2)", () => {
  const projectRoot = `/tmp/nax-sec-test-${randomUUID()}`;
  const projectPluginsDir = resolve(projectRoot, "nax/plugins");
  const globalPluginsDir = resolve(projectRoot, ".nax/plugins");
  
  let capturedErrors: string[] = [];

  beforeEach(async () => {
    await fs.mkdir(projectPluginsDir, { recursive: true });
    await fs.mkdir(globalPluginsDir, { recursive: true });
    capturedErrors = [];
    _setPluginErrorSink((msg: string) => capturedErrors.push(msg));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    _resetPluginErrorSink();
  });

  test("SEC-1: Blocks plugin load from outside allowed roots", async () => {
    // Attempt to load from /etc/passwd (outside project/global roots)
    const configPlugins = [{ module: "/etc/passwd", config: {} }];
    
    const registry = await loadPlugins(
      globalPluginsDir,
      projectPluginsDir,
      configPlugins,
      projectRoot
    );

    expect(registry.plugins).toHaveLength(0);
    expect(capturedErrors.some(err => err.includes("Security: Path \"/etc/passwd\" is outside allowed roots"))).toBe(true);
  });

  test("SEC-1: Allows plugin load from project directory", async () => {
    // Create a dummy plugin in project directory
    const pluginPath = resolve(projectPluginsDir, "test-plugin.ts");
    await fs.writeFile(pluginPath, `
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
    `);

    const registry = await loadPlugins(
      globalPluginsDir,
      projectPluginsDir,
      [],
      projectRoot
    );

    if (registry.plugins.length === 0) { console.log('Captured Errors:', capturedErrors); }
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].name).toBe("test-plugin");
  });

  test("SEC-2: Blocks custom routing strategy from outside project root", async () => {
    // Attempt to load from /etc/passwd (outside project root)
    try {
      await loadCustomStrategy("/etc/passwd", projectRoot);
      throw new Error("Should have failed");
    } catch (error) {
      expect(error.message).toContain("Security: Path \"/etc/passwd\" is outside allowed roots");
    }
  });
});
