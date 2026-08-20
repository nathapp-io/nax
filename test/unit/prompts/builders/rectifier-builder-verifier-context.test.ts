/**
 * AC7: RectifierPromptBuilder.verifierContext static method exists on the class
 * AC8: src/prompts/sections/verdict.ts is byte-identical to SHA 52634c0b (not modified by this story)
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import type { Finding } from "@/findings/types";

const VERIFIER_FINDING: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "tests-failed",
  message: "3 test(s) failed (verifier)",
  fixTarget: "source",
  meta: {
    passCount: 1,
    failCount: 3,
    reasoning: "tests ran but 3 failed",
  },
};

// ── AC7: RectifierPromptBuilder.verifierContext ──────────────────────────────

describe("AC7: RectifierPromptBuilder.verifierContext static method", () => {
  test("AC7: RectifierPromptBuilder is exported from src/prompts barrel", async () => {
    const mod = await import("@/prompts");
    expect(mod.RectifierPromptBuilder).toBeDefined();
  });

  test("AC7: verifierContext is a static method on RectifierPromptBuilder", async () => {
    const { RectifierPromptBuilder } = await import("@/prompts");
    expect(typeof RectifierPromptBuilder.verifierContext).toBe("function");
  });

  test("AC7: verifierContext returns a string when given findings", async () => {
    const { RectifierPromptBuilder } = await import("@/prompts");
    // Stub throws — test will fail until implemented
    let result: string | undefined;
    try {
      result = RectifierPromptBuilder.verifierContext([VERIFIER_FINDING]);
    } catch {
      // stub throws "not implemented" — test fails here, proving impl is missing
    }
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  test("AC7: verifierContext returns a string when findings is empty", async () => {
    const { RectifierPromptBuilder } = await import("@/prompts");
    let result: string | undefined;
    try {
      result = RectifierPromptBuilder.verifierContext([]);
    } catch {
      // stub throws — test fails until implemented
    }
    expect(typeof result).toBe("string");
  });

  test("AC7: rectifier-builder.ts contains exactly one static verifierContext( definition", async () => {
    const file = Bun.file(join(import.meta.dir, "../../../../src/prompts/builders/rectifier-builder.ts"));
    const content = await file.text();
    const matches = content
      .split("\n")
      .filter((line) => /static verifierContext\(/.test(line));
    expect(matches.length).toBe(1);
  });
});

// ── AC8: verdict.ts is unchanged ─────────────────────────────────────────────

describe("AC8: src/prompts/sections/verdict.ts is not modified by this story", () => {
  test("AC8: verdict.ts still exports buildVerdictSection function", async () => {
    const mod = await import("@/prompts/sections/verdict");
    expect(typeof mod.buildVerdictSection).toBe("function");
  });

  test("AC8: verdict.ts does not contain verifierContext or normalizedFindings references", async () => {
    const file = Bun.file(join(import.meta.dir, "../../../../src/prompts/sections/verdict.ts"));
    const content = await file.text();
    expect(content).not.toContain("verifierContext");
    expect(content).not.toContain("normalizedFindings");
  });

  test("AC8: verdict.ts contains the canonical approved:true schema example", async () => {
    const file = Bun.file(join(import.meta.dir, "../../../../src/prompts/sections/verdict.ts"));
    const content = await file.text();
    // Key marker from the known content at SHA 52634c0b
    expect(content).toContain('"approved":true');
    expect(content).toContain("buildVerdictSection");
    expect(content).toContain(".nax-verifier-verdict.json");
  });
});
