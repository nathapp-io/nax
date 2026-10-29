import { describe, expect, mock, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { createJobRunner } from "@/chat/jobs/job-runner";
import { createJobsProvider } from "@/chat/jobs/jobs-provider";
import type { ChatRunAsks } from "@/chat/jobs/run-asks";
import { buildJobsInstructions } from "@/prompts";

function fixture(enabled = true, ok = true) {
  const approve = mock(async (): Promise<"allow"> => "allow");
  const answer = mock<ChatRunAsks["answer"]>(async () => (ok ? { ok: true } : { ok: false, message: "ask expired" }));
  const runAsks: ChatRunAsks = {
    answer,
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    takeNotes: () => [],
    noteUserTurn() {},
    onChange: () => () => {},
    dispose() {},
  };
  const jobs = createJobRunner({ repoRoot: "/fixture", outputDir: "/fixture/output", now: () => new Date() });
  const provider = createJobsProvider({
    repoRoot: "/fixture",
    naxEntry: ["nax"],
    interactionPlugin: "cli",
    jobs,
    approve,
    sessionId: () => "chat",
    now: () => new Date(),
    ...(enabled ? { runAsks } : {}),
  });
  return { provider, answer, approve };
}
async function tool(f: ReturnType<typeof fixture>) {
  const value = (await f.provider.tools("/fixture")).find((t) => t.localName === "answer_ask");
  assertDefined(value, "answer_ask");
  return value;
}
const ctx = { root: "/fixture", resolvedPaths: [], maxBytes: 1000, maxFileBytes: 1000 };
describe("answer_ask", () => {
  test("AC-1/2 appends a closed schema requiring three strings", async () => {
    const f = fixture();
    expect((await f.provider.tools("/fixture")).at(-1)?.localName).toBe("answer_ask");
    expect((await tool(f)).inputSchema).toEqual({
      type: "object",
      properties: {
        ask: { type: "string" },
        answer: { type: "string" },
        reason: { type: "string" },
      },
      required: ["ask", "answer", "reason"],
      additionalProperties: false,
    });
  });
  test("AC-3 preserves tools and instructions without registry", async () => {
    const f = fixture(false);
    expect((await f.provider.tools("/fixture")).map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "bot_review",
      "bot_fix",
      "list",
      "cancel",
    ]);
    expect(await f.provider.instructions?.("/fixture")).toBe(buildJobsInstructions());
  });
  test("AC-4 delegates without an approval card", async () => {
    const f = fixture();
    expect(
      await (await tool(f)).run({ ask: "run/key", answer: "approve", reason: "within budget" }, ctx),
    ).not.toHaveProperty("isError", true);
    expect(f.answer).toHaveBeenCalledWith("run/key", { answer: "approve", reason: "within budget" });
    expect(f.approve).not.toHaveBeenCalled();
  });
  test("AC-5 maps refusal to tool error", async () => {
    const f = fixture(true, false);
    expect(await (await tool(f)).run({ ask: "run/key", answer: "approve", reason: "budget" }, ctx)).toEqual({
      isError: true,
      content: "ask expired",
    });
  });
  test("AC-6 enables answer instructions", async () => {
    expect(await fixture().provider.instructions?.("/fixture")).toContain("nax-jobs__answer_ask");
  });
  test("rejects malformed input without delegating", async () => {
    const f = fixture();
    expect(await (await tool(f)).run({ ask: "run/key", answer: "approve" }, ctx)).toHaveProperty("isError", true);
    expect(f.answer).not.toHaveBeenCalled();
  });
});
