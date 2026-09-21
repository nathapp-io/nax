/**
 * PRD schema satellites folded into one file.
 *
 * - UserStory.workdirSource (nax#2067)
 * - agentProfileId preservation through the sanitizer
 * - raw control-character repair in parseRawString (#2124)
 *
 * They live beside schema.test.ts, which is 791 lines against the 800-line cap.
 */

import { describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf, assertDefined } from "@test/helpers";
import { NaxError } from "@/errors";
import { validatePlanOutput } from "@/prd/schema";
import { validateStory } from "@/prd/schema-story";

function baseStory(overrides: Record<string, unknown> = {}) {
  return {
    id: "US-001",
    title: "A story",
    description: "Does a thing",
    acceptanceCriteria: ["When x, then y"],
    complexity: "simple",
    ...overrides,
  };
}

/**
 * validateStory takes FOUR arguments: (raw, index, allIds, seenIds).
 *
 * `seenIds` is MUTATED — schema-story.ts:103 does `seenIds.add(id)` after a
 * duplicate check at :92. Sharing one Set across calls therefore makes the
 * second call with the same story id throw "duplicate id". Every call below
 * gets its own pair of Sets.
 */
function validate(raw: Record<string, unknown>) {
  return validateStory(raw, 0, new Set<string>(["US-001"]), new Set<string>());
}

describe("validateStory — workdirSource (nax#2067)", () => {
  test("passes through each of the three legal values", () => {
    for (const source of ["stated", "derived", "defaulted"] as const) {
      const story = validate(baseStory({ workdir: "packages/app", workdirSource: source }));
      expect(story.workdirSource).toBe(source);
    }
  });

  test("omits the field entirely when absent", () => {
    const story = validate(baseStory());
    expect(story.workdirSource).toBeUndefined();
    expect("workdirSource" in story).toBe(false);
  });

  test("rejects a value outside the three", () => {
    expect(() => validate(baseStory({ workdirSource: "guessed" }))).toThrow(/workdirSource/);
  });

  test("rejects a non-string value", () => {
    expect(() => validate(baseStory({ workdirSource: 3 }))).toThrow(/workdirSource/);
  });

  test("a defaulted story may carry no workdir", () => {
    const story = validate(baseStory({ workdirSource: "defaulted" }));
    expect(story.workdirSource).toBe("defaulted");
    expect(story.workdir).toBeUndefined();
  });
});

describe("PRD sanitizer preserves agentProfileId", () => {
  test("keeps routing.agentProfileId emitted by the planner", () => {
    const raw = JSON.stringify({
      project: "p",
      feature: "f",
      branchName: "feat/f",
      userStories: [
        {
          id: "US-001",
          title: "t",
          description: "d",
          acceptanceCriteria: ["When X, then Y"],
          tags: [],
          dependencies: [],
          routing: {
            complexity: "medium",
            testStrategy: "tdd-simple",
            reasoning: "because",
            agentProfileId: "opencode-structural",
          },
        },
      ],
    });
    const prd = validatePlanOutput(raw, "f", "feat/f");
    const story = prd.userStories[0];
    assertDefined(story, "prd.userStories[0]");
    assertDefined(story.routing, "story.routing");
    expect(story.routing.agentProfileId).toBe("opencode-structural");
  });

  test("omits agentProfileId when the planner did not emit one", () => {
    const raw = JSON.stringify({
      project: "p",
      feature: "f",
      branchName: "feat/f",
      userStories: [
        {
          id: "US-001",
          title: "t",
          description: "d",
          acceptanceCriteria: ["When X, then Y"],
          tags: [],
          dependencies: [],
          routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "because" },
        },
      ],
    });
    const prd = validatePlanOutput(raw, "f", "feat/f");
    const story = prd.userStories[0];
    assertDefined(story, "prd.userStories[0]");
    assertDefined(story.routing, "story.routing");
    expect(story.routing.agentProfileId).toBeUndefined();
  });
});

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
