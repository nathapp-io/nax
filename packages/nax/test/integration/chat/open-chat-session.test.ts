import { afterEach, describe, expect, test } from "bun:test";
import { createSessionStorage, type SessionEvent } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
} from "@test/helpers";
import { type ChatSessionHandle, openChatSession } from "@/chat";

describe("openChatSession sandbox-down posture", () => {
  withDepsRestore(_sessionSandboxDeps);
  let handle: ChatSessionHandle | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    try {
      await handle?.session.close();
    } finally {
      await handle?.release();
      handle = undefined;
      if (dir !== undefined) cleanupTempDir(dir);
      dir = undefined;
    }
  });
  test.each(["disabled", "unavailable"] as const)("AC-22 %s opens and each Bash asks", async (kind) => {
    dir = makeTempDir("chat-posture-");
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "test probe unavailable" });
    const config = makeNaxConfig({ execution: { bashApproval: "raw", sandbox: { enabled: kind !== "disabled" } } });
    handle = await openChatSession({
      storage: createSessionStorage({ dir, pid: process.pid, now: () => new Date(), logger: makeLogger() }),
      cwd: dir,
      repoRoot: dir,
      mode: "guarded",
      model: "openai/gpt-5.4-mini",
      loopHandlers: [],
      config,
    });
    expect(handle.session.backend.sandbox?.kind).toBe(kind);
    // The metadata stores the configured posture, while the backend gates when down.
    expect(handle.meta).toMatchObject({ mode: "ask", bashApproval: "raw" });
    const session = handle.session;
    const run = session.runCommand;
    expect(run).toBeDefined();
    if (run === undefined) throw new Error("native session has no Bash command port");
    for (const command of ["printf first", "printf second"]) {
      const asks: Extract<SessionEvent, { type: "approval_requested" }>[] = [];
      const result = await run.call(session, command, (event) => {
        if (event.type === "approval_requested") {
          asks.push(event);
          session.answer(event.requestId, { decision: "deny" });
        }
      });
      expect(asks).toHaveLength(1);
      expect(asks[0]?.tool).toBe("Bash");
      expect(result.isError).toBe(true);
    }
  });
});
