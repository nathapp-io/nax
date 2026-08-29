/**
 * Root config schema validation throws a coded NaxError (US-004 AC-5)
 *
 * The root-config Zod-failure path in `loadConfig` previously threw a bare
 * `Error`. Callers (CLI, monorepo resolution, debug tooling) could not branch
 * on the failure kind. This test pins the fix: a failed root `safeParse`
 * rejects with a `NaxError` whose message still lists every failing field
 * path — preserving the existing field-path reporting the user depends on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertNaxError, makeTempDir } from "@test/helpers";
import { loadConfig } from "@/config/loader";

describe("loadConfig — root schema validation throws coded NaxError (US-004 AC-5)", () => {
  let root: string;
  let originalGlobalDir: string | undefined;

  beforeEach(async () => {
    root = makeTempDir("nax-root-schema-err-");
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(root, ".global-nax");
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (originalGlobalDir === undefined) process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  });

  // Multi-field failure: every failing field path must still surface in the
  // message. The shape is what the user depends on for debugging which keys
  // to fix, so it is preserved verbatim while the throw type is upgraded.
  test("AC-5: rejects with a coded NaxError whose message lists every failing field path", async () => {
    // Two independent invalid values across two separate branches of the
    // schema — quality.requireLint is a dead flag (caught by the pre-parse
    // guard) and routing.strategy is a value outside the enum. The dead-flag
    // guard fails-fast before Zod, so the test focuses on a Zod-only failure
    // path by using values the schema rejects but the guards do not.
    await Bun.write(
      join(root, ".nax", "config.json"),
      JSON.stringify({
        quality: {
          // 'commands.test' must be a string — a number fails the Zod schema.
          commands: { test: 42 },
        },
        routing: {
          // 'strategy' is a Zod enum — 'nonsense' fails it.
          strategy: "nonsense",
        },
      }),
    );

    const err = await loadConfig(root).catch((e: unknown) => e);
    assertNaxError(err, "loadConfig rejection on invalid root config");
    // Every failing field path must still appear in the message so the user
    // can debug which keys to fix.
    expect(err.message).toContain("quality.commands.test");
    expect(err.message).toContain("routing.strategy");
  });

  // Single-field failure still produces a coded NaxError — the bare-error
  // regression was the same shape for any number of failed paths.
  test("AC-5: a single failing field path also rejects with a coded NaxError", async () => {
    await Bun.write(join(root, ".nax", "config.json"), JSON.stringify({ routing: { strategy: "nonsense" } }));

    const err = await loadConfig(root).catch((e: unknown) => e);
    assertNaxError(err, "loadConfig rejection on single bad field");
    expect(err.message).toContain("routing.strategy");
  });

  // Sanity: a valid project config still loads — proves the new error path
  // does not regress the happy path.
  test("AC-5: a valid project config still loads (happy path unchanged)", async () => {
    await Bun.write(join(root, ".nax", "config.json"), JSON.stringify({ quality: { commands: { test: "bun test" } } }));
    const config = await loadConfig(root);
    expect(config.quality?.commands?.test).toBe("bun test");
  });
});
