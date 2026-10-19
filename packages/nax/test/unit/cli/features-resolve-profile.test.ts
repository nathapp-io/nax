/**
 * `resolveFeatureSpec` profiles its config resolution (US-001).
 *
 * `nax features resolve` used to call `loadConfig(workdir)` with no profile, so
 * a project whose config only validates under the profile the PRD was planned
 * with (its `routingProfile`) always reported a failed acceptance resolution,
 * even though `nax run` succeeds. These tests pin the profile chain — CLI
 * `--profile` > `NAX_PROFILE` > PRD `routingProfile` — reaching both
 * `loadConfig` call sites inside the resolver.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { resolveFeatureSpec } from "@/cli/features-resolve";

let tempDir: string;
let savedEnvProfile: string | undefined;

beforeEach(() => {
  tempDir = makeTempDir("nax-resolve-profile-");
  savedEnvProfile = process.env.NAX_PROFILE;
  delete process.env.NAX_PROFILE;
});

afterEach(() => {
  if (savedEnvProfile === undefined) delete process.env.NAX_PROFILE;
  else process.env.NAX_PROFILE = savedEnvProfile;
  cleanupTempDir(tempDir);
});

/**
 * A nax repo whose config fails schema validation on its own.
 * `mode: "pipeline"` keeps workflow mode from forcing acceptance off once a
 * profile repairs the invalid value.
 */
function initInvalidRepo(): string {
  const naxDir = join(tempDir, ".nax");
  mkdirSync(join(naxDir, "features"), { recursive: true });
  writeFileSync(
    join(naxDir, "config.json"),
    JSON.stringify({ name: "test-project", execution: { mode: "pipeline", storyIsolation: "bogus" } }),
  );
  return naxDir;
}

/** Writes .nax/features/<name>/prd.json — also the feature's spec source. */
function writePRD(naxDir: string, name: string, routingProfile?: string): void {
  const dir = join(naxDir, "features", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "prd.json"),
    JSON.stringify({
      project: "p",
      feature: name,
      branchName: "main",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      ...(routingProfile ? { routingProfile } : {}),
      userStories: [
        {
          id: "US-001",
          title: "US-001",
          description: "",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 0,
        },
      ],
    }),
  );
}

/** Writes a config profile under .nax/profiles/<name>.json. */
function writeProfile(naxDir: string, name: string, config: Record<string, unknown>): void {
  const dir = join(naxDir, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(config));
}

describe("resolveFeatureSpec profile chain", () => {
  // AC-8: the PRD's routingProfile is adopted when neither the CLI nor the
  // environment names a profile.
  test("adopts the PRD routingProfile that makes the config valid (AC-8)", async () => {
    const naxDir = initInvalidRepo();
    writePRD(naxDir, "feat", "fix");
    writeProfile(naxDir, "fix", { execution: { storyIsolation: "shared" } });

    const result = await resolveFeatureSpec("feat", tempDir);

    expect(result.status).toBe("ok");
    expect(result.acceptance?.status).toBe("ok");
  });

  // AC-9: an explicit CLI profile wins over the PRD's absent routingProfile.
  test("adopts the CLI profile when the PRD has no routingProfile (AC-9)", async () => {
    const naxDir = initInvalidRepo();
    writePRD(naxDir, "feat");
    writeProfile(naxDir, "fix", { execution: { storyIsolation: "shared" } });

    const result = await resolveFeatureSpec("feat", tempDir, { profile: ["fix"] });

    expect(result.status).toBe("ok");
    expect(result.acceptance?.status).toBe("ok");
  });

  // AC-10: NAX_PROFILE outranks the PRD, so a PRD routingProfile that would
  // have repaired the config is deliberately NOT adopted.
  test("does not adopt the PRD routingProfile when NAX_PROFILE is set (AC-10)", async () => {
    const naxDir = initInvalidRepo();
    writePRD(naxDir, "feat", "fix");
    writeProfile(naxDir, "fix", { execution: { storyIsolation: "shared" } });
    writeProfile(naxDir, "other", { execution: { storyIsolation: "also-bogus" } });
    process.env.NAX_PROFILE = "other";

    const result = await resolveFeatureSpec("feat", tempDir);

    expect(result.status).toBe("ok");
    expect(result.acceptance?.status).toBe("error");
    expect(result.acceptance?.error?.code).toBe("CONFIG_SCHEMA_INVALID");
  });

  // AC-11: the profile reaches the testPatterns resolver too, not just acceptance.
  test("resolves testPatterns under the profile chain (AC-11)", async () => {
    const naxDir = initInvalidRepo();
    writePRD(naxDir, "feat", "fix");
    writeProfile(naxDir, "fix", { execution: { storyIsolation: "shared" } });

    const result = await resolveFeatureSpec("feat", tempDir);

    expect(result.testPatterns).toBeDefined();
    expect(result.testPatterns?.regex.length).toBeGreaterThan(0);
  });

  // The auto-discovered path resolves the chain the same way as the named one.
  test("adopts the PRD routingProfile for an auto-discovered feature", async () => {
    const naxDir = initInvalidRepo();
    writePRD(naxDir, "solo", "fix");
    writeProfile(naxDir, "fix", { execution: { storyIsolation: "shared" } });

    const result = await resolveFeatureSpec(undefined, tempDir);

    expect(result.status).toBe("ok");
    expect(result.acceptance?.status).toBe("ok");
  });

  // Auto-discovery lists any directory holding a prd.json, including one whose
  // name is not a valid feature id. Reading the profile must not turn that into
  // a throw — the spec still resolves, just without a PRD-derived profile.
  test("resolves spec for a feature directory whose name is not a valid feature id", async () => {
    const naxDir = initInvalidRepo();
    const dir = join(naxDir, "features", "bad name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ feature: "bad name", userStories: [] }));

    const result = await resolveFeatureSpec(undefined, tempDir);

    expect(result.status).toBe("ok");
    expect(result.featureName).toBe("bad name");
  });
});
