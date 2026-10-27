import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";
import { buildWorkflowInstructions } from "@/prompts/builders/workflow-builder";

/** The four billed nax commands the instruction section must gate behind approval. */
const BILLED_COMMANDS = ["nax plan", "nax run", "nax bot review", "nax bot fix"];

/** First-mention order of the loop steps the section names. */
const LOOP_ORDER = ["spec-review", "nax plan", "nax run", "nax bot fix"];

function lines(text: string): string[] {
  return text.split("\n");
}

describe("buildWorkflowInstructions", () => {
  test("AC-1 names nax-workflow__state", () => {
    expect(buildWorkflowInstructions()).toContain("nax-workflow__state");
  });

  test("AC-1 tells the agent to check state before proposing a step and again after one ends", () => {
    const stateLine = lines(buildWorkflowInstructions()).find((line) => line.includes("nax-workflow__state")) ?? "";
    expect(stateLine).not.toBe("");
    expect(stateLine).toContain("before proposing");
    expect(stateLine).toContain("after");
  });

  test("AC-2 first mentions spec-review, nax plan, nax run and nax bot fix in loop order", () => {
    const text = buildWorkflowInstructions();
    const positions = LOOP_ORDER.map((step) => text.indexOf(step));
    for (const [index, position] of positions.entries()) {
      expect({ step: LOOP_ORDER[index], found: position >= 0 }).toEqual({ step: LOOP_ORDER[index], found: true });
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(LOOP_ORDER.length);
  });

  test("AC-3 names the --prd PRD fidelity check", () => {
    expect(buildWorkflowInstructions()).toContain("--prd");
  });

  test("AC-4 caps spec-review fix rounds at two", () => {
    expect(buildWorkflowInstructions()).toContain("at most two");
  });

  test("AC-5 says a billed launch starts only on explicit approval", () => {
    const approvalLine = lines(buildWorkflowInstructions()).find((line) => line.includes("explicit")) ?? "";
    expect(approvalLine).not.toBe("");
    expect(approvalLine).toContain("billed");
    for (const command of BILLED_COMMANDS) expect(approvalLine).toContain(command);
  });

  test("AC-6 says nax never merges a PR", () => {
    expect(buildWorkflowInstructions()).toContain("never merges");
  });

  test("AC-7 is re-exported from the @/prompts barrel with the same text", () => {
    expect(typeof prompts.buildWorkflowInstructions).toBe("function");
    expect(prompts.buildWorkflowInstructions()).toBe(buildWorkflowInstructions());
  });

  test("AC-8 forbids launching any billed command without the user's explicit approval of that launch", () => {
    const forbidding = lines(buildWorkflowInstructions()).filter(
      (line) =>
        BILLED_COMMANDS.every((command) => line.includes(command)) &&
        /\bnever\b|\bdo not\b/i.test(line) &&
        /approv/i.test(line),
    );
    expect(forbidding).toHaveLength(1);
  });

  test("returns the same fixed text on every call", () => {
    expect(buildWorkflowInstructions()).toBe(buildWorkflowInstructions());
  });
});
