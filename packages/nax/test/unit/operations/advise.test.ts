import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import type { AdviceQuestion } from "@/advisor";
import { buildMenu } from "@/advisor";
import { type AdviseOpInput, adviseOp, validateAdvisorReply } from "@/operations";

const options = buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true }); // A fix, B waive, C hold
const question: AdviceQuestion = {
  id: "Q-1",
  kind: "finish-judgment",
  feature: "f",
  askedAtSha: "s",
  summary: "x",
  evidence: [],
  options,
};
const input: AdviseOpInput = {
  question,
  specPath: "spec.md",
  prdText: "{}",
  priorDecisions: [],
  continuation: false,
  keepOpen: false,
};

function makeCtx(advisor?: Record<string, unknown>) {
  const config = makeNaxConfig(advisor ? { advisor } : {});
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(adviseOp.config)) };
}

const ok = (o: Record<string, unknown>) =>
  `Reasoning…\n\`\`\`json\n${JSON.stringify({ rationale: "r", confidence: "high", reversible: true, needsHumanConfirm: false, ...o })}\n\`\`\``;

describe("validateAdvisorReply", () => {
  test("accepts an on-menu option with its required text", () => {
    const r = validateAdvisorReply(
      {
        optionId: "A",
        instruction: "do x",
        rationale: "r",
        confidence: "high",
        reversible: true,
        needsHumanConfirm: false,
      },
      options,
    );
    expect(r.ok).toBe(true);
  });
  test("rejects an option that is not on the menu", () => {
    expect(
      validateAdvisorReply(
        { optionId: "Z", rationale: "r", confidence: "high", reversible: true, needsHumanConfirm: false },
        options,
      ),
    ).toEqual({ ok: false, error: "optionId Z is not on the menu" });
  });
  test("rejects a valid option whose required text is missing or blank (Review Focus 1)", () => {
    const r = validateAdvisorReply(
      {
        optionId: "A",
        instruction: "  ",
        rationale: "r",
        confidence: "high",
        reversible: true,
        needsHumanConfirm: false,
      },
      options,
    );
    expect(r).toEqual({ ok: false, error: "option A (fix) requires a non-empty instruction" });
  });
  test("rejects a bad confidence or a missing rationale", () => {
    expect(
      validateAdvisorReply(
        { optionId: "C", reason: "x", rationale: "r", confidence: "sure", reversible: true, needsHumanConfirm: false },
        options,
      ).ok,
    ).toBe(false);
    expect(
      validateAdvisorReply(
        { optionId: "C", reason: "x", confidence: "high", reversible: true, needsHumanConfirm: false },
        options,
      ).ok,
    ).toBe(false);
  });
});

describe("adviseOp", () => {
  test("is a read-only review-stage run op with the advisor role", () => {
    expect(adviseOp.kind).toBe("run");
    expect(adviseOp.stage).toBe("review");
    expect(adviseOp.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(adviseOp.session).toEqual({ role: "advisor", lifetime: "fresh" });
  });
  test("parse: fenced JSON with an on-menu option", () => {
    expect(adviseOp.parse(ok({ optionId: "B", reason: "spec allows it" }), input, makeCtx())).toEqual({
      ok: true,
      reply: {
        optionId: "B",
        reason: "spec allows it",
        rationale: "r",
        confidence: "high",
        reversible: true,
        needsHumanConfirm: false,
      },
    });
  });
  test("parse: no JSON at all is a typed failure with a preview, never a throw", () => {
    const out = adviseOp.parse("I think we should fix it.", input, makeCtx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.preview).toContain("fix it");
  });
  test("parse: empty output yields a non-empty preview", () => {
    const out = adviseOp.parse("", input, makeCtx());
    expect(out).toEqual({ ok: false, error: "no-json", preview: "(empty response)" });
  });
  test("model: input override, else advisor.model, else 'powerful'", () => {
    const resolve = (i: AdviseOpInput, c: ReturnType<typeof makeCtx>) =>
      typeof adviseOp.model === "function" ? adviseOp.model(i, c) : adviseOp.model;
    expect(resolve(input, makeCtx())).toBe("powerful");
    expect(resolve(input, makeCtx({ model: "fast" }))).toBe("fast");
    expect(resolve({ ...input, model: "balanced" }, makeCtx({ model: "fast" }))).toBe("balanced");
  });
  test("keepOpen follows the input (warm memory)", () => {
    expect(adviseOp.keepOpen?.({ ...input, keepOpen: true }, makeCtx())).toBe(true);
    expect(adviseOp.keepOpen?.(input, makeCtx())).toBe(false);
  });
});
