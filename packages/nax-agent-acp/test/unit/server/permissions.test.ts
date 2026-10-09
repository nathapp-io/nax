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

  test("execute tools: the command plus its subcommand when the second word is a plain word", () => {
    expect(memoryKey(approval("r", "Bash", { command: "  git push origin main" }))).toBe("Bash:git push");
    expect(memoryKey(approval("r", "Bash", { command: "git status" }))).toBe("Bash:git status");
    expect(memoryKey(approval("r", "Bash", { command: "npm test -- --watch" }))).toBe("Bash:npm test");
  });

  test("execute tools: the command alone when there is no subcommand or it starts with a flag", () => {
    expect(memoryKey(approval("r", "Bash", { command: "ls" }))).toBe("Bash:ls");
    expect(memoryKey(approval("r", "Bash", { command: "ls -la src" }))).toBe("Bash:ls");
  });

  test("a second word that is not plain is never remembered (it must not widen to the bare command)", () => {
    for (const command of ["git 'push' --force", 'git "status"', "git pu*h", "git $CMD"]) {
      expect(memoryKey(approval("r", "Bash", { command }))).toBeUndefined();
    }
  });

  test("a leading environment assignment is never remembered", () => {
    expect(memoryKey(approval("r", "Bash", { command: "FOO=1 rm -rf build" }))).toBeUndefined();
  });

  test("a masked command is never remembered: its visible words are not the real command", () => {
    expect(memoryKey(approval("r", "Bash", { command: "[REDACTED:github] rm -rf build" }))).toBeUndefined();
    expect(memoryKey(approval("r", "Bash", { command: "curl -H [REDACTED:bearer] https://x" }))).toBeUndefined();
  });

  test("a wrapper or interpreter is never remembered: its first word says nothing about what runs", () => {
    for (const command of [
      "bash -c 'rm -rf ~'",
      "env X=1 rm x",
      "xargs rm",
      "sudo ls",
      "find . -delete",
      "node -e 1",
    ]) {
      expect(memoryKey(approval("r", "Bash", { command }))).toBeUndefined();
    }
    expect(memoryKey(approval("r", "Bash", { command: "/usr/bin/env rm x" }))).toBeUndefined();
  });

  test("a first word that is not a plain name is never remembered (quotes, escapes, globs, case)", () => {
    for (const command of ["'bash' -c x", '"sh" x', "b\\ash -c x", "ba*h -c x", "BASH -c x", "$(which sh) x"]) {
      expect(memoryKey(approval("r", "Bash", { command }))).toBeUndefined();
    }
    expect(memoryKey(approval("r", "Bash", { command: "./scripts/build.sh --fast" }))).toBe("Bash:./scripts/build.sh");
  });

  test("an execute tool with no command is never remembered (M-12)", () => {
    expect(memoryKey(approval("r", "Bash"))).toBeUndefined();
    expect(memoryKey(approval("r", "Bash", { command: "   " }))).toBeUndefined();
  });
});

describe("createPermissionBroker failures never escape (final review I-2)", () => {
  test("an answer() that throws is logged and drain still resolves", async () => {
    const fake = fakePort();
    const { logger, lines } = recordingLogger();
    const broker = createPermissionBroker({
      port: fake.port,
      answer: () => {
        throw new Error("AGENT_SESSION_INVALID_ANSWER");
      },
      memory: new Map(),
      logger,
    });
    broker.request(approval("r1", "Edit"), undefined);
    await broker.drain();
    expect(lines.some((l) => l.level === "warn" && l.data?.error === "AGENT_SESSION_INVALID_ANSWER")).toBe(true);
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

  test("allow_always on an MCP tool is remembered for that tool only (S5-5 spec §5.5)", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "git__status"), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "git__status"), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(1);
    s.broker.request(approval("r3", "git__log"), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.memory.get("git__status")).toBe("allow");
    expect(s.answers.map((a) => a.reply)).toEqual([
      { decision: "allow" },
      { decision: "allow" },
      { decision: "allow" },
    ]);
  });

  test("reject_always on an MCP tool denies that tool without asking again", async () => {
    const s = setup({ permission: async () => select("reject_always") });
    s.broker.request(approval("r1", "git__push"), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "git__push"), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(1);
    expect(s.answers.map((a) => a.reply)).toEqual([{ decision: "deny" }, { decision: "deny" }]);
  });

  test("reject_always on a subcommand covers that subcommand only", async () => {
    const s = setup({ permission: async () => select("reject_always") });
    s.broker.request(approval("r1", "Bash", { command: "git push" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git push --force origin main" }), undefined);
    s.broker.request(approval("r3", "Bash", { command: "git status" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.answers.find((a) => a.requestId === "r2")?.reply).toEqual({ decision: "deny" });
  });

  test("always-allow on git status never approves git push --force", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "Bash", { command: "git status" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git status --short" }), undefined);
    s.broker.request(approval("r3", "Bash", { command: "git push --force" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.asks[1]?.toolCall.rawInput).toEqual({ command: "git push --force" });
    expect(s.answers.find((a) => a.requestId === "r2")?.reply).toEqual({ decision: "allow" });
  });

  test("a remembered allow never covers a compound command; a remembered reject does", async () => {
    const allow = setup({ permission: async () => select("allow_always") });
    allow.broker.request(approval("r1", "Bash", { command: "git status" }), undefined);
    await allow.broker.drain();
    allow.broker.request(approval("r2", "Bash", { command: "git status; rm -rf ~" }), undefined);
    allow.broker.request(approval("r3", "Bash", { command: "git status $(cat secret)" }), undefined);
    allow.broker.request(approval("r4", "Bash", { command: "git status --short" }), undefined);
    await allow.broker.drain();
    expect(allow.asks).toHaveLength(3);
    expect(allow.answers.find((a) => a.requestId === "r4")?.reply).toEqual({ decision: "allow" });
    const reject = setup({ permission: async () => select("reject_always") });
    reject.broker.request(approval("r1", "Bash", { command: "git push" }), undefined);
    await reject.broker.drain();
    reject.broker.request(approval("r2", "Bash", { command: "git push && echo done" }), undefined);
    await reject.broker.drain();
    expect(reject.asks).toHaveLength(1);
    expect(reject.answers.find((a) => a.requestId === "r2")?.reply).toEqual({ decision: "deny" });
  });

  test("the fallback tool call shows no control or bidi characters", async () => {
    const s = setup();
    s.broker.request(
      approval("r1", "Bash", { summary: "run\u202E evil\nnext line", command: "echo\u0007 hi\u202E" }),
      undefined,
    );
    await s.broker.drain();
    const call = s.asks[0]?.toolCall;
    expect(call?.title).toBe("run evil next line");
    expect(JSON.stringify(call?.rawInput)).not.toMatch(/\\u(0007|202e)/i);
    expect(call?.rawInput).toEqual({ command: "echo hi" });
  });

  test("always-allow on one masked command never answers another", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "Bash", { command: "[REDACTED:github] echo hi" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "[REDACTED:github] rm -rf ~" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.memory.size).toBe(0);
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
