import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { ProbeResult, SandboxBackend } from "@/sandbox";

type Scenario = {
  result?: ProbeResult;
  reject?: Error | string;
  resetReject?: boolean;
  platform?: string;
};

// The feature module is loaded only when a unit case runs, so this file still
// loads on the pre-implementation baseline. Always restore its mutable seam.
async function withProbe<T>(scenario: Scenario, check: (ctx: Awaited<ReturnType<typeof stubProbe>>) => Promise<T>): Promise<T> {
  const ctx = await stubProbe(scenario);
  try {
    return await check(ctx);
  } finally {
    Object.assign(ctx.deps, ctx.original);
  }
}

async function stubProbe(scenario: Scenario) {
  const { _sandboxProbeCmdDeps: deps, sandboxProbeCommand: run } = await import("@/cli/sandbox-probe");
  const original = { ...deps };
  const log = mock((_text: string) => {});
  const reset = mock(async () => {
    if (scenario.resetReject) throw new Error("reset failed");
  });
  const backend: SandboxBackend = {
    name: "srt",
    isSupportedPlatform: async () => true,
    wrap: async () => [],
    annotate: () => "",
    commandFinished: () => {},
    reset,
  };
  const createBackend = mock((_network: Parameters<typeof deps.createBackend>[0]) => backend);
  const probe = mock(async (_backend: SandboxBackend): Promise<ProbeResult> => {
    if (scenario.reject !== undefined) throw scenario.reject;
    return scenario.result ?? { available: true };
  });
  deps.log = log;
  deps.platform = () => scenario.platform ?? "linux";
  deps.createBackend = createBackend;
  deps.probe = probe;
  return { deps, original, run, log, reset, backend, createBackend, probe };
}

function onlyOutput(log: ReturnType<typeof mock<(text: string) => void>>): string {
  expect(log).toHaveBeenCalledTimes(1);
  const text = log.mock.calls[0]?.[0];
  expect(typeof text).toBe("string");
  return text!;
}

describe("sandbox probe command acceptance", () => {
  test("AC-1: available JSON has exact fields and no reason", async () => {
    await withProbe({ platform: "darwin" }, async ({ run, log }) => {
      await run({ json: true });
      const report = JSON.parse(onlyOutput(log));
      expect(report).toEqual({ backend: "srt", platform: "darwin", available: true });
      expect(report).not.toHaveProperty("reason");
    });
  });
  test("AC-2: available JSON returns zero", async () => {
    await withProbe({}, async ({ run }) => expect(await run({ json: true })).toBe(0));
  });
  test("AC-3: unavailable JSON includes the write-deny reason", async () => {
    const reason = "sandbox ran a command but did not enforce a write deny";
    await withProbe({ result: { available: false, reason }, platform: "linux" }, async ({ run, log }) => {
      await run({ json: true });
      expect(JSON.parse(onlyOutput(log))).toEqual({ backend: "srt", platform: "linux", available: false, reason });
    });
  });
  test("AC-4: unavailable JSON returns one", async () => {
    await withProbe({ result: { available: false, reason: "x" } }, async ({ run }) =>
      expect(await run({ json: true })).toBe(1),
    );
  });
  test("AC-5: Error rejection becomes an unavailable JSON report", async () => {
    await withProbe({ reject: new Error("module not found") }, async ({ run, log }) => {
      await run({ json: true });
      const report = JSON.parse(onlyOutput(log));
      expect(report.available).toBe(false);
      expect(report.reason).toBe("sandbox probe failed: module not found");
    });
  });
  test("AC-6: Error rejection resolves with exit code one", async () => {
    await withProbe({ reject: new Error("module not found") }, async ({ run }) =>
      expect(await run({ json: true })).toBe(1),
    );
  });
  test("AC-7: non-Error rejection is stringified in JSON reason", async () => {
    await withProbe({ reject: "boom" }, async ({ run, log }) => {
      await run({ json: true });
      expect(JSON.parse(onlyOutput(log)).reason).toBe("sandbox probe failed: boom");
    });
  });
  test("AC-8: backend is created once with defaults, independent of project config", async () => {
    const { DEFAULT_SANDBOX_CONFIG } = await import("@/config");
    const dir = makeTempDir("probe-config-override-");
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".nax"));
      writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ execution: { sandbox: { enabled: false, network: { allowedDomains: ["invalid.example"] } } } }));
      process.chdir(dir);
      await withProbe({}, async ({ run, createBackend }) => {
        await run({ json: true });
        expect(createBackend).toHaveBeenCalledTimes(1);
        expect(createBackend.mock.calls[0]).toEqual([DEFAULT_SANDBOX_CONFIG.network]);
      });
    } finally {
      process.chdir(previousCwd);
      cleanupTempDir(dir);
    }
  });
  test("AC-9: probe receives the identical backend returned by createBackend", async () => {
    await withProbe({}, async ({ run, backend, probe }) => {
      await run({ json: true });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0]).toHaveLength(1);
      expect(probe.mock.calls[0]?.[0]).toBe(backend);
    });
  });
  test("AC-10: successful probe resets backend exactly once", async () => {
    await withProbe({}, async ({ run, reset }) => {
      await run({ json: true });
      expect(reset).toHaveBeenCalledTimes(1);
    });
  });
  test("AC-11: rejected probe resets backend exactly once", async () => {
    await withProbe({ reject: new Error("probe failed") }, async ({ run, reset }) => {
      await run({ json: true });
      expect(reset).toHaveBeenCalledTimes(1);
    });
  });
  test("AC-12: reset rejection does not change successful exit code", async () => {
    await withProbe({ resetReject: true }, async ({ run }) => expect(await run({ json: true })).toBe(0));
  });
  test("AC-13: reset rejection does not change available JSON", async () => {
    await withProbe({ resetReject: true }, async ({ run, log }) => {
      await run({ json: true });
      expect(JSON.parse(onlyOutput(log)).available).toBe(true);
    });
  });
  test("AC-14: unavailable JSON logs exactly once", async () => {
    await withProbe({ result: { available: false, reason: "x" } }, async ({ run, log }) => {
      await run({ json: true });
      expect(log).toHaveBeenCalledTimes(1);
    });
  });
  test("AC-15: JSON output has no ANSI escape and parses", async () => {
    await withProbe({ result: { available: false, reason: "x" } }, async ({ run, log }) => {
      await run({ json: true });
      const s = onlyOutput(log);
      expect(s).not.toContain("\u001b");
      expect(() => JSON.parse(s)).not.toThrow();
    });
  });
  test("AC-16: available text output is exact", async () => {
    await withProbe({ platform: "darwin" }, async ({ run, log }) => {
      await run({});
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("Sandbox (srt, darwin): available");
    });
  });
  test("AC-17: unavailable text output is exact", async () => {
    await withProbe({ result: { available: false, reason: "no bwrap" }, platform: "linux" }, async ({ run, log }) => {
      await run({});
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("Sandbox (srt, linux): unavailable: no bwrap");
    });
  });
  test("AC-18: unavailable text returns one", async () => {
    await withProbe({ result: { available: false, reason: "no bwrap" } }, async ({ run }) =>
      expect(await run({})).toBe(1),
    );
  });
  test("AC-19: unavailable text logs exactly once", async () => {
    await withProbe({ result: { available: false, reason: "no bwrap" } }, async ({ run, log }) => {
      await run({});
      expect(log).toHaveBeenCalledTimes(1);
    });
  });
  test("AC-20: CLI barrel exports a callable no-argument handler", async () => {
    await withProbe({}, async () => {
      const { sandboxProbeCommand } = await import("@/cli");
      expect(await sandboxProbeCommand()).toBe(0);
    });
  });
  test("AC-23: unsupported-platform reason passes through verbatim", async () => {
    const reason = "platform linux is not supported by the srt sandbox";
    await withProbe({ result: { available: false, reason } }, async ({ run, log }) => {
      expect(await run({ json: true })).toBe(1);
      const report = JSON.parse(onlyOutput(log));
      expect(report.available).toBe(false);
      expect(report.reason).toBe(reason);
    });
  });
  test("AC-24: command-failure reason passes through verbatim", async () => {
    const reason = "sandbox could not run a command: exit 1";
    await withProbe({ result: { available: false, reason } }, async ({ run, log }) => {
      expect(await run({ json: true })).toBe(1);
      const report = JSON.parse(onlyOutput(log));
      expect(report.available).toBe(false);
      expect(report.reason).toBe(reason);
    });
  });
});

// Live integration setup: use the same real sandbox availability gate as
// test/integration/sandbox/sandbox-live.test.ts. The child is launched from
// the package root (where package.json and bin/nax.ts live).
const { DEFAULT_SANDBOX_CONFIG } = await import("@/config");
const { probeSandboxOnce, sandboxBackendFor } = await import("@/sandbox");
const liveProbe = await probeSandboxOnce(sandboxBackendFor({ ...DEFAULT_SANDBOX_CONFIG, enabled: true }));
const root = resolve(import.meta.dir, "../../..");
async function liveCli() {
  const child = Bun.spawn(["bun", "bin/nax.ts", "sandbox", "probe", "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!liveProbe.available)("live sandbox probe CLI", () => {
  test("AC-21: real sandbox probe JSON CLI exits zero", async () => {
    const { exitCode } = await liveCli();
    expect(exitCode).toBe(0);
  }, 60_000);
  test("AC-22: real sandbox probe JSON CLI reports available srt", async () => {
    const { stdout } = await liveCli();
    const report = JSON.parse(stdout);
    expect(report.available).toBe(true);
    expect(report.backend).toBe("srt");
  }, 60_000);
});