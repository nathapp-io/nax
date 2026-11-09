/** nax#2837: no repair or fix prompt may invite making a gate green by gaming its precondition. */
import { describe, expect, test } from "bun:test";
import {
  buildBotPrFixPrompt,
  buildWorkflowBranchFixPrompt,
  buildWorkflowCiRepairPrompt,
  GATE_INTEGRITY_RULE,
} from "@/prompts";

const pr = { number: 1, url: "https://example.com/pull/1", title: "t", body: "b" };
const botBase = { pr, findings: [], bar: ["bun test"], checkoutState: "clean", reportPath: "r.md" } as const;

const prompts: Record<string, string> = {
  "branch fix": buildWorkflowBranchFixPrompt({ reportPath: "r.md", findings: [] }),
  "ci repair": buildWorkflowCiRepairPrompt({ round: 1, reportPath: "r.md", findings: [] }),
  "bot repair": buildBotPrFixPrompt({ ...botBase, mode: "repair", redGates: [{ name: "e2e", tail: "red" }] }),
  "bot fix": buildBotPrFixPrompt({ ...botBase, mode: "fix" }),
};

describe("GATE_INTEGRITY_RULE", () => {
  test("forbids gaming a gate and tells the session to reply BLOCKED", () => {
    expect(GATE_INTEGRITY_RULE).toContain("never change the gate's command or the quality config");
    expect(GATE_INTEGRITY_RULE).toContain("BLOCKED");
  });

  for (const [name, text] of Object.entries(prompts)) {
    test(`${name} carries the rule`, () => {
      expect(text).toContain(GATE_INTEGRITY_RULE);
    });
    test(`${name} drops the old make-it-green wording`, () => {
      expect(text).not.toContain("make that gate green");
      expect(text).not.toContain("make its gates green");
    });
  }
});
