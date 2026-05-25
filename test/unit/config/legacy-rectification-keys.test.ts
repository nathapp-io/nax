// test/unit/config/legacy-rectification-keys.test.ts
//
// Regression guard for the rectification-config consolidation: loading a
// pre-migration config with any of the five legacy keys must throw with a
// clear migration message.
//
// Without this guard, Zod's default .strip() mode silently drops the unknown
// keys and the run continues with the new defaults — re-introducing the exact
// silent-no-op failure mode (cycle exits on first regression because the
// user's `maxTotalAttempts: 12` override never reached the cycle).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../../../src/errors";
import { _clearRootConfigCache, loadConfig } from "../../../src/config/loader";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(e.message).toContain("quality.autofix.maxTotalAttempts");
      expect(e.message).toContain("execution.rectification.maxAttemptsTotal");
    }
  });

  test("rejects quality.autofix.rethinkAtAttempt with migration pointer", async () => {
    const root = await writeProjectConfig({
      quality: { autofix: { rethinkAtAttempt: 2 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(e.message).toContain("quality.autofix.rethinkAtAttempt");
      expect(e.message).toContain("execution.rectification.rethinkAtAttempt");
    }
  });

  test("rejects quality.autofix.urgencyAtAttempt with migration pointer", async () => {
    const root = await writeProjectConfig({
      quality: { autofix: { urgencyAtAttempt: 3 } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(e.message).toContain("quality.autofix.urgencyAtAttempt");
      expect(e.message).toContain("execution.rectification.urgencyAtAttempt");
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
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(e.message).toContain("execution.rectification.maxRetries");
      expect(e.message).toContain("execution.rectification.maxAttemptsTotal");
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
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_LEGACY_RECTIFICATION_KEYS");
      expect(e.message).toContain("execution.regressionGate.maxRectificationAttempts");
      expect(e.message).toContain("execution.rectification.maxAttemptsTotal");
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
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      const ctx = e.context as { legacyKeys?: string[] } | undefined;
      expect(ctx?.legacyKeys).toEqual([
        "quality.autofix.maxTotalAttempts",
        "quality.autofix.rethinkAtAttempt",
        "quality.autofix.urgencyAtAttempt",
        "execution.rectification.maxRetries",
        "execution.regressionGate.maxRectificationAttempts",
      ]);
    }
  });

  test("accepts canonical config — execution.rectification.{maxAttemptsTotal,maxAttemptsPerStrategy}", async () => {
    const root = await writeProjectConfig({
      execution: {
        rectification: { maxAttemptsTotal: 12, maxAttemptsPerStrategy: 3 },
      },
    });
    const config = await loadConfig(root);
    expect(config.execution.rectification.maxAttemptsTotal).toBe(12);
    expect(config.execution.rectification.maxAttemptsPerStrategy).toBe(3);
  });
});
