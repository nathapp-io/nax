// RE-ARCH: keep
/**
 * Constitution system tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, loadConstitution, truncateToTokens } from "../../../src/constitution";
import type { ConstitutionConfig } from "../../../src/constitution";

const TEST_DIR = join(import.meta.dir, ".tmp-constitution-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("estimateTokens", () => {
  test("estimates tokens using 1 token ≈ 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 chars = 1 token
    expect(estimateTokens("abcdefgh")).toBe(2); // 8 chars = 2 tokens
    expect(estimateTokens("a".repeat(100))).toBe(25); // 100 chars = 25 tokens (rounded up)
  });

  test("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("rounds up fractional tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3 chars = 0.75 tokens → rounds up to 1
  });
});

describe("truncateToTokens", () => {
  test("returns full text if within token limit", () => {
    const text = "Hello world";
    const result = truncateToTokens(text, 100);
    expect(result).toBe(text);
  });

  test("truncates at word boundary", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = truncateToTokens(text, 5); // 5 tokens ≈ 15 chars
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).not.toContain("fox"); // Should stop before "fox"
    // Result should be "The quick" which ends with a word character
    expect(result.trim()).toBe("The quick");
  });

  test("truncates at newline boundary", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4";
    const result = truncateToTokens(text, 3); // 3 tokens ≈ 9 chars
    expect(result).toContain("Line 1");
    expect(result).not.toContain("Line 3");
  });

  test("hard cuts if no word boundary found", () => {
    const text = "a".repeat(100);
    const result = truncateToTokens(text, 5); // 5 tokens ≈ 15 chars
    expect(result.length).toBe(15);
  });
});

describe("loadConstitution", () => {
  test("returns null if disabled", async () => {
    const config: ConstitutionConfig = {
      enabled: false,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).toBeNull();
  });

  test("returns null if file doesn't exist", async () => {
    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).toBeNull();
  });

  test("returns null if file is empty", async () => {
    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, "   \n\n  "); // Only whitespace

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).toBeNull();
  });

  test("loads constitution without truncation", async () => {
    const content = "# Project Constitution\n\nFollow these rules.";
    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.content).toBe(content);
    expect(result?.tokens).toBe(estimateTokens(content));
    expect(result?.truncated).toBe(false);
    expect(result?.originalTokens).toBeUndefined();
  });

  test("truncates constitution if exceeds maxTokens", async () => {
    const content = "A".repeat(300); // 300 chars = 75 tokens (1 token ≈ 4 chars)
    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 50, // Only allow 50 tokens
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.truncated).toBe(true);
    expect(result?.tokens).toBeLessThanOrEqual(50);
    expect(result?.originalTokens).toBe(75);
    expect(result?.content.length).toBeLessThan(content.length);
  });

  test("loads from custom path", async () => {
    const content = "# Custom Constitution";
    const customPath = join(TEST_DIR, "custom-rules.md");
    await Bun.write(customPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "custom-rules.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.content).toBe(content);
  });

  test("handles large constitution with meaningful content", async () => {
    const content = `# Project Constitution

## Coding Standards
- Use TypeScript strict mode
- Follow ESLint rules
- Write clear variable names

## Testing
- Write unit tests for all functions
- Aim for 80%+ coverage
- Use describe/test/expect pattern

## Architecture
- Keep functions small (<50 lines)
- Use dependency injection
- Follow SOLID principles

## Forbidden Patterns
- No any types
- No console.log
- No hardcoded secrets
`;

    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.content).toBe(content);
    expect(result?.truncated).toBe(false);
    expect(result?.tokens).toBeGreaterThan(0);
  });
});
