/**
 * AuthConfigSchema — the global-only `auth` block (US-001).
 *
 * The schema owns the defaults and the source/exec coupling that the loader
 * and the credential store both rely on. These tests pin the schema surface
 * only; the global-only rejection rule lives in loader-auth-global-only.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { AuthConfigSchema } from "@/config/schemas-auth";

describe("AuthConfigSchema defaults", () => {
  test('AC1: parse({}) returns source equal to "file"', () => {
    const config = AuthConfigSchema.parse({});

    expect(config.source).toBe("file");
  });

  test('AC2: parse({}) returns onChange equal to "warn"', () => {
    const config = AuthConfigSchema.parse({});

    expect(config.onChange).toBe("warn");
  });
});

describe("AuthConfigSchema exec coupling", () => {
  test("AC3: safeParse({ source: 'exec' }) fails with an issue on path exec", () => {
    const result = AuthConfigSchema.safeParse({ source: "exec" });

    expect(result.success).toBe(false);
    // Narrowing only — the assertion above already failed the test when parsing succeeded.
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("exec");
  });

  test("AC4: parse({ source: 'exec', exec: { command: ['koda-cred'] } }) returns exec.timeoutMs equal to 10000", () => {
    const config = AuthConfigSchema.parse({ source: "exec", exec: { command: ["koda-cred"] } });

    expect(config.exec?.timeoutMs).toBe(10000);
  });

  test("AC5: safeParse fails when exec.command is []", () => {
    const result = AuthConfigSchema.safeParse({ source: "exec", exec: { command: [] } });

    expect(result.success).toBe(false);
  });
});

describe("AuthConfigSchema exec.timeoutMs range", () => {
  test("AC6: safeParse fails when exec.timeoutMs is 999", () => {
    const result = AuthConfigSchema.safeParse({
      source: "exec",
      exec: { command: ["koda-cred"], timeoutMs: 999 },
    });

    expect(result.success).toBe(false);
  });

  test("AC7: safeParse fails when exec.timeoutMs is 60001", () => {
    const result = AuthConfigSchema.safeParse({
      source: "exec",
      exec: { command: ["koda-cred"], timeoutMs: 60001 },
    });

    expect(result.success).toBe(false);
  });

  test.each([1000, 60000])("AC6/AC7: safeParse accepts exec.timeoutMs %i, the inclusive range bound", (timeoutMs) => {
    const result = AuthConfigSchema.safeParse({
      source: "exec",
      exec: { command: ["koda-cred"], timeoutMs },
    });

    expect(result.success).toBe(true);
  });
});

describe("AuthConfigSchema onChange enum", () => {
  test('AC8: safeParse fails when onChange is "ignore"', () => {
    const result = AuthConfigSchema.safeParse({ onChange: "ignore" });

    expect(result.success).toBe(false);
  });
});
