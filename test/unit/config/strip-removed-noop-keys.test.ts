// test/unit/config/strip-removed-noop-keys.test.ts
//
// Tests for stripRemovedNoOpKeys (US-005c: no-op config key removal).
//
// Four config keys were declared but never read at any code site:
//   - execution.rectification.escalateOnExhaustion
//   - tdd.autoVerifyIsolation
//   - tdd.autoApproveVerifier
//   - acceptance.generateTests
//
// Setting any of them to false was a silent no-op (the behaviour ran anyway).
// The previous behaviour was to silently strip them, which let the user keep
// believing their override was in effect. The fix: warn once per removed key
// (one warning per resolved config, regardless of which layer supplied the
// key) and strip them from the loaded config.
//
// Unlike the throwing `reject*` siblings in config-guards.ts, this guard
// warns rather than throws — the keys are inert, not behaviour-changing, so
// we prefer the gentler mechanism. See the function's doc comment for the
// rationale and the divergence from its `reject*` siblings.

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { stripRemovedNoOpKeys } from "@/config/config-guards";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _clearRootConfigCache, loadConfig, loadConfigForWorkdir } from "@/config/loader";
import { NaxConfigSchema } from "@/config/schemas";
import { addSink, initLogger, resetLogger } from "@/logger";

const tempDirs: string[] = [];

async function writeProjectConfig(contents: object, projectRoot?: string): Promise<string> {
  const root = projectRoot ?? makeTempDir("nax-noop-");
  tempDirs.push(root);
  const naxDir = join(root, ".nax");
  await mkdir(naxDir, { recursive: true });
  await Bun.write(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// stripRemovedNoOpKeys — direct unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedNoOpKeys — direct unit", () => {
  test("AC-1: warns exactly four times when all four removed paths are present", () => {
    const captured: string[] = [];
    stripRemovedNoOpKeys(
      {
        execution: { rectification: { escalateOnExhaustion: false } },
        tdd: { autoVerifyIsolation: false, autoApproveVerifier: false },
        acceptance: { generateTests: false },
      },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(4);
    expect(captured.some((m) => m.includes("execution.rectification.escalateOnExhaustion"))).toBe(true);
    expect(captured.some((m) => m.includes("tdd.autoVerifyIsolation"))).toBe(true);
    expect(captured.some((m) => m.includes("tdd.autoApproveVerifier"))).toBe(true);
    expect(captured.some((m) => m.includes("acceptance.generateTests"))).toBe(true);
  });

  test("AC-2: strips tdd.autoVerifyIsolation without mutating the input", () => {
    const input: { tdd: Record<string, unknown> } = { tdd: { autoVerifyIsolation: false, maxRetries: 3 } };
    const result = stripRemovedNoOpKeys(input, () => {});

    expect((result.tdd as Record<string, unknown>).autoVerifyIsolation).toBeUndefined();
    expect(input.tdd.autoVerifyIsolation).toBe(false);
  });

  test("AC-3: returns a deeply-equal value and is silent when no removed paths are present", () => {
    const captured: string[] = [];
    const input = {
      tdd: { maxRetries: 3 },
      acceptance: { enabled: true },
      execution: { rectification: { abortOnNoProgress: true } },
    };
    const result = stripRemovedNoOpKeys(input, (msg) => captured.push(msg));

    expect(captured.length).toBe(0);
    expect(result).toEqual(input);
    // The function must not mutate its input even when no work is done
    expect(result).not.toBe(input);
  });

  test("AC-4: retains other tdd fields when stripping tdd.autoVerifyIsolation", () => {
    const result = stripRemovedNoOpKeys({ tdd: { autoVerifyIsolation: false, maxRetries: 5 } }, () => {});

    const tdd = result.tdd as Record<string, unknown>;
    expect(tdd.maxRetries).toBe(5);
    expect(tdd.autoVerifyIsolation).toBeUndefined();
  });

  test("AC-5: retains other acceptance fields when stripping acceptance.generateTests", () => {
    const result = stripRemovedNoOpKeys({ acceptance: { generateTests: false, enabled: true } }, () => {});

    const acceptance = result.acceptance as Record<string, unknown>;
    expect(acceptance.enabled).toBe(true);
    expect(acceptance.generateTests).toBeUndefined();
  });

  test("AC-6: retains other execution.rectification fields when stripping execution.rectification.escalateOnExhaustion", () => {
    const result = stripRemovedNoOpKeys(
      { execution: { rectification: { escalateOnExhaustion: false, abortOnNoProgress: true } } },
      () => {},
    );

    const rectification =
      ((result.execution as Record<string, unknown>).rectification as Record<string, unknown>) ?? {};
    expect(rectification.abortOnNoProgress).toBe(true);
    expect(rectification.escalateOnExhaustion).toBeUndefined();
  });

  test("AC-7: handles a config with no tdd property without warning or throwing", () => {
    const captured: string[] = [];
    const input = { execution: {} };
    let result: Record<string, unknown> | undefined;
    expect(() => {
      result = stripRemovedNoOpKeys(input, (msg) => captured.push(msg));
    }).not.toThrow();
    assertDefined(result, "result");
    expect(captured.length).toBe(0);
    expect(result).toEqual(input);
  });

  test("AC-8: handles a tdd property of unexpected shape (number) without warning or throwing", () => {
    const captured: string[] = [];
    const input = { tdd: 42 };
    let result: Record<string, unknown> | undefined;
    expect(() => {
      result = stripRemovedNoOpKeys(input, (msg) => captured.push(msg));
    }).not.toThrow();
    assertDefined(result, "result");
    expect(captured.length).toBe(0);
    expect((result.tdd as unknown) === 42).toBe(true);
  });

  test("AC-9: warns and strips when tdd.autoVerifyIsolation is a string", () => {
    const captured: string[] = [];
    const result = stripRemovedNoOpKeys({ tdd: { autoVerifyIsolation: "yes" } }, (msg) => captured.push(msg));

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("tdd.autoVerifyIsolation");
    expect((result.tdd as Record<string, unknown>).autoVerifyIsolation).toBeUndefined();
  });

  test("debate.stages.review is stripped with a warning (#1859)", async () => {
    const warnings: string[] = [];
    const stripped = stripRemovedNoOpKeys({ debate: { enabled: true, stages: { review: { enabled: true } } } }, (msg) =>
      warnings.push(msg),
    );

    // The whole `debate` block is gone — the retired subsystem is stripped as
    // one key, subsuming the old per-key `debate.stages.review` strip.
    expect(stripped).not.toHaveProperty("debate");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("debate");
  });

  it("strips a retired top-level debate block and warns once", () => {
    const warnings: string[] = [];
    const out = stripRemovedNoOpKeys({ debate: { enabled: true, agents: 3 }, plan: { outputPath: "prd.json" } }, (m) =>
      warnings.push(m),
    );
    expect(out).not.toHaveProperty("debate");
    expect(out).toHaveProperty("plan");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("debate");
  });

  it("strips the retired pipeline-only plan keys", () => {
    const warnings: string[] = [];
    const out = stripRemovedNoOpKeys(
      { plan: { outputPath: "prd.json", citationThreshold: 0.7, criticModel: "fast" } },
      (m) => warnings.push(m),
    ) as { plan: Record<string, unknown> };
    expect(out.plan).not.toHaveProperty("citationThreshold");
    expect(out.plan).not.toHaveProperty("criticModel");
    expect(out.plan).toHaveProperty("outputPath");
    expect(warnings).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — retire review.gateLLMChecksOnMechanicalPass (#2174)
//
// The key was declared in the schema, carried in DEFAULT_CONFIG and documented
// in the CLI, but read at no code site — setting it to `false` never gated
// anything. It is retired through the same warn-and-strip path as the keys
// above, so an existing config that still sets it keeps loading.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedNoOpKeys — review.gateLLMChecksOnMechanicalPass (US-001)", () => {
  test("AC-1: strips the key from the returned review", () => {
    const result = stripRemovedNoOpKeys({ review: { gateLLMChecksOnMechanicalPass: false, enabled: true } }, () => {});
    expect(result.review).toBeDefined();
    expect(result.review).not.toHaveProperty("gateLLMChecksOnMechanicalPass");
  });

  test("AC-2: retains the sibling review.enabled key", () => {
    const result = stripRemovedNoOpKeys({ review: { gateLLMChecksOnMechanicalPass: false, enabled: true } }, () => {});
    expect(result.review).toMatchObject({ enabled: true });
  });

  test("AC-3: warns exactly once naming the key and its removal", () => {
    const captured: string[] = [];
    stripRemovedNoOpKeys({ review: { gateLLMChecksOnMechanicalPass: false } }, (msg) => captured.push(msg));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("review.gateLLMChecksOnMechanicalPass");
    expect(captured[0]).toContain("has been removed");
  });

  test("AC-4: does not mutate the input review", () => {
    const input = { review: { gateLLMChecksOnMechanicalPass: false } };
    stripRemovedNoOpKeys(input, () => {});
    expect(input.review.gateLLMChecksOnMechanicalPass).toBe(false);
  });

  test("AC-5: NaxConfigSchema.parse yields a review without the retired key", () => {
    // `ReviewConfigSchema` requires `enabled` + `checks`, so the review block is
    // seeded from the schema's own default (which must also drop the key).
    const parsed = NaxConfigSchema.parse({ review: { ...DEFAULT_CONFIG.review } });
    expect(parsed.review).toBeDefined();
    expect("gateLLMChecksOnMechanicalPass" in parsed.review).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig integration — the guard runs at both root-chain and per-package sites
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedNoOpKeys via loadConfig — end-to-end", () => {
  beforeEach(() => {
    _clearRootConfigCache();
    tempDirs.splice(0, tempDirs.length);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  test("AC-10: loadConfig strips tdd.autoVerifyIsolation from project config", async () => {
    const root = await writeProjectConfig({ tdd: { autoVerifyIsolation: false } });
    const config = await loadConfig(root);
    expect("autoVerifyIsolation" in config.tdd).toBe(false);
  });

  test("AC-11: loadConfig strips acceptance.generateTests from global config", async () => {
    // Set only the global config; isolate it from any test env
    const globalDir = makeTempDir("nax-noop-global-");
    tempDirs.push(globalDir);
    const orig = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    await mkdir(join(globalDir, "config.json").replace(/\/config\.json$/, ""), { recursive: true });
    await Bun.write(join(globalDir, "config.json"), JSON.stringify({ acceptance: { generateTests: false } }));
    try {
      // Use a fresh project root with no .nax so only the global layer applies
      const root = makeTempDir("nax-noop-proj-");
      tempDirs.push(root);
      const config = await loadConfig(root);
      expect("generateTests" in config.acceptance).toBe(false);
    } finally {
      if (orig === undefined) {
        delete process.env.NAX_GLOBAL_CONFIG_DIR;
      } else {
        process.env.NAX_GLOBAL_CONFIG_DIR = orig;
      }
    }
  });

  test("AC-12: loadConfig strips execution.rectification.escalateOnExhaustion set in both global and project", async () => {
    const globalDir = makeTempDir("nax-noop-global-");
    tempDirs.push(globalDir);
    const orig = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    await mkdir(join(globalDir, "config.json").replace(/\/config\.json$/, ""), { recursive: true });
    await Bun.write(
      join(globalDir, "config.json"),
      JSON.stringify({ execution: { rectification: { escalateOnExhaustion: false } } }),
    );
    try {
      const root = await writeProjectConfig({
        execution: { rectification: { escalateOnExhaustion: false } },
      });
      const config = await loadConfig(root);
      expect("escalateOnExhaustion" in config.execution.rectification).toBe(false);
    } finally {
      if (orig === undefined) {
        delete process.env.NAX_GLOBAL_CONFIG_DIR;
      } else {
        process.env.NAX_GLOBAL_CONFIG_DIR = orig;
      }
    }
  });

  test("AC-13: loadConfigForWorkdir strips tdd.autoApproveVerifier from per-package overlay", async () => {
    const root = makeTempDir("nax-noop-mono-");
    tempDirs.push(root);
    // .nax/config.json (root) + .nax/mono/<pkg>/config.json (per-package overlay)
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    await Bun.write(join(naxDir, "config.json"), JSON.stringify({}));
    const monoDir = join(naxDir, "mono", "packages", "api");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(join(monoDir, "config.json"), JSON.stringify({ tdd: { autoApproveVerifier: false } }));

    const config = await loadConfigForWorkdir(join(naxDir, "config.json"), "packages/api");
    expect("autoApproveVerifier" in config.tdd).toBe(false);
  });

  // AC-13b: tdd is a root-only field, so the per-package overlay above does
  // not actually exercise the strip call — the override is silently dropped
  // by mergePackageConfig. The mergeable-field companion test below covers the
  // case where a per-package overlay can actually contribute a no-op key to
  // the merged result, which is when the strip has something to do.
  test("AC-13b: loadConfigForWorkdir strips acceptance.generateTests from a per-package overlay on a mergeable field", async () => {
    const root = makeTempDir("nax-noop-mono-mergeable-");
    tempDirs.push(root);
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    await Bun.write(join(naxDir, "config.json"), JSON.stringify({}));
    const monoDir = join(naxDir, "mono", "packages", "api");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(join(monoDir, "config.json"), JSON.stringify({ acceptance: { generateTests: false } }));

    const config = await loadConfigForWorkdir(join(naxDir, "config.json"), "packages/api");
    expect("generateTests" in config.acceptance).toBe(false);
  });

  test("AC-6: loadConfig warn-and-strips review.gateLLMChecksOnMechanicalPass from a project config", async () => {
    const root = await writeProjectConfig({ review: { gateLLMChecksOnMechanicalPass: true } });
    const config = await loadConfig(root);
    expect(config.review).toBeDefined();
    expect("gateLLMChecksOnMechanicalPass" in config.review).toBe(false);
  });

  test("AC-13c: loadConfigForWorkdir strips execution.rectification.escalateOnExhaustion from a per-package overlay on a mergeable field", async () => {
    const root = makeTempDir("nax-noop-mono-rect-");
    tempDirs.push(root);
    const naxDir = join(root, ".nax");
    await mkdir(naxDir, { recursive: true });
    await Bun.write(join(naxDir, "config.json"), JSON.stringify({}));
    const monoDir = join(naxDir, "mono", "packages", "api");
    await mkdir(monoDir, { recursive: true });
    await Bun.write(
      join(monoDir, "config.json"),
      JSON.stringify({ execution: { rectification: { escalateOnExhaustion: false } } }),
    );

    const config = await loadConfigForWorkdir(join(naxDir, "config.json"), "packages/api");
    expect("escalateOnExhaustion" in config.execution.rectification).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema and FIELD_DESCRIPTIONS: the four keys are gone from the schema and
// from the CLI description table.
// ─────────────────────────────────────────────────────────────────────────────

describe("NaxConfigSchema and FIELD_DESCRIPTIONS — removed keys", () => {
  test("AC-14: NaxConfigSchema parses {} without an execution.rectification.escalateOnExhaustion property", () => {
    const parsed = NaxConfigSchema.parse({});
    const rect = parsed.execution.rectification as Record<string, unknown>;
    expect("escalateOnExhaustion" in rect).toBe(false);
  });

  test("AC-15: NaxConfigSchema parses {} without a tdd.autoVerifyIsolation property", () => {
    const parsed = NaxConfigSchema.parse({});
    const tdd = parsed.tdd as Record<string, unknown>;
    expect("autoVerifyIsolation" in tdd).toBe(false);
  });

  test("AC-16: NaxConfigSchema parses {} without a tdd.autoApproveVerifier property", () => {
    const parsed = NaxConfigSchema.parse({});
    const tdd = parsed.tdd as Record<string, unknown>;
    expect("autoApproveVerifier" in tdd).toBe(false);
  });

  test("AC-17: NaxConfigSchema parses {} without an acceptance.generateTests property", () => {
    const parsed = NaxConfigSchema.parse({});
    const acceptance = parsed.acceptance as Record<string, unknown>;
    expect("generateTests" in acceptance).toBe(false);
  });

  test("AC-18: FIELD_DESCRIPTIONS has no execution.rectification.escalateOnExhaustion entry", () => {
    expect(FIELD_DESCRIPTIONS["execution.rectification.escalateOnExhaustion"]).toBeUndefined();
  });

  test("AC-19: FIELD_DESCRIPTIONS has no tdd.autoVerifyIsolation entry", () => {
    expect(FIELD_DESCRIPTIONS["tdd.autoVerifyIsolation"]).toBeUndefined();
  });

  test("AC-20: FIELD_DESCRIPTIONS has no tdd.autoApproveVerifier entry", () => {
    expect(FIELD_DESCRIPTIONS["tdd.autoApproveVerifier"]).toBeUndefined();
  });

  test("AC-21: FIELD_DESCRIPTIONS has no acceptance.generateTests entry", () => {
    expect(FIELD_DESCRIPTIONS["acceptance.generateTests"]).toBeUndefined();
  });

  test("AC-22: FIELD_DESCRIPTIONS has a non-empty acceptance.enabled entry (the surviving control)", () => {
    const entry = FIELD_DESCRIPTIONS["acceptance.enabled"];
    expect(typeof entry).toBe("string");
    expect(entry.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — retire quality.autofix.enforceTestWriterIsolation (#2248)
//
// The key gated a guard on the old autofix-cycle stage; #1084 deleted that
// stage, the guard and its tests, leaving the key declared in the schema, the
// defaults and the runtime type while it gated nothing. It is retired through
// the same warn-and-strip path as the keys above, so an existing config that
// still sets it keeps loading.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripRemovedNoOpKeys — quality.autofix.enforceTestWriterIsolation (US-003)", () => {
  test("AC-1: warns exactly once naming the key and #1084 when the key is false", () => {
    const captured: string[] = [];

    stripRemovedNoOpKeys({ quality: { autofix: { enforceTestWriterIsolation: false } } }, (msg) => captured.push(msg));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("quality.autofix.enforceTestWriterIsolation");
    expect(captured[0]).toContain("#1084");
  });

  test("AC-2: warns exactly once naming the key when the key is true", () => {
    const captured: string[] = [];

    stripRemovedNoOpKeys({ quality: { autofix: { enforceTestWriterIsolation: true } } }, (msg) => captured.push(msg));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("quality.autofix.enforceTestWriterIsolation");
  });

  test("AC-3: returns quality.autofix equal to { enabled: false, maxAttempts: 2 }, dropping only the retired key", () => {
    const stripped = stripRemovedNoOpKeys(
      { quality: { autofix: { enabled: false, maxAttempts: 2, enforceTestWriterIsolation: false } } },
      () => {},
    );

    expect(stripped.quality).toEqual({ autofix: { enabled: false, maxAttempts: 2 } });
  });

  test("AC-4: NaxConfigSchema.parse({}) yields a quality.autofix without the retired key", () => {
    const autofix = NaxConfigSchema.parse({}).quality.autofix;

    expect(autofix).toBeDefined();
    expect(Object.hasOwn(autofix, "enforceTestWriterIsolation")).toBe(false);
    expect(autofix.enabled).toBe(true);
  });

  test("AC-5: loadConfig on a project setting the retired key resolves and warns once naming it", async () => {
    _clearRootConfigCache();
    const root = await writeProjectConfig({ quality: { autofix: { enforceTestWriterIsolation: false } } });

    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
    try {
      config = await loadConfig(root);
    } finally {
      removeSink();
      resetLogger();
      cleanupTempDir(root);
    }

    assertDefined(config, "loadConfig result");
    const autofix = config.quality.autofix;
    assertDefined(autofix, "config.quality.autofix");
    expect(Object.hasOwn(autofix, "enforceTestWriterIsolation")).toBe(false);
    const relevant = captured.filter((msg) => msg.includes("quality.autofix.enforceTestWriterIsolation"));
    expect(relevant).toHaveLength(1);
  });
});
