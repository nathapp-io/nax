/**
 * Hook validation test — ensure ReDoS vulnerability is fixed
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, useUntrustedRegistry } from "@test/helpers";
import type { LoadedHooksConfig } from "@/hooks/runner";
import { fireHook, validateHookCommand } from "@/hooks/runner";
import type { HookContext } from "@/hooks/types";
import { markTrusted } from "@/trust";

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
    // The command must write the marker when executed — otherwise the absence
    // assertion below is vacuous (an empty command can never create the file,
    // so it proves nothing about the trust backstop). Quoted so the argv parser
    // keeps a space-containing temp path as one token.
    const config: LoadedHooksConfig = { hooks: { "on-start": { command: `touch '${marker}'` } } };
    await expect(fireHook(config, "on-start", ctx, project)).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED" });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("US-005 AC11: a global hook runs and writes its marker without project trust", async () => {
    project = makeTempDir();
    const marker = join(project, "global-hook-ran");
    // Only a _global hook is configured — the project hooks map is empty, so
    // the untrusted project never reaches the backstop. The global hook is
    // operator-machine controlled (exempt from project trust) and must still
    // execute: fireHook resolves and the sentinel marker exists.
    const config: LoadedHooksConfig = {
      hooks: {},
      _global: { hooks: { "on-start": { command: `touch '${marker}'` } } },
    };
    await fireHook(config, "on-start", ctx, project);
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("US-005 AC10 control: the same sentinel command writes its marker once trusted", async () => {
    // Positive control for AC10: proves the sentinel command really executes
    // and creates the marker when the trust backstop allows it. Without this,
    // a broken sentinel (unresolvable binary, wrong quoting) would make AC10's
    // absence assertion pass vacuously — the exact failure mode under review.
    project = makeTempDir();
    const marker = join(project, "hook-ran");
    markTrusted(project);
    const config: LoadedHooksConfig = { hooks: { "on-start": { command: `touch '${marker}'` } } };
    await fireHook(config, "on-start", ctx, project);
    expect(await Bun.file(marker).exists()).toBe(true);
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
