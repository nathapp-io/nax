import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileTranscriptStore, isProcessAlive, type OpenSessionOpts } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { fakeAcpBackend, fakeMethods, fakeStartPids } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, createSession, reopenFresh, shutdownSession } from "@/agents/acp-sdk/session";
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
});
