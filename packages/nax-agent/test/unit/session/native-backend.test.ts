/**
 * S4-0: nativeBackend opens the native session behind the SessionBackend seam
 * (spec 5.2). The facade's own native assembly still exists until Task 5; this
 * suite covers the parallel backend's contract only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BackendOpenContext } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _clientDeps } from "#src/native/client";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { NATIVE_BACKEND_KIND, nativeBackend } from "#src/session/native-backend";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { MODEL } from "#test/helpers/agent-session";
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
