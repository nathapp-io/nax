// test/unit/config/non-blocking-fix-config.test.ts
//
// US-001 — non-blocking-fix config moved from `review.adversarial.nonBlockingFix`
// to a standalone `review.nonBlockingFix` with a `sources` array of reviewer
// names. These tests assert:
//   - the new standalone schema's defaults (AC1, AC2)
//   - the `sources` enum and validation (AC3, AC4)
//   - the new key's absence is an absence, not a default (AC5)
//   - the AdversarialReviewConfigSchema no longer carries nonBlockingFix (AC10)
//   - the migration shim handles legacy / canonical / mixed inputs (AC6-AC9)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
import type { ConfigWarnLogger } from "@/config/migrations";
import { migrateLegacyNonBlockingFix } from "@/config/migrations";
import { AdversarialReviewConfigSchema, NonBlockingFixConfigSchema, ReviewConfigSchema } from "@/config/schemas-review";
import { addSink, initLogger, resetLogger } from "@/logger";

type NonBlockingFixLogger = ConfigWarnLogger;

/** Walk a key path through a raw (pre-Zod) config object, yielding `undefined`
 * whenever any hop is missing — mirrors the optional-chain reads the
 * `migrateLegacyTestPattern` test suite uses, so the new shim's tests can
 * avoid per-read `as Record<string, unknown>` casts. */
function probe(root: unknown, keys: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in (current as object))) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("NonBlockingFixConfigSchema — defaults and validation (AC1, AC2)", () => {
  test("AC1: empty object resolves to the documented default shape", () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    });
  });

  test('AC2: sources defaults to ["adversarial"]', () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed.sources).toEqual(["adversarial"]);
  });

  test('AC3: sources ["adversarial", "semantic"] preserves both entries in declared order', () => {
    const parsed = NonBlockingFixConfigSchema.parse({ sources: ["adversarial", "semantic"] });
    expect(parsed.sources).toEqual(["adversarial", "semantic"]);
  });

  test("AC4: unrecognised reviewer name in sources rejects with a validation error naming sources", () => {
    let thrown: unknown = null;
    try {
      NonBlockingFixConfigSchema.parse({ sources: ["adversarial", "unknown-reviewer"] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    const message = (thrown as Error).message ?? String(thrown);
    expect(message).toContain("sources");
  });

  test("rejects an empty sources array", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ sources: [] })).toThrow();
  });

  test("scope: 'triage' parses successfully", () => {
    const parsed = NonBlockingFixConfigSchema.parse({ enabled: true, scope: "triage" });
    expect(parsed.scope).toBe("triage");
  });

  test("scope: defaults to 'both' when unset", () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed.scope).toBe("both");
  });

  test("scope: rejects values outside source|both|triage", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ scope: "invalid" })).toThrow();
  });

  test("rejects negative regressionAttempts", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ regressionAttempts: -1 })).toThrow();
  });

  test("sourceDiffCap user values are preserved verbatim", () => {
    const parsed = NonBlockingFixConfigSchema.parse({ sourceDiffCap: { maxFiles: 3, maxLines: 50 } });
    expect(parsed.sourceDiffCap).toEqual({ maxFiles: 3, maxLines: 50 });
  });

  test("sourceDiffCap rejects negative values", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ sourceDiffCap: { maxFiles: -1, maxLines: 50 } })).toThrow();
    expect(() => NonBlockingFixConfigSchema.parse({ sourceDiffCap: { maxFiles: 5, maxLines: -10 } })).toThrow();
  });
});

describe("ReviewConfigSchema — nonBlockingFix is a top-level optional field (AC5, AC10)", () => {
  test("AC5: review.nonBlockingFix omitted — resolved slice is undefined and no nbf defaults are synthesised elsewhere", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
    });
    expect(parsed.nonBlockingFix).toBeUndefined();
    // Whether the adversarial block exists (defaults) or not, it never carries nonBlockingFix.
    if (parsed.adversarial !== undefined) {
      expect(parsed.adversarial).not.toHaveProperty("nonBlockingFix");
    }
  });

  test("AC10: AdversarialReviewConfigSchema strips nonBlockingFix — the parsed adversarial block has no nonBlockingFix property", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      nonBlockingFix: { enabled: true, scope: "triage" },
    });
    expect(parsed).not.toHaveProperty("nonBlockingFix");
  });

  test("AdversarialReviewConfigSchema does not declare a nonBlockingFix field at all", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed).not.toHaveProperty("nonBlockingFix");
  });

  test("ReviewConfigSchema parses review.nonBlockingFix and exposes it as a typed slice", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
      nonBlockingFix: { enabled: true, sources: ["semantic", "adversarial"] },
    });
    expect(parsed.nonBlockingFix).toBeDefined();
    expect(parsed.nonBlockingFix?.sources).toEqual(["semantic", "adversarial"]);
  });

  test("ReviewConfigSchema: review.nonBlockingFix accepts the documented defaults when explicit", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
      nonBlockingFix: {
        enabled: false,
        scope: "both",
        regressionAttempts: 1,
        verifierGuard: true,
        sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        sources: ["adversarial"],
      },
    });
    expect(parsed.nonBlockingFix).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    });
  });
});

describe("migrateLegacyNonBlockingFix — AC6, AC7, AC8, AC9", () => {
  function captureWarnings(): { messages: string[]; fakeLogger: NonBlockingFixLogger | null } {
    const messages: string[] = [];
    const fakeLogger: NonBlockingFixLogger = {
      warn: (_stage: string, msg: string) => messages.push(msg),
    };
    return { messages, fakeLogger };
  }

  test("AC6: only legacy is supplied — canonical slice resolves to the legacy value and emits one config warning naming both keys", () => {
    const { messages, fakeLogger } = captureWarnings();
    const legacy = { enabled: true, scope: "triage", regressionAttempts: 2, verifierGuard: false };
    const raw: Record<string, unknown> = {
      review: { adversarial: { nonBlockingFix: legacy } },
    };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);

    expect(probe(result, ["review", "nonBlockingFix"])).toEqual(legacy);
    expect(probe(result, ["review", "adversarial", "nonBlockingFix"])).toBeUndefined();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("review.adversarial.nonBlockingFix");
    expect(messages[0]).toContain("review.nonBlockingFix");
  });

  test("AC7: both legacy and canonical are supplied — canonical wins, one warning names both keys, no throw", () => {
    const { messages, fakeLogger } = captureWarnings();
    const legacy = { enabled: false, scope: "source" };
    const canonical = { enabled: true, scope: "triage", sources: ["semantic"] };
    const raw: Record<string, unknown> = {
      review: {
        adversarial: { nonBlockingFix: legacy },
        nonBlockingFix: canonical,
      },
    };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);
    expect(probe(result, ["review", "nonBlockingFix"])).toEqual(canonical);
    expect(probe(result, ["review", "adversarial", "nonBlockingFix"])).toBeUndefined();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("review.adversarial.nonBlockingFix");
    expect(messages[0]).toContain("review.nonBlockingFix");
  });

  test("AC7 (no-throw): calling the migration with both keys present does not throw", () => {
    const { fakeLogger } = captureWarnings();
    const raw: Record<string, unknown> = {
      review: {
        adversarial: { nonBlockingFix: { enabled: false } },
        nonBlockingFix: { enabled: true },
      },
    };
    expect(() => migrateLegacyNonBlockingFix(raw, fakeLogger)).not.toThrow();
  });

  test("AC8: neither legacy nor canonical is supplied — migration returns the config unchanged and emits no warning", () => {
    const { messages, fakeLogger } = captureWarnings();
    const raw: Record<string, unknown> = { review: { adversarial: { rules: [] } } };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);
    expect(result).toBe(raw);
    expect(messages.length).toBe(0);
  });

  test("AC8: neither legacy nor canonical is supplied — migration returns the config unchanged and emits no warning", () => {
    const { messages, fakeLogger } = captureWarnings();
    const raw: Record<string, unknown> = { review: { adversarial: { rules: [] } } };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);
    expect(result).toBe(raw);
    expect(messages.length).toBe(0);
  });
});

describe("migrateLegacyNonBlockingFix — AC9 (end-to-end wiring via loadConfig)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-nbf-migrate-ac9-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    _clearRootConfigCache();
  });

  afterEach(() => {
    _clearRootConfigCache();
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  async function writeProjectConfig(config: Record<string, unknown>): Promise<void> {
    await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify(config));
  }

  async function captureLoadWarnings(load: () => Promise<unknown>): Promise<string[]> {
    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      await load();
    } finally {
      removeSink();
      resetLogger();
    }
    return captured;
  }

  test("AC9: legacy in one layer + canonical in a later layer — after migration runs before layer merge, the later canonical value wins", async () => {
    // End-to-end wiring test (not a unit test of the shim — see AC6/AC7 above for
    // those). Per-layer compat shims run before merge in the real loader; if any
    // layer ever forgets to run the shim, the legacy key on that layer would
    // either be silently dropped (losing user config) or, worse, would override
    // a later canonical layer with the adversarial-nested value. This test
    // pins that the loader:
    //   1. runs the shim on the project layer (legacy moves to canonical)
    //   2. runs the shim on the CLI override layer (no-op, no extra warn)
    //   3. merges with later-layer-wins via real deepMergeConfig
    //   4. emits exactly one warning naming both keys
    //   5. leaves no `review.adversarial.nonBlockingFix` behind
    await writeProjectConfig({
      review: {
        adversarial: {
          // legacy key in the earlier layer — must migrate before merge
          nonBlockingFix: { enabled: false, scope: "source", regressionAttempts: 1 },
        },
      },
    });

    const cliOverrides = {
      // CLI overrides merge AFTER the project layer. We name every field
      // explicitly so the assertion proves the LATER layer's value wins —
      // any field the CLI omitted would inherit the project layer's migrated
      // value, which would muddy the "later wins" read.
      review: {
        nonBlockingFix: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 5,
          verifierGuard: false,
          sourceDiffCap: { maxFiles: 7, maxLines: 70 },
          sources: ["semantic", "adversarial"],
        },
      },
    };

    const warnings = await captureLoadWarnings(() => loadConfig(tempDir, cliOverrides));

    // loadConfig caches by (path, profile) — a fresh call with the same cliOverrides
    // re-runs the merge. Without `loadConfig` running the shim on the project layer,
    // the legacy block would still be in the merged config and the CLI override's
    // canonical `nonBlockingFix` would be over-written by the post-migration
    // adversarial-nested value (or silently dropped).
    const config = await loadConfig(tempDir, cliOverrides);
    expect(config.review?.nonBlockingFix).toEqual({
      enabled: true,
      scope: "triage",
      regressionAttempts: 5,
      verifierGuard: false,
      sourceDiffCap: { maxFiles: 7, maxLines: 70 },
      sources: ["semantic", "adversarial"],
    });
    // Legacy `review.adversarial.nonBlockingFix` is gone after Zod strip (AC10),
    // so this assertion is purely a backstop on the migration: if the loader
    // ever stops running the shim, the legacy key would still be present here
    // before strip — the migration's job is to drop it pre-parse so the
    // post-parse config never sees it.
    expect((config.review?.adversarial as Record<string, unknown> | undefined)?.nonBlockingFix).toBeUndefined();

    const nbfWarnings = warnings.filter((m) => m.includes("review.adversarial.nonBlockingFix"));
    expect(nbfWarnings).toHaveLength(1);
    expect(nbfWarnings[0]).toContain("review.nonBlockingFix");
  });
});
