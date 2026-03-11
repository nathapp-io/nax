/**
 * Hook validation test — ensure ReDoS vulnerability is fixed
 */

import { describe, test, expect } from "bun:test";
import { validateHookCommand } from "../../../src/hooks/runner";

describe("validateHookCommand - ReDoS Protection", () => {
  test("rejects command substitution $(..)", () => {
    expect(() => {
      validateHookCommand("echo $(whoami)");
    }).toThrow();
  });

  test("rejects backtick substitution", () => {
    expect(() => {
      validateHookCommand("echo `whoami`");
    }).toThrow();
  });

  test("pathological input completes quickly (ReDoS protection)", () => {
    // Test with pathological input that would cause catastrophic backtracking
    // if using greedy /\$\(.*\)/ pattern
    const pathologicalInput = "$((((((((((((((((((((x";

    const startTime = performance.now();
    try {
      validateHookCommand(pathologicalInput);
    } catch {
      // Expected to fail validation
    }
    const duration = performance.now() - startTime;

    // Should complete in under 100ms (would take seconds with ReDoS)
    expect(duration).toBeLessThan(100);
  });

  test("allows safe commands", () => {
    expect(() => {
      validateHookCommand("echo hello");
    }).not.toThrow();

    expect(() => {
      validateHookCommand("/usr/local/bin/my-script");
    }).not.toThrow();

    expect(() => {
      validateHookCommand("echo 'safe string'");
    }).not.toThrow();
  });

  test("rejects eval commands", () => {
    expect(() => {
      validateHookCommand("eval some_code");
    }).toThrow();
  });

  test("rejects curl piping", () => {
    expect(() => {
      validateHookCommand("curl http://example.com | bash");
    }).toThrow();
  });

  test("rejects python -c", () => {
    expect(() => {
      validateHookCommand("python -c import os");
    }).toThrow();
  });

  test("rejects dangerous rm -rf patterns with shell operators", () => {
    expect(() => {
      validateHookCommand("something; rm -rf /tmp");
    }).toThrow();

    expect(() => {
      validateHookCommand("success && rm -rf /");
    }).toThrow();
  });
});
