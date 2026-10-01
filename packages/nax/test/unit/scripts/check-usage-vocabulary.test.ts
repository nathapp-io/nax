import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findVocabularyViolations } from "@scripts/check-usage-vocabulary";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("check-usage-vocabulary", () => {
  test("nax-ai may declare the standard types", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax-ai/src/types.ts", "export interface TokenUsage { inputTokens: number }\n");
    write(
      "packages/nax-ai/src/providers/types.ts",
      "export interface Pricing { input: number }\nexport interface PricingRates { input: number }\n",
    );
    expect(findVocabularyViolations(root)).toEqual([]);
  });

  test("a second declaration anywhere else fails", () => {
    root = makeTempDir("usage-vocab-");
    write(
      "packages/nax/src/metrics/types.ts",
      "export interface TokenUsage { inputTokens: number }\nexport class TokenUsage {}\n",
    );
    write("packages/nax/src/agents/cost/estimate.ts", "export interface ResolvedRates { inputPer1M: number }\n");
    write("packages/nax/src/x.ts", "export type TokenPricing = { a: number };\n");
    expect(findVocabularyViolations(root)).toEqual([
      "packages/nax/src/agents/cost/estimate.ts:1  interface ResolvedRates",
      "packages/nax/src/metrics/types.ts:1  interface TokenUsage",
      "packages/nax/src/metrics/types.ts:2  class TokenUsage",
      "packages/nax/src/x.ts:1  type TokenPricing",
    ]);
  });

  test("re-exports and similarly named types do not count", () => {
    root = makeTempDir("usage-vocab-");
    write(
      "packages/nax/src/agents/cost/standard-types.ts",
      'export type { TokenUsage, Pricing } from "@nathapp/nax-ai";\n',
    );
    write(
      "packages/nax/src/metrics/types.ts",
      "export interface StoryTokenUsage { inputTokens: number }\nexport interface ConfigPricing { inputPer1M: number }\n",
    );
    expect(findVocabularyViolations(root)).toEqual([]);
  });

  test("test files are not scanned", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax/test/unit/x.test.ts", "interface TokenUsage { inputTokens: number }\n");
    expect(findVocabularyViolations(root)).toEqual([]);
  });

  test("tsx declarations are scanned but tsx test files are not", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax/src/tui/CostRow.tsx", "export interface TokenUsage { inputTokens: number }\n");
    write("packages/nax/src/tui/CostRow.test.tsx", "interface Pricing { input: number }\n");
    expect(findVocabularyViolations(root)).toEqual(["packages/nax/src/tui/CostRow.tsx:1  interface TokenUsage"]);
  });
});
