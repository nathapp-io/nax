/**
 * `defaultForgeDeps` — the default `ForgeDeps` implementation for subprocess
 * execution and file reads used by `src/finish/`. Lifted from the auto-pr
 * plugin's own `defaultRun`/`defaultReadText` (BUG-8); this file exercises
 * this module's own copy directly.
 */
import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS, defaultForgeDeps, defaultRun } from "@/forge/deps";

describe("defaultRun", () => {
  test("returns exitCode, stdout, and stderr for a normal command", async () => {
    const result = await defaultRun(["echo", "hello"], { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("reports a non-zero exit code without a timeout note", async () => {
    const result = await defaultRun(["sh", "-c", "exit 3"], { cwd: "/tmp" });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain("timeout");
  });

  test("kills a hanging subprocess after timeoutMs and annotates stderr with the timeout", async () => {
    const result = await defaultRun(["sleep", "5"], { cwd: "/tmp", timeoutMs: 100 });
    // The killed process exits via SIGTERM (a non-zero code on this platform),
    // so the 124-substitution branch (exitCode === 0) isn't the one exercised
    // here — it is a fallback for a process that manages to exit 0 right as
    // it's killed. What every timeout must produce is the stderr annotation.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[forge] command killed after 100ms timeout");
  }, 10_000);

  test("substitutes exit code 124 when the killed process still reports exit 0", async () => {
    // A process that happens to exit 0 in the same tick it's killed must not
    // be reported as a success — the 124 substitution is what makes a timeout
    // distinguishable from a clean exit.
    const result = await defaultRun(["sh", "-c", "trap 'exit 0' TERM; sleep 5"], { cwd: "/tmp", timeoutMs: 100 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("[forge] command killed after 100ms timeout");
  }, 10_000);

  test("DEFAULT_SUBPROCESS_TIMEOUT_MS is 30 seconds", () => {
    expect(DEFAULT_SUBPROCESS_TIMEOUT_MS).toBe(30_000);
  });
});

describe("defaultForgeDeps.readText", () => {
  let dir: string;

  test("returns file contents when the file exists", async () => {
    dir = makeTempDir("nax-forge-deps-");
    try {
      const path = `${dir}/template.md`;
      await Bun.write(path, "hello template");
      expect(await defaultForgeDeps.readText(path)).toBe("hello template");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("returns null when the file does not exist", async () => {
    dir = makeTempDir("nax-forge-deps-");
    try {
      expect(await defaultForgeDeps.readText(`${dir}/missing.md`)).toBeNull();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
