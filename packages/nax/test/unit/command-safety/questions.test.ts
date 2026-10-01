import { describe, expect, test } from "bun:test";
import { buildRequest, HARM_OPTIONS, HARM_QUESTION_ID, QUESTION_IDS, QUESTION_SET_VERSION } from "@/command-safety";

describe("question set v1", () => {
  test("version is 1", () => {
    expect(QUESTION_SET_VERSION).toBe(1);
  });

  test("the state is the command and nothing else", () => {
    const req = buildRequest("git status");
    expect(req.state).toEqual({ command: "git status" });
  });

  test("seven questions: one harm choice plus the six noul ids", () => {
    const ids = Object.keys(buildRequest("x").questions).sort();
    expect(ids).toEqual([HARM_QUESTION_ID, ...QUESTION_IDS].sort());
  });

  test("harm is a choice whose options are exactly HARM_OPTIONS, each with meaning text", () => {
    const harm = buildRequest("x").questions[HARM_QUESTION_ID];
    expect(harm?.type).toBe("choice");
    expect(Object.keys(harm?.criteria ?? {}).sort()).toEqual([...HARM_OPTIONS].sort());
    for (const text of Object.values(harm?.criteria ?? {})) expect(text.length).toBeGreaterThan(10);
  });

  test("every noul question refers to the field in backticks and carries true/false criteria", () => {
    const qs = buildRequest("x").questions;
    for (const id of QUESTION_IDS) {
      const q = qs[id];
      expect(q?.type).toBe("noul");
      expect(q?.instructions).toContain("`command`");
      expect(q?.criteria).toEqual({ true: expect.any(String), false: expect.any(String) });
    }
  });

  test("the questions object is shared, not rebuilt per call", () => {
    expect(buildRequest("a").questions).toBe(buildRequest("b").questions);
  });
});
