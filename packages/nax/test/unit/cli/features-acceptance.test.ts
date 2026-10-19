import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { resolveFeatureAcceptance } from "@/cli";

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
  writeFileSync(
    join(naxDir, "config.json"),
    JSON.stringify({ name: "test-project", execution: { mode: "pipeline" }, ...config }),
  );
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

/** Writes a config profile under .nax/profiles/<name>.json. */
function writeProfile(naxDir: string, name: string, config: Record<string, unknown>): void {
  const dir = join(naxDir, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(config));
}

/**
 * A project config that fails schema validation on its own (storyIsolation enum).
 * `mode: "pipeline"` is kept so a repairing profile is not overridden by workflow
 * mode, which forces `acceptance.enabled` off.
 */
const INVALID_EXECUTION = { execution: { mode: "pipeline", storyIsolation: "bogus" } };

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

  // AC-15: disabled wins over a missing PRD, and carries no error.
  test("returns status=disabled with no error property when prd.json is absent (AC-15)", async () => {
    initRepo({ acceptance: { enabled: false } });

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("disabled");
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// no-prd
// ---------------------------------------------------------------------------

describe("no prd.json", () => {
  test("returns status=no-prd when the feature has no prd.json (AC-5)", async () => {
    initRepo();
    // No PRD written for "feat".

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("no-prd");
    expect(result.enabled).toBe(true);
    expect(result.groups).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  // AC-4: an unparseable PRD is a failure, not an absent PRD — and the
  // resolver must still never throw (it is awaited inside resolveFeatureSpec).
  test("returns status=error with groups=[] when prd.json is malformed, never throwing (AC-4)", async () => {
    const naxDir = initRepo();
    const dir = join(naxDir, "features", "feat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prd.json"), "{ not valid json");

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("error");
    expect(result.groups).toEqual([]);
  });

  // AC-17: the caught error's code and message are reported, not swallowed.
  test("reports the PRD load failure's code and message for a malformed prd.json (AC-17)", async () => {
    const naxDir = initRepo();
    const dir = join(naxDir, "features", "feat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prd.json"), "{ not valid json");

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("error");
    expect(result.groups).toEqual([]);
    expect(result.error?.code).toBe("PRD_INVALID");
    expect(result.error?.message).toContain("PRD file is corrupt");
  });

  // AC-18: an invalid/legacy config no longer degrades to no-prd — the message
  // names the cause so a --json consumer can act on it.
  test("returns status=error naming the cause when the config is legacy, never throwing (AC-18)", async () => {
    // A legacy autoMode.defaultAgent key makes loadConfig throw.
    const naxDir = initRepo({ autoMode: { defaultAgent: "claude" } });
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("error");
    expect(result.groups).toEqual([]);
    expect(result.error?.code).toBe("CONFIG_LEGACY_AGENT_KEYS");
    expect(result.error?.message).toContain("legacy agent keys");
  });
});

// ---------------------------------------------------------------------------
// config errors
// ---------------------------------------------------------------------------

describe("config errors", () => {
  // AC-1: a schema-invalid project config is an error, not "no PRD" — the PRD
  // exists and is perfectly readable.
  test("returns status=error when the config fails schema validation (AC-1)", async () => {
    const naxDir = initRepo(INVALID_EXECUTION);
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("error");
  });

  test("reports error.code CONFIG_SCHEMA_INVALID for a schema-invalid config (AC-2)", async () => {
    const naxDir = initRepo(INVALID_EXECUTION);
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.error?.code).toBe("CONFIG_SCHEMA_INVALID");
  });

  test("reports error.message containing 'Invalid configuration' (AC-3)", async () => {
    const naxDir = initRepo(INVALID_EXECUTION);
    writePRD(naxDir, "feat", [{ id: "US-001" }]);

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.error?.message).toContain("Invalid configuration");
  });

  // AC-16: the config failure is reported even when there is no PRD to blame.
  test("reports status=error when loadConfig throws even with no prd.json (AC-16)", async () => {
    initRepo(INVALID_EXECUTION);
    // No PRD written for "feat".

    const result = await resolveFeatureAcceptance("feat", tempDir);

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(result.error?.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// profile overrides
// ---------------------------------------------------------------------------

describe("profile overrides", () => {
  // AC-7: the configOverrides argument reaches loadConfig's CLI layer, so a
  // profile that repairs an otherwise-invalid project config resolves.
  test("resolves ok when a profile overlay makes an invalid config valid (AC-7)", async () => {
    const naxDir = initRepo(INVALID_EXECUTION);
    writePRD(naxDir, "feat", [{ id: "US-001" }]);
    writeProfile(naxDir, "fix", { execution: { storyIsolation: "shared" } });

    const result = await resolveFeatureAcceptance("feat", tempDir, { profile: ["fix"] });

    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
    expect(result.groups).toHaveLength(1);
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
    // AC-6: an ok result carries no error.
    expect(result.error).toBeUndefined();
    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group.packageDir).toBe("");
    expect(group.testPath).toBe(".nax/features/feat/.nax-acceptance.test.ts");
    expect(group.exists).toBe(false);
    expect(group.command).toBeUndefined();
    expect(group.cwd).toBe("");
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
    expect(byPkg["packages/core"].cwd).toBe("packages/core");
    expect(byPkg["packages/api"].cwd).toBe("packages/api");
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
  test("returns status=no-prd with enabled=true when there is no .nax dir (AC-14)", async () => {
    // tempDir has no .nax — resolveFeatureAcceptance must not throw.
    const result = await resolveFeatureAcceptance("feat", tempDir);
    expect(result.status).toBe("no-prd");
    expect(result.groups).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});
