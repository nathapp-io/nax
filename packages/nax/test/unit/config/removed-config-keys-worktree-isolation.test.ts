// test/unit/config/removed-config-keys-worktree-isolation.test.ts
//
// US-006 — the two worktree-isolation keys (`execution.storyIsolation`,
// `execution.worktreeDependencies`) as entries in `REMOVED_CONFIG_KEYS`.
//
// Split out of removed-config-keys.test.ts, which would otherwise pass the
// 800-line test-file cap: the mechanism and the individual removed paths stay
// there, the two keys that configured the deleted story-worktree execution path
// live here.
//
// "Warns" means the loader warning reaches a logger sink registered with
// `addSink`; `loadConfig` takes no warn parameter.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
import { addSink, initLogger, resetLogger } from "@/logger";

const tempDirs: string[] = [];

/**
 * The hint both keys carry. `STORY_ISOLATION_HINT` is module-private in
 * `removed-config-keys.ts`, so the warning text is the observable — spelling it
 * out here also pins the format `removalWarning` produces.
 */
const WORKTREE_ISOLATION_HINT =
  "stories always run in the project checkout since worktree isolation was removed with pipeline mode";

const STORY_ISOLATION_REMOVAL_WARNING =
  'Config key "execution.storyIsolation" has been removed — stories always run in the project checkout since worktree isolation was removed with pipeline mode. Remove it from your config.';

const WORKTREE_DEPENDENCIES_REMOVAL_WARNING =
  'Config key "execution.worktreeDependencies" has been removed — stories always run in the project checkout since worktree isolation was removed with pipeline mode. Remove it from your config.';

/** The warning `stripKeysAtPaths` emits for one removed path. */
function removalWarning(path: string, hint: string): string {
  return `Config key "${path}" has been removed — ${hint}. Remove it from your config.`;
}

/** Write a project `.nax/config.json` and return the project root. */
async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-removed-isolation-");
  tempDirs.push(root);
  const naxDir = join(root, ".nax");
  await mkdir(naxDir, { recursive: true });
  await Bun.write(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

/** Run `fn` with a logger sink capturing every warning message it emits. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; messages: string[] }> {
  const messages: string[] = [];
  resetLogger();
  initLogger({ level: "warn" });
  const removeSink = addSink((entry) => messages.push(entry.message));
  try {
    const result = await fn();
    return { result, messages };
  } finally {
    removeSink();
    resetLogger();
  }
}

/** The removed-key warnings in a captured message list. */
function removedKeyWarnings(messages: string[]): string[] {
  return messages.filter((msg) => msg.includes("has been removed") && msg.startsWith("Config key "));
}

/** The warnings naming one dotted path. */
function warningsFor(messages: string[], path: string): string[] {
  return messages.filter((msg) => msg.includes(`"${path}"`));
}

beforeEach(() => {
  _clearRootConfigCache();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupTempDir(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — the removed worktree-isolation keys (US-006)
//
// `execution.storyIsolation` and `execution.worktreeDependencies` configured the
// story-worktree execution path, which the pipeline-mode removal deleted: the
// schema fields, their defaults, the merge block, the config descriptions and
// the inherit-mode shim all go with it. Both keys are now entries in
// `REMOVED_CONFIG_KEYS`, so a config that still carries them loads, is stripped
// before `safeParse`, and warns once per key with the isolation hint.
//
// `worktreeDependencies` is stripped as a whole section — one warning naming the
// section, never one per leaf — which is why a config that pins the retired
// `mode: "inherit"` gets no inherit-shim warning: the shim is gone with the key.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfig — execution.storyIsolation", () => {
  test("US-006 AC-1: resolves when the project config sets execution.storyIsolation", async () => {
    const root = await writeProjectConfig({ execution: { storyIsolation: "worktree" } });

    const config = await loadConfig(root);

    assertDefined(config.execution, "config.execution");
  });

  test("US-006 AC-2: a logger sink receives exactly one warning — the storyIsolation removal message", async () => {
    const root = await writeProjectConfig({ execution: { storyIsolation: "worktree" } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(removedKeyWarnings(messages)).toEqual([STORY_ISOLATION_REMOVAL_WARNING]);
    expect(STORY_ISOLATION_REMOVAL_WARNING).toBe(removalWarning("execution.storyIsolation", WORKTREE_ISOLATION_HINT));
  });

  test("US-006 AC-3: the resolved execution has no storyIsolation property", async () => {
    const root = await writeProjectConfig({ execution: { storyIsolation: "worktree" } });

    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution, "storyIsolation")).toBe(false);
  });
});

describe("stripRemovedConfigKeys via loadConfig — execution.worktreeDependencies (mode inherit)", () => {
  test("US-006 AC-4: resolves when the project config pins the retired inherit mode", async () => {
    const root = await writeProjectConfig({ execution: { worktreeDependencies: { mode: "inherit" } } });

    const config = await loadConfig(root);

    assertDefined(config.execution, "config.execution");
  });

  test("US-006 AC-5: a logger sink receives exactly one warning naming execution.worktreeDependencies", async () => {
    const root = await writeProjectConfig({ execution: { worktreeDependencies: { mode: "inherit" } } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(warningsFor(messages, "execution.worktreeDependencies")).toHaveLength(1);
  });

  test("US-006 AC-6: the logger sink receives no warning mentioning inherit", async () => {
    const root = await writeProjectConfig({ execution: { worktreeDependencies: { mode: "inherit" } } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(messages.filter((msg) => msg.toLowerCase().includes("inherit"))).toEqual([]);
  });

  test("US-006 AC-7: the resolved execution has no worktreeDependencies property", async () => {
    const root = await writeProjectConfig({ execution: { worktreeDependencies: { mode: "inherit" } } });

    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution, "worktreeDependencies")).toBe(false);
  });
});

// Every mode the section could carry, including the two the schema accepted
// (`off`, `provision`) and the retired `inherit`. Each must be stripped whole.
const WORKTREE_DEPENDENCIES_MODES: string[] = ["off", "provision", "inherit"];

describe("stripRemovedConfigKeys via loadConfig — execution.worktreeDependencies (any mode)", () => {
  test.each(WORKTREE_DEPENDENCIES_MODES)(
    "US-006 AC-8: mode %s leaves the resolved execution without a worktreeDependencies property",
    async (mode) => {
      const root = await writeProjectConfig({ execution: { worktreeDependencies: { mode } } });

      const config = await loadConfig(root);

      expect(Object.hasOwn(config.execution, "worktreeDependencies")).toBe(false);
    },
  );

  test.each(WORKTREE_DEPENDENCIES_MODES)(
    "US-006 AC-9: mode %s warns exactly once with the worktreeDependencies removal message",
    async (mode) => {
      const root = await writeProjectConfig({ execution: { worktreeDependencies: { mode } } });

      const { messages } = await captureWarnings(() => loadConfig(root));

      expect(removedKeyWarnings(messages)).toEqual([WORKTREE_DEPENDENCIES_REMOVAL_WARNING]);
      expect(WORKTREE_DEPENDENCIES_REMOVAL_WARNING).toBe(
        removalWarning("execution.worktreeDependencies", WORKTREE_ISOLATION_HINT),
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — no project config file still warns about nothing (US-006 AC-10)
//
// A retention pin, like US-003's default-load case: both keys leave the schema
// in the same change that adds their strip entries, so a default load must stay
// silent. The global layer is redirected per test — an ambient
// `~/.nax/config.json` must neither make this pass nor make it fail.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfig — no project config (US-006 AC-10)", () => {
  let previousGlobalDir: string | undefined;

  beforeEach(() => {
    previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    const globalDir = makeTempDir("nax-removed-isolation-global-");
    tempDirs.push(globalDir);
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  });

  afterEach(() => {
    if (previousGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
    }
  });

  test("US-006 AC-10: emits no warning containing 'has been removed'", async () => {
    const root = makeTempDir("nax-removed-isolation-none-");
    tempDirs.push(root);

    const { result, messages } = await captureWarnings(() => loadConfig(root));

    assertDefined(result, "loadConfig result");
    expect(messages.filter((msg) => msg.includes("has been removed"))).toEqual([]);
  });
});
