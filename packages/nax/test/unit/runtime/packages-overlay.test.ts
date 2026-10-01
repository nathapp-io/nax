import { describe, expect, test } from "bun:test";
import { makeConfigSlice, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { createConfigLoader } from "@/config";
import { createPackageRegistry } from "@/runtime/packages";

/**
 * The tests below cover the RAW overlay hydration added for the provenance
 * routing rule (src/operations/gate-cwd.ts): a gate must be able to tell which
 * commands a package actually declared, which the post-merge `config` cannot.
 * Split out of packages.test.ts by concern, per test-architecture.md.
 */
const rootConfig = makeNaxConfig({ quality: { commands: { lint: "root-lint" } } });

/** The raw per-package override the loader hands back — never merged. */
const rawOverlay: Partial<NaxConfig> = {
  quality: makeConfigSlice("quality", { commands: { test: "bun test" } }),
};

describe("PackageRegistry.hydrate — raw overlay retention", () => {
  test("US-002 AC7: resolve(pkg).overlay deep-equals the raw override the loader returned", async () => {
    const registry = createPackageRegistry(createConfigLoader(rootConfig), "/repo");

    await registry.hydrate(["packages/lib"], async (_root, dir) => (dir === "packages/lib" ? rawOverlay : null));

    expect(registry.resolve("packages/lib").overlay).toEqual(rawOverlay);
  });

  test("US-002 AC8: hasOverride is true for a hydrated package with an overlay", async () => {
    const registry = createPackageRegistry(createConfigLoader(rootConfig), "/repo");

    await registry.hydrate(["packages/lib"], async (_root, dir) => (dir === "packages/lib" ? rawOverlay : null));

    expect(registry.resolve("packages/lib").hasOverride).toBe(true);
  });

  test("US-002 AC9: a hydrated package with no overlay has no 'overlay' property at all", async () => {
    const registry = createPackageRegistry(createConfigLoader(rootConfig), "/repo");

    await registry.hydrate(["packages/app"], async () => null);

    expect("overlay" in registry.resolve("packages/app")).toBe(false);
  });

  test("US-002 AC10: hasOverride is false for a hydrated package with no overlay", async () => {
    const registry = createPackageRegistry(createConfigLoader(rootConfig), "/repo");

    await registry.hydrate(["packages/app"], async () => null);

    expect(registry.resolve("packages/app").hasOverride).toBe(false);
  });
});
