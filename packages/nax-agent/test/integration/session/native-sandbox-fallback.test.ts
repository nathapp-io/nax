/**
 * The session sandbox floor end to end (US-001): a native session opened on a
 * machine with no usable sandbox runs unwrapped when the caller allowed it, and
 * reports the state it resolved on `session.backend`. The bash call proves the
 * second half — with the floor's launcher dropped, Bash takes its existing
 * direct-spawn branch, and `raw` runs the command as written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, nativeBackend, type SessionEvent } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _bashToolDeps, DEFAULT_BASH_SHELL } from "#src/tools/index";
import {
  collect,
  eventsOf,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import {
  assertNaxError,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const tempDirs: string[] = [];
const sessionCleanups: (() => Promise<void>)[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function closeTestSessions(): Promise<void> {
  const closed = await Promise.allSettled(sessionCleanups.splice(0).map(async (close) => close()));
  const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, "Failed to close test sessions");
}

async function createTestSession(...args: Parameters<typeof createAgentSession>) {
  const session = await createAgentSession(...args);
  sessionCleanups.push(() => session.close());
  return session;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
  return caught;
}

afterEach(async () => {
  try {
    await closeTestSessions();
  } finally {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    resetScriptedProvider();
  }
});

/** The probe answers "no sandbox here" with `reason`, and the rest of the seam is a working stub. */
function noUsableSandbox(reason: string): void {
  stubSessionSandboxDeps(_sessionSandboxDeps);
  _sessionSandboxDeps.probe = async () => ({ available: false, reason });
}

describe("a native session with no usable sandbox", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  withDepsRestore(_bashToolDeps, ["runArgv"]);

  // AC-14
  test("full + raw + allowUnsandboxed opens and reports the unavailable state", async () => {
    noUsableSandbox("srt missing");
    const session = await createTestSession(
      sessionOptions({
        profile: "full",
        workdir: makeTestDir("nax-sandbox-fallback-"),
        backend: nativeBackend({ model: MODEL, bashApproval: "raw", allowUnsandboxed: true }),
      }),
    );
    expect(session.backend.sandbox).toEqual({ kind: "unavailable", backend: "srt", reason: "srt missing" });
    // The record is what an embedder quotes to a person, so it is frozen and
    // cannot be rewritten after the fact (US-001; the deep case -- an
    // `available` state's `network` list -- is pinned in
    // test/unit/session/agent-session-backend.test.ts).
    expect(Object.isFrozen(session.backend.sandbox)).toBe(true);
    expect(Object.isFrozen(session.backend)).toBe(true);
  });

  // AC-15
  test("a Bash call in that session direct-spawns the shell unwrapped", async () => {
    noUsableSandbox("srt missing");
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "Bash", input: { command: "ls" } }]), textRound("listed it"));
    const calls: Parameters<typeof _bashToolDeps.runArgv>[0][] = [];
    _bashToolDeps.runArgv = async (options) => {
      calls.push(options);
      return { exitCode: 0, stdout: "a.txt", stderr: "", timedOut: false };
    };
    const session = await createTestSession(
      sessionOptions({
        profile: "full",
        workdir: makeTestDir("nax-sandbox-fallback-bash-"),
        backend: nativeBackend({ model: MODEL, bashApproval: "raw", allowUnsandboxed: true }),
      }),
    );
    const events: SessionEvent[] = await collect(session.send("list the root"));
    expect(calls.map((call) => [...call.argv])).toEqual([[DEFAULT_BASH_SHELL, "-c", "ls"]]);
    expect(eventsOf(events, "tool_result")[0]).toMatchObject({ callId: "c1", isError: false });
    expect(turnEndOf(events).status).toBe("completed");
  });

  // AC-19
  test("full + raw without allowUnsandboxed is still refused, naming the fallback option", async () => {
    noUsableSandbox("srt missing");
    const err = await rejectsWith(
      createAgentSession(
        sessionOptions({
          profile: "full",
          workdir: makeTestDir("nax-sandbox-refused-"),
          backend: nativeBackend({ model: MODEL, bashApproval: "raw" }),
        }),
      ),
      "AGENT_SESSION_SANDBOX_UNAVAILABLE",
    );
    expect(err.message).toContain("Pass allowUnsandboxed: true to run without one.");
  });
});

describe("a native session whose profile runs no shell", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  // AC-16, AC-17 and AC-18
  test("read reports the disabled sandbox, the native kind and no capabilities", async () => {
    const session = await createTestSession(
      sessionOptions({ profile: "read", workdir: makeTestDir("nax-sandbox-read-") }),
    );
    expect(session.backend.sandbox).toEqual({ kind: "disabled" });
    expect(session.backend.kind).toBe("native");
    expect(session.backend.capabilities).toEqual({});
  });
});
