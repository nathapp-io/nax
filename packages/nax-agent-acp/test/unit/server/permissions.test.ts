import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { type AnswerReply, approvalMemoryKey } from "@nathapp/nax-agent";
import * as permissions from "#src/server/permissions";
import { type ApprovalEvent, createPermissionBroker, type Decision, PERMISSION_OPTIONS } from "#src/server/permissions";
import { toolKind } from "#src/server/translate/tool-kind";
import { type FakePortOptions, fakePort, NEVER, select } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

describe("shared approval-memory integration", () => {
  test("the broker module no longer exports memoryKey", () => {
    expect(Object.keys(permissions)).not.toContain("memoryKey");
  });

  test("every display execute tool has a command-scoped shared memory key", async () => {
    // Discover names from the display map so newly registered tools are tested too.
    const source = await readFile(new URL("../../../src/server/translate/tool-kind.ts", import.meta.url), "utf8");
    const tools = [...source.matchAll(/\[\s*["']([^"']+)["']\s*,\s*["']execute["']\s*,?\s*\]/g)];
    expect(tools.length).toBeGreaterThan(0);
    for (const [, tool = ""] of tools) {
      expect(toolKind(tool)).toBe("execute");
      expect(approvalMemoryKey({ tool, command: "npm test" })).toBe(`${tool}:npm test`);
    }
  });
});

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
  test("shared memory allows git status again but asks for git status --short", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "Bash", { command: "git status" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git status" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(1);
    expect(s.answers).toEqual([
      { requestId: "r1", reply: { decision: "allow" } },
      { requestId: "r2", reply: { decision: "allow" } },
    ]);
    s.broker.request(approval("r3", "Bash", { command: "git status --short" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(2);
    expect(s.asks[1]?.toolCall.rawInput).toEqual({ command: "git status --short" });
  });

  test("shared memory rejects git push origin --force after rejecting git push origin main", async () => {
    const s = setup({ permission: async () => select("reject_always") });
    s.broker.request(approval("r1", "Bash", { command: "git push origin main" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git push origin --force" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(1);
    expect(s.answers).toEqual([
      { requestId: "r1", reply: { decision: "deny" } },
      { requestId: "r2", reply: { decision: "deny" } },
    ]);
  });

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
    // nax#2553: `--short` is a flag after the key, so it is asked again rather than covered.
    expect(s.asks).toHaveLength(3);
    expect(s.asks.map((a) => a.toolCall.rawInput)).toEqual([
      { command: "git status" },
      { command: "git status --short" },
      { command: "git push --force" },
    ]);
  });

  test("a remembered allow never covers a compound command; a remembered reject does", async () => {
    const allow = setup({ permission: async () => select("allow_always") });
    allow.broker.request(approval("r1", "Bash", { command: "git status" }), undefined);
    await allow.broker.drain();
    allow.broker.request(approval("r2", "Bash", { command: "git status; rm -rf ~" }), undefined);
    allow.broker.request(approval("r3", "Bash", { command: "git status $(cat secret)" }), undefined);
    allow.broker.request(approval("r4", "Bash", { command: "git status --short" }), undefined);
    allow.broker.request(approval("r5", "Bash", { command: "git status src" }), undefined);
    await allow.broker.drain();
    // nax#2553: a flag after the key changes what runs, so `--short` is asked again; a plain word is not.
    expect(allow.asks).toHaveLength(4);
    expect(allow.asks.map((a) => a.toolCall.rawInput)).not.toContainEqual({ command: "git status src" });
    const reject = setup({ permission: async () => select("reject_always") });
    reject.broker.request(approval("r1", "Bash", { command: "git push" }), undefined);
    await reject.broker.drain();
    reject.broker.request(approval("r2", "Bash", { command: "git push && echo done" }), undefined);
    await reject.broker.drain();
    expect(reject.asks).toHaveLength(1);
    expect(reject.answers.find((a) => a.requestId === "r2")?.reply).toEqual({ decision: "deny" });
  });

  test("a remembered allow never covers a later flag: `git push origin --force` is asked again (nax#2553)", async () => {
    const s = setup({ permission: async () => select("allow_always") });
    s.broker.request(approval("r1", "Bash", { command: "git push origin main" }), undefined);
    await s.broker.drain();
    s.broker.request(approval("r2", "Bash", { command: "git push origin main --force" }), undefined);
    s.broker.request(approval("r3", "Bash", { command: "git push origin main -f" }), undefined);
    s.broker.request(approval("r4", "Bash", { command: "git push origin feature" }), undefined);
    await s.broker.drain();
    expect(s.asks).toHaveLength(3);
    expect(s.asks.map((a) => a.toolCall.rawInput)).not.toContainEqual({ command: "git push origin feature" });
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
