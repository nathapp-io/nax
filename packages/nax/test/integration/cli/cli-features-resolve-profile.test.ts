/**
 * `nax features resolve` profile awareness at the process boundary (US-001).
 *
 * Both ACs are stated in terms of the CLI's exit code and its `--json`
 * document, so this test spawns the real entry point in a temp project (same
 * approach as `cli-run-parallel.test.ts`). No agent is started: `features
 * resolve` only reads the config, the feature tree and the profile files.
 *
 * `NAX_PROFILE` is stripped from the child environment so the profile under
 * test is the only source that can repair the invalid config — a developer with
 * it exported would otherwise silently decide these assertions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..", "..");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir("nax-features-resolve-profile-");
  writeProject();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

/**
 * A nax repo whose project config fails schema validation on its own and is
 * valid only under `.nax/profiles/fix.json` (`storyIsolation: "shared"`).
 * `mode: "pipeline"` keeps workflow mode from forcing acceptance off once the
 * profile repairs the value.
 */
function writeProject(): void {
  const naxDir = join(tempDir, ".nax");
  const featureDir = join(naxDir, "features", "feat");
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(naxDir, "config.json"),
    JSON.stringify({ name: "test-project", execution: { mode: "pipeline", storyIsolation: "bogus" } }),
  );
  writeFileSync(
    join(featureDir, "prd.json"),
    JSON.stringify({
      project: "p",
      feature: "feat",
      branchName: "main",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
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
  mkdirSync(join(naxDir, "profiles"), { recursive: true });
  writeFileSync(join(naxDir, "profiles", "fix.json"), JSON.stringify({ execution: { storyIsolation: "shared" } }));
}

async function runResolve(args: string[]): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NAX_PROFILE;
  const proc = Bun.spawn(["bun", join(PACKAGE_ROOT, "bin", "nax.ts"), "features", "resolve", "feat", ...args], {
    cwd: PACKAGE_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("nax features resolve — profile awareness (US-001)", () => {
  // AC-12: an acceptance "error" is reported in the document, not converted
  // into a non-zero exit — the spec still resolved.
  test("AC-12: exits 0 and reports acceptance.status=error when no profile repairs the config", async () => {
    const { exitCode, stdout } = await runResolve(["--json", "-d", tempDir]);

    expect(exitCode).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.status).toBe("ok");
    expect(doc.acceptance.status).toBe("error");
    expect(doc.acceptance.error.code).toBe("CONFIG_SCHEMA_INVALID");
  }, 30000);

  // AC-13: --profile reaches loadConfig through resolveFeatureSpec.
  test("AC-13: --profile fix makes the config valid so acceptance.status is ok", async () => {
    const { exitCode, stdout } = await runResolve(["--json", "--profile", "fix", "-d", tempDir]);

    expect(exitCode).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.status).toBe("ok");
    expect(doc.acceptance.status).toBe("ok");
    expect(doc.acceptance.error).toBeUndefined();
  }, 30000);
});
