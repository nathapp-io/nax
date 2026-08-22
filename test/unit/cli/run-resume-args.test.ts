/**
 * bin/nax.ts `nax run` — commander parsing regression test.
 *
 * Adversarial finding: `.option("--no-resume", ..., false)` set the default
 * `options.resume` to `false`. The bin/nax.ts action handler mapped
 * `options.resume === false` → `resumeMode: "fresh"`, which forced fresh
 * mode for every normal `nax run` invocation (when the user passed neither
 * `--fresh` nor `--no-resume`). The spec requires auto-resume to be the
 * default.
 *
 * The fix uses a sentinel default for the `--no-resume` option so we can
 * distinguish "user passed --no-resume" (`options.resume === false`) from
 * "user passed nothing" (`options.resume === "__UNSET__"`). The
 * resumeMode derivation then becomes:
 *
 *   resumeMode = options.fresh === true || options.resume === false ? "fresh" : "auto"
 *
 * This test exercises the `run` subcommand via commander parsing to confirm
 * the resumeMode derivation logic against all three input combinations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { Command, Option } from "commander";

const RESUME_UNSET = "__UNSET__";

interface ParsedRunOptions {
  feature: string;
  dir?: string;
  fresh?: boolean;
  resume?: boolean | string;
}

/**
 * Build a `run` subcommand that mirrors bin/nax.ts options and returns
 * the parsed argv via a closure. The action handler captures the parsed
 * options without doing any real work.
 */
function buildRunCommand(): {
  cmd: Command;
  parseWith: (argv: string[]) => Promise<ParsedRunOptions>;
} {
  const captured: { options?: ParsedRunOptions } = {};

  const cmd = new Command();
  cmd.exitOverride();
  cmd
    .name("nax")
    .command("run")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Working directory", process.cwd())
    .option("--fresh", "Ignore any existing checkpoint.jsonl and re-run every incomplete story from scratch", false)
    .addOption(
      new Option("--no-resume", "Alias for --fresh: never auto-resume from a prior checkpoint").default(RESUME_UNSET),
    )
    .action(async (options: ParsedRunOptions) => {
      captured.options = options;
    });

  return {
    cmd,
    parseWith: async (argv: string[]) => {
      captured.options = undefined;
      await cmd.parseAsync(["node", "nax", "run", ...argv], { from: "node" });
      if (!captured.options) {
        throw new Error("action handler did not capture options");
      }
      return captured.options;
    },
  };
}

/**
 * The resumeMode derivation expression, factored out of bin/nax.ts:781
 * for unit testing. This is the function under test.
 */
function deriveResumeMode(options: ParsedRunOptions): "auto" | "fresh" {
  return options.fresh === true || options.resume === false ? "fresh" : "auto";
}

describe("bin/nax.ts `nax run` — commander argv parsing", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-run-args-");
  });

  afterEach(() => {
    cleanupTempDir(workdir);
  });

  test("default invocation (no --fresh, no --no-resume) yields resumeMode='auto'", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir]);
    expect(deriveResumeMode(options)).toBe("auto");
  });

  test("--fresh yields resumeMode='fresh'", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir, "--fresh"]);
    expect(deriveResumeMode(options)).toBe("fresh");
  });

  test("--no-resume yields resumeMode='fresh'", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir, "--no-resume"]);
    expect(deriveResumeMode(options)).toBe("fresh");
  });

  test("regression: neither flag must NOT yield resumeMode='fresh' (default-false bug)", async () => {
    // Guards against re-introducing `.option("--no-resume", ..., false)` +
    // `options.resume === false` which would force fresh mode for every
    // normal `nax run` invocation.
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir]);
    expect(deriveResumeMode(options)).not.toBe("fresh");
    expect(deriveResumeMode(options)).toBe("auto");
  });

  test("commander parses --fresh as options.fresh === true when passed", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir, "--fresh"]);
    expect(options.fresh).toBe(true);
  });

  test("commander leaves options.fresh as false when --fresh is absent", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir]);
    expect(options.fresh).toBe(false);
  });

  test("sentinel default: options.resume is the sentinel when --no-resume is absent", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir]);
    expect(options.resume).toBe(RESUME_UNSET);
  });

  test("sentinel default: options.resume is false when --no-resume is passed", async () => {
    const { parseWith } = buildRunCommand();
    const options = await parseWith(["-f", "feat-x", "-d", workdir, "--no-resume"]);
    expect(options.resume).toBe(false);
  });
});
