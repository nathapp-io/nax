import { describe, expect, test } from "bun:test";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AnswerReply } from "@nathapp/nax-agent";
import {
  type ApprovalEvent,
  createPermissionBroker,
  type Decision,
  memoryKey,
  PERMISSION_OPTIONS,
} from "#src/server/permissions";
import { type FakePortOptions, fakePort, NEVER, select } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const BASE = { sessionId: "s1", turnId: "t1", at: "2026-10-09T00:00:00.000Z", metadata: {} };

function approval(requestId: string, tool: string, extra: Partial<ApprovalEvent> = {}): ApprovalEvent {
  return {
    ...BASE,
    type: "approval_requested",
    requestId,
    tool,
    summary: `${tool} something`,
    reason: "ask profile",
    expiresAt: "2026-10-09T00:10:00.000Z",
    ...extra,
  };
}

function setup(options: FakePortOptions = {}) {
  const fake = fakePort(options);
  const answers: { requestId: string; reply: AnswerReply }[] = [];
  const memory = new Map<string, Decision>();
  const { logger, lines } = recordingLogger();
  const broker = createPermissionBroker({
    port: fake.port,
    answer: (requestId, reply) => {
      answers.push({ requestId, reply });
      return "accepted";
    },
    memory,
    logger,
  });
  return { ...fake, answers, memory, lines, broker };
}

describe("memoryKey (spec §4.3)", () => {
  test("the tool name for non-execute tools", () => {
    expect(memoryKey(approval("r", "Edit"))).toBe("Edit");
  });

  test("tool plus the command's first word for execute tools", () => {
    expect(memoryKey(approval("r", "Bash", { command: "  git push origin main" }))).toBe("Bash:git");
  });

  test("an execute tool with no command is never remembered (M-12)", () => {
    expect(memoryKey(approval("r", "Bash"))).toBeUndefined();
    expect(memoryKey(approval("r", "Bash", { command: "   " }))).toBeUndefined();
  });
});

describe("createPermissionBroker", () => {
  test("asks the client with the tool call and the four options, then answers", async () => {
    const s = setup();
    const toolCall = { toolCallId: "c1", title: "Edit a.ts", kind: "edit" as const, status: "pending" as const };
    s.broker.request(approval("r1", "Edit", { callId: "c1" }), toolCall);
    await s.broker.drain();
    expect(s.asks).toEqual([{ toolCall, options: PERMISSION_OPTIONS }]);
    expect(PERMISSION_OPTIONS.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]);
    expect(s.answers).toEqual([{ requestId: "r1", reply: { decision: "allow" } }]);
  });

  test("reject_once, an unknown option and a cancelled outcome all deny", async () => {
    const outcomes: RequestPermissionResponse[] = [
      select("reject_once"),
      select("made_up"),
      { outcome: { outcome: "cancelled" } },
    ];
    const replies: AnswerReply[] = [];
    for (const outcome of outcomes) {
      const s = setup({ permission: async () => outcome });
      s.broker.request(approval("r1", "Edit"), undefined);
      await s.broker.drain();
      replies.push(...s.answers.map((a) => a.reply));
      expect(s.memory.size).toBe(0);
    }
    expect(replies).toEqual([{ decision: "deny" }, { decision: "deny" }, { decision: "deny" }]);
  });

  test("allow_always is remembered: the next matching request is answered without asking", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "Edit"), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Edit"), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(1);
    expect(s.answers.map((a) => a.reply)).toEqual([{ decision: "allow" }, { decision: "allow" }]);
    expect(s.memory.get("Edit")).toBe("allow");
  });

  test("reject_always on a bash prefix covers that prefix only", async () => {
    const s = setup({ permission: async () => select("reject_always") });
    s.broker.request(approval("r1", "Bash", { command: "git status" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git push" }), undefined);
    s.broker.request(approval("r3", "Bash", { command: "ls -la" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.answers.find((a) => a.requestId === "r2")?.reply).toEqual({ decision: "deny" });
  });

  test("S3 settling first aborts the client request; a late reply is ignored", async () => {
    let late: (value: RequestPermissionResponse) => void = () => {};
    const s = setup({
      permission: () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    });
    s.broker.request(approval("r1", "Edit"), undefined);
    s.broker.settled("r1");
    await s.broker.drain();
    expect(s.signals[0]?.aborted).toBe(true);
    late(select("allow_once"));
    await Promise.resolve();
    expect(s.answers).toEqual([]);
  });

  test("a client that never answers does not block drain after abortAll", async () => {
    const s = setup({ permission: NEVER });
    s.broker.request(approval("r1", "Edit"), undefined);
    s.broker.request(approval("r2", "Write"), undefined);
    s.broker.abortAll();
    await s.broker.drain();
    expect(s.signals.every((signal) => signal.aborted)).toBe(true);
    expect(s.answers).toEqual([]);
  });

  test("a failing client request is a deny, logged at warn (M-13)", async () => {
    const s = setup({ permission: async () => Promise.reject(new Error("Method not found")) });
    s.broker.request(approval("r1", "Edit"), undefined);
    await s.broker.drain();
    expect(s.answers).toEqual([{ requestId: "r1", reply: { decision: "deny" } }]);
    expect(s.lines[0]).toMatchObject({ level: "warn", data: { error: "Method not found" } });
  });

  test("without a known tool call, a fallback tool call carries the summary and command", async () => {
    const s = setup();
    s.broker.request(approval("r1", "Bash", { command: "rm -rf build" }), undefined);
    s.broker.request(approval("r2", "Edit", { callId: "c9" }), undefined);
    await s.broker.drain();
    expect(s.asks[0]?.toolCall).toEqual({
      toolCallId: "r1",
      title: "Bash something",
      kind: "execute",
      status: "pending",
      rawInput: { command: "rm -rf build" },
    });
    expect(s.asks[1]?.toolCall).toEqual({ toolCallId: "c9", title: "Edit something", kind: "edit", status: "pending" });
  });
});
