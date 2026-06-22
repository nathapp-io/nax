import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFeatureAcceptance } from "@/cli";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir("nax-accept-");
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

/** Creates .nax/config.json (partial config is layered over defaults by loadConfig). */
function initRepo(config: Record<string, unknown> = {}): string {
  const naxDir = join(tempDir, ".nax");
  mkdirSync(join(naxDir, "features"), { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "test-project", ...config }));
  return naxDir;
}

/** Writes .nax/features/<name>/prd.json with the given stories. */
function writePRD(
  naxDir: string,
  name: string,
  stories: Array<{ id: string; workdir?: string; acceptanceCriteria?: string[]; status?: string }>,
): void {
  const dir = join(naxDir, "features", name);
  mkdirSync(dir, { recursive: true });
  const userStories = stories.map((s) => ({
    id: s.id,
    title: s.id,
    description: "",
    acceptanceCriteria: s.acceptanceCriteria ?? ["AC1"],
    tags: [],
    dependencies: [],
    status: s.status ?? "passed",
    passes: true,
    escalations: [],
    attempts: 0,
    ...(s.workdir ? { workdir: s.workdir } : {}),
  }));
  writeFileSync(
    join(dir, "prd.json"),
    JSON.stringify({
      project: "p",
      feature: name,
      branchName: "main",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories,
    }),
  );
}

/** Writes a per-package override config under .nax/mono/<packageDir>/config.json. */
function writePackageOverride(naxDir: string, packageDir: string, config: Record<string, unknown>): void {
  const dir = join(naxDir, "mono", packageDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// disabled
// ---------------------------------------------------------------------------

describe("acceptance disabled", () => {
  test("returns status=disabled when acceptance.enabled is false", async () => {
    const naxDir = initRepo({ acceptance: { enabled: false } });
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("disabled");
    expect(result.enabled).toBe(false);
    expect(result.groups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// no-prd
// ---------------------------------------------------------------------------

describe("no prd.json", () => {
  test("returns status=no-prd when the feature has no prd.json", async () => {
    initRepo();
    // No PRD written for "feat".

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("no-prd");
    expect(result.enabled).toBe(true);
    expect(result.groups).toEqual([]);
  });

  test("returns status=no-prd when prd.json is malformed (never throws)", async () => {
    const naxDir = initRepo();
    const dir = join(naxDir, "features", "feat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prd.json"), "{ not valid json");

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("no-prd");
    expect(result.groups).toEqual([]);
  });

  test("degrades to no-prd (never throws) when the config is invalid/legacy", async () => {
    // A legacy autoMode.defaultAgent key makes loadConfig throw — the resolver
    // must catch it rather than break the whole `features resolve` command.
    const naxDir = initRepo({ autoMode: { defaultAgent: "claude" } });
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("no-prd");
    expect(result.groups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// single-package
// ---------------------------------------------------------------------------

describe("single-package", () => {
  test("resolves one root group with canonical testPath and exists=false when no file", async () => {
    const naxDir = initRepo();
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("ok");
    expect(result.enabled).toBe(true);
    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group.packageDir).toBe("");
    expect(group.testPath).toBe(".nax/features/feat/.nax-acceptance.test.ts");
    expect(group.exists).toBe(false);
    expect(group.command).toBeUndefined();
  });

  test("exists=true when the acceptance test file is present on disk", async () => {
    const naxDir = initRepo();
    writePRD(naxDir, "feat", [{ id: "US-001" }]);
    writeFileSync(join(naxDir, "features", "feat", ".nax-acceptance.test.ts"), "// test");

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.groups[0].exists).toBe(true);
  });

  test("surfaces the root acceptance.command", async () => {
    const naxDir = initRepo({ acceptance: { command: "bun test {{FILE}}" } });
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.groups[0].command).toBe("bun test {{FILE}}");
  });

  test("honours a custom acceptance.testPath in the filename", async () => {
    const naxDir = initRepo({ acceptance: { testPath: "acceptance.spec.ts" } });
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.groups[0].testPath).toBe(".nax/features/feat/acceptance.spec.ts");
  });
});

// ---------------------------------------------------------------------------
// monorepo
// ---------------------------------------------------------------------------

describe("monorepo", () => {
  test("resolves one group per package the feature touches", async () => {
    const naxDir = initRepo();
    writePRD(naxDir, "feat", [
      { id: "US-001", workdir: "packages/core" },
      { id: "US-002", workdir: "packages/api" },
    ]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("ok");
    const byPkg = Object.fromEntries(result.groups.map((g) => [g.packageDir, g]));
    expect(Object.keys(byPkg).sort()).toEqual(["packages/api", "packages/core"]);
    expect(byPkg["packages/core"].testPath).toBe("packages/core/.nax/features/feat/.nax-acceptance.test.ts");
    expect(byPkg["packages/api"].testPath).toBe("packages/api/.nax/features/feat/.nax-acceptance.test.ts");
  });

  test("per-package acceptance.command override beats the root command", async () => {
    const naxDir = initRepo({ acceptance: { command: "bun test {{FILE}}" } });
    writePRD(naxDir, "feat", [
      { id: "US-001", workdir: "packages/core" },
      { id: "US-002", workdir: "packages/api" },
    ]);
    writePackageOverride(naxDir, "packages/core", { acceptance: { command: "vitest run {{FILE}}" } });

    const result = await resolveFeatureAcceptance("feat", tempDir);

    const byPkg = Object.fromEntries(result.groups.map((g) => [g.packageDir, g]));
    expect(byPkg["packages/core"].command).toBe("vitest run {{FILE}}");
    expect(byPkg["packages/api"].command).toBe("bun test {{FILE}}");
  });
});

// ---------------------------------------------------------------------------
// not a nax repo
// ---------------------------------------------------------------------------

describe("not a nax repo", () => {
  test("returns status=no-prd with enabled=true when there is no .nax dir", async () => {
    // tempDir has no .nax — resolveFeatureAcceptance must not throw.
    const result = await resolveFeatureAcceptance("feat", tempDir);
    expect(result.status).toBe("no-prd");
    expect(result.groups).toEqual([]);
  });
});
