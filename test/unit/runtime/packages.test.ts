import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { createConfigLoader, pickSelector } from "@/config";
import { _packagesDeps, createPackageRegistry } from "@/runtime/packages";

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

  // TYPE-29 (D-23): the previous startsWith(repoRoot) check (without a
  // trailing separator) made a sibling directory whose name is a prefix of
  // the repo root look like it lived inside it — /repository was reported
  // as relativeFromRoot: "ry" against repoRoot "/repo". path.relative
  // gives the unambiguous answer.
  test("relativeFromRoot does not collide when packageDir is a prefix-named sibling (TYPE-29)", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    const view = registry.resolve("/repository");
    expect(view.relativeFromRoot).toBe("../repository");
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

  test("resolve(absolute path) hits the same merged config as resolve(relative)", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } } as any));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate(["packages/agent"], async (_root, dir) =>
      dir === "packages/agent" ? ({ quality: { commands: { lint: "pkg-lint" } } } as any) : null,
    );
    // Pipeline stages call resolve() with an absolute path like /repo/packages/agent.
    const viewAbsolute = registry.resolve("/repo/packages/agent");
    expect(viewAbsolute.config.quality?.commands?.lint).toBe("pkg-lint");
    // Same instance — the cache key is normalized.
    expect(viewAbsolute).toBe(registry.resolve("packages/agent"));
  });
});

describe("PackageView.hasOverride and repoRoot", () => {
  test("hasOverride=false and repoRoot exposed for unhydrated package (root-config fallback)", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    const view = registry.resolve("packages/app");
    expect(view.hasOverride).toBe(false);
    expect(view.repoRoot).toBe("/repo");
  });

  test("hasOverride=true for hydrated package with per-package override", async () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate(["packages/lib"], async (_root, dir) =>
      dir === "packages/lib" ? ({ quality: { commands: { lint: "echo ok" } } } as any) : null,
    );
    const view = registry.resolve("packages/lib");
    expect(view.hasOverride).toBe(true);
    expect(view.repoRoot).toBe("/repo");
  });

  test("hasOverride=false for repo() (root view)", () => {
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");
    expect(registry.repo().hasOverride).toBe(false);
    expect(registry.repo().repoRoot).toBe("/repo");
  });
});

describe("F2 invariant — pre-hydrate warn for non-root resolve()", () => {
  let origGetSafeLogger: typeof _packagesDeps.getSafeLogger;

  beforeEach(() => {
    origGetSafeLogger = _packagesDeps.getSafeLogger;
  });

  afterEach(() => {
    _packagesDeps.getSafeLogger = origGetSafeLogger;
  });

  test("warns when resolve(nonRootPkg) is called before hydrate()", () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    registry.resolve("packages/app");

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn" && c.stage === "packages");
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0].data?.packageDir).toBe("packages/app");
  });

  test("does not warn for repo() (root-equivalent, no per-package override expected)", () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    registry.repo();

    expect(mockLogger.calls.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  test("does not warn after hydrate() has run", async () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    // hydrate with an empty list — sufficient to set the hydrated flag
    await registry.hydrate([], async () => null);
    registry.resolve("packages/app");

    expect(mockLogger.calls.filter((c) => c.level === "warn" && c.stage === "packages")).toHaveLength(0);
  });

  test("does not warn for a package that was hydrated with an override", async () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    await registry.hydrate(["packages/app"], async (_root, dir) =>
      dir === "packages/app" ? ({ quality: { commands: { lint: "pkg-lint" } } } as any) : null,
    );
    registry.resolve("packages/app");

    expect(mockLogger.calls.filter((c) => c.level === "warn" && c.stage === "packages")).toHaveLength(0);
  });

  test("warns only once per package (cached view suppresses repeat)", () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    registry.resolve("packages/app");
    registry.resolve("packages/app"); // second call hits cache — no second warn

    expect(mockLogger.calls.filter((c) => c.level === "warn" && c.stage === "packages")).toHaveLength(1);
  });
});
