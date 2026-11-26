import { expect, test } from "bun:test";
import { _srtBackendDeps, createSrtBackend } from "#src/sandbox/srt-backend";
import { assertDefined, withDepsRestore } from "#test/helpers/index";

withDepsRestore(_srtBackendDeps);
type Manager = Awaited<ReturnType<typeof _srtBackendDeps.load>>["SandboxManager"];
type Config = Parameters<Manager["initialize"]>[0];

function fixture() {
  const initial: Config[] = [];
  const updates: Config[] = [];
  _srtBackendDeps.platform = () => "darwin";
  _srtBackendDeps.mkdir = async () => undefined;
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async (config) => {
        initial.push(structuredClone(config));
      },
      updateConfig: (config: Config) => {
        updates.push(structuredClone(config));
      },
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async () => ({ argv: ["true"], env: {} }),
      annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    },
  });
  const backend = createSrtBackend({ allowedDomains: ["*"], allowLocalBinding: true });
  const wrap = () =>
    backend.wrap({
      command: "true",
      shell: "/bin/sh",
      cwd: "/repo",
      commandId: "network",
      policy: { writeRoots: [], denyRead: [], denyWrite: [], network: { allowedDomains: ["*"] } },
    });
  return { backend, wrap, initial, updates };
}

test("AC-9: live update replaces only allowedDomains in the initialized config", async () => {
  const { backend, wrap, initial, updates } = fixture();
  await wrap();
  assertDefined(backend.updateNetwork);
  await backend.updateNetwork(["registry.npmjs.org"]);
  const config = initial[0];
  assertDefined(config);
  expect(config.network.allowedDomains).toEqual(["*"]);
  expect(updates).toEqual([{ ...config, network: { ...config.network, allowedDomains: ["registry.npmjs.org"] } }]);
  expect(updates[0]?.network).toEqual({
    allowedDomains: ["registry.npmjs.org"],
    deniedDomains: [],
    allowLocalBinding: true,
  });
});
test("AC-10: pre-init update changes the later initialize without loading srt early", async () => {
  const { backend, wrap, initial, updates } = fixture();
  assertDefined(backend.updateNetwork);
  await backend.updateNetwork(["registry.npmjs.org"]);
  expect(initial).toEqual([]);
  expect(updates).toEqual([]);
  await wrap();
  expect(initial[0]?.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  expect(initial[0]?.network.allowLocalBinding).toBe(true);
});
