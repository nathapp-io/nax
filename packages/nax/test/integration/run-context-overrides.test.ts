/**
 * US-002 — run-level rules and project-context overrides, end to end.
 *
 * Three surfaces of the same feature, each driven through its real entry point:
 *
 *   1. `initializeAfterLock` reaches the rules-override validation through
 *      `configureRunRules`, with the REAL directory probe — so a missing or
 *      non-directory `overrideDir` stops the run before the session manager is
 *      configured, and the feature lock is still released on the way out.
 *   2. `configJsonCommand` reports the configured path at its own key, so an
 *      orchestrator can see what a repo asked for without running it.
 *   3. `nax run --help` lists `--rules-dir` and `--context-file`.
 *
 * The flag → `cliOverrides.context` translation itself lives in
 * `src/cli/run-context-overrides.ts` and is covered by
 * `test/unit/cli/run-context-overrides.test.ts` (AC-7 / AC-8 / AC-9) — `bin/`
 * imports are banned by `noRestrictedImports`, the same reason the other
 * `nax run` flag parsers live under `src/cli/`.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import {
  assertNaxError,
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { _configJsonDeps, type ConfigJsonReport, configJsonCommand } from "@/cli/config-json";
import type { ConfigRequirements } from "@/cli/config-requirements";
import type { NaxConfig } from "@/config";
import { acquireFeatureLock, featureLockPath } from "@/execution/feature-lock";
import type { InitializeAfterLockDeps, InitializeAfterLockResult } from "@/execution/lifecycle/run-setup-init";
import { initializeAfterLock } from "@/execution/lifecycle/run-setup-init";
import type { NaxRuntime } from "@/runtime";

const FEATURE = "lazy-rules-us-002";
const RUN_ID = "run-us-002";
const LOOP_HANDLER_PLUGIN = "seed-note-plugin";

/** A plugin that stages one `before_turn` handler, so the delivered set is non-empty. */
const LOOP_HANDLER_PLUGIN_SOURCE = `
export default {
  name: "${LOOP_HANDLER_PLUGIN}",
  version: "1.0.0",
  provides: ["loop-handlers"],
  extensions: {
    loopHandlers: {
      register(on) {
        on("before_turn", () => ({ seed: [{ role: "user", content: "SEED-NOTE" }] }));
      },
    },
  },
};
`;

const tempDirs: string[] = [];

/** A fresh temp dir, removed by the file-level afterEach. */
function freshDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

/** A temp workdir holding a `.nax/config.json` and one loop-handler plugin. */
async function makeRunWorkdir(prefix: string, config: Record<string, unknown> = {}): Promise<string> {
  const dir = freshDir(prefix);
  const pluginDir = join(dir, ".nax", "plugins");
  await fs.mkdir(pluginDir, { recursive: true });
  await Bun.write(join(pluginDir, "seed-note-plugin.ts"), LOOP_HANDLER_PLUGIN_SOURCE);
  await Bun.write(join(dir, ".nax", "config.json"), JSON.stringify(config));
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 / AC-11 / AC-12 / AC-20 — initializeAfterLock through configureRunRules
// ─────────────────────────────────────────────────────────────────────────────

const DEPS: InitializeAfterLockDeps = {
  detectProjectProfile: async () => ({}),
  sweepFeatureTranscripts: async () => 0,
};

/** Run the real post-lock initialization over `workdir` with `config`. */
async function runInitializeAfterLock(
  workdir: string,
  config: NaxConfig,
  configureLoopHandlers: (set: LoopHandlerSet) => void,
  runtime?: NaxRuntime,
): Promise<InitializeAfterLockResult> {
  const prdPath = join(workdir, ".nax", "features", FEATURE, "prd.json");
  await fs.mkdir(dirname(prdPath), { recursive: true });
  const prd = makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-002" })] });
  await Bun.write(prdPath, JSON.stringify(prd, null, 2));

  return initializeAfterLock({
    config,
    workdir,
    feature: FEATURE,
    dryRun: true,
    runtime: runtime ?? makeMockRuntime({ workdir, sessionManager: makeSessionManager({ configureLoopHandlers }) }),
    prdPath,
    prd,
    interactionChain: null,
    runId: RUN_ID,
    statusWriter: makeStatusWriter(),
    deps: DEPS,
  });
}

describe("initializeAfterLock — rules override validation (US-002)", () => {
  test("AC-10: delivery 'push' with no overrides delivers the plugin registry's own set", async () => {
    const workdir = await makeRunWorkdir("nax-run-overrides-push-");
    const delivered: LoopHandlerSet[] = [];

    const result = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { rules: { delivery: "push", overrideDir: undefined } } }),
      (set) => delivered.push(set),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBe(result.pluginRegistry.getLoopHandlers());
    expect(delivered[0]?.map((entry) => entry.plugin)).toEqual([LOOP_HANDLER_PLUGIN]);
  });

  test("AC-11: a missing overrideDir rejects with RULES_OVERRIDE_DIR_NOT_FOUND", async () => {
    const workdir = await makeRunWorkdir("nax-run-overrides-missing-");
    const overrideDir = join(workdir, "missing-org-rules");

    const err = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { rules: { overrideDir } } }),
      () => {},
    ).catch((caught: unknown) => caught);

    assertNaxError(err, "initializeAfterLock rejection");
    expect(err.code).toBe("RULES_OVERRIDE_DIR_NOT_FOUND");
    expect(err.context).toMatchObject({ stage: "run-setup", overrideDir });
  });

  test("AC-12: a missing overrideDir leaves configureLoopHandlers uncalled", async () => {
    const workdir = await makeRunWorkdir("nax-run-overrides-uncalled-");
    let calls = 0;

    await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { rules: { overrideDir: join(workdir, "missing-org-rules") } } }),
      () => {
        calls++;
      },
    ).catch(() => undefined);

    expect(calls).toBe(0);
  });

  test("AC-20: an overrideDir that exists but is a file rejects the same way, before any story runs", async () => {
    const workdir = await makeRunWorkdir("nax-run-overrides-file-");
    const overrideDir = join(workdir, "org-rules.md");
    await Bun.write(overrideDir, "# not a directory\n");
    let calls = 0;

    const err = await runInitializeAfterLock(workdir, makeNaxConfig({ context: { rules: { overrideDir } } }), () => {
      calls++;
    }).catch((caught: unknown) => caught);

    assertNaxError(err, "initializeAfterLock rejection");
    expect(err.code).toBe("RULES_OVERRIDE_DIR_NOT_FOUND");
    expect(err.context).toMatchObject({ stage: "run-setup", overrideDir });
    expect(calls).toBe(0);
  });

  test("an overrideDir that really is a directory is accepted", async () => {
    const workdir = await makeRunWorkdir("nax-run-overrides-present-");
    const overrideDir = join(workdir, "org-rules");
    await fs.mkdir(overrideDir, { recursive: true });
    const delivered: LoopHandlerSet[] = [];

    await runInitializeAfterLock(workdir, makeNaxConfig({ context: { rules: { overrideDir } } }), (set) =>
      delivered.push(set),
    );

    expect(delivered).toHaveLength(1);
  });

  test("the feature lock is still released when the override validation throws (FIX-H16)", async () => {
    const workdir = await makeRunWorkdir("nax-run-overrides-lock-");
    const runtime = makeMockRuntime({
      workdir,
      sessionManager: makeSessionManager({ configureLoopHandlers: () => {} }),
    });
    const lockPath = featureLockPath(runtime.outputDir, FEATURE);
    await fs.mkdir(dirname(lockPath), { recursive: true });
    const acquired = await acquireFeatureLock({
      outputDir: runtime.outputDir,
      feature: FEATURE,
      workdir,
      runId: RUN_ID,
    });
    expect(acquired.acquired).toBe(true);
    expect(await Bun.file(lockPath).exists()).toBe(true);

    const err = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { rules: { overrideDir: join(workdir, "gone") } } }),
      () => {},
      runtime,
    ).catch((caught: unknown) => caught);

    assertNaxError(err, "initializeAfterLock rejection");
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19 — `nax config --json` reports the configured override path
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_REQUIREMENTS: ConfigRequirements = {
  agent: "stub-agent",
  transport: "acp",
  protocol: "hybrid",
  providers: [],
  sandbox: false,
};

const realLog = _configJsonDeps.log;
const realBuildConfigRequirements = _configJsonDeps.buildConfigRequirements;
const realIsHeadless = _configJsonDeps.isHeadless;

describe("configJsonCommand — context.rules.overrideDir (US-002)", () => {
  test("AC-19: an absolute overrideDir in .nax/config.json is reported at context.rules.overrideDir", async () => {
    const project = await makeRunWorkdir("nax-context-overrides-config-json-", {
      context: { rules: { overrideDir: "/abs/org-rules" } },
    });
    const out: string[] = [];
    _configJsonDeps.log = (text: string) => out.push(text);
    _configJsonDeps.buildConfigRequirements = () => FIXED_REQUIREMENTS;
    _configJsonDeps.isHeadless = () => true;

    try {
      const code = await configJsonCommand({ dir: project });

      expect(code).toBe(0);
      const [first] = out;
      expect(first).toBeDefined();
      const document: Partial<ConfigJsonReport> = JSON.parse(first ?? "{}");
      expect(document.config).toMatchObject({ context: { rules: { overrideDir: "/abs/org-rules" } } });
    } finally {
      _configJsonDeps.log = realLog;
      _configJsonDeps.buildConfigRequirements = realBuildConfigRequirements;
      _configJsonDeps.isHeadless = realIsHeadless;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13 / AC-14 — the flags are listed in `nax run --help`
// ─────────────────────────────────────────────────────────────────────────────

/** The package root (`packages/nax`), whatever cwd the suite was launched from. */
const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

/**
 * Cold-starting bin/nax.ts costs ~1s locally and more under full-suite CI load
 * (the same reason `trust.test.ts` uses 30s — PR #2570).
 */
const CLI_PROCESS_TIMEOUT_MS = 30_000;

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "bin/nax.ts", ...args], { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

describe("nax run --help (US-002)", () => {
  test(
    "AC-13/AC-14: lists --rules-dir <path> and --context-file <path>",
    async () => {
      const { code, stdout } = await runCli(["run", "--help"]);

      expect(code).toBe(0);
      expect(stdout).toContain("--rules-dir <path>");
      expect(stdout).toContain("--context-file <path>");
    },
    CLI_PROCESS_TIMEOUT_MS,
  );
});
