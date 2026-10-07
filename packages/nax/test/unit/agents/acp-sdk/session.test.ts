import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFileTranscriptStore,
  isProcessAlive,
  NO_OP_INTERACTION_HANDLER,
  type OpenSessionOpts,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { fakeAcpBackend, fakeMethods, fakeStartPids } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, createSession, reopenFresh, shutdownSession } from "@/agents/acp-sdk/session";
import { runTurnLoop } from "@/agents/acp-sdk/turn-loop";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpSdkDeps };
let dir = "";
let record = "";
let transcripts = "";

beforeEach(() => {
  dir = makeTempDir("acp-sdk-session-");
  record = join(dir, "record.jsonl");
  transcripts = join(dir, "sessions");
  _acpSdkDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
});

afterEach(() => {
  Object.assign(_acpSdkDeps, REAL);
  cleanupTempDir(dir);
});

function opts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 60,
    transcriptDir: transcripts,
    trackedSpawnDeadlineMs: 2_000,
    ...overrides,
  };
}

function useFake(script: Record<string, unknown> = {}): void {
  _acpSdkDeps.acpBackend = fakeAcpBackend(script, record);
}

const RESUMABLE = { capabilities: { sessionCapabilities: { resume: {} } } };

describe("createSession (spec §6.1)", () => {
  test("opens a fresh session: model set, handle carries the ACP session id, document saved", async () => {
    useFake();
    const session = await createSession("nax-s1", "claude", opts({ modelTier: "balanced" }));
    expect(session.handle).toMatchObject({
      id: "nax-s1",
      agentName: "claude",
      protocolIds: { sessionId: "fake-session-1", recordId: "fake-session-1" },
      modelTier: "balanced",
    });
    expect(fakeMethods(record)).toContain("session/new");
    expect(fakeMethods(record)).toContain("session/set_config_option");
    expect(await createFileTranscriptStore(transcripts).load("nax-s1")).toMatchObject({ backend: "acp:claude" });
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("a matching crash-leftover document is resumed, not recreated", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s2", {
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "claude", cwd: dir },
      savedAt: "2026-10-07T00:00:00Z",
      messages: [],
    });
    const session = await createSession("nax-s2", "claude", opts());
    expect(fakeMethods(record)).toContain("session/resume");
    expect(fakeMethods(record)).not.toContain("session/new");
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("a leftover for another agent is discarded and the session opens fresh (D2-j)", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s3", {
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "codex", cwd: dir },
      savedAt: "2026-10-07T00:00:00Z",
      messages: [],
    });
    const session = await createSession("nax-s3", "claude", opts());
    expect(fakeMethods(record)).toContain("session/new");
    expect(fakeMethods(record)).not.toContain("session/resume");
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("a native transcript under the same name is discarded (Review Focus 2)", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s4", { savedAt: "2026-10-07T00:00:00Z", messages: [] });
    const session = await createSession("nax-s4", "claude", opts());
    expect(fakeMethods(record)).toContain("session/new");
    expect(await createFileTranscriptStore(transcripts).load("nax-s4")).toMatchObject({ backend: "acp:claude" });
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("a leftover the agent no longer knows is discarded after NOT_FOUND", async () => {
    useFake(RESUMABLE);
    await createFileTranscriptStore(transcripts).save("nax-s5", {
      backend: "acp:claude",
      acp: { agentSessionId: "gone-session", agent: "claude", cwd: dir },
      savedAt: "2026-10-07T00:00:00Z",
      messages: [],
    });
    const session = await createSession("nax-s5", "claude", opts());
    expect(fakeMethods(record)).toEqual(expect.arrayContaining(["session/resume", "session/new"]));
    expect(session.handle.protocolIds?.sessionId).toBe("fake-session-1");
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("an unreadable leftover is discarded", async () => {
    useFake();
    await createFileTranscriptStore(transcripts).save("nax-s6", { savedAt: "t", messages: [] });
    writeFileSync(join(transcripts, "nax-s6.transcript.json"), "{ not json", "utf8");
    const session = await createSession("nax-s6", "claude", opts());
    expect(fakeMethods(record)).toContain("session/new");
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("an open failure that is not a leftover problem propagates", async () => {
    useFake({ newSessionFailure: { code: -32603, message: "boom" } });
    await expect(createSession("nax-s7", "claude", opts())).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
    });
  }, 20_000);

  test("an already-aborted run signal fails the open and unlinks the no-op remover", async () => {
    useFake();
    const runSignal = new AbortController();
    runSignal.abort(new Error("run aborted before the session opened"));
    await expect(createSession("nax-s8", "claude", opts({ signal: runSignal.signal }))).rejects.toThrow();
    expect(await createFileTranscriptStore(transcripts).load("nax-s8")).toBeNull();
  }, 20_000);

  test("the startup deadline bounds initialize: a hung agent fails the open BACKEND_UNAVAILABLE (§7.2)", async () => {
    useFake({ hangInitialize: true });
    await expect(
      createSession("nax-start", "claude", opts({ trackedSpawnStartupDeadlineMs: 50 })),
    ).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
    });
  }, 20_000);
});

describe("shutdownSession and reopenFresh", () => {
  test("close ends the agent process and deletes the document", async () => {
    useFake();
    const session = await createSession("nax-c1", "claude", opts());
    const [pid] = fakeStartPids(record);
    await shutdownSession(session, { waitMs: 2_000 });
    expect(session.closer.signal.aborted).toBe(true);
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
    expect(await createFileTranscriptStore(transcripts).load("nax-c1")).toBeNull();
  }, 20_000);

  test("pid hooks feed nax's registry; a forced close kills the process group at once (review M1)", async () => {
    useFake();
    const spawned: number[] = [];
    const exited: number[] = [];
    const session = await createSession(
      "nax-c3",
      "claude",
      opts({ onPidSpawned: (pid) => spawned.push(pid), onPidExited: (pid) => exited.push(pid) }),
    );
    const [pid] = fakeStartPids(record);
    expect(spawned).toEqual([pid ?? -1]);
    expect(session.process.pid).toBe(pid);
    await shutdownSession(session, { waitMs: 2_000, force: true });
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
    await waitForCondition(() => exited.includes(pid ?? -1), 5_000);
  }, 20_000);

  test("reopenFresh closes the old process and opens a new session without resume (D2-l)", async () => {
    useFake(RESUMABLE);
    const session = await createSession("nax-c2", "claude", opts());
    const before = session.opened;
    await reopenFresh(session);
    expect(session.opened).not.toBe(before);
    expect(fakeStartPids(record)).toHaveLength(2);
    expect(fakeMethods(record).filter((m) => m === "session/new")).toHaveLength(2);
    expect(fakeMethods(record)).not.toContain("session/resume");
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("a run signal aborts the closer and is unlinked on close", async () => {
    useFake();
    const runSignal = new AbortController();
    const session = await createSession("nax-c4", "claude", opts({ signal: runSignal.signal }));
    expect(session.closer.signal.aborted).toBe(false);
    runSignal.abort(new Error("run aborted"));
    expect(session.closer.signal.aborted).toBe(true);
    await shutdownSession(session, { waitMs: 2_000 });
  }, 20_000);

  test("a close that rejects is warned about and the teardown still completes", async () => {
    useFake();
    const session = await createSession("nax-c6", "claude", opts());
    session.opened = { ...session.opened, close: () => Promise.reject(new Error("close boom")) };
    await shutdownSession(session, { waitMs: 2_000 });
    expect(await createFileTranscriptStore(transcripts).load("nax-c6")).toBeNull();
  }, 20_000);

  test("a close that outlives the teardown deadline kills the process group", async () => {
    useFake();
    const session = await createSession("nax-c7", "claude", opts());
    const [pid] = fakeStartPids(record);
    session.opened = { ...session.opened, close: () => new Promise<void>(() => {}) };
    await shutdownSession(session, { waitMs: 20 });
    expect(session.closer.signal.aborted).toBe(true);
    await waitForCondition(() => pid !== undefined && !isProcessAlive(pid), 5_000);
    expect(await createFileTranscriptStore(transcripts).load("nax-c7")).toBeNull();
  }, 20_000);

  test("a transcript document that cannot be deleted does not fail the close", async () => {
    useFake();
    const session = await createSession("nax-c8", "claude", opts());
    chmodSync(transcripts, 0o555);
    try {
      await shutdownSession(session, { waitMs: 2_000 });
    } finally {
      chmodSync(transcripts, 0o755);
    }
    expect(session.closer.signal.aborted).toBe(true);
  }, 20_000);

  test("close flushes the tool audit before deleting the transcript (spec §7.4)", async () => {
    useFake();
    const auditDir = join(dir, "audit");
    const session = await createSession(
      "nax-audit",
      "claude",
      opts({ toolAudit: { dir: auditDir, header: { runId: "run-1", storyId: "US-1" } } }),
    );
    session.audit.onEvent({ type: "tool_call", callId: "c1", name: "Read", input: {} });
    session.audit.onEvent({ type: "tool_result", callId: "c1", isError: false, preview: "x", resultBytes: 1 });
    await shutdownSession(session, { waitMs: 2_000 });
    const files = readdirSync(auditDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("run-1");
  }, 20_000);

  test("a call the profile refuses is one denied row, end to end through the fake agent (Review Focus 3)", async () => {
    useFake({
      turns: [
        {
          steps: [
            {
              kind: "permission",
              options: ["allow_once", "reject_once"],
              toolCall: { kind: "edit", title: "Write x", rawInput: { path: "x" } },
            },
            { kind: "text", text: "done" },
          ],
        },
      ],
    });
    const auditDir = join(dir, "audit-deny");
    const session = await createSession(
      "nax-deny",
      "claude",
      opts({
        resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
        toolAudit: { dir: auditDir, header: { runId: "run-2", storyId: "US-2" } },
      }),
    );
    await runTurnLoop(session, "go", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    await shutdownSession(session, { waitMs: 2_000 });
    const [file] = readdirSync(auditDir);
    const calls = (
      JSON.parse(readFileSync(join(auditDir, file ?? ""), "utf8")) as { calls: Array<{ outcome: string }> }
    ).calls;
    expect(calls.map((c) => c.outcome)).toEqual(["denied"]);
  }, 20_000);
});
