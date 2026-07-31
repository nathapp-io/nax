import { afterEach, describe, expect, test } from "bun:test";
import { _acceptanceDeps, buildAcceptanceCommand, runAcceptanceGate } from "@flows/nax-finish/steps/acceptance";

const originalRunShell = _acceptanceDeps.runShell;
afterEach(() => {
  _acceptanceDeps.runShell = originalRunShell;
});

const group = (over: Record<string, unknown> = {}) => ({
  packageDir: "apps/web",
  testPath: "apps/web/.nax/features/x/a.test.tsx",
  exists: true,
  command: "bun vitest run {{FILE}}",
  language: "typescript",
  ...over,
});

describe("buildAcceptanceCommand", () => {
  test("substitutes an absolute, shell-quoted FILE into the configured template", () => {
    expect(buildAcceptanceCommand("/repo", group())).toBe(
      "bun vitest run '/repo/apps/web/.nax/features/x/a.test.tsx'",
    );
  });

  test("quoting survives a repo path containing spaces", () => {
    expect(buildAcceptanceCommand("/my repo", group())).toContain("'/my repo/apps/web/.nax/features/x/a.test.tsx'");
  });

  test("falls back to a per-language runner when no command is configured", () => {
    expect(buildAcceptanceCommand("/repo", group({ command: undefined, language: "python" }))).toContain(
      "uv run pytest",
    );
    expect(buildAcceptanceCommand("/repo", group({ command: undefined, language: "go" }))).toContain("go test");
  });
});

describe("runAcceptanceGate", () => {
  test("runs each existing group at cwd=repoRoot/packageDir, preserving shell semantics", async () => {
    const calls: { command: string; cwd: string; timeoutMs?: number }[] = [];
    _acceptanceDeps.runShell = async (command, opts) => {
      calls.push({ command, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const r = await runAcceptanceGate("/repo", [group({ command: "cd .. && bun vitest run {{FILE}}" })]);
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(1);
    expect(calls[0].cwd).toBe("/repo/apps/web");
    // The `&&` reaches the shell intact rather than being split into argv.
    expect(calls[0].command).toContain("cd .. &&");
    expect(calls[0].timeoutMs).toBeGreaterThan(0);
  });

  test("honours the acceptance timeout from the flow input", async () => {
    const seen: number[] = [];
    _acceptanceDeps.runShell = async (_c, opts) => {
      seen.push(opts.timeoutMs ?? 0);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runAcceptanceGate("/repo", [group()], { timeoutMs: 1234 });
    expect(seen).toEqual([1234]);
  });

  test("fails when a group exits non-zero", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    const r = await runAcceptanceGate("/repo", [group({ packageDir: "", testPath: ".nax/features/x/a.test.ts" })]);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("boom");
  });

  test("reports ran=0 (and says so) when no acceptance files exist", async () => {
    let called = false;
    _acceptanceDeps.runShell = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await runAcceptanceGate("/repo", [group({ exists: false })]);
    expect(called).toBe(false);
    expect(r.ran).toBe(0);
    expect(r.output).toContain("no acceptance test files present");
  });

  test("names the packages whose acceptance test was expected but never generated", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const r = await runAcceptanceGate("/repo", [
      group({ packageDir: "apps/api", exists: true }),
      group({ packageDir: "apps/web", exists: false }),
    ]);
    // the runnable group passed, but the gate must not hide the missing one
    expect(r.ran).toBe(1);
    expect(r.missing).toEqual(["apps/web"]);
  });

  test("reports the root package's missing test under a readable name", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const r = await runAcceptanceGate("/repo", [group({ packageDir: "", exists: false })]);
    expect(r.missing).toEqual(["root"]);
  });

  test("missing is empty when every group ran", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const r = await runAcceptanceGate("/repo", [group()]);
    expect(r.missing).toEqual([]);
  });
});
