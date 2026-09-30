/**
 * Hook validation test — ensure ReDoS vulnerability is fixed
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, useUntrustedRegistry } from "@test/helpers";
import { fireHook, validateHookCommand } from "@/hooks/runner";
import type { LoadedHooksConfig } from "@/hooks/runner";
import type { HookContext } from "@/hooks/types";

describe("fireHook — US-005 trust backstop", () => {
  useUntrustedRegistry();
  let project = "";
  afterEach(() => cleanupTempDir(project));

  const ctx: HookContext = { event: "on-start", feature: "trust-test" };

  test("US-005 AC9: rejects an untrusted project hook with PROJECT_UNTRUSTED and hooks surface", async () => {
    project = makeTempDir();
    const config: LoadedHooksConfig = { hooks: { "on-start": { command: "" } } };
    await expect(fireHook(config, "on-start", ctx, project)).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
      context: { surface: "hooks" },
    });
  });

  test("US-005 AC10: does not execute an untrusted project hook", async () => {
    project = makeTempDir();
    const marker = join(project, "hook-ran");
    const config: LoadedHooksConfig = { hooks: { "on-start": { command: "" } } };
    await expect(fireHook(config, "on-start", ctx, project)).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED" });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

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
