import { describe, test, expect } from "bun:test";
import { createPackageRegistry } from "../../../src/runtime/packages";
import { createConfigLoader } from "../../../src/config/loader-runtime";
import { pickSelector } from "../../../src/config/selector";
import type { NaxConfig } from "../../../src/config";

const minConfig = { routing: { strategy: "keyword" } } as unknown as NaxConfig;
const routingSel = pickSelector("routing-pkg-test", "routing");

describe("PackageRegistry", () => {
  test("resolve(undefined) returns root-equivalent view (packageDir = '')", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    const view = registry.resolve(undefined);
    expect(view.packageDir).toBe("");
  });

  test("resolve(undefined) twice returns same instance", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    expect(registry.resolve(undefined)).toBe(registry.resolve(undefined));
  });

  test("repo() is alias for resolve(undefined)", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    expect(registry.repo()).toBe(registry.resolve(undefined));
  });
});

describe("PackageView.select()", () => {
  test("select() returns narrowed config slice", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    const view = registry.resolve(undefined);
    const slice = view.select(routingSel);
    expect(slice).toHaveProperty("routing");
  });

  test("select() memoizes per selector name", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    const view = registry.resolve(undefined);
    const first = view.select(routingSel);
    const second = view.select(routingSel);
    expect(first).toBe(second);
  });
});
