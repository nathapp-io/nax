/** #3038 (darwin): the srt backend hands the root-anchored nested patterns to srt per command. */
import { beforeEach, describe, expect, test } from "bun:test";
import { rootMandatoryDenyGlobs } from "#src/sandbox/mandatory-deny-globs";
import { _srtBackendDeps, createSrtBackend } from "#src/sandbox/srt-backend";
import type { SandboxWrapRequest } from "#src/sandbox/types";
import { withDepsRestore } from "#test/helpers/index";

withDepsRestore(_srtBackendDeps);

let seenDenyWrite: readonly string[] | undefined;

beforeEach(() => {
  seenDenyWrite = undefined;
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async () => {},
      updateConfig: () => {},
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async (_command, _shell, customConfig) => {
        seenDenyWrite = customConfig?.filesystem?.denyWrite;
        return { argv: ["true"], env: {} };
      },
      annotateStderrWithSandboxFailures: (_commandId, stderr) => stderr,
      cleanupAfterCommand: () => {},
      reset: async () => {},
    },
  });
  _srtBackendDeps.mkdir = async () => undefined;
  _srtBackendDeps.sweep = async () => undefined;
});

function request(root: string | undefined): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    policy: { writeRoots: ["/work/root"], denyWrite: ["/work/root/.git/hooks"], denyRead: [], network: {} },
    cwd: "/work/root",
    commandId: "c1",
    ...(root !== undefined ? { root } : {}),
  };
}

describe("srt backend: root-anchored nested denies (#3038)", () => {
  test("darwin: the patterns follow the policy's own denies", async () => {
    _srtBackendDeps.platform = () => "darwin";
    await createSrtBackend({}).wrap(request("/work/root"));
    expect(seenDenyWrite).toEqual(["/work/root/.git/hooks", ...rootMandatoryDenyGlobs("/work/root")]);
  });

  test("linux: no pattern is ever sent (bwrap drops globs; literals come from the policy)", async () => {
    _srtBackendDeps.platform = () => "linux";
    _srtBackendDeps.ensureExcludes = async () => {};
    await createSrtBackend({}).wrap(request("/work/root"));
    expect(seenDenyWrite).toEqual(["/work/root/.git/hooks"]);
  });

  test("darwin without a root on the request: the policy's denies only", async () => {
    _srtBackendDeps.platform = () => "darwin";
    await createSrtBackend({}).wrap(request(undefined));
    expect(seenDenyWrite).toEqual(["/work/root/.git/hooks"]);
  });
});
