import { afterEach, describe, expect, test } from "bun:test";
import type { AcceptanceGroupResult } from "@/cli";
import { _acceptanceGateDeps, runAcceptanceGate } from "../../../src/finish/gates/acceptance";
import { routeAcceptance } from "../../../src/finish/route";
import type { FinishPhaseState } from "../../../src/finish/state";

const originalRun = _acceptanceGateDeps.run;
afterEach(() => {
  _acceptanceGateDeps.run = originalRun;
});

const zeroedState = (): FinishPhaseState => ({
  fixAttempts: 0,
  reviewAttempts: 0,
  incompleteAttempts: 0,
  rounds: 0,
});

const group = (over: Partial<AcceptanceGroupResult> = {}): AcceptanceGroupResult => ({
  packageDir: "apps/web",
  testPath: "apps/web/.nax/features/x/a.test.tsx",
  exists: true,
  command: "bun vitest run {{FILE}}",
  cwd: "apps/web",
  language: "typescript",
  ...over,
});

describe("runAcceptanceGate", () => {
  test("substitutes an absolute, shell-quoted {{FILE}} and spawns at cwd=repoRoot/packageDir", async () => {
    const calls: { commandName: string; command: string; workdir: string; timeoutMs?: number }[] = [];
    _acceptanceGateDeps.run = async (opts) => {
      calls.push({
        commandName: opts.commandName,
        command: opts.command,
        workdir: opts.workdir,
        timeoutMs: opts.timeoutMs,
      });
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "ok",
        durationMs: 1,
        timedOut: false,
      };
    };
    const r = await runAcceptanceGate("/repo", [group()]);
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(1);
    expect(calls[0].workdir).toBe("/repo/apps/web");
    expect(calls[0].command).toBe("bun vitest run '/repo/apps/web/.nax/features/x/a.test.tsx'");
  });

  test("a repo path containing a space produces a quoted, unsplit command", async () => {
    const calls: { command: string }[] = [];
    _acceptanceGateDeps.run = async (opts) => {
      calls.push({ command: opts.command });
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 1,
        timedOut: false,
      };
    };
    await runAcceptanceGate("/my repo", [group()]);
    expect(calls[0].command).toContain("'/my repo/apps/web/.nax/features/x/a.test.tsx'");
  });

  test("falls back to the language-appropriate default runner when no command is configured", async () => {
    const calls: { command: string }[] = [];
    _acceptanceGateDeps.run = async (opts) => {
      calls.push({ command: opts.command });
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 1,
        timedOut: false,
      };
    };
    await runAcceptanceGate("/repo", [group({ command: undefined, language: "python" })]);
    expect(calls[0].command).toContain("uv run pytest");

    await runAcceptanceGate("/repo", [group({ command: undefined, language: "go", packageDir: "svc", cwd: "svc" })]);
    expect(calls[1].command).toContain("go test");

    await runAcceptanceGate("/repo", [
      group({ command: undefined, language: undefined, packageDir: "svc2", cwd: "svc2" }),
    ]);
    expect(calls[2].command).toContain("bun test");
  });

  test("stops at the first non-zero exit and does not run remaining groups", async () => {
    const calls: string[] = [];
    _acceptanceGateDeps.run = async (opts) => {
      calls.push(opts.workdir);
      const failing = opts.workdir.endsWith("apps/api");
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: !failing,
        exitCode: failing ? 1 : 0,
        output: failing ? "boom" : "ok",
        durationMs: 1,
        timedOut: false,
      };
    };
    const r = await runAcceptanceGate("/repo", [
      group({ packageDir: "apps/api", cwd: "apps/api" }),
      group({ packageDir: "apps/web", cwd: "apps/web" }),
    ]);
    expect(r.passed).toBe(false);
    expect(calls).toEqual(["/repo/apps/api"]);
    expect(r.output).toContain("boom");
  });

  test("a group with exists:false is counted missing and never spawned", async () => {
    let called = false;
    _acceptanceGateDeps.run = async (opts) => {
      called = true;
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 1,
        timedOut: false,
      };
    };
    const r = await runAcceptanceGate("/repo", [group({ exists: false })]);
    expect(called).toBe(false);
    expect(r.ran).toBe(0);
    expect(r.missing).toEqual(["apps/web"]);
  });

  test("reports the root package's missing test under a readable name", async () => {
    _acceptanceGateDeps.run = async (opts) => ({
      commandName: opts.commandName,
      command: opts.command,
      success: true,
      exitCode: 0,
      output: "",
      durationMs: 1,
      timedOut: false,
    });
    const r = await runAcceptanceGate("/repo", [group({ packageDir: "", cwd: "", exists: false })]);
    expect(r.missing).toEqual(["root"]);
  });

  test("an empty groups array yields ran: 0, passed: true from this function", async () => {
    let called = false;
    _acceptanceGateDeps.run = async (opts) => {
      called = true;
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 1,
        timedOut: false,
      };
    };
    const r = await runAcceptanceGate("/repo", []);
    expect(called).toBe(false);
    expect(r.ran).toBe(0);
    expect(r.passed).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("I1: an empty-groups pass is escalated by routeAcceptance, not by this gate", async () => {
    _acceptanceGateDeps.run = async (opts) => ({
      commandName: opts.commandName,
      command: opts.command,
      success: true,
      exitCode: 0,
      output: "",
      durationMs: 1,
      timedOut: false,
    });
    const r = await runAcceptanceGate("/repo", []);
    expect(r.passed).toBe(true);
    const routed = routeAcceptance(r, zeroedState());
    expect(routed.route).toBe("escalate");
  });

  test("routeAcceptance escalates a pass that still has a non-empty missing list", async () => {
    _acceptanceGateDeps.run = async (opts) => ({
      commandName: opts.commandName,
      command: opts.command,
      success: true,
      exitCode: 0,
      output: "",
      durationMs: 1,
      timedOut: false,
    });
    const r = await runAcceptanceGate("/repo", [group({ packageDir: "apps/web", exists: false })]);
    expect(r.passed).toBe(true);
    expect(r.missing).toEqual(["apps/web"]);
    const routed = routeAcceptance(r, zeroedState());
    expect(routed.route).toBe("escalate");
  });

  test("honours the configured timeoutMs", async () => {
    const seen: (number | undefined)[] = [];
    _acceptanceGateDeps.run = async (opts) => {
      seen.push(opts.timeoutMs);
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 1,
        timedOut: false,
      };
    };
    await runAcceptanceGate("/repo", [group()], { timeoutMs: 1234 });
    expect(seen).toEqual([1234]);
  });
});
