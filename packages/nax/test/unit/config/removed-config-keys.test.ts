// test/unit/config/removed-config-keys.test.ts
//
// C1 B3c-2 (US-002) — the shared warn-and-strip traversal for the config keys
// the pipeline-mode removal retired.
//
// `stripKeysAtPaths` is the generic mechanism: it walks a dotted path, warns
// once per path present, and rebuilds the objects above the change instead of
// mutating its input. `stripRemovedConfigKeys` binds it to
// `REMOVED_CONFIG_KEYS`, and `stripRemovedConfig` (removed-stage-names.ts) runs
// it between the no-op-key strip and the removed-stage-name strip with one sink,
// at every loader strip site — before `NaxConfigSchema.safeParse`, so a key
// under a `.strict()` schema is gone before the schema sees it.
//
// "Warns" here means the loader warning reaches a logger sink registered with
// `addSink`, the same way test/unit/config/removed-stage-names.test.ts captures
// it: `loadConfig` takes no warn parameter.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig, loadConfigForWorkdir } from "@/config/loader";
import {
  PIPELINE_ONLY_KEY_HINT,
  REMOVED_CONFIG_KEYS,
  stripKeysAtPaths,
  stripRemovedConfigKeys,
} from "@/config/removed-config-keys";
import { addSink, initLogger, resetLogger } from "@/logger";

const tempDirs: string[] = [];
const PROVIDER_HINT = "nothing read this key; the interceptor is always rtk";
/** US-003 — the hint `execution.verificationTimeoutSeconds` carries. */
const VERIFICATION_TIMEOUT_HINT = "verification uses execution.regressionGate.timeoutSeconds";

/** The warning `stripKeysAtPaths` emits for one removed path. */
function removalWarning(path: string, hint: string): string {
  return `Config key "${path}" has been removed — ${hint}. Remove it from your config.`;
}

/** Write a project `.nax/config.json` and return the project root. */
async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-removed-keys-");
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
// loadConfig — one removed rectification leaf
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfig — execution.rectification leaves", () => {
  test("AC-1: resolves without the removed abortOnNoProgress property", async () => {
    const root = await writeProjectConfig({ execution: { rectification: { abortOnNoProgress: false } } });

    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution.rectification, "abortOnNoProgress")).toBe(false);
  });

  test("AC-2: a logger sink receives exactly the removed-key warning for abortOnNoProgress", async () => {
    const root = await writeProjectConfig({ execution: { rectification: { abortOnNoProgress: false } } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(warningsFor(messages, "execution.rectification.abortOnNoProgress")).toEqual([
      removalWarning("execution.rectification.abortOnNoProgress", PIPELINE_ONLY_KEY_HINT),
    ]);
  });

  test("AC-10: retains execution.rectification.maxAttemptsTotal", async () => {
    const root = await writeProjectConfig({ execution: { rectification: { maxAttemptsTotal: 7 } } });

    const config = await loadConfig(root);

    expect(config.execution.rectification.maxAttemptsTotal).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — the two removed execution sections and the interceptor provider
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTION_FIXTURE = {
  mutationCheck: { enabled: true },
  flakeDetection: { enabled: false },
  commandInterceptor: { enabled: true, provider: "rtk" },
};

describe("stripRemovedConfigKeys via loadConfig — removed execution sections", () => {
  let root: string;

  beforeEach(async () => {
    root = await writeProjectConfig({ execution: EXECUTION_FIXTURE });
  });

  test("AC-3: resolves rather than rejecting the removed keys", async () => {
    const config = await loadConfig(root);

    expect(config.execution).toBeDefined();
  });

  test("AC-4: warns exactly once per removed key, with the section and provider hints", async () => {
    const { messages } = await captureWarnings(() => loadConfig(root));

    const removed = removedKeyWarnings(messages);
    expect(removed).toHaveLength(3);
    expect(warningsFor(removed, "execution.mutationCheck")).toEqual([
      removalWarning("execution.mutationCheck", PIPELINE_ONLY_KEY_HINT),
    ]);
    expect(warningsFor(removed, "execution.flakeDetection")).toEqual([
      removalWarning("execution.flakeDetection", PIPELINE_ONLY_KEY_HINT),
    ]);
    expect(warningsFor(removed, "execution.commandInterceptor.provider")).toEqual([
      removalWarning("execution.commandInterceptor.provider", PROVIDER_HINT),
    ]);
  });

  test("AC-5: the resolved execution has no mutationCheck property", async () => {
    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution, "mutationCheck")).toBe(false);
  });

  test("AC-6: the resolved execution has no flakeDetection property", async () => {
    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution, "flakeDetection")).toBe(false);
  });

  test("AC-7: retains execution.commandInterceptor.enabled", async () => {
    const config = await loadConfig(root);

    expect(config.execution.commandInterceptor.enabled).toBe(true);
  });

  test("AC-8: the resolved commandInterceptor has no provider property", async () => {
    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution.commandInterceptor, "provider")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — the removed verification timeout (US-003)
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfig — execution.verificationTimeoutSeconds", () => {
  test("AC-1: resolves without a verificationTimeoutSeconds property on execution", async () => {
    const root = await writeProjectConfig({ execution: { verificationTimeoutSeconds: 120 } });

    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution, "verificationTimeoutSeconds")).toBe(false);
  });

  test("AC-2: a logger sink receives exactly the removed-key warning for verificationTimeoutSeconds", async () => {
    const root = await writeProjectConfig({ execution: { verificationTimeoutSeconds: 120 } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(warningsFor(messages, "execution.verificationTimeoutSeconds")).toEqual([
      removalWarning("execution.verificationTimeoutSeconds", VERIFICATION_TIMEOUT_HINT),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — the dead regression-gate mode beside a live timeout (US-003)
//
// The fixture carries a live key on purpose: the strip must remove `mode` and
// leave `timeoutSeconds` alone, so the two are asserted from one load.
// ─────────────────────────────────────────────────────────────────────────────

const REGRESSION_GATE_FIXTURE = { mode: "per-story", timeoutSeconds: 90 };

describe("stripRemovedConfigKeys via loadConfig — execution.regressionGate.mode", () => {
  let root: string;

  beforeEach(async () => {
    root = await writeProjectConfig({ execution: { regressionGate: REGRESSION_GATE_FIXTURE } });
  });

  test("AC-3: retains the live execution.regressionGate.timeoutSeconds", async () => {
    const config = await loadConfig(root);

    expect(config.execution.regressionGate.timeoutSeconds).toBe(90);
  });

  test("AC-4: a logger sink receives exactly the removed-key warning for regressionGate.mode", async () => {
    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(warningsFor(messages, "execution.regressionGate.mode")).toEqual([
      removalWarning("execution.regressionGate.mode", PIPELINE_ONLY_KEY_HINT),
    ]);
  });

  test("AC-5: the resolved regressionGate has no mode property", async () => {
    const config = await loadConfig(root);

    expect(Object.hasOwn(config.execution.regressionGate, "mode")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — the removed `acceptance` section (pipeline-acceptance-isolation-delete US-003)
//
// `src/acceptance/` was deleted with pipeline mode, so the section configures
// nothing. It is stripped WHOLE: one warning naming `acceptance`, never one per
// leaf under it, and no `acceptance` property on the resolved config. The whole
// section is one entry in `REMOVED_CONFIG_KEYS`, so a leaf such as the retired
// `acceptance.generateTests` is reported as part of the section, not under its
// own dotted name.
// ─────────────────────────────────────────────────────────────────────────────

/** The two-field fixture the US-003 ACs name verbatim. */
const ACCEPTANCE_FIXTURE = { enabled: true, model: "fast" };

/** AC-2's message, spelled out rather than derived, so the format is pinned too. */
const ACCEPTANCE_REMOVAL_WARNING =
  'Config key "acceptance" has been removed — nothing reads this key since pipeline mode was removed. Remove it from your config.';

describe("stripRemovedConfigKeys via loadConfig — the removed acceptance section", () => {
  test("US-003 AC-1: resolves when the project config sets acceptance", async () => {
    const root = await writeProjectConfig({ acceptance: ACCEPTANCE_FIXTURE });

    const config = await loadConfig(root);

    assertDefined(config, "loadConfig result");
  });

  test("US-003 AC-2: a logger sink receives exactly one warning — the acceptance removal message", async () => {
    const root = await writeProjectConfig({ acceptance: ACCEPTANCE_FIXTURE });

    const { messages } = await captureWarnings(() => loadConfig(root));

    expect(removedKeyWarnings(messages)).toEqual([ACCEPTANCE_REMOVAL_WARNING]);
    expect(ACCEPTANCE_REMOVAL_WARNING).toBe(removalWarning("acceptance", PIPELINE_ONLY_KEY_HINT));
  });

  test("US-003 AC-3: the resolved config has no acceptance property", async () => {
    const root = await writeProjectConfig({ acceptance: ACCEPTANCE_FIXTURE });

    const config = await loadConfig(root);

    expect(Object.hasOwn(config, "acceptance")).toBe(false);
  });
});

describe("stripRemovedConfigKeys via loadConfig — acceptance.generateTests", () => {
  test("US-003 AC-4: resolves when the project config sets acceptance.generateTests", async () => {
    const root = await writeProjectConfig({ acceptance: { generateTests: true } });

    const config = await loadConfig(root);

    assertDefined(config, "loadConfig result");
  });

  test("US-003 AC-5: warns once naming the section, never the generateTests leaf", async () => {
    const root = await writeProjectConfig({ acceptance: { generateTests: true } });

    const { messages } = await captureWarnings(() => loadConfig(root));

    const removed = removedKeyWarnings(messages);
    expect(removed).toEqual([removalWarning("acceptance", PIPELINE_ONLY_KEY_HINT)]);
    expect(removed.filter((msg) => msg.includes("acceptance.generateTests"))).toEqual([]);
  });
});

// Every shape a leftover section can take: the section alone, and one fixture
// per nesting depth a leaf actually sits at. Each must be stripped whole.
const ACCEPTANCE_LEAF_FIXTURES: Array<[string, object]> = [
  ["the section set to a single leaf", { acceptance: { enabled: true } }],
  ["the retired generateTests leaf", { acceptance: { generateTests: true } }],
  ["a two-level leaf", { acceptance: { fix: { strategy: "implement-only" } } }],
  ["a two-level hardening leaf", { acceptance: { hardening: { enabled: false } } }],
];

describe("stripRemovedConfigKeys via loadConfig — any nested acceptance leaf", () => {
  test.each(ACCEPTANCE_LEAF_FIXTURES)(
    "US-003 AC-6: setting %s leaves the resolved config without an acceptance property",
    async (_label, fixture) => {
      const root = await writeProjectConfig(fixture);

      const config = await loadConfig(root);

      expect(Object.hasOwn(config, "acceptance")).toBe(false);
    },
  );

  test.each(ACCEPTANCE_LEAF_FIXTURES)(
    "US-003 AC-7: setting %s warns exactly once, naming acceptance",
    async (_label, fixture) => {
      const root = await writeProjectConfig(fixture);

      const { messages } = await captureWarnings(() => loadConfig(root));

      expect(removedKeyWarnings(messages)).toEqual([removalWarning("acceptance", PIPELINE_ONLY_KEY_HINT)]);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — a default load still warns about nothing (US-003 AC-8)
//
// A retention pin. `DEFAULT_CONFIG` is `NaxConfigSchema.parse({})`, and the
// loader warns about a key only when the CONFIG supplies it — so a strip entry
// whose schema field survived would warn on every load. With no project file
// and an owned global dir (no ambient `~/.nax/config.json` can decide this),
// there must be no removal warning at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfig — a default load (US-003 AC-8)", () => {
  let previousGlobalDir: string | undefined;

  beforeEach(() => {
    previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    const globalDir = makeTempDir("nax-removed-acceptance-global-");
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

  test("US-003 AC-8: emits no warning containing 'has been removed'", async () => {
    const root = makeTempDir("nax-removed-acceptance-none-");
    tempDirs.push(root);

    const { result, messages } = await captureWarnings(() => loadConfig(root));

    assertDefined(result, "loadConfig result");
    expect(messages.filter((msg) => msg.includes("has been removed"))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retention pins (AC-6 … AC-10) — every one of these passes before the removals
// as well. They are here so a later change cannot take a live regression
// setting with the dead ones. The global layer is redirected per test for the
// same reason the AC-9 block above redirects it: an ambient
// `~/.nax/config.json` must neither make them pass nor make them fail.
// ─────────────────────────────────────────────────────────────────────────────

describe("loadConfig — the retained regression settings after the removals", () => {
  let previousGlobalDir: string | undefined;

  beforeEach(() => {
    previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    const globalDir = makeTempDir("nax-removed-retained-global-");
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

  /** A project root that holds no `.nax/config.json` at all. */
  function makeBareRoot(): string {
    const root = makeTempDir("nax-removed-retained-");
    tempDirs.push(root);
    return root;
  }

  test("AC-6: a default load resolves execution.regressionGate.enabled === true", async () => {
    const config = await loadConfig(makeBareRoot());

    expect(config.execution.regressionGate.enabled).toBe(true);
  });

  test("AC-7: a default load resolves execution.regressionGate.acceptOnTimeout === true", async () => {
    const config = await loadConfig(makeBareRoot());

    expect(config.execution.regressionGate.acceptOnTimeout).toBe(true);
  });

  test("AC-10: an out-of-range timeoutSeconds still rejects with CONFIG_SCHEMA_INVALID naming the path", async () => {
    const root = await writeProjectConfig({ execution: { regressionGate: { timeoutSeconds: 0 } } });

    const err = await loadConfig(root).catch((e: unknown) => e);

    assertNaxError(err, "loadConfig rejection on an out-of-range regression timeout");
    expect(err.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(err.message).toContain("execution.regressionGate.timeoutSeconds");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig — the default config warns about nothing
//
// AC-9 is about a load with NO config at ANY layer, so the test must own the
// global layer too: an ambient `~/.nax/config.json` (or a global dir a sibling
// suite left behind) that still names a C1 key decides this test's result
// otherwise. Each test in this block points NAX_GLOBAL_CONFIG_DIR at its own
// directory and restores the previous value, so the ambient global layer can
// neither make it pass nor make it fail.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfig — no project config", () => {
  let previousGlobalDir: string | undefined;

  /** Point the global config layer at a directory this test owns. */
  async function useGlobalDir(contents?: object): Promise<string> {
    const dir = makeTempDir("nax-removed-none-global-");
    tempDirs.push(dir);
    if (contents !== undefined) {
      await Bun.write(join(dir, "config.json"), JSON.stringify(contents));
    }
    process.env.NAX_GLOBAL_CONFIG_DIR = dir;
    return dir;
  }

  beforeEach(() => {
    previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  });

  afterEach(() => {
    if (previousGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
    }
  });

  test("AC-9: a logger sink receives no 'has been removed' warning", async () => {
    await useGlobalDir();
    const root = makeTempDir("nax-removed-none-");
    tempDirs.push(root);

    const { result, messages } = await captureWarnings(() => loadConfig(root));

    assertDefined(result, "loadConfig result");
    expect(messages.filter((msg) => msg.includes("has been removed"))).toEqual([]);
  });

  test("AC-9 companion: a removed key in the global layer is still stripped with a warning", async () => {
    // The other half of the isolation: the redirect above must not silence the
    // global layer — it is a real config source and its retired keys warn like
    // a project file's do. Without this, dropping the redirect would look safe.
    await useGlobalDir({ execution: { mutationCheck: { enabled: true } } });
    const root = makeTempDir("nax-removed-none-proj-");
    tempDirs.push(root);

    const { result, messages } = await captureWarnings(() => loadConfig(root));

    assertDefined(result, "loadConfig result");
    expect(Object.hasOwn(result.execution, "mutationCheck")).toBe(false);
    expect(warningsFor(messages, "execution.mutationCheck")).toEqual([
      removalWarning("execution.mutationCheck", PIPELINE_ONLY_KEY_HINT),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripKeysAtPaths — direct unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("stripKeysAtPaths", () => {
  test("AC-16: strips a nested leaf and keeps its siblings", () => {
    const result = stripKeysAtPaths({ a: { b: 1, c: 2 } }, { "a.b": "h" }, () => {});

    expect(result).toEqual({ a: { c: 2 } });
  });

  test("AC-17: warns once with the removed-key message", () => {
    const captured: string[] = [];

    stripKeysAtPaths({ a: { b: 1, c: 2 } }, { "a.b": "h" }, (msg) => captured.push(msg));

    expect(captured).toEqual(['Config key "a.b" has been removed — h. Remove it from your config.']);
  });

  test("AC-18: never mutates its input", () => {
    const input = { a: { b: 1, c: 2 } };

    stripKeysAtPaths(input, { "a.b": "h" }, () => {});

    expect(input.a.b).toBe(1);
  });

  test("AC-19: tolerates a non-object intermediate and returns the config unchanged", () => {
    const result = stripKeysAtPaths({ a: 42 }, { "a.b": "h" }, () => {});

    expect(result).toEqual({ a: 42 });
  });

  test("AC-20: does not warn when the walk cannot reach the leaf", () => {
    const captured: string[] = [];

    stripKeysAtPaths({ a: 42 }, { "a.b": "h" }, (msg) => captured.push(msg));

    expect(captured).toEqual([]);
  });

  test("returns a new top-level object even when no key matched", () => {
    const input = { a: { c: 2 } };

    const result = stripKeysAtPaths(input, { "a.b": "h" }, () => {});

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  test("stripRemovedConfigKeys strips every removed key it is given, warning once each", () => {
    const conf: Record<string, unknown> = {
      execution: {
        rectification: { enabled: true, maxAttemptsTotal: 9 },
        mutationCheck: { enabled: true },
        flakeDetection: { enabled: true },
        commandInterceptor: { enabled: true, provider: "rtk" },
      },
    };

    const captured: string[] = [];
    const result = stripRemovedConfigKeys(conf, (msg) => captured.push(msg));

    expect(captured).toHaveLength(4);
    expect(result).toEqual({
      execution: { rectification: { maxAttemptsTotal: 9 }, commandInterceptor: { enabled: true } },
    });
  });

  test("US-003: strips the whole acceptance section with one warning, leaving no acceptance property", () => {
    const captured: string[] = [];

    const result = stripRemovedConfigKeys(
      { acceptance: { enabled: true, model: "fast", fix: { fixModel: "balanced" } }, tdd: { strategy: "auto" } },
      (msg) => captured.push(msg),
    );

    expect(captured).toEqual([removalWarning("acceptance", PIPELINE_ONLY_KEY_HINT)]);
    expect(Object.hasOwn(result, "acceptance")).toBe(false);
    expect(result.tdd).toEqual({ strategy: "auto" });
  });

  test("REMOVED_CONFIG_KEYS covers eleven rectification leaves, three sections, the provider and US-003's two keys", () => {
    expect(Object.keys(REMOVED_CONFIG_KEYS).sort()).toEqual(
      [
        "acceptance",
        "execution.commandInterceptor.provider",
        "execution.flakeDetection",
        "execution.mutationCheck",
        "execution.rectification.abortOnIncreasingFailures",
        "execution.rectification.abortOnNoProgress",
        "execution.rectification.consecutiveIncreasesToBail",
        "execution.rectification.consecutiveNoProgressToBail",
        "execution.rectification.enabled",
        "execution.rectification.maxAttemptsPerStrategy",
        "execution.rectification.maxFailureSummaryChars",
        "execution.rectification.repoScopedFallback",
        "execution.rectification.rethinkAtAttempt",
        "execution.rectification.storyScopedFixBudget",
        "execution.rectification.urgencyAtAttempt",
        "execution.regressionGate.mode",
        "execution.verificationTimeoutSeconds",
      ].sort(),
    );
  });

  test("the sections carry the pipeline-only hint and the two special keys their own hints", () => {
    expect(REMOVED_CONFIG_KEYS.acceptance).toBe(PIPELINE_ONLY_KEY_HINT);
    expect(REMOVED_CONFIG_KEYS["execution.flakeDetection"]).toBe(PIPELINE_ONLY_KEY_HINT);
    expect(REMOVED_CONFIG_KEYS["execution.mutationCheck"]).toBe(PIPELINE_ONLY_KEY_HINT);
    expect(REMOVED_CONFIG_KEYS["execution.rectification.abortOnNoProgress"]).toBe(PIPELINE_ONLY_KEY_HINT);
    expect(REMOVED_CONFIG_KEYS["execution.commandInterceptor.provider"]).toBe(PROVIDER_HINT);
    expect(REMOVED_CONFIG_KEYS["execution.regressionGate.mode"]).toBe(PIPELINE_ONLY_KEY_HINT);
    expect(REMOVED_CONFIG_KEYS["execution.verificationTimeoutSeconds"]).toBe(VERIFICATION_TIMEOUT_HINT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfigForWorkdir — the per-package overlay path
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedConfigKeys via loadConfigForWorkdir — per-package overlay", () => {
  let configPath: string;

  beforeEach(async () => {
    const root = makeTempDir("nax-removed-keys-mono-");
    tempDirs.push(root);
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    configPath = join(naxDir, "config.json");
    await Bun.write(configPath, JSON.stringify({}));
    const monoDir = join(naxDir, "mono", "packages", "api");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(
      join(monoDir, "config.json"),
      JSON.stringify({
        execution: { rectification: { abortOnNoProgress: false, maxAttemptsTotal: 5 } },
      }),
    );
  });

  test("AC-27: resolves with the retained execution.rectification.maxAttemptsTotal", async () => {
    const config = await loadConfigForWorkdir(configPath, "packages/api");

    expect(config.execution.rectification.maxAttemptsTotal).toBe(5);
  });

  test("AC-28: the resolved rectification has no abortOnNoProgress property", async () => {
    const config = await loadConfigForWorkdir(configPath, "packages/api");

    expect(Object.hasOwn(config.execution.rectification, "abortOnNoProgress")).toBe(false);
  });

  test("AC-29: a logger sink records one warning naming execution.rectification.abortOnNoProgress", async () => {
    const { messages } = await captureWarnings(() => loadConfigForWorkdir(configPath, "packages/api"));

    expect(warningsFor(messages, "execution.rectification.abortOnNoProgress")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfigForWorkdir — the retained regression timeout (US-003 AC-8)
//
// A separate fixture from the block above so the assertion is about the live
// per-package overlay path, not about the rectification strip happening to
// leave the rest of `execution` intact.
// ─────────────────────────────────────────────────────────────────────────────

describe("loadConfigForWorkdir — retained per-package execution.regressionGate.timeoutSeconds", () => {
  let configPath: string;

  beforeEach(async () => {
    const root = makeTempDir("nax-removed-keys-mono-rt-");
    tempDirs.push(root);
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    configPath = join(naxDir, "config.json");
    await Bun.write(configPath, JSON.stringify({}));
    const monoDir = join(naxDir, "mono", "packages", "api");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(
      join(monoDir, "config.json"),
      JSON.stringify({ execution: { regressionGate: { timeoutSeconds: 45 } } }),
    );
  });

  test("AC-8: resolves the package's own execution.regressionGate.timeoutSeconds", async () => {
    const config = await loadConfigForWorkdir(configPath, "packages/api");

    expect(config.execution.regressionGate.timeoutSeconds).toBe(45);
  });
});
