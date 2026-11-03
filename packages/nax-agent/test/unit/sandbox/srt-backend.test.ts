import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { _srtBackendDeps, createSrtBackend, probeSandbox, type SandboxWrapRequest } from "#src/sandbox/index";

const backend = createSrtBackend({});
const probe = await probeSandbox(backend);
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

describe(`srt backend (${label})`, () => {
  afterAll(() => backend.reset());

  test.skipIf(!probe.available)("open network: the wrapped argv sets no proxy variables", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t1",
    });
    backend.commandFinished();
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY=");
  });

  test.skipIf(!probe.available)("wrap returns argv only -- the backend's env never crosses (F6)", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t2",
    });
    backend.commandFinished();
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.every((a) => typeof a === "string")).toBe(true);
  });
});

/**
 * Linux bwrap mount-point cleanup.
 *
 * srt counts every wrapped command itself (`activeSandboxCount`, incremented per
 * `wrapWithSandboxArgv`, decremented per `cleanupAfterCommand`) and deletes the
 * placeholder files (`.bashrc`, `.profile`, `.claude/commands`, ...) only when its
 * count reaches zero. The backend must therefore call `cleanupAfterCommand` once
 * per finished command. Gating that call behind a second, nax-side counter leaks
 * srt's count after any overlap, and the placeholders then outlive every command.
 */
/** A stand-in for srt that keeps srt's own count and reports when it would delete placeholders. */
function installCountingSrt(opts: { readonly wrapThrows?: boolean } = {}): {
  readonly cleanups: () => number;
  readonly placeholdersRemoved: () => number;
} {
  let active = 0;
  let cleanups = 0;
  let placeholdersRemoved = 0;
  _srtBackendDeps.load = async () => ({
    SandboxManager: {
      initialize: async () => {},
      isSupportedPlatform: () => true,
      wrapWithSandboxArgv: async () => {
        if (opts.wrapThrows) throw new Error("bwrap profile too long");
        active += 1;
        return { argv: ["/bin/sh", "-c", "true"], env: {} };
      },
      annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
      cleanupAfterCommand: () => {
        cleanups += 1;
        if (active > 0) active -= 1;
        if (active === 0) placeholdersRemoved += 1;
      },
      reset: async () => {},
    },
  });
  _srtBackendDeps.mkdir = async () => undefined;
  return { cleanups: () => cleanups, placeholdersRemoved: () => placeholdersRemoved };
}

function request(commandId: string): SandboxWrapRequest {
  return {
    command: "true",
    shell: "/bin/sh",
    policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
    cwd: process.cwd(),
    commandId,
  };
}

describe("srt backend mount-point cleanup", () => {
  const realLoad = _srtBackendDeps.load;
  const realMkdir = _srtBackendDeps.mkdir;

  afterEach(() => {
    _srtBackendDeps.load = realLoad;
    _srtBackendDeps.mkdir = realMkdir;
  });

  test("each finished command reports its cleanup to srt", async () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(request("a"));
    await backend.wrap(request("b"));
    backend.commandFinished();
    backend.commandFinished();

    expect(srt.cleanups()).toBe(2);
  });

  test("placeholders are removed once overlapping commands have all finished", async () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(request("a"));
    await backend.wrap(request("b"));
    backend.commandFinished();
    expect(srt.placeholdersRemoved()).toBe(0);
    backend.commandFinished();

    expect(srt.placeholdersRemoved()).toBe(1);
  });

  test("a later lone command still removes its placeholders after an earlier overlap", async () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    await backend.wrap(request("a"));
    await backend.wrap(request("b"));
    backend.commandFinished();
    backend.commandFinished();
    await backend.wrap(request("c"));
    backend.commandFinished();

    expect(srt.placeholdersRemoved()).toBe(2);
  });

  test("a wrap that throws leaves srt's count alone and reaches no cleanup", async () => {
    const srt = installCountingSrt({ wrapThrows: true });
    const backend = createSrtBackend({});

    await expect(backend.wrap(request("a"))).rejects.toThrow("bwrap profile too long");

    expect(srt.cleanups()).toBe(0);
  });

  test("commandFinished before any wrap does not reach srt", () => {
    const srt = installCountingSrt();
    const backend = createSrtBackend({});

    backend.commandFinished();

    expect(srt.cleanups()).toBe(0);
  });
});
