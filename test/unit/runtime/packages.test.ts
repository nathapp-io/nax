import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { createConfigLoader, pickSelector } from "@/config";
import { _packagesDeps, createPackageRegistry, packageOverrideKey } from "@/runtime/packages";

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
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    // Inject a fake override loader to avoid disk I/O.
    await registry.hydrate(["packages/agent"], async (_root, dir) =>
      dir === "packages/agent" ? makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } }) : null,
    );
    const view = registry.resolve("packages/agent");
    expect(view.config.quality?.commands?.lint).toBe("pkg-lint");
  });

  test("resolve(unhydrated pkg) falls back to root config", () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    expect(registry.resolve("packages/other").config.quality?.commands?.lint).toBe("root-lint");
  });

  test("resolve(absolute path) hits the same merged config as resolve(relative)", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate(["packages/agent"], async (_root, dir) =>
      dir === "packages/agent" ? makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } }) : null,
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
      dir === "packages/lib" ? makeNaxConfig({ quality: { commands: { lint: "echo ok" } } }) : null,
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

  test("does not warn for a known package after hydrate() has run", async () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    // hydrate a known package that has no override — sufficient to set the hydrated flag
    await registry.hydrate(["packages/app"], async () => null);
    registry.resolve("packages/app");

    expect(mockLogger.calls.filter((c) => c.level === "warn" && c.stage === "packages")).toHaveLength(0);
  });

  test("does not warn for a package that was hydrated with an override", async () => {
    const mockLogger = makeLogger();
    _packagesDeps.getSafeLogger = mock(() => mockLogger);
    const loader = createConfigLoader(minConfig);
    const registry = createPackageRegistry(loader, "/repo");

    await registry.hydrate(["packages/app"], async (_root, dir) =>
      dir === "packages/app" ? makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } }) : null,
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

describe("PackageRegistry — worktree paths resolve the package override (#2069)", () => {
  async function registryWithOverride() {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate(["apps/web-ui"], async (_root, dir) =>
      dir === "apps/web-ui" ? makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } }) : null,
    );
    return registry;
  }

  test("a worktree package path finds the hydrated override", async () => {
    const registry = await registryWithOverride();
    const view = registry.resolve("/repo/.nax-wt/US-005/apps/web-ui");
    expect(view.hasOverride).toBe(true);
    expect(view.config.quality?.commands?.lint).toBe("pkg-lint");
  });

  test("refreshes a worktree view that was resolved before hydration", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    const before = registry.resolve("/repo/.nax-wt/US-005/apps/web-ui");

    await registry.hydrate(["apps/web-ui"], async (_root, dir) =>
      dir === "apps/web-ui" ? makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } }) : null,
    );

    const after = registry.resolve("/repo/.nax-wt/US-005/apps/web-ui");
    expect(after).not.toBe(before);
    expect(after.hasOverride).toBe(true);
    expect(after.config.quality?.commands?.lint).toBe("pkg-lint");
  });

  // The identity invariant: packageWorkdir(view) joins packageDir onto repoRoot,
  // so shortening packageDir would repoint file tools at the MAIN checkout.
  test("packageDir still addresses the worktree, not the main checkout", async () => {
    const registry = await registryWithOverride();
    const view = registry.resolve("/repo/.nax-wt/US-005/apps/web-ui");
    expect(view.packageDir).toBe(".nax-wt/US-005/apps/web-ui");
  });

  // Two parallel stories on the SAME package must not share one view.
  test("two worktrees of the same package get distinct views", async () => {
    const registry = await registryWithOverride();
    const a = registry.resolve("/repo/.nax-wt/US-001/apps/web-ui");
    const b = registry.resolve("/repo/.nax-wt/US-002/apps/web-ui");
    expect(a).not.toBe(b);
    expect(a.packageDir).toBe(".nax-wt/US-001/apps/web-ui");
    expect(b.packageDir).toBe(".nax-wt/US-002/apps/web-ui");
    expect(a.hasOverride).toBe(true);
    expect(b.hasOverride).toBe(true);
  });

  // A story with no package workdir: the worktree ROOT is the repo package.
  test("a bare worktree root resolves to the repo-level view", async () => {
    const registry = await registryWithOverride();
    const view = registry.resolve("/repo/.nax-wt/US-005");
    expect(view.hasOverride).toBe(false);
    expect(view.config.quality?.commands?.lint).toBe("root-lint");
  });

  // A real directory that merely starts with the same characters must not match.
  test("a package named like the worktree dir is not mistaken for one", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate([".nax-wtx/pkg"], async (_root, dir) =>
      dir === ".nax-wtx/pkg" ? makeNaxConfig({ quality: { commands: { lint: "decoy-lint" } } }) : null,
    );
    const view = registry.resolve("/repo/.nax-wtx/pkg");
    expect(view.config.quality?.commands?.lint).toBe("decoy-lint");
  });
});

describe("PackageRegistry — unknown package key is loud (#2069)", () => {
  const originalLogger = _packagesDeps.getSafeLogger;
  afterEach(() => {
    _packagesDeps.getSafeLogger = originalLogger;
  });

  interface CapturedWarning {
    readonly message: string;
    readonly data: Record<string, unknown> | undefined;
  }

  function captureWarnings(): CapturedWarning[] {
    const warnings: CapturedWarning[] = [];
    const logger = makeLogger();
    logger.warn = mock((_channel: string, message: string, data?: Record<string, unknown>) => {
      warnings.push({ message, data });
    });
    _packagesDeps.getSafeLogger = () => logger;
    return warnings;
  }

  test("warns when a non-empty key matches no hydrated package", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve("/repo/apps/does-not-exist");
    expect(warnings.some((w) => w.message.includes("unknown package"))).toBe(true);
    const unknown = warnings.find((w) => w.message.includes("unknown package"));
    expect(unknown?.data?.overrideKey).toBe("apps/does-not-exist");
  });

  test("reports the worktree-stripped overrideKey for an unknown worktree package", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve("/repo/.nax-wt/US-009/apps/gone");
    const unknown = warnings.find((w) => w.message.includes("unknown package"));
    // The override lookup key is stripped of the worktree prefix...
    expect(unknown?.data?.overrideKey).toBe("apps/gone");
    // ...while packageDir still addresses the worktree itself.
    expect(unknown?.data?.packageDir).toBe(".nax-wt/US-009/apps/gone");
  });

  test("stays quiet for a known package that simply has no override", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve("/repo/apps/web-ui");
    expect(warnings).toEqual([]);
  });

  test("stays quiet for the repo-root view", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve(undefined);
    expect(warnings).toEqual([]);
  });
});

// LOW-8 (whole-branch review, 2026-09-18): the worktree-prefix stripping was
// extracted to a pure, exported helper — but only integration tests exercise
// it via resolve() and hydrate(). Pin the helper directly so a future change
// to slice indices, prefix matching, or the early-return guard is caught at
// the unit boundary, not through a filesystem-backed resolve call.
describe("packageOverrideKey — pure helper (LOW-8)", () => {
  test.each([
    // Canonical story-isolated worktree path: strips the `.nax-wt/<storyId>/` prefix.
    [".nax-wt/US-001/packages/api", "packages/api"],
    // Degenerate worktree (no package segment): slice(2) is [], join is "".
    // Pinned as the CURRENT behavior — LOW-2 flagged it as a latent edge case
    // but the user explicitly scoped this fix to LOW-8 only.
    [".nax-wt/US-001", ""],
    // Empty input: passed through unchanged (no first-segment match).
    ["", ""],
    // Non-worktree relative path: passed through unchanged.
    ["packages/api", "packages/api"],
    // Absolute non-worktree path: passed through unchanged.
    ["/abs/path", "/abs/path"],
  ])("packageOverrideKey(%j) === %j", (input, expected) => {
    expect(packageOverrideKey(input)).toBe(expected);
  });
});
