import { describe, test, expect } from "bun:test";
import { createPackageRegistry } from "../../../src/runtime/packages";
import { createConfigLoader, pickSelector } from "../../../src/config";
import { makeNaxConfig } from "../../helpers";

const minConfig = makeNaxConfig({ routing: { strategy: "keyword" } });
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

describe("PackageRegistry.hydrate — per-package merge", () => {
  test("resolve(pkg) returns merged config after hydrate", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } } as any));
    const registry = createPackageRegistry(loader, "/repo");
    // Inject a fake override loader to avoid disk I/O.
    await registry.hydrate(["packages/agent"], async (_root, dir) =>
      dir === "packages/agent" ? ({ quality: { commands: { lint: "pkg-lint" } } } as any) : null,
    );
    const view = registry.resolve("packages/agent");
    expect(view.config.quality?.commands?.lint).toBe("pkg-lint");
  });

  test("resolve(unhydrated pkg) falls back to root config", () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } } as any));
    const registry = createPackageRegistry(loader, "/repo");
    expect(registry.resolve("packages/other").config.quality?.commands?.lint).toBe("root-lint");
  });
});
