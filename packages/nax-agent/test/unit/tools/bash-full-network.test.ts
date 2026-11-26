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
