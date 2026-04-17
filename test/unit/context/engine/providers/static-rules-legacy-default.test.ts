/**
 * StaticRulesProvider — #508-M3 allowLegacyClaudeMd default tests
 *
 * AC-28/AC-31: The default for allowLegacyClaudeMd must be false.
 * Legacy CLAUDE.md fallback must be opt-in, not opt-out.
 *
 * Kept in a separate file because static-rules.test.ts exceeds 400 lines.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StaticRulesProvider, _staticRulesDeps } from "../../../../../src/context/engine/providers/static-rules";
import { NaxConfigSchema } from "../../../../../src/config/schemas";
import type { ContextRequest } from "../../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origReadFile: typeof _staticRulesDeps.readFile;
let origFileExists: typeof _staticRulesDeps.fileExists;
let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

beforeEach(() => {
  origReadFile = _staticRulesDeps.readFile;
  origFileExists = _staticRulesDeps.fileExists;
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  _staticRulesDeps.loadCanonicalRules = async () => [];
});

afterEach(() => {
  _staticRulesDeps.readFile = origReadFile;
  _staticRulesDeps.fileExists = origFileExists;
  _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
});

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// #508-M3: AC-28/AC-31 allowLegacyClaudeMd defaults to false
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — #508-M3 allowLegacyClaudeMd defaults to false", () => {
  test("returns empty chunks by default when no canonical rules and CLAUDE.md exists", async () => {
    // Canonical rules: empty (no .nax/rules/)
    _staticRulesDeps.loadCanonicalRules = async () => [];
    // CLAUDE.md exists and has content — legacy fallback would pick this up
    _staticRulesDeps.fileExists = async (path: string) => path.endsWith("CLAUDE.md");
    _staticRulesDeps.readFile = async () => "# Project rules\n\nUse async/await.";

    // RED: current default is true — provider falls back to CLAUDE.md and returns a chunk.
    // GREEN: default false — no legacy fallback, returns empty.
    const provider = new StaticRulesProvider(); // no options
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
  });

  test("returns legacy chunks when explicitly opted in with allowLegacyClaudeMd: true", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => [];
    _staticRulesDeps.fileExists = async (path: string) => path.endsWith("CLAUDE.md");
    _staticRulesDeps.readFile = async () => "# Rules\n\nUse async/await.";

    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: true });
    const result = await provider.fetch(BASE_REQUEST);
    // Explicit opt-in must still work
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test("NaxConfigSchema default for allowLegacyClaudeMd is false", () => {
    const config = NaxConfigSchema.parse({});
    // RED: current schema default is true.
    // GREEN: flipped to false.
    expect(config.context?.v2?.rules?.allowLegacyClaudeMd).toBe(false);
  });
});
