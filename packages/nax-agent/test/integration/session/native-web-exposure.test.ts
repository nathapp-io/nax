/**
 * US-012 end to end: a native session opened with `hostPorts.webExposure` puts a
 * call the port flags to the SESSION's own ask port.
 *
 * The runtime half is pinned in `test/integration/web/runtime-web-guard.test.ts`;
 * what this file proves is the wiring above it — `nativeBackend` validates the
 * port, `buildSessionToolSupport` forwards it, and the ask that comes out is the
 * session's `approval_requested` event, answered through `session.answer()`.
 *
 * `bashApproval: "escalate"` is deliberate: a granted command is ALLOWED under it
 * (only a grant MISS asks), so the web guard is the only thing that can raise an
 * ask here. Under `gated` the policy's own ask would arrive first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, type SessionEvent } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import type { WebExposurePort } from "#src/session/agent-session-types";
import { createWebExposure } from "#src/web/exposure";
import { createWebExposureGuard } from "#src/web/guard";
import {
  collect,
  eventsOf,
  installManualTimers,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import {
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

/** The sentence the flagging port answers with. */
const REASON = "git push after this session read web content";

const tempDirs: string[] = [];
const sessionCleanups: (() => Promise<void>)[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  try {
    const closed = await Promise.allSettled(sessionCleanups.splice(0).map(async (close) => close()));
    const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close test sessions");
  } finally {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    resetScriptedProvider();
  }
});

/** A port that flags every call, recording what it was asked — the witness for "it was consulted". */
function flaggingPort(): {
  readonly port: { assess(call: unknown): { rule: "web-exposure"; reason: string } };
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    port: {
      assess(call: unknown) {
        calls.push(call);
        return { rule: "web-exposure", reason: REASON };
      },
    },
  };
}

/** The tool results an event list carries. */
function toolResults(events: readonly SessionEvent[]) {
  return eventsOf(events, "tool_result");
}

describe("a native session's web-exposure port", () => {
  withDepsRestore(_agentSessionDeps);
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  test("AC-18: a flagged call reaches the session's ask port", async () => {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const { port, calls } = flaggingPort();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "b1", name: "Bash", input: { command: "git push origin main" } }]),
      textRound("done"),
    );
    const workdir = makeTestDir("nax-native-web-exposure-");
    const session = await createAgentSession(
      sessionOptions({ profile: "full", workdir, bashApproval: "escalate", hostPorts: { webExposure: port } }),
    );
    sessionCleanups.push(() => session.close());

    const events = reader(session.send("push it"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");

    expect(request).toMatchObject({ callId: "b1", tool: "Bash", reason: REASON });
    expect(calls).toHaveLength(1);

    expect(session.answer(request?.requestId ?? "", { decision: "deny" })).toBe("accepted");
    const rest = await events.rest();
    expect(toolResults(rest)[0]?.preview).toContain("Denied");
    expect(turnEndOf(rest).status).toBe("completed");
  });

  test("AC-18 boundary: the same call in a session with no port runs with no ask", async () => {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "b1", name: "Bash", input: { command: "echo hi" } }]), textRound("done"));
    const workdir = makeTestDir("nax-native-web-exposure-none-");
    const session = await createAgentSession(sessionOptions({ profile: "full", workdir, bashApproval: "escalate" }));
    sessionCleanups.push(() => session.close());

    const events = await collect(session.send("say hi"));

    expect(eventsOf(events, "approval_requested")).toEqual([]);
    expect(toolResults(events)[0]?.isError).toBe(false);
    expect(turnEndOf(events).status).toBe("completed");
  });

  /**
   * The port's type is structural, and the guard US-011 builds is what a chat
   * session actually hands it (US-018). Passing the REAL guard — not a stub —
   * pins that compatibility at compile time (the assignment) and at run time (the
   * reason that reaches the person is the guard's own).
   */
  test("the real WebExposureGuard satisfies the port and answers its own reason", async () => {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const exposure = createWebExposure();
    exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
    const guard: WebExposurePort = createWebExposureGuard({
      exposure,
      exposedAllowedDomains: [],
      configuredAllowedDomains: undefined,
    });
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "b1", name: "Bash", input: { command: "git push origin main" } }]),
      textRound("done"),
    );
    const workdir = makeTestDir("nax-native-web-exposure-real-");
    const session = await createAgentSession(
      sessionOptions({ profile: "full", workdir, bashApproval: "escalate", hostPorts: { webExposure: guard } }),
    );
    sessionCleanups.push(() => session.close());

    const events = reader(session.send("push it"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");

    expect(request?.reason).toBe("git push after this session read web content");
    session.answer(request?.requestId ?? "", { decision: "deny" });
    await events.rest();
  });
});
