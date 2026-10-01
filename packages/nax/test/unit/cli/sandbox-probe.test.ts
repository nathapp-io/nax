import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { sandboxProbeCommand as barrelCommand } from "@/cli";
import { _sandboxProbeCmdDeps, sandboxProbeCommand } from "@/cli/sandbox-probe";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "@/config";
import type { ProbeResult, SandboxBackend } from "@/sandbox";

describe("sandboxProbeCommand", () => {
  const backend: SandboxBackend = {
    name: "srt",
    isSupportedPlatform: async () => true,
    wrap: async () => [],
    annotate: () => "",
    commandFinished: () => {},
    reset: mock(async () => {}),
  };
  let original: typeof _sandboxProbeCmdDeps;
  let logs: string[];
  let createBackend: ReturnType<typeof mock<(network: SandboxConfig["network"]) => SandboxBackend>>;
  let probe: ReturnType<typeof mock<(backend: SandboxBackend) => Promise<ProbeResult>>>;

  beforeEach(() => {
    original = { ..._sandboxProbeCmdDeps };
    logs = [];
    createBackend = mock<(network: SandboxConfig["network"]) => SandboxBackend>(() => backend);
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => ({ available: true }));
    _sandboxProbeCmdDeps.log = (text) => logs.push(text);
    _sandboxProbeCmdDeps.platform = () => "darwin";
    _sandboxProbeCmdDeps.createBackend = createBackend;
    _sandboxProbeCmdDeps.probe = probe;
    backend.reset = mock(async () => {});
  });

  afterEach(() => Object.assign(_sandboxProbeCmdDeps, original));

  test("US-001 AC1: emits an available sandbox JSON report", async () => {
    expect(await sandboxProbeCommand({ json: true })).toBe(0);
    expect(JSON.parse(logs.at(0) ?? "")).toEqual({ backend: "srt", platform: "darwin", available: true });
  });

  test("US-001 AC3: includes the unavailable reason in JSON", async () => {
    _sandboxProbeCmdDeps.platform = () => "linux";
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => ({
      available: false,
      reason: "sandbox ran a command but did not enforce a write deny",
    }));
    _sandboxProbeCmdDeps.probe = probe;
    expect(await sandboxProbeCommand({ json: true })).toBe(1);
    expect(JSON.parse(logs.at(0) ?? "")).toEqual({
      backend: "srt",
      platform: "linux",
      available: false,
      reason: "sandbox ran a command but did not enforce a write deny",
    });
  });

  test("US-001 AC5-7: converts rejected probes into unavailable results", async () => {
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => {
      throw new Error("module not found");
    });
    _sandboxProbeCmdDeps.probe = probe;
    expect(await sandboxProbeCommand({ json: true })).toBe(1);
    expect(JSON.parse(logs.at(0) ?? "")).toMatchObject({
      available: false,
      reason: "sandbox probe failed: module not found",
    });
    logs = [];
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => {
      // biome-ignore lint/style/useThrowOnlyError: validates handling of non-Error rejection values.
      throw "boom";
    });
    _sandboxProbeCmdDeps.probe = probe;
    expect(await sandboxProbeCommand({ json: true })).toBe(1);
    expect(JSON.parse(logs.at(0) ?? "").reason).toBe("sandbox probe failed: boom");
  });

  test("US-001 AC8-11: probes the fresh default backend and always resets it", async () => {
    expect(await sandboxProbeCommand({ json: true })).toBe(0);
    expect(createBackend).toHaveBeenCalledTimes(1);
    expect(createBackend).toHaveBeenCalledWith(DEFAULT_SANDBOX_CONFIG.network);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(backend);
    expect(backend.reset).toHaveBeenCalledTimes(1);
    logs = [];
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => {
      throw new Error("failed");
    });
    _sandboxProbeCmdDeps.probe = probe;
    expect(await sandboxProbeCommand({ json: true })).toBe(1);
    expect(backend.reset).toHaveBeenCalledTimes(2);
  });

  test("US-001 AC12-13: reset failure does not change the available verdict", async () => {
    backend.reset = mock(async () => {
      throw new Error("reset failed");
    });
    expect(await sandboxProbeCommand({ json: true })).toBe(0);
    expect(JSON.parse(logs.at(0) ?? "").available).toBe(true);
  });

  test("US-001 AC14-15: an unavailable JSON report is logged once without ANSI escapes", async () => {
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => ({ available: false, reason: "x" }));
    _sandboxProbeCmdDeps.probe = probe;
    expect(await sandboxProbeCommand({ json: true })).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("\u001b");
  });

  test("US-001 AC16-19: renders one plain-text line and failure status", async () => {
    expect(await sandboxProbeCommand({})).toBe(0);
    expect(logs).toEqual(["Sandbox (srt, darwin): available"]);
    logs = [];
    _sandboxProbeCmdDeps.platform = () => "linux";
    probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => ({
      available: false,
      reason: "no bwrap",
    }));
    _sandboxProbeCmdDeps.probe = probe;
    expect(await sandboxProbeCommand({})).toBe(1);
    expect(logs).toEqual(["Sandbox (srt, linux): unavailable: no bwrap"]);
  });

  test("US-001 AC20: the CLI barrel exports the defaultable command", async () => {
    expect(await barrelCommand()).toBe(0);
  });

  test.each(["platform linux is not supported by the srt sandbox", "sandbox could not run a command: exit 1"])(
    "US-001 AC23-24: preserves probe reason %s",
    async (reason) => {
      probe = mock<(backend: SandboxBackend) => Promise<ProbeResult>>(async () => ({ available: false, reason }));
      _sandboxProbeCmdDeps.probe = probe;
      expect(await sandboxProbeCommand({ json: true })).toBe(1);
      expect(JSON.parse(logs.at(0) ?? "").reason).toBe(reason);
    },
  );
});
