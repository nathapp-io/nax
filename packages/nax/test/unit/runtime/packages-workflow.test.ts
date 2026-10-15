import { describe, expect, test } from "bun:test";
import { makeConfigSlice, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { createConfigLoader } from "@/config";
import { createPackageRegistry } from "@/runtime/packages";

describe("PackageRegistry.hydrate - workflow-mode normalisation", () => {
  const override: Partial<NaxConfig> = { acceptance: makeConfigSlice("acceptance", { enabled: true }) };

  test("a package override with acceptance.enabled:true resolves false in workflow mode", async () => {
    const root = makeNaxConfig({ execution: { mode: "workflow" }, acceptance: { enabled: false } });
    const registry = createPackageRegistry(createConfigLoader(root), "/repo");

    await registry.hydrate(["packages/lib"], async () => override);

    expect(registry.resolve("packages/lib").config.acceptance.enabled).toBe(false);
  });

  test("outside workflow mode the package override still enables acceptance", async () => {
    const root = makeNaxConfig({ execution: { mode: "pipeline" }, acceptance: { enabled: false } });
    const registry = createPackageRegistry(createConfigLoader(root), "/repo");

    await registry.hydrate(["packages/lib"], async () => override);

    expect(registry.resolve("packages/lib").config.acceptance.enabled).toBe(true);
  });
});
