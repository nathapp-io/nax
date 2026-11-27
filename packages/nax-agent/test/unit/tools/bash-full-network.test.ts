import { expect, test } from "bun:test";
import type { CommandLauncher, LaunchRequest } from "#src/sandbox/index";
import { createBashTool } from "#src/tools/bash";

const fullNetwork = { isExposed: () => false };
const context = { root: "/repo", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 4096 };
test("AC-14: fullNetwork advertises the full-only network input", () => {
  expect(createBashTool({ fullNetwork }).inputSchema.properties).toHaveProperty("network", {
    type: "string",
    enum: ["full"],
  });
});
test("AC-15: description explains approval and the unsandboxed full-network launch", () => {
  expect(createBashTool({ fullNetwork }).description).toContain(
    'Set "network": "full" only when the command needs a host outside the package registries and git remotes; the user is asked first, and the command then runs outside the sandbox.',
  );
});
test("AC-16: ordinary Bash has no network field", () => {
  expect(createBashTool({}).inputSchema.properties).not.toHaveProperty("network");
});
test("AC-22: ordinary Bash retains exactly its original property set", () => {
  expect(Object.keys(createBashTool({}).inputSchema.properties ?? {}).sort()).toEqual([
    "command",
    "description",
    "timeoutMs",
  ]);
});

for (const exposed of [true, false]) {
  test(`${exposed ? "AC-17" : "AC-18"}: network full launches unwrapped=${exposed} when exposed=${exposed}`, async () => {
    const requests: LaunchRequest[] = [];
    const launcher: CommandLauncher = {
      state: { kind: "available", backend: "srt", network: ["registry.npmjs.org"] },
      run: async (req) => {
        requests.push(req);
        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          executed: [],
          sandbox: { backend: "none", wrapped: false },
        };
      },
    };
    const tool = createBashTool({ fullNetwork: { isExposed: () => exposed }, launcher });
    const result = await tool.run({ command: "echo hi", network: "full" }, context);
    expect(result.isError).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.unwrapped).toBe(exposed);
  });
}

test("stray full network input without opt-in never unwraps", async () => {
  const requests: LaunchRequest[] = [];
  const tool = createBashTool({
    launcher: {
      state: { kind: "available", backend: "srt", network: "open" },
      run: async (req) => {
        requests.push(req);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          executed: [],
          sandbox: { backend: "none", wrapped: false },
        };
      },
    },
  });
  await tool.run({ command: "true", network: "full" }, context);
  expect(requests[0]?.unwrapped).not.toBe(true);
});

/**
 * US-002 ACs 8-10: the runtime's decision arrives on the run context, and it
 * WINS over the tool's own `fullNetwork` option — in both directions, because
 * an approval granted while the session was unexposed must not become an escape
 * just because the session read a page while the ask was open.
 */
function recordingLauncher(requests: LaunchRequest[]): CommandLauncher {
  return {
    state: { kind: "available", backend: "srt", network: ["registry.npmjs.org"] },
    run: async (req) => {
      requests.push(req);
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        executed: [],
        sandbox: { backend: "none", wrapped: false },
      };
    },
  };
}

/** The run context plus US-002's field, omitted when the case is a control for its absence. */
function contextWith(fullNetworkUnwrapped?: boolean) {
  return { ...context, ...(fullNetworkUnwrapped === undefined ? {} : { fullNetworkUnwrapped }) };
}

test("AC-8: a run context decided unwrapped launches unwrapped over an unexposed option", async () => {
  const requests: LaunchRequest[] = [];
  const tool = createBashTool({ fullNetwork: { isExposed: () => false }, launcher: recordingLauncher(requests) });
  const result = await tool.run({ command: "echo hi", network: "full" }, contextWith(true));
  expect(result.isError).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.unwrapped).toBe(true);
});

test("AC-9: a run context decided wrapped launches wrapped over an exposed option", async () => {
  const requests: LaunchRequest[] = [];
  const tool = createBashTool({ fullNetwork: { isExposed: () => true }, launcher: recordingLauncher(requests) });
  await tool.run({ command: "echo hi", network: "full" }, contextWith(false));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.unwrapped).toBe(false);
});

test("AC-10: with no run-context decision the tool's exposed option still unwraps", async () => {
  const requests: LaunchRequest[] = [];
  const tool = createBashTool({ fullNetwork: { isExposed: () => true }, launcher: recordingLauncher(requests) });
  await tool.run({ command: "echo hi", network: "full" }, contextWith());
  expect(requests).toHaveLength(1);
  expect(requests[0]?.unwrapped).toBe(true);
});
