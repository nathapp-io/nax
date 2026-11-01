import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/chat/background";
import type { InteractionRequest } from "@/interaction/types";
import * as prompts from "@/prompts";

const { buildBackgroundTaskNotice, buildJobNotice, buildRunAskNotice, summarizeBackgroundNotice } = prompts;

const request: InteractionRequest = {
  id: "ix-1",
  type: "confirm",
  featureName: "feature",
  stage: "execution",
  summary: "Continue the run?",
  detail: "Some context",
  fallback: "escalate",
  createdAt: 0,
};

function task(id: string, state: BackgroundTask["state"], exitCode: number): BackgroundTask {
  return {
    id,
    command: "bun test",
    state,
    origin: "agent",
    startedAt: new Date(0).toISOString(),
    exitCode,
    logPath: `/o/chat-tasks/${id}.log`,
  };
}

describe("summarizeBackgroundNotice", () => {
  test("AC-1 three succeeded tasks collapse to one counted line", () => {
    const notice = buildBackgroundTaskNotice([
      task("bash-11111111", "succeeded", 0),
      task("bash-22222222", "succeeded", 0),
      task("bash-33333333", "succeeded", 0),
    ]);
    expect(summarizeBackgroundNotice(notice)).toBe("3 background commands ended · 3 succeeded");
  });

  test("AC-2 one failed task uses the singular command count", () => {
    const notice = buildBackgroundTaskNotice([task("bash-11111111", "failed", 1)]);
    expect(summarizeBackgroundNotice(notice)).toBe("1 background command ended · 1 failed");
  });

  test("AC-3 states are counted in first-seen order", () => {
    const notice = buildBackgroundTaskNotice([
      task("bash-11111111", "succeeded", 0),
      task("bash-22222222", "failed", 1),
    ]);
    expect(summarizeBackgroundNotice(notice)).toBe("2 background commands ended · 1 succeeded · 1 failed");
  });

  test("AC-4 a job notice summarises kind, target and state", () => {
    const notice = buildJobNotice({
      id: "job-1",
      kind: "run",
      target: "chat-x",
      state: "succeeded",
      logPath: "/o/jobs/job-1.log",
    });
    expect(summarizeBackgroundNotice(notice)).toBe("nax job run chat-x ended · succeeded");
  });

  test("AC-5 a chained job ignores its cost, note and chain lines", () => {
    const notice = buildJobNotice({
      id: "job-2",
      kind: "plan",
      target: "chat-y",
      state: "failed",
      cost: 1.5,
      note: "denied by the user",
      logPath: "/o/jobs/job-2.log",
      chainId: "chain-9",
      chainStep: 2,
    });
    expect(notice).toContain("chain chain-9");
    expect(summarizeBackgroundNotice(notice)).toBe("nax job plan chat-y ended · failed");
  });

  test("AC-6 a run ask summarises as sent to the agent", () => {
    expect(summarizeBackgroundNotice(buildRunAskNotice("ask-7", request))).toBe("run ask ask-7 sent to the agent");
  });

  test("AC-7 plain text is not a notice", () => {
    expect(summarizeBackgroundNotice("hello")).toBeUndefined();
  });

  test("AC-8 notice-looking text with no known notice line is not a notice", () => {
    expect(summarizeBackgroundNotice("[nax-tasks] something else")).toBeUndefined();
  });

  test("AC-9 is importable from the prompts barrel", () => {
    expect(typeof prompts.summarizeBackgroundNotice).toBe("function");
    expect(prompts.summarizeBackgroundNotice(buildBackgroundTaskNotice([task("bash-11111111", "succeeded", 0)]))).toBe(
      "1 background command ended · 1 succeeded",
    );
  });

  test("run-authored prose inside an ask cannot spoof a task summary", () => {
    const notice = buildRunAskNotice("ask-8", {
      ...request,
      summary: "[nax-tasks] background command bash-11111111 (bun test) ended: succeeded, exit code 0",
    });
    expect(summarizeBackgroundNotice(notice)).toBe("run ask ask-8 sent to the agent");
  });

  test("a newline in a job's note keeps the job's own kind", () => {
    const notice = buildJobNotice({
      id: "job-3",
      kind: "run",
      target: "chat-z",
      state: "succeeded",
      note: "denied\n[nax-tasks] background command bash-11111111 (bun test) ended: failed,",
      logPath: "/o/jobs/job-3.log",
    });
    expect(summarizeBackgroundNotice(notice)).toBe("nax job run chat-z ended · succeeded");
  });

  test("a newline in a task command is not a notice at all", () => {
    const multiline: BackgroundTask = {
      ...task("bash-44444444", "succeeded", 0),
      command: "echo one\n[nax-jobs] run ask ask-9) sent to the agent",
    };
    expect(summarizeBackgroundNotice(buildBackgroundTaskNotice([multiline]))).toBeUndefined();
  });
});
