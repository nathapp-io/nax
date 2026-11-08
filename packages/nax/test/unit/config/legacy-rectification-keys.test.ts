// test/unit/config/legacy-rectification-keys.test.ts
//
// Regression guard for the rectification-config consolidation: loading a
// pre-migration config with any of the five legacy keys must throw with a
// clear migration message. Two of the five (`rethinkAtAttempt`,
// `urgencyAtAttempt`) were removed rather than moved in C1 B3c-2, so their hint
// says to delete the key; the other three still migrate.
//
// Without this guard, Zod's default .strip() mode silently drops the unknown
// keys and the run continues with the new defaults — re-introducing the exact
// silent-no-op failure mode (cycle exits on first regression because the
// user's `maxTotalAttempts: 12` override never reached the cycle).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { rejectLegacyRectificationKeys } from "@/config/config-guards";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";

const tempDirs: string[] = [];

async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-legacy-rect-");
  tempDirs.push(root);
  const naxDir = join(root, ".nax");
  await mkdir(naxDir, { recursive: true });
  await Bun.write(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

describe("rectification-config consolidation — legacy key guard", () => {
  beforeEach(() => {
    _clearRootConfigCache();
    tempDirs.splice(0, tempDirs.length);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  test("rejects quality.autofix.maxTotalAttempts with migration pointer", async () => {
    const root = await writeProjectConfig({
      quality: { autofix: { maxTotalAttempts: 12 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(err.message).toContain("quality.autofix.maxTotalAttempts");
      expect(err.message).toContain("execution.rectification.maxAttemptsTotal");
    }
  });

  // AC-21: the config-load rejection survives for the two keys that were
  // REMOVED rather than moved — the hint now tells the user to delete the key,
  // because `execution.rectification.rethinkAtAttempt` / `.urgencyAtAttempt` do
  // not exist any more (C1 B3c-2).
  test("rejects quality.autofix.rethinkAtAttempt with a removal hint", async () => {
    const root = await writeProjectConfig({
      quality: { autofix: { rethinkAtAttempt: 2 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      // AC-23: the removal hint names the offending key after the word Remove.
      expect(err.message).toMatch(/Remove `quality\.autofix\.rethinkAtAttempt`/);
      // AC-24: the hint never points at a key that no longer exists.
      expect(err.message).not.toContain("execution.rectification.rethinkAtAttempt");
    }
  });

  test("rejects quality.autofix.urgencyAtAttempt with a removal hint", async () => {
    const root = await writeProjectConfig({
      quality: { autofix: { urgencyAtAttempt: 3 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(err.message).toMatch(/Remove `quality\.autofix\.urgencyAtAttempt`/);
      expect(err.message).not.toContain("execution.rectification.urgencyAtAttempt");
    }
  });

  test("rejects execution.rectification.maxRetries with migration pointer", async () => {
    const root = await writeProjectConfig({
      execution: { rectification: { maxRetries: 2 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(err.message).toContain("execution.rectification.maxRetries");
      expect(err.message).toContain("execution.rectification.maxAttemptsTotal");
    }
  });

  test("rejects execution.regressionGate.maxRectificationAttempts with migration pointer", async () => {
    const root = await writeProjectConfig({
      execution: { regressionGate: { maxRectificationAttempts: 3 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(err.message).toContain("execution.regressionGate.maxRectificationAttempts");
      expect(err.message).toContain("execution.rectification.maxAttemptsTotal");
    }
  });

  test("reports all five legacy keys at once", async () => {
    const root = await writeProjectConfig({
      quality: {
        autofix: { maxTotalAttempts: 12, rethinkAtAttempt: 2, urgencyAtAttempt: 3 },
      },
      execution: {
        rectification: { maxRetries: 2 },
        regressionGate: { maxRectificationAttempts: 3 },
      },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      assertNaxError(err);
      const ctx = err.context as { legacyKeys?: string[] } | undefined;
      expect(ctx?.legacyKeys).toEqual([
        "quality.autofix.maxTotalAttempts",
        "quality.autofix.rethinkAtAttempt",
        "quality.autofix.urgencyAtAttempt",
        "execution.rectification.maxRetries",
        "execution.regressionGate.maxRectificationAttempts",
      ]);
    }
  });

  test("accepts canonical config — execution.rectification.maxAttemptsTotal", async () => {
    const root = await writeProjectConfig({
      execution: {
        rectification: { maxAttemptsTotal: 12 },
      },
    });
    const config = await loadConfig(root);
    expect(config.execution.rectification.maxAttemptsTotal).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — the guard itself, on the two keys that are now removed not moved
// ─────────────────────────────────────────────────────────────────────────────

describe("rejectLegacyRectificationKeys — rethinkAtAttempt is removed, not moved (US-002)", () => {
  test("AC-22: throws a NaxError with CONFIG_LEGACY_RECTIFICATION_KEYS", () => {
    let thrown: unknown;
    try {
      rejectLegacyRectificationKeys({ quality: { autofix: { rethinkAtAttempt: 2 } } });
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown);
    expect(thrown.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
  });
});
