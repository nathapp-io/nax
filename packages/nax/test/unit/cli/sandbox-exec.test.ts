import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeFakeSandboxBackend } from "@test/helpers/sandbox";
import { _sandboxExecDeps as deps, sandboxExecCommand } from "@/cli/sandbox-exec";

const original = { ...deps };
const file = {
  version: 1,
  home: "/home/real",
  stripEnv: ["CURSOR_API_KEY"],
  policy: { writeRoots: ["/tmp"], denyWrite: [], denyRead: [], network: {} },
};
let backend: ReturnType<typeof makeFakeSandboxBackend>;
let handlers: Map<string, () => void>;
const kill = mock((_signal: string) => {});

beforeEach(() => {
  backend = makeFakeSandboxBackend("leak");
  backend.reset = mock(async () => {});
  backend.wrap = mock(async () => ["/bin/sh", "-c", "exit 3"]);
  handlers = new Map();
  kill.mockClear();
  Object.assign(deps, {
    readFile: mock(async () => JSON.stringify(file)),
    createBackend: mock(() => backend),
    cwd: () => "/tmp",
    env: () => ({ CURSOR_API_KEY: "k", PATH: "/bin", ABSENT: undefined }),
    spawn: mock(() => ({ exited: Promise.resolve({ exitCode: 3, signal: null }), kill })),
    onSignal: (signal: string, handler: () => void) => {
      handlers.set(signal, handler);
    },
    stderr: mock((_line: string) => {}),
  });
});
afterEach(() => {
  Object.assign(deps, original);
});

describe("sandbox exec", () => {
  test("AC-1..4,11,14: wraps, restores HOME, strips credentials and cleans up without stdout", async () => {
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await sandboxExecCommand("policy", "exit 3")).toBe(3);
      expect(deps.createBackend).toHaveBeenCalledWith(file.policy.network);
      expect(backend.wrap).toHaveBeenCalledWith({
        command: "exit 3",
        shell: "/bin/bash",
        policy: file.policy,
        cwd: "/tmp",
        commandId: expect.any(String),
      });
      expect(deps.spawn).toHaveBeenCalledWith(["/bin/sh", "-c", "exit 3"], {
        cwd: "/tmp",
        env: { HOME: "/home/real", PATH: "/bin" },
      });
      expect(backend.finished).toBe(1);
      expect(backend.reset).toHaveBeenCalledTimes(1);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
  test("AC-1: fake backend argv runs through the real spawn and exits 3", async () => {
    deps.spawn = original.spawn;
    expect(await sandboxExecCommand("policy", "exit 3")).toBe(3);
  });
  test("AC-14: exit zero emits no stdout", async () => {
    deps.spawn = () => ({ exited: Promise.resolve({ exitCode: 0, signal: null }), kill });
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await sandboxExecCommand("policy", "exit 0")).toBe(0);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
  test("exit rejection still finishes and resets; reset failure preserves verdict", async () => {
    deps.spawn = () => ({ exited: Promise.reject(new Error("wait failed")), kill });
    backend.reset = mock(async () => {
      throw new Error("reset failed");
    });
    expect(await sandboxExecCommand("policy", "true")).toBe(126);
    expect(backend.finished).toBe(1);
    expect(backend.reset).toHaveBeenCalledTimes(1);
    expect(deps.stderr).toHaveBeenCalledWith("nax sandbox exec: wait failed");
  });
  test.each(["missing", "unreadable"])("AC-5,18: %s file fails closed", async (reason) => {
    deps.readFile = async () => {
      throw new Error(reason);
    };
    expect(await sandboxExecCommand("bad", "true")).toBe(126);
    expect(deps.stderr).toHaveBeenCalledWith(`nax sandbox exec: ${reason}`);
    expect(backend.wrap).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  test.each([
    "not JSON",
    JSON.stringify({ ...file, version: 2 }),
    JSON.stringify({ ...file, extra: 1 }),
    JSON.stringify({ ...file, policy: { ...file.policy, extra: 1 } }),
    JSON.stringify({ ...file, policy: { ...file.policy, network: { extra: 1 } } }),
    JSON.stringify({ ...file, policy: { ...file.policy, network: { allowLocalBinding: false } } }),
  ])("AC-6,7,18: rejects malformed or non-strict policy %s", async (text) => {
    deps.readFile = async () => text;
    expect(await sandboxExecCommand("bad", "true")).toBe(126);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/^nax sandbox exec:/));
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  test.each(["unsupported", "wrap"])("AC-8,9,19,20: %s fails closed with reset", async (failure) => {
    if (failure === "unsupported") backend.isSupportedPlatform = async () => false;
    else
      backend.wrap = async () => {
        throw new Error("wrap failed");
      };
    expect(await sandboxExecCommand("policy", "true")).toBe(126);
    expect(deps.stderr).toHaveBeenCalledWith(
      `nax sandbox exec: ${failure === "unsupported" ? "the OS sandbox is not available on this host" : "wrap failed"}`,
    );
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(backend.reset).toHaveBeenCalledTimes(1);
  });
  test("AC-10,12: forwards both signals while running and returns signal exit status", async () => {
    deps.spawn = () => ({
      kill,
      exited: Promise.resolve().then(() => {
        handlers.get("SIGINT")?.();
        handlers.get("SIGTERM")?.();
        return { exitCode: null, signal: "SIGTERM" };
      }),
    });
    expect(await sandboxExecCommand("policy", "true")).toBe(143);
    expect(kill.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
  });
  test("preserves HOME when omitted, cleans up after spawn failure", async () => {
    deps.readFile = async () => JSON.stringify({ ...file, home: undefined });
    deps.env = () => ({ HOME: "/original" });
    deps.spawn = mock(() => {
      throw new Error("spawn failed");
    });
    expect(await sandboxExecCommand("policy", "true")).toBe(126);
    expect(deps.spawn).toHaveBeenCalledWith(expect.any(Array), { cwd: "/tmp", env: { HOME: "/original" } });
    expect(backend.finished).toBe(0);
    expect(backend.reset).toHaveBeenCalledTimes(1);
  });
});
