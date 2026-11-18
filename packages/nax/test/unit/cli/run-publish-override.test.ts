/**
 * US-001 — `nax run --publish <mode>` → `cliOverrides.workflow.publish`.
 *
 * The mapping lives in `src/cli/run-publish-override.ts` for the same reason as
 * `run-context-overrides.ts`: `bin/` is a CLI entry point with no unit test of its
 * own and `../../` imports are banned, so a mapping that lived inline there could
 * not be tested at all.
 *
 * What matters for the operator:
 * - the flag was not passed      → no override at all, so the configured
 *                                  `workflow.publish` stays in force (AC-1);
 * - a valid mode                  → only `workflow.publish`, so every sibling key
 *                                  keeps its configured value (AC-2, AC-3, AC-6);
 * - anything else                 → a refusal naming the accepted values, so nothing
 *                                  loads or starts (AC-4, AC-5, AC-9).
 *
 * US-001 also covers the chat `run` side (AC-10..AC-16), which lands in
 * `test/unit/chat/jobs/job-argv.test.ts`, `chain-argv.test.ts`,
 * `jobs-provider.test.ts` and `jobs-launch.test.ts`.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { resolvePublishCliOverride } from "@/cli/run-publish-override";
import { loadConfig } from "@/config";

describe("resolvePublishCliOverride (US-001)", () => {
  test("AC-1 an unpassed flag yields no override at all", () => {
    expect(resolvePublishCliOverride(undefined)).toBeUndefined();
  });

  test("AC-2 none asks the run to end without publishing", () => {
    expect(resolvePublishCliOverride("none")).toEqual({ workflow: { publish: "none" } });
  });

  test("AC-3 push asks the run to push the branch without a PR", () => {
    expect(resolvePublishCliOverride("push")).toEqual({ workflow: { publish: "push" } });
  });

  test("AC-4 an unknown mode is refused, naming the value and the accepted modes", () => {
    expect(resolvePublishCliOverride("draft")).toEqual({
      error: 'nax run --publish must be one of pr, push, none (got "draft")',
    });
  });

  test("AC-5 an empty value is refused the same way, naming the empty value", () => {
    const result = resolvePublishCliOverride("");
    expect(result).toEqual({ error: 'nax run --publish must be one of pr, push, none (got "")' });
  });

  test("pr is accepted as the third mode", () => {
    expect(resolvePublishCliOverride("pr")).toEqual({ workflow: { publish: "pr" } });
  });
});

describe("resolvePublishCliOverride → loadConfig's CLI layer (US-001)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-publish-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    cleanupTempDir(tempDir);
  });

  test("AC-6 the override replaces only workflow.publish, keeping maxFixRounds", async () => {
    await Bun.write(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ workflow: { publish: "pr", maxFixRounds: 3 } }),
    );
    const override = resolvePublishCliOverride("none");
    expect(override).toEqual({ workflow: { publish: "none" } });
    if (override === undefined || "error" in override) throw new Error("expected a workflow override");

    const config = await loadConfig(tempDir, { workflow: override.workflow });

    expect(config.workflow?.publish).toBe("none");
    expect(config.workflow?.maxFixRounds).toBe(3);
  });
});

interface SpawnResult {
  readonly code: number;
  readonly stderr: string;
}

/** Spawn the real entry point, as `runNax` does in `test/unit/cli/trust.test.ts`. */
async function spawnNax(args: readonly string[], globalConfigDir: string): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", "bin/nax.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalConfigDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr };
}

/** A cold start of bin/nax.ts takes ~1s; under full-suite load it exceeded bun's 5s default (PR #2570). */
const CLI_PROCESS_TIMEOUT_MS = 30_000;

describe("nax run --publish at the process boundary (US-001)", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-publish-cli-");
    projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test(
    "AC-9 --publish draft exits 1 with the refusal on stderr and starts nothing",
    async () => {
      const { code, stderr } = await spawnNax(["run", "-f", "f1", "-d", projectDir, "--publish", "draft"], tempDir);

      expect(code).toBe(1);
      expect(stderr).toContain('nax run --publish must be one of pr, push, none (got "draft")');
    },
    CLI_PROCESS_TIMEOUT_MS,
  );
});
