/**
 * US-002 — the `nax migrate` command-line contract.
 *
 * `migrate` and its commander options are defined inline in `bin/nax.ts` and
 * cannot be imported, so this file spawns the CLI exactly as
 * `test/unit/cli/trust.test.ts` does. That is a deliberate exception to the
 * "Spawning full `nax` process in tests" rule: the option set itself is what
 * these criteria pin, and only a real spawn exercises commander's parsing.
 *
 * Every spawn sets `NAX_GLOBAL_CONFIG_DIR` to a temp directory, so no spawn
 * reaches the real `~/.nax` — including the `--reclaim` case, whose whole job
 * is to move a directory under the global config dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

/** `packages/nax` — resolved from this file, not from `process.cwd()`. */
const PACKAGE_DIR = join(import.meta.dir, "..", "..", "..");

const USAGE_MESSAGE = "nax migrate needs --reclaim <name> or --merge <name>";
const DESCRIPTION = "Recover a project-name collision: --reclaim or --merge";
const RECLAIM_NAME = "reclaim-cli-project";

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

let globalDir: string;
let projectDir: string;
const tempDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  globalDir = makeDir("nax-migrate-cli-global-");
  projectDir = makeDir("nax-migrate-cli-project-");
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

/** Spawn the CLI with the global config dir redirected at `globalDir`. */
async function runMigrate(args: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", "bin/nax.ts", ...args], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * A minimal but real project: `.nax/config.json` whose `outputDir` points
 * inside the temp dir, plus a generated entry the removed migration would have
 * moved. With a config present the pre-change CLI exits 0 ("nothing to
 * migrate"), so AC5/AC6 discriminate against the old behaviour.
 */
async function seedProject(): Promise<void> {
  await Bun.write(
    join(projectDir, ".nax", "config.json"),
    JSON.stringify({ name: "migrate-cli-fixture", outputDir: join(projectDir, "out") }),
  );
  await Bun.write(join(projectDir, ".nax", "metrics.json"), "{}");
}

describe("nax migrate — no mode", () => {
  test("US-002 AC5: exits 1 when neither --reclaim nor --merge is passed", async () => {
    await seedProject();

    const result = await runMigrate(["migrate", "-d", projectDir]);

    expect(result.code).toBe(1);
  });

  test("US-002 AC6: the refusal names both flags on stderr", async () => {
    await seedProject();

    const result = await runMigrate(["migrate", "-d", projectDir]);

    expect(result.stderr).toContain(USAGE_MESSAGE);
  });
});

describe("nax migrate — option contract", () => {
  test("US-002 AC7: --dry-run is no longer a known option", async () => {
    await seedProject();

    const result = await runMigrate(["migrate", "--dry-run", "-d", projectDir]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--dry-run'");
  });

  test("US-002 AC8: --help describes collision recovery", async () => {
    const result = await runMigrate(["migrate", "--help"]);

    expect(result.stdout).toContain(DESCRIPTION);
  });
});

describe("nax migrate --reclaim", () => {
  test("US-002 AC9: archives the named global project directory and exits 0", async () => {
    await Bun.write(join(globalDir, RECLAIM_NAME, "config.json"), JSON.stringify({ name: RECLAIM_NAME }));

    const result = await runMigrate(["migrate", "--reclaim", RECLAIM_NAME]);

    expect(result.code).toBe(0);
    // The reclaimed directory is gone, and the archive entry is named
    // `<name>-<timestamp>` — not a fixed name, so assert on the prefix.
    expect(existsSync(join(globalDir, RECLAIM_NAME))).toBe(false);
    const archiveBase = join(globalDir, "_archive");
    expect(existsSync(archiveBase)).toBe(true);
    const archived = readdirSync(archiveBase);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.startsWith(`${RECLAIM_NAME}-`)).toBe(true);
  });
});
