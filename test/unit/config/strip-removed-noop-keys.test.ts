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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stripRemovedNoOpKeys } from "../../../src/config/config-guards";
import { _clearRootConfigCache, loadConfig, loadConfigForWorkdir } from "../../../src/config/loader";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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
    const result = stripRemovedNoOpKeys(
      { tdd: { autoVerifyIsolation: false, maxRetries: 5 } },
      () => {},
    );

    const tdd = result.tdd as Record<string, unknown>;
    expect(tdd.maxRetries).toBe(5);
    expect(tdd.autoVerifyIsolation).toBeUndefined();
  });

  test("AC-5: retains other acceptance fields when stripping acceptance.generateTests", () => {
    const result = stripRemovedNoOpKeys(
      { acceptance: { generateTests: false, enabled: true } },
      () => {},
    );

    const acceptance = result.acceptance as Record<string, unknown>;
    expect(acceptance.enabled).toBe(true);
    expect(acceptance.generateTests).toBeUndefined();
  });

  test("AC-6: retains other execution.rectification fields when stripping execution.rectification.escalateOnExhaustion", () => {
    const result = stripRemovedNoOpKeys(
      { execution: { rectification: { escalateOnExhaustion: false, abortOnNoProgress: true } } },
      () => {},
    );

    const rectification = ((result.execution as Record<string, unknown>).rectification as Record<string, unknown>) ?? {};
    expect(rectification.abortOnNoProgress).toBe(true);
    expect(rectification.escalateOnExhaustion).toBeUndefined();
  });

  test("AC-7: handles a config with no tdd property without warning or throwing", () => {
    const captured: string[] = [];
    const input = { execution: {} };
    let result: Record<string, unknown>;
    expect(() => {
      result = stripRemovedNoOpKeys(input, (msg) => captured.push(msg));
    }).not.toThrow();
    expect(captured.length).toBe(0);
    expect(result!).toEqual(input);
  });

  test("AC-8: handles a tdd property of unexpected shape (number) without warning or throwing", () => {
    const captured: string[] = [];
    const input = { tdd: 42 };
    let result: Record<string, unknown>;
    expect(() => {
      result = stripRemovedNoOpKeys(input, (msg) => captured.push(msg));
    }).not.toThrow();
    expect(captured.length).toBe(0);
    expect((result!.tdd as unknown) === 42).toBe(true);
  });

  test("AC-9: warns and strips when tdd.autoVerifyIsolation is a string", () => {
    const captured: string[] = [];
    const result = stripRemovedNoOpKeys(
      { tdd: { autoVerifyIsolation: "yes" } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("tdd.autoVerifyIsolation");
    expect((result.tdd as Record<string, unknown>).autoVerifyIsolation).toBeUndefined();
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
