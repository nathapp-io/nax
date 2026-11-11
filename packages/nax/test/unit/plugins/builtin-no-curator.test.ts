import { describe, expect, it } from "bun:test";
import { loadPlugins } from "@/plugins/loader";

describe("built-in plugins", () => {
  it("does not register the removed curator", async () => {
    const registry = await loadPlugins("/nonexistent/nax-global", "/nonexistent/nax-project", []);
    expect(registry.plugins.map((plugin) => plugin.name)).not.toContain("curator");
    expect(registry.plugins.map((plugin) => plugin.name)).not.toContain("nax-curator");
  });
});
