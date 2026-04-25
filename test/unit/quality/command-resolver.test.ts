/**
 * Quality Command Resolver — unit tests
 *
 * Covers: priority resolution, {{package}} substitution, orchestrator promotion.
 */

import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { _commandResolverDeps, resolveQualityTestCommands } from "../../../src/quality/command-resolver";
import { makeNaxConfig } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Record<string, unknown>) {
  return makeNaxConfig(overrides);
}

// ---------------------------------------------------------------------------
// Priority resolution
// ---------------------------------------------------------------------------

describe("resolveQualityTestCommands — priority", () => {
  test("uses quality.commands.test when review.commands.test is absent", async () => {
    const config = makeConfig({ quality: { ...DEFAULT_CONFIG.quality, commands: { test: "jest" } } });
    const result = await resolveQualityTestCommands(config, "/workdir");
    expect(result.rawTestCommand).toBe("jest");
    expect(result.testCommand).toBe("jest");
  });

  test("review.commands.test takes priority over quality.commands.test", async () => {
    const config = makeConfig({
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" } },
      review: { ...DEFAULT_CONFIG.review, commands: { ...DEFAULT_CONFIG.review.commands, test: "jest" } },
    });
    const result = await resolveQualityTestCommands(config, "/workdir");
    expect(result.rawTestCommand).toBe("jest");
  });

  test("returns undefined rawTestCommand when neither is configured", async () => {
    const config = makeConfig({ quality: { ...DEFAULT_CONFIG.quality, commands: {} }, review: undefined });
    const result = await resolveQualityTestCommands(config, "/workdir");
    expect(result.rawTestCommand).toBeUndefined();
    expect(result.testCommand).toBeUndefined();
  });

  test("scopeFileThreshold defaults to 10 when not configured", async () => {
    const config = makeConfig({ quality: { ...DEFAULT_CONFIG.quality, scopeTestThreshold: undefined } });
    const result = await resolveQualityTestCommands(config, "/workdir");
    expect(result.scopeFileThreshold).toBe(10);
  });

  test("scopeFileThreshold uses configured value", async () => {
    const config = makeConfig({ quality: { ...DEFAULT_CONFIG.quality, scopeTestThreshold: 5 } });
    const result = await resolveQualityTestCommands(config, "/workdir");
    expect(result.scopeFileThreshold).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// {{package}} resolution
// ---------------------------------------------------------------------------

describe("resolveQualityTestCommands — {{package}} substitution", () => {
  test("resolves {{package}} when storyWorkdir is set and package.json exists", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve("@acme/api"));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test", testScoped: "bun test --filter={{package}}" },
        },
      });
      const result = await resolveQualityTestCommands(config, "/workdir", "packages/api");
      expect(result.testScopedTemplate).toBe("bun test --filter=@acme/api");
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });

  test("skips {{package}} resolution when storyWorkdir is absent", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve("@acme/api"));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test", testScoped: "bun test --filter={{package}}" },
        },
      });
      // no storyWorkdir → template kept as-is
      const result = await resolveQualityTestCommands(config, "/workdir");
      expect(result.testScopedTemplate).toBe("bun test --filter={{package}}");
      expect(_commandResolverDeps.readPackageName).not.toHaveBeenCalled();
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });

  test("clears testScopedTemplate when package.json is absent", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve(null));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test", testScoped: "bun test --filter={{package}}" },
        },
      });
      const result = await resolveQualityTestCommands(config, "/workdir", "packages/api");
      expect(result.testScopedTemplate).toBeUndefined();
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });
});

// ---------------------------------------------------------------------------
// Monorepo orchestrator promotion
// ---------------------------------------------------------------------------

describe("resolveQualityTestCommands — orchestrator promotion", () => {
  test("promotes resolved scoped template to testCommand for turbo + storyWorkdir", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve("@koda/cli"));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bunx turbo test", testScoped: "bunx turbo test --filter={{package}}" },
        },
      });
      const result = await resolveQualityTestCommands(config, "/workdir", "apps/cli");
      expect(result.rawTestCommand).toBe("bunx turbo test");
      expect(result.testCommand).toBe("bunx turbo test --filter=@koda/cli");
      expect(result.testScopedTemplate).toBeUndefined(); // cleared for orchestrators
      expect(result.isMonorepoOrchestrator).toBe(true);
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });

  test("no promotion when storyWorkdir is absent (full monorepo suite)", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve("@koda/cli"));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bunx turbo test", testScoped: "bunx turbo test --filter={{package}}" },
        },
      });
      const result = await resolveQualityTestCommands(config, "/workdir"); // no storyWorkdir
      expect(result.testCommand).toBe("bunx turbo test"); // not promoted
      expect(result.isMonorepoOrchestrator).toBe(true);
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });

  test("no promotion when package.json is absent for turbo command", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve(null));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bunx turbo test", testScoped: "bunx turbo test --filter={{package}}" },
        },
      });
      const result = await resolveQualityTestCommands(config, "/workdir", "apps/cli");
      expect(result.testCommand).toBe("bunx turbo test"); // not promoted — template resolved to undefined
      expect(result.testScopedTemplate).toBeUndefined();
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });

  test("always clears testScopedTemplate for orchestrators regardless of promotion", async () => {
    const origRead = _commandResolverDeps.readPackageName;
    _commandResolverDeps.readPackageName = mock(() => Promise.resolve("@koda/cli"));
    try {
      const config = makeConfig({
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bunx nx test", testScoped: "bunx nx test my-app" },
        },
      });
      const result = await resolveQualityTestCommands(config, "/workdir", "apps/my-app");
      // testScoped has no {{package}} → no readPackageName call, but still cleared
      expect(result.testScopedTemplate).toBeUndefined();
      expect(result.isMonorepoOrchestrator).toBe(true);
    } finally {
      _commandResolverDeps.readPackageName = origRead;
    }
  });

  test("non-orchestrator commands preserve testScopedTemplate", async () => {
    const config = makeConfig({
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "jest", testScoped: "jest --testPathPattern={{files}}" },
      },
    });
    const result = await resolveQualityTestCommands(config, "/workdir", "packages/api");
    expect(result.testScopedTemplate).toBe("jest --testPathPattern={{files}}");
    expect(result.isMonorepoOrchestrator).toBe(false);
    expect(result.testCommand).toBe("jest"); // not promoted
  });
});
