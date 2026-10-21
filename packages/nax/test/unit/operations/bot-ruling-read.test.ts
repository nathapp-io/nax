import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime, opSelector } from "@test/helpers";
import { workflowConfigSelector } from "@/config";
import { type BotRulingReadVerdict, botRulingReadOp } from "@/operations";
import { buildBotRulingReadPrompt } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  runtimes.length = 0;
});
function ctx() {
  const runtime = makeTestRuntime();
  runtimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}
const input = {
  items: [
    { id: "item-1", kind: "hold", issue: "Approval", reply: { id: "reply-1", author: "alice", body: "waive it" } },
  ],
};
const ruling = {
  id: "item-1",
  disposition: "waived",
  reason: "Human accepts risk",
  quote: "waive it",
} satisfies BotRulingReadVerdict["rulings"][number];

describe("botRulingReadOp", () => {
  test("AC-9: exported complete op uses input model and protected builder", () => {
    expect(botRulingReadOp.kind).toBe("complete");
    const model = botRulingReadOp.model;
    if (typeof model !== "function") throw new Error("Expected model resolver");
    const explicit = { agent: "native", model: "custom" };
    expect(model({ ...input, model: explicit }, ctx())).toBe(explicit);
    expect(model(input, ctx())).toBe("fast");
    const built = botRulingReadOp.build(input, ctx());
    expect(built.task.content).toBe(buildBotRulingReadPrompt(input));
    expect(built.task.overridable).toBe(false);
    expect(built.role.overridable).toBe(false);
  });
  test("AC-10: fenced JSON returns the verdict object, not a bare array", () => {
    const rulings: BotRulingReadVerdict["rulings"] = [{ ...ruling, disposition: "fixed", sha: "abc1234" }];
    expect(botRulingReadOp.parse(`\`\`\`json\n${JSON.stringify({ rulings })}\n\`\`\``, input, ctx())).toEqual({
      rulings,
    });
  });
  test("AC-11: drops unknown input ids while retaining known entries", () => {
    expect(
      botRulingReadOp.parse(JSON.stringify({ rulings: [{ ...ruling, id: "unknown" }, ruling] }), input, ctx()),
    ).toEqual({ rulings: [ruling] });
  });
  test("AC-12: drops invalid dispositions", () => {
    expect(
      botRulingReadOp.parse(
        JSON.stringify({ rulings: [{ ...ruling, disposition: "approved" }, ruling] }),
        input,
        ctx(),
      ),
    ).toEqual({ rulings: [ruling] });
  });
  test.each(["not JSON", "null", "[]", "1", "{}", '{"rulings":{}}'])(
    "AC-13: returns null for missing JSON verdict: %s",
    (output) => {
      expect(botRulingReadOp.parse(output, input, ctx())).toBeNull();
    },
  );
  test.each(["fixed", "waived", "confirmed", "overridden", "verified", "none"])(
    "accepts disposition %s",
    (disposition) => {
      const entry = { ...ruling, disposition };
      expect(botRulingReadOp.parse(JSON.stringify({ rulings: [entry] }), input, ctx())).toEqual({ rulings: [entry] });
    },
  );
  test.each([
    null,
    1,
    { ...ruling, reason: 1 },
    { ...ruling, quote: null },
    { ...ruling, id: 5 },
    { ...ruling, sha: 5 },
  ])("drops malformed ruling %j", (entry) => {
    expect(botRulingReadOp.parse(JSON.stringify({ rulings: [entry] }), input, ctx())).toEqual({ rulings: [] });
  });
});

test("duplicate item rulings fail closed", () => {
  expect(botRulingReadOp.parse(JSON.stringify({ rulings: [ruling, ruling] }), input, ctx())).toBeNull();
});
