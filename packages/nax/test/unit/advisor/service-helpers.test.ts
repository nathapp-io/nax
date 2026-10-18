import { afterAll, describe, expect, test } from "bun:test";
import { makeTestRuntime } from "@test/helpers";
import type { AdviceQuestion, AdvisorReply } from "@/advisor";
import { type AdvisorCallContext, decisionDraftFor } from "@/advisor/service-helpers";

const runtime = makeTestRuntime();
afterAll(async () => {
  await runtime.close();
});
const context: AdvisorCallContext = {
  callCtx: { runtime, packageView: runtime.packages.repo(), packageDir: "/repo", agentName: "native" },
  repoRoot: "/repo",
  outputDir: "/output",
  feature: "f",
  runId: "r",
  specPath: "s",
  workdir: "/repo",
};
const question: AdviceQuestion = {
  id: "Q-1",
  kind: "finish-approval",
  feature: "f",
  askedAtSha: "s",
  summary: "approve?",
  evidence: [],
  options: [{ id: "A", type: "approve", label: "Approve" }],
};

describe("decisionDraftFor inspected files", () => {
  test.each([
    ["AC-6", ["src/a.ts"]],
    ["AC-7", undefined],
    ["empty list", []],
  ] as const)("%s", (_ac, files) => {
    const reply: AdvisorReply = {
      optionId: "A",
      rationale: "clean",
      confidence: "high",
      reversible: true,
      needsHumanConfirm: false,
      ...(files === undefined ? {} : { inspectedFiles: [...files] }),
    };
    const draft = decisionDraftFor(context, question, reply, "powerful", undefined);
    expect(draft).not.toBeNull();
    const decision = draft?.("D-1");
    expect(decision?.action).toEqual({ type: "approve" });
    if (files === undefined) expect(decision).not.toHaveProperty("inspectedFiles");
    else expect(decision).toHaveProperty("inspectedFiles", [...files]);
  });
});
