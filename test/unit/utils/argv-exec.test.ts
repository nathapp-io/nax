import { describe, expect, test } from "bun:test";
import { runArgv } from "@/utils/argv-exec";

describe("runArgv", () => {
  test("returns exit code and stdout without a shell", async () => {
    const result = await runArgv({ argv: ["echo", "hello"], cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  test("does not interpret shell metacharacters", async () => {
    // With a shell this would print "a" and run `echo b`. Without one, the
    // whole string is a single argument to echo.
    const result = await runArgv({ argv: ["echo", "a; echo b"], cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.stdout.trim()).toBe("a; echo b");
  });

  test("reports timedOut and a non-zero exit when the deadline passes", async () => {
    const result = await runArgv({ argv: ["sleep", "5"], cwd: process.cwd(), timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("applies the env overlay to the child", async () => {
    const result = await runArgv({
      argv: ["sh", "-c", "printenv NAX_TEST_OVERLAY || true"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: { NAX_TEST_OVERLAY: "on" },
    });
    expect(result.stdout.trim()).toBe("on");
  });

  test("strips the named environment variables from the child", async () => {
    process.env.NAX_TEST_SECRET = "leaked";
    try {
      const result = await runArgv({
        argv: ["sh", "-c", "printenv NAX_TEST_SECRET || true"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        stripEnvVars: ["NAX_TEST_SECRET"],
      });
      expect(result.stdout).not.toContain("leaked");
    } finally {
      process.env.NAX_TEST_SECRET = undefined;
    }
  });
});
