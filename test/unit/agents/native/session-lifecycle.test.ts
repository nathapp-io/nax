// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentAdapter } from "@test/helpers";
import { closeNativeSession, openNativeSession } from "@/agents/native/session/session";
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
import type { OpenSessionOpts, SessionHandle } from "@/agents/session-types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-session-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = (over: Partial<OpenSessionOpts> = {}): OpenSessionOpts => ({
  agentName: "native",
  workdir: "/tmp",
  resolvedPermissions: { mode: "approve-all" },
  modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
  timeoutSeconds: 60,
  transcriptDir: dir,
  ...over,
});

describe("native session lifecycle", () => {
  test("opening returns a handle naming the session and the native agent", async () => {
    const handle = await openNativeSession("sess-a", opts());
    expect(handle.id).toBe("sess-a");
    expect(handle.agentName).toBe("native");
  });

  test("a missing transcriptDir fails loudly rather than choosing a default", async () => {
    await expect(openNativeSession("sess-a", opts({ transcriptDir: undefined }))).rejects.toThrow(/transcriptDir/i);
  });

  test("a clean close deletes the transcript", async () => {
    const handle = await openNativeSession("sess-a", opts());
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "hi" }]);
    await closeNativeSession(handle, false);
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("a failed close keeps the transcript for debugging", async () => {
    const handle = await openNativeSession("sess-a", opts());
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "hi" }]);
    await closeNativeSession(handle, true);
    expect(await loadTranscript(dir, "sess-a")).toHaveLength(1);
  });
});

// ─── SessionManager forwarding ──────────────────────────────────────────────
//
// The manager.ts:484-ish forwarding of OpenSessionRequest.transcriptDir into
// adapter.openSession's OpenSessionOpts is untested elsewhere: the existing
// session-opts-threading.test.ts only pins the *type* accepting the field, and
// deleting the actual forwarding line leaves both typecheck and that test
// green. This test exercises SessionManager.openSession end-to-end through a
// fake adapter injected via the SessionManager({ getAdapter }) constructor
// seam — the established pattern in test/unit/session/manager-phase-b-session.test.ts
// — so it fails if the forwarding line in src/session/manager.ts is removed.
describe("SessionManager forwards transcriptDir to the adapter", () => {
  test("adapter.openSession receives the exact transcriptDir passed to SessionManager.openSession", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      transcriptDir: dir,
    };

    await sm.openSession("nax-transcript-wiring", request);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].transcriptDir).toBe(dir);
  });
});
