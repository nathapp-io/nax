/**
 * S4-0: nativeBackend opens the native session behind the SessionBackend seam
 * (spec 5.2). The facade's own native assembly still exists until Task 5; this
 * suite covers the parallel backend's contract only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type BackendOpenContext, createAgentSession } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _clientDeps } from "#src/native/client";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _launcherDeps } from "#src/sandbox/index";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { NATIVE_BACKEND_KIND, nativeBackend } from "#src/session/native-backend";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { DEFAULT_BASH_SHELL } from "#src/tools/index";
import {
  collect,
  eventsOf,
  installManualTimers,
  installScriptedProvider,
  MODEL,
  reader,
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

async function openBackend(backend: ReturnType<typeof nativeBackend>, context: BackendOpenContext) {
  const opened = await backend.open(context);
  sessionCleanups.push(async () => {
    try {
      await opened.adapter.closeSession(opened.handle);
    } finally {
      await opened.close();
    }
  });
  return opened;
}

afterEach(async () => {
  try {
    await closeTestSessions();
  } finally {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    resetScriptedProvider();
  }
});

const IDLE = new AbortController().signal;

async function ctx(extra: Partial<BackendOpenContext> = {}): Promise<BackendOpenContext> {
  const workdir = makeTestDir("nax-native-backend-");
  const table = createPendingAskTable(30_000);
  return {
    sessionId: "s1",
    workdir,
    profile: "read",
    instructions: undefined,
    tools: [],
    transcriptStore: createMemoryTranscriptStore(),
    resume: undefined,
    asks: createSessionAskPort({ table, emit: () => {}, turn: () => undefined }),
    turnSignal: () => IDLE,
    currentTurnId: () => undefined,
    turnTimeoutSeconds: 60,
    metadata: {},
    openSignal: IDLE,
    ...extra,
  };
}

describe("nativeBackend", () => {
  test("has kind native and opens with the read tool set", async () => {
    const backend = nativeBackend({ model: MODEL });
    expect(backend.kind).toBe(NATIVE_BACKEND_KIND);
    const opened = await openBackend(backend, await ctx());
    expect(opened.info).toEqual({ kind: "native", capabilities: {}, sandbox: { kind: "disabled" } });
    const names = (opened.turnOpts().codingTools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Git"]));
    expect(names).not.toContain("Write");
    await opened.adapter.closeSession(opened.handle);
    await opened.close();
    await opened.close(); // idempotent
  });

  test("validates its options at construction", () => {
    let caught: unknown;
    try {
      nativeBackend({ model: "no-provider" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("a resume from a document written by another model is refused", async () => {
    const backend = nativeBackend({ model: MODEL });
    const doc = { savedAt: new Date(0).toISOString(), messages: [], model: "anthropic/other" };
    let caught: unknown;
    try {
      await openBackend(backend, await ctx({ resume: { doc } }));
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_MODEL_MISMATCH");
  });

  test("carryHistoryAcrossModels lets a resume read another model's document", async () => {
    const backend = nativeBackend({ model: MODEL, carryHistoryAcrossModels: true });
    const doc = { savedAt: new Date(0).toISOString(), messages: [], model: "anthropic/other" };
    const opened = await openBackend(backend, await ctx({ resume: { doc } }));
    await opened.close();
  });

  test("embedder tools are advertised after the built-ins", async () => {
    const tool = {
      name: "lookup",
      description: "d",
      inputSchema: { type: "object" },
      approval: "never" as const,
      run: async () => ({ content: "x" }),
    };
    const opened = await openBackend(nativeBackend({ model: MODEL }), await ctx({ profile: "none", tools: [tool] }));
    const names = (opened.turnOpts().codingTools ?? []).map((t) => t.name);
    expect(names.at(-1)).toBe("lookup");
    await opened.adapter.closeSession(opened.handle);
  });

  test("construction is validation-only: no credentials or catalog are touched, and bad compaction throws", () => {
    const real = _clientDeps.build;
    let builds = 0;
    _clientDeps.build = async (...args) => {
      builds += 1;
      return real(...args);
    };
    try {
      expect(() => nativeBackend({ model: "nosuch/unknown-model", compaction: { enabled: true } })).not.toThrow();
      expect(builds).toBe(0);
      let caught: unknown;
      try {
        nativeBackend({ model: "nosuch/unknown-model", compaction: { compactAtPercent: 10 } });
      } catch (err) {
        caught = err;
      }
      assertNaxError(caught);
      expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    } finally {
      _clientDeps.build = real;
    }
  });
});

/**
 * US-003: `allowUnsandboxedCommands` is the profile's validated opt-in for
 * Bash's per-call `unsandboxed` argument. This pins the THREADING — from
 * nativeBackend's own options, through `nativeProfileRules`, into the tool the
 * session advertises. The `review` profile reaches Bash without the write tools
 * and requires a usable sandbox, so the seam is stubbed; the end-to-end
 * `createAgentSession` case lives in
 * test/integration/session/native-unsandboxed-commands.test.ts.
 */
describe("nativeBackend — unsandboxedCommands", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  async function bashPropertyKeys(extra: { readonly allowUnsandboxedCommands?: boolean }): Promise<string[]> {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const opened = await openBackend(nativeBackend({ model: MODEL, ...extra }), await ctx({ profile: "review" }));
    const bash = (opened.turnOpts().codingTools ?? []).find((tool) => tool.name === "Bash");
    if (bash === undefined) throw new Error("the review profile must advertise Bash");
    // Read without casting to a Capitalised type, which the looseCast ratchet counts.
    const properties: unknown = bash.inputSchema.properties;
    if (typeof properties !== "object" || properties === null) {
      throw new Error("expected the Bash tool's inputSchema.properties to be an object");
    }
    return Object.keys(properties).sort();
  }

  test("the option reaches the advertised Bash tool, and is absent without it", async () => {
    expect(await bashPropertyKeys({ allowUnsandboxedCommands: true })).toContain("unsandboxed");
    expect(await bashPropertyKeys({})).not.toContain("unsandboxed");
  });
});

/**
 * US-007: the ASSEMBLED session, end to end.
 *
 * US-001..US-006 proved each seam on its own; this block proves they are wired
 * to each other through `createAgentSession` with a scripted model, for the
 * three modes that decide what an escape request does. No production code
 * changed for this story — the subject is the wiring, so the assertions are
 * behavioural: which event the person sees, which argv actually runs, and
 * whether the sandbox's `wrap` was skipped.
 *
 * The probe is stubbed available (a "full" session needs a usable sandbox) and
 * `_launcherDeps.runArgv` is stubbed so `curl x` never runs. `backend.wrap` is
 * the fake sandbox backend from `stubSessionSandboxDeps`, so its `calls` are
 * the record of what the session asked the OS sandbox to do.
 */
type NativeOptions = Parameters<typeof nativeBackend>[0];

describe("nativeBackend — the assembled session's unsandboxed Bash escape", () => {
  withDepsRestore(_agentSessionDeps);
  withDepsRestore(_sessionSandboxDeps);
  withDepsRestore(_launcherDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  /** Records every `runArgv` the launcher makes, so no scripted command ever executes. */
  function stubLauncherRunArgv(): (readonly string[])[] {
    const calls: (readonly string[])[] = [];
    _launcherDeps.runArgv = async (options) => {
      calls.push([...options.argv]);
      return { exitCode: 0, stdout: "ran", stderr: "", timedOut: false, aborted: false, orphansKilled: false };
    };
    return calls;
  }

  async function openFullSession(backend: NativeOptions) {
    const workdir = makeTestDir("nax-session-unsandboxed-");
    const session = await createAgentSession(
      sessionOptions({ profile: "full", workdir, backend: nativeBackend(backend) }),
    );
    sessionCleanups.push(() => session.close());
    return session;
  }

  test("AC-1..AC-3: under gated the escape asks with its reason, and an allow runs the logical argv unwrapped", async () => {
    installManualTimers();
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const runArgvCalls = stubLauncherRunArgv();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([
        { id: "u1", name: "Bash", input: { command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" } },
      ]),
      textRound("ok"),
    );
    const session = await openFullSession({ model: MODEL, bashApproval: "gated", allowUnsandboxedCommands: true });

    const events = reader(session.send("reach the network"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "u1", tool: "Bash", unsandboxed: true });
    expect(request?.reason).toContain("runs OUTSIDE the sandbox: needs network");

    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    expect(turnEndOf(await events.rest()).status).toBe("completed");
    expect(runArgvCalls).toEqual([[DEFAULT_BASH_SHELL, "-c", "curl x"]]);
    // The sandbox stayed on for the session: wrap was never even asked.
    expect(seam.backend.calls).toEqual([]);
  });

  test("AC-4..AC-5: a denial runs nothing, wraps nothing, and the model gets a refused tool result", async () => {
    installManualTimers();
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const runArgvCalls = stubLauncherRunArgv();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([
        { id: "u1", name: "Bash", input: { command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" } },
      ]),
      textRound("ok"),
    );
    const session = await openFullSession({ model: MODEL, bashApproval: "gated", allowUnsandboxedCommands: true });

    const events = reader(session.send("reach the network"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    session.answer(request?.requestId ?? "", { decision: "deny" });
    expect(turnEndOf(await events.rest()).status).toBe("completed");

    expect(runArgvCalls).toEqual([]);
    expect(seam.backend.calls).toEqual([]);
    // ADR-029 §5: a refusal is STRUCTURAL (`denied`), not a crash (`isError`) —
    // the model gets a tool result carrying the operator's reason.
    const refusal = provider.requests[1]?.messages.find((message) => message.role === "tool-result");
    expect(refusal).toMatchObject({ toolCallId: "u1", denied: { breach: false } });
    expect(JSON.stringify(refusal)).toContain("Denied:");
  });

  test("AC-6: a later ordinary Bash call in the same session is wrapped again", async () => {
    installManualTimers();
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const runArgvCalls = stubLauncherRunArgv();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([
        { id: "u1", name: "Bash", input: { command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" } },
      ]),
      textRound("ok"),
      toolRound([{ id: "b2", name: "Bash", input: { command: "ls" } }]),
      textRound("done"),
    );
    const session = await openFullSession({ model: MODEL, bashApproval: "gated", allowUnsandboxedCommands: true });

    const firstTurn = reader(session.send("reach the network"));
    const [unwrapped] = eventsOf(await firstTurn.until("approval_requested"), "approval_requested");
    expect(session.answer(unwrapped?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    await firstTurn.rest();

    const ordinary = reader(session.send("list the root"));
    const [wrapped] = eventsOf(await ordinary.until("approval_requested"), "approval_requested");
    expect(wrapped?.unsandboxed).toBeUndefined();
    expect(session.answer(wrapped?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    await ordinary.rest();

    // The ordinary call went through the sandbox; the escape did not.
    expect(seam.backend.calls).toHaveLength(1);
    expect(seam.backend.calls[0]?.command).toContain("ls");
    expect(runArgvCalls[0]).toEqual([DEFAULT_BASH_SHELL, "-c", "curl x"]);
    expect(runArgvCalls[1]?.[2]).toContain("ls");
  });

  test("AC-7..AC-9: under raw the escape never asks, runs unwrapped, and is never wrapped", async () => {
    installManualTimers();
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const runArgvCalls = stubLauncherRunArgv();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "u1", name: "Bash", input: { command: "curl x", unsandboxed: true } }]),
      textRound("ok"),
    );
    const session = await openFullSession({ model: MODEL, bashApproval: "raw", allowUnsandboxedCommands: true });

    const events = await collect(session.send("reach the network"));
    expect(eventsOf(events, "approval_requested")).toEqual([]);
    expect(turnEndOf(events).status).toBe("completed");
    expect(runArgvCalls).toEqual([[DEFAULT_BASH_SHELL, "-c", "curl x"]]);
    expect(seam.backend.calls).toEqual([]);
  });

  test("AC-10..AC-12: without allowUnsandboxedCommands no ask is raised, the model is told why, nothing runs", async () => {
    installManualTimers();
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const runArgvCalls = stubLauncherRunArgv();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "u1", name: "Bash", input: { command: "curl x", unsandboxed: true } }]),
      textRound("ok"),
    );
    const session = await openFullSession({ model: MODEL, bashApproval: "gated" });

    const events = await collect(session.send("reach the network"));
    expect(eventsOf(events, "approval_requested")).toEqual([]);
    const refusal = provider.requests[1]?.messages.find((message) => message.role === "tool-result");
    expect(refusal).toMatchObject({ toolCallId: "u1", isError: true });
    expect(JSON.stringify(refusal)).toContain("allowUnsandboxedCommands");
    expect(runArgvCalls).toEqual([]);
    expect(seam.backend.calls).toEqual([]);
  });
});
