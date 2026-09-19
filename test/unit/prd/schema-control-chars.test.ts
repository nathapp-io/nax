/**
 * Unit tests for the raw control-character repair rung in parseRawString (#2124).
 *
 * The planner wrote prd.json with a literal newline inside the `analysis`
 * string. Every JSON parser rejected the whole 17.6 KB file with
 * "Unterminated string", although the payload was otherwise complete.
 */

import { describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf } from "@test/helpers";
import { NaxError } from "@/errors";
import { validatePlanOutput } from "@/prd/schema";

/** One valid story, inlined so the fixtures below stay readable. */
const STORY =
  '{"id":"US-001","title":"A story","description":"Does a thing","acceptanceCriteria":["AC-1: it works","AC-2: it fails on invalid input"],"complexity":"simple","testStrategy":"tdd-simple","dependencies":[]}';

describe("validatePlanOutput — raw control characters", () => {
  test("recovers a PRD whose analysis holds a raw newline", () => {
    // The \n below is a REAL newline byte inside the JSON string.
    const raw = `{"analysis":"Reviewed the codebase.\nTwo stories follow.","userStories":[${STORY}]}`;

    const prd = validatePlanOutput(raw, "feat-x", "feat/feat-x");

    expect(prd.analysis).toBe("Reviewed the codebase.\nTwo stories follow.");
    expect(prd.userStories).toHaveLength(1);
    expect(prd.userStories[0]?.id).toBe("US-001");
  });

  test("recovers a raw tab inside a story description", () => {
    const story = STORY.replace('"Does a thing"', '"Does\ta thing"');
    const prd = validatePlanOutput(`{"userStories":[${story}]}`, "feat-x", "feat/feat-x");
    expect(prd.userStories[0]?.description).toBe("Does\ta thing");
  });

  test("leaves a pretty-printed PRD untouched", () => {
    const pretty = `{\n  "analysis": "clean",\n  "userStories": [${STORY}]\n}`;
    const prd = validatePlanOutput(pretty, "feat-x", "feat/feat-x");
    expect(prd.analysis).toBe("clean");
  });

  test("still rejects a payload that is broken for another reason", () => {
    // Truncated: the repair cannot and must not rescue this.
    let thrown: unknown;
    try {
      validatePlanOutput(`{"analysis":"a\nb","userStories":[${STORY}`, "feat-x", "feat/feat-x");
    } catch (err) {
      thrown = err;
    }
    assertCaughtInstanceOf(thrown, NaxError, "validatePlanOutput rejection");
    expect(thrown.code).toBe("SCHEMA_VALIDATION_FAILED");
  });
});
