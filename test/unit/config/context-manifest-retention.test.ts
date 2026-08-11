/**
 * US-001: Manifest retention — schema & runtime-type config
 *
 * Adds an optional `manifest.retentionDays` block to ContextV2Config. The
 * block is .optional() with no .default(), so an unset key resolves to
 * `undefined` and DEFAULT_CONFIG retains its current shape.
 */

import { describe, expect, test } from "bun:test";
import { ContextV2ConfigSchema } from "@/config";
import type { ContextV2Config } from "@/config/runtime-types-context";

describe("ContextV2ConfigSchema — manifest retentionDays (US-001)", () => {
  test("AC-1: parsing an empty object yields manifest === undefined", () => {
    const parsed = ContextV2ConfigSchema.parse({});
    expect(parsed.manifest).toBeUndefined();
  });

  test("AC-2: parsing { manifest: { retentionDays: 30 } } yields retentionDays === 30", () => {
    const parsed = ContextV2ConfigSchema.parse({ manifest: { retentionDays: 30 } });
    expect(parsed.manifest?.retentionDays).toBe(30);
  });

  test("AC-3: parsing { manifest: { retentionDays: 0 } } throws schema validation", () => {
    expect(() => ContextV2ConfigSchema.parse({ manifest: { retentionDays: 0 } })).toThrow();
  });

  test("runtime type allows optional manifest field", () => {
    const cfg: ContextV2Config = {
      enabled: true,
      minScore: 0.1,
      providerTimeoutMs: 5000,
      pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 },
      rules: { allowLegacyClaudeMd: false, budgetTokens: 8192, rulesShare: 0.4, enforceBudget: true },
      pluginProviders: [],
      stages: {},
      deterministic: false,
      session: { retentionDays: 7, archiveOnFeatureArchive: true },
      staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
      providers: { historyScope: "package", neighborScope: "package", crossPackageDepth: 1, maxGlobFiles: 500 },
      manifest: { retentionDays: 30 },
    };
    expect(cfg.manifest?.retentionDays).toBe(30);
  });
});
