// test/unit/config/removed-config-keys-unread.test.ts
//
// C1 wave B3c-3 — the last config keys nothing reads, as entries in
// `REMOVED_CONFIG_KEYS`: the dead tdd, autoMode and quality keys, the optimizer
// section and prompt overrides, and the keys that were unread even before C1.
//
// Split out of removed-config-keys.test.ts, which would otherwise pass the
// 800-line test-file cap: the mechanism stays there, these key groups live here.
//
// "Warns" means the loader warning reaches a logger sink registered with
// `addSink`; `loadConfig` takes no warn parameter.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig, loadConfigForWorkdir } from "@/config/loader";
import { NaxError } from "@/errors";
import { addSink, initLogger, resetLogger } from "@/logger";

const tempDirs: string[] = [];

/** `PIPELINE_ONLY_KEY_HINT` in removed-config-keys.ts, spelled out so the warning text is pinned. */
const PIPELINE_ONLY_HINT = "nothing reads this key since pipeline mode was removed";

/** The warning `stripKeysAtPaths` emits for one removed path. */
function removalWarning(path: string, hint: string): string {
  return `Config key "${path}" has been removed — ${hint}. Remove it from your config.`;
}

/** Write a project `.nax/config.json` and return the project root. */
async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-removed-unread-");
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

/** The value at a dotted path, or undefined when any segment is missing. */
function getAtPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const segment of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Reflect.get(cur, segment);
  }
  return cur;
}

/** Build `{ a: { b: value } }` from `"a.b"`. */
function rawAtPath(dotted: string, value: unknown): Record<string, unknown> {
  const segments = dotted.split(".");
  let built: Record<string, unknown> = { [segments[segments.length - 1]]: value };
  for (const segment of segments.slice(0, -1).reverse()) {
    built = { [segment]: built };
  }
  return built;
}

beforeEach(() => {
  _clearRootConfigCache();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupTempDir(dir);
  }
});

/** Assert that loading `raw` warns exactly once for `path` and drops it. */
async function expectStripped(path: string, raw: Record<string, unknown>, hint: string): Promise<void> {
  const root = await writeProjectConfig(raw);
  const { result, messages } = await captureWarnings(() => loadConfig(root));
  expect(warningsFor(removedKeyWarnings(messages), path)).toEqual([removalWarning(path, hint)]);
  expect(getAtPath(result, path)).toBeUndefined();
}

// ─────────────────────────────────────────────────────────────────────────────
// tdd, autoMode and quality keys (Task 1)
// ─────────────────────────────────────────────────────────────────────────────

const FIX_COMMAND = "bun x";

const TDD_AUTOMODE_QUALITY_KEYS: ReadonlyArray<readonly [string, unknown]> = [
  ["tdd.maxRetries", 3],
  ["tdd.verifierTimeoutSeconds", 900],
  ["tdd.testWriterAllowedPaths", ["src/x.ts"]],
  ["tdd.testWriterCommitHooks", "run"],
  ["tdd.rollbackOnFailure", false],
  ["tdd.sessionTiers", { testWriter: "fast" }],
  ["autoMode.enabled", true],
  ["quality.commands.lintFix", FIX_COMMAND],
  ["quality.commands.lintFixScoped", FIX_COMMAND],
  ["quality.commands.formatFix", FIX_COMMAND],
  ["quality.commands.formatFixScoped", FIX_COMMAND],
  ["review.commands.lintFix", FIX_COMMAND],
  ["review.commands.lintFixScoped", FIX_COMMAND],
  ["review.commands.formatFix", FIX_COMMAND],
  ["review.commands.formatFixScoped", FIX_COMMAND],
  ["quality.typecheckOutput", { format: "tsc" }],
  ["quality.autofix", { enabled: true }],
];

describe("removed tdd, autoMode and quality keys", () => {
  test.each(TDD_AUTOMODE_QUALITY_KEYS)("%s loads, warns once and is dropped", async (path, value) => {
    await expectStripped(path, rawAtPath(path, value), PIPELINE_ONLY_HINT);
  });

  test("loading an empty project config emits no removed-key warning", async () => {
    const root = await writeProjectConfig({});
    const { messages } = await captureWarnings(() => loadConfig(root));
    expect(removedKeyWarnings(messages)).toEqual([]);
  });

  test("quality.autofix.enforceTestWriterIsolation alone warns once, for the section", async () => {
    const root = await writeProjectConfig({ quality: { autofix: { enforceTestWriterIsolation: true } } });
    const { messages } = await captureWarnings(() => loadConfig(root));
    expect(removedKeyWarnings(messages)).toEqual([removalWarning("quality.autofix", PIPELINE_ONLY_HINT)]);
  });

  test("kept tdd and quality siblings survive", async () => {
    const root = await writeProjectConfig({
      tdd: { strategy: "lite", greenfieldDetection: true, maxRetries: 3 },
      quality: { commands: { test: "bun run test", lintFix: "x" } },
    });
    const config = await loadConfig(root);
    expect(config.tdd.strategy).toBe("lite");
    expect(config.tdd.greenfieldDetection).toBe(true);
    expect(config.quality.commands.test).toBe("bun run test");
  });

  test("quality.autofix.maxTotalAttempts is still rejected", async () => {
    const root = await writeProjectConfig({ quality: { autofix: { maxTotalAttempts: 4 } } });
    const error = await loadConfig(root).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "CONFIG_LEGACY_RECTIFICATION_KEYS" });
  });

  test("a package overlay's removed quality key is stripped with a warning", async () => {
    const root = await writeProjectConfig({});
    const monoDir = join(root, ".nax", "mono", "packages", "app");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(join(monoDir, "config.json"), JSON.stringify({ quality: { commands: { lintFix: "x" } } }));

    const configPath = join(root, ".nax", "config.json");
    const { result, messages } = await captureWarnings(() => loadConfigForWorkdir(configPath, "packages/app"));

    expect(warningsFor(removedKeyWarnings(messages), "quality.commands.lintFix")).toHaveLength(1);
    expect(getAtPath(result, "quality.commands.lintFix")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// optimizer and prompt overrides (Task 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("removed optimizer section and prompt overrides", () => {
  test.each([
    ["optimizer.enabled", { optimizer: { enabled: true } }],
    ["optimizer.strategy", { optimizer: { strategy: "noop" } }],
    ["optimizer.strategies", { optimizer: { strategies: {} } }],
  ])("a config setting %s warns once, for the optimizer section", async (_label, raw) => {
    const root = await writeProjectConfig(raw);
    const { result, messages } = await captureWarnings(() => loadConfig(root));
    expect(removedKeyWarnings(messages)).toEqual([removalWarning("optimizer", PIPELINE_ONLY_HINT)]);
    expect(messages.filter((msg) => msg.startsWith("optimizer."))).toEqual([]);
    expect(getAtPath(result, "optimizer")).toBeUndefined();
  });

  test("prompts.overrides loads, warns once and is dropped", async () => {
    await expectStripped("prompts.overrides", { prompts: { overrides: { implementer: "p.md" } } }, PIPELINE_ONLY_HINT);
  });

  test("prompts.overrides.single-session alone warns once, for prompts.overrides", async () => {
    const root = await writeProjectConfig({ prompts: { overrides: { "single-session": "a.md" } } });
    const { messages } = await captureWarnings(() => loadConfig(root));
    expect(removedKeyWarnings(messages)).toEqual([removalWarning("prompts.overrides", PIPELINE_ONLY_HINT)]);
  });

  test("prompts.behavioralGuardrails warns independently of overrides", async () => {
    const root = await writeProjectConfig({
      prompts: { behavioralGuardrails: "strict", overrides: { implementer: "p.md" } },
    });
    const { messages } = await captureWarnings(() => loadConfig(root));
    expect(warningsFor(messages, "prompts.behavioralGuardrails")).toEqual([
      removalWarning("prompts.behavioralGuardrails", PIPELINE_ONLY_HINT),
    ]);
  });

  test("an unknown override role no longer fails validation", async () => {
    const root = await writeProjectConfig({ prompts: { overrides: { bogus: "p.md" } } });
    const { messages } = await captureWarnings(() => loadConfig(root));
    expect(removedKeyWarnings(messages)).toEqual([removalWarning("prompts.overrides", PIPELINE_ONLY_HINT)]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// keys unread before C1 (Task 3)
// ─────────────────────────────────────────────────────────────────────────────

const NEVER_READ_HINT = "nothing reads this key";
const HOOKS_SECTION_HINT = "nothing reads this key; lifecycle hooks are read from .nax/hooks.json";

describe("removed keys unread before C1", () => {
  test.each([
    ["plan.outputPath", "out/prd.json"],
    ["routing.llm.timeoutMs", 5000],
    ["routing.agents.strategy", "llm"],
  ] as const)("%s loads, warns once and is dropped", async (path, value) => {
    await expectStripped(path, rawAtPath(path, value), NEVER_READ_HINT);
  });

  test("hooks loads, warns once and is dropped", async () => {
    await expectStripped("hooks", { hooks: { skipGlobal: true, hooks: {} } }, HOOKS_SECTION_HINT);
  });

  test("routing.agents.strategy llm with no profiles no longer fails validation", async () => {
    const root = await writeProjectConfig({ routing: { agents: { strategy: "llm", profiles: [] } } });
    const config = await loadConfig(root);
    expect(config.routing.agents?.profiles).toEqual([]);
  });

  test("routing.llm.batchMode still maps to mode with its deprecation warning", async () => {
    const root = await writeProjectConfig({ routing: { llm: { batchMode: true } } });
    const { result, messages } = await captureWarnings(() => loadConfig(root));
    const llm = result.routing.llm ?? {};
    expect(llm.mode).toBe("one-shot");
    expect("batchMode" in llm).toBe(false);
    expect(messages.filter((msg) => msg.includes("routing.llm.batchMode is deprecated"))).toHaveLength(1);
    expect(removedKeyWarnings(messages)).toEqual([]);
  });

  test("batchMode beside mode is dropped silently", async () => {
    const root = await writeProjectConfig({ routing: { llm: { batchMode: true, mode: "per-story" } } });
    const { result, messages } = await captureWarnings(() => loadConfig(root));
    const llm = result.routing.llm ?? {};
    expect(llm.mode).toBe("per-story");
    expect("batchMode" in llm).toBe(false);
    expect(messages.filter((msg) => msg.includes("batchMode"))).toEqual([]);
  });

  test("routing.llm.mode and routing.strategy survive", async () => {
    const root = await writeProjectConfig({ routing: { strategy: "llm", llm: { mode: "hybrid", timeoutMs: 10 } } });
    const config = await loadConfig(root);
    expect(config.routing.strategy).toBe("llm");
    expect(config.routing.llm?.mode).toBe("hybrid");
  });
});
