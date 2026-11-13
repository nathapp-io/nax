import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createCommandLauncher,
  networkDenialHintLine,
  SANDBOX_STATUS_LINE,
  type SandboxPolicy,
  socketDenialHintLine,
  unsandboxedNextStepLine,
} from "#src/sandbox/index";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-status-");
});
afterEach(() => cleanupTempDir(root));

const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;

async function runFailing(command: string, extra: { unsandboxedOffered?: boolean; unwrapped?: true } = {}) {
  const launcher = createCommandLauncher({
    state: available,
    backend: makeFakeSandboxBackend("enforce"),
    policyFor: async (r) => policy(r),
  });
  return launcher.run({
    spec: { kind: "shell", shell: "/bin/sh", command },
    root,
    cwd: root,
    timeoutMs: 5000,
    stripEnvVars: [],
    ...extra,
  });
}

describe("failed wrapped command status (#2890)", () => {
  test("lowercase 'operation not permitted' gets the denial hint and the status line", async () => {
    const r = await runFailing("echo 'dial unix /var/run/docker.sock: socket: operation not permitted' >&2; exit 1");
    expect(r.stderr).toContain(socketDenialHintLine());
    expect(r.stderr).toContain(SANDBOX_STATUS_LINE);
    expect(r.sandbox.denialHint).toBe(true);
  });

  test.each([
    "fatal: unable to access: CONNECT tunnel failed, response 403",
    "socat E CONNECT gitlab.com:22: Forbidden",
  ])("network refusal '%s' gets the network hint and the status line", async (line) => {
    const r = await runFailing(`echo '${line}' >&2; exit 128`);
    expect(r.stderr).toContain(networkDenialHintLine("open"));
    expect(r.stderr).not.toContain("writable roots");
    expect(r.stderr).toContain(SANDBOX_STATUS_LINE);
    expect(r.sandbox.denialHint).toBe(true);
  });

  const DOCKER = "dial unix /var/run/docker.sock: socket: operation not permitted";

  test("a socket refusal gets its own hint, not the writable-roots hint", async () => {
    const r = await runFailing(`echo '${DOCKER}' >&2; exit 1`);
    expect(r.stderr).toContain(socketDenialHintLine());
    expect(r.stderr).not.toContain("writable roots");
    expect(r.sandbox.denialHint).toBe(true);
  });

  test("a plain EPERM keeps the denial hint and status line but gets no next step", async () => {
    const r = await runFailing("echo 'kill: (1) - Operation not permitted' >&2; exit 1", { unsandboxedOffered: true });
    expect(r.stderr).toContain("writable roots");
    expect(r.stderr).toContain(SANDBOX_STATUS_LINE);
    expect(r.stderr).not.toContain(unsandboxedNextStepLine(true));
    expect(r.stderr).not.toContain(unsandboxedNextStepLine(false));
  });

  test("a read-only file system write denial gets no next step", async () => {
    const r = await runFailing("echo 'cannot create /x: Read-only file system' >&2; exit 1", {
      unsandboxedOffered: true,
    });
    expect(r.stderr).not.toContain("unsandboxed: true");
  });

  test("a network refusal gets the next step", async () => {
    const r = await runFailing("echo 'socat E CONNECT gitlab.com:22: Forbidden' >&2; exit 1", {
      unsandboxedOffered: true,
    });
    expect(r.stderr).toContain(unsandboxedNextStepLine(true));
  });

  test("a real server 403 is not a network denial", async () => {
    const r = await runFailing("echo 'The requested URL returned error: 403' >&2; exit 22", {
      unsandboxedOffered: true,
    });
    expect(r.sandbox.denialHint).toBeUndefined();
    expect(r.stderr).not.toContain("note: this command ran");
    expect(r.stderr).not.toContain("unsandboxed: true");
  });

  test("next step offers unsandboxed only when the session advertises it", async () => {
    const offered = await runFailing(`echo '${DOCKER}' >&2; exit 1`, { unsandboxedOffered: true });
    expect(offered.stderr).toContain(unsandboxedNextStepLine(true));
    expect(offered.stderr).toContain("`unsandboxed: true`");
    const notOffered = await runFailing(`echo '${DOCKER}' >&2; exit 1`);
    expect(notOffered.stderr).toContain(unsandboxedNextStepLine(false));
    expect(notOffered.stderr).not.toContain("unsandboxed: true");
    expect(notOffered.stderr).toContain("allowUnsandboxedCommands");
  });

  test("a plain failure gets the status line but no denial hint or next step", async () => {
    const r = await runFailing("exit 3");
    expect(r.stderr).toContain(SANDBOX_STATUS_LINE);
    expect(r.stderr).not.toContain("note: this command ran");
    expect(r.stderr).not.toContain("unsandboxed: true");
  });

  test("a wrapped command that exits 0 gets no extra lines", async () => {
    const r = await runFailing("echo 'x: operation not permitted' >&2; exit 0");
    expect(r.stderr).not.toContain("[nax]");
    expect(r.stderr).not.toContain("note: this command ran");
  });

  test("an unwrapped command never gets the INSIDE line", async () => {
    const r = await runFailing("echo 'x: operation not permitted' >&2; exit 1", { unwrapped: true });
    expect(r.sandbox.wrapped).toBe(false);
    expect(r.stderr).not.toContain("INSIDE the sandbox");
  });
});
