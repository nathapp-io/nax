/**
 * Characterization tests for validateStory (src/prd/schema-story.ts), pinning
 * current behaviour before the complexity-drain refactor (docs/plans/STATUS-complexity-drain.md P0).
 *
 * workdirSource coverage already lives in ./schema-workdir-source.test.ts — not
 * duplicated here.
 */

import { describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf, assertDefined } from "@test/helpers";
import { NaxError } from "@/errors";
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

/** Fresh Sets per call — seenIds is mutated by the function under test. */
function validate(raw: Record<string, unknown>, allIds = new Set<string>(["US-001", "US-002"])) {
  return validateStory(raw, 0, allIds, new Set<string>());
}

function throwsSchemaError(raw: Record<string, unknown>, messagePattern: RegExp) {
  let thrown: unknown;
  try {
    validate(raw);
  } catch (err) {
    thrown = err;
  }
  assertCaughtInstanceOf(thrown, NaxError, "validateStory rejection");
  expect(thrown.code).toBe("SCHEMA_VALIDATION_FAILED");
  expect(thrown.message).toMatch(messagePattern);
}

describe("validateStory — top-level shape", () => {
  test("rejects a non-object", () => {
    expect(() => validateStory("nope", 0, new Set(), new Set())).toThrow(/must be an object/);
  });

  test("rejects null", () => {
    expect(() => validateStory(null, 0, new Set(), new Set())).toThrow(/must be an object/);
  });

  test("rejects an array", () => {
    expect(() => validateStory([], 0, new Set(), new Set())).toThrow(/must be an object/);
  });
});

describe("validateStory — id", () => {
  test("rejects missing id", () => throwsSchemaError(baseStory({ id: undefined }), /id is required/));
  test("rejects empty id", () => throwsSchemaError(baseStory({ id: "" }), /id is required/));
  test("rejects non-string id", () => throwsSchemaError(baseStory({ id: 42 }), /id must be a string/));

  test("normalizes ST001 -> ST-001", () => {
    const story = validate(baseStory({ id: "US001" }), new Set(["US001"]));
    expect(story.id).toBe("US-001");
  });

  test("rejects a duplicate id within the same seenIds set", () => {
    const seen = new Set<string>();
    const allIds = new Set<string>(["US-001"]);
    validateStory(baseStory(), 0, allIds, seen);
    expect(() => validateStory(baseStory(), 1, allIds, seen)).toThrow(/duplicate of an earlier story/);
  });
});

describe("validateStory — title / description / acceptanceCriteria", () => {
  test("rejects missing title", () => throwsSchemaError(baseStory({ title: undefined }), /title is required/));
  test("rejects blank title", () => throwsSchemaError(baseStory({ title: "   " }), /title is required/));
  test("rejects missing description", () =>
    throwsSchemaError(baseStory({ description: undefined }), /description is required/));
  test("rejects blank description", () =>
    throwsSchemaError(baseStory({ description: "  " }), /description is required/));
  test("rejects missing acceptanceCriteria", () =>
    throwsSchemaError(baseStory({ acceptanceCriteria: undefined }), /acceptanceCriteria is required/));
  test("rejects empty acceptanceCriteria array", () =>
    throwsSchemaError(baseStory({ acceptanceCriteria: [] }), /acceptanceCriteria is required/));
  test("rejects a non-string acceptanceCriteria entry", () =>
    throwsSchemaError(baseStory({ acceptanceCriteria: ["ok", 5] }), /acceptanceCriteria\[1\] must be a string/));

  test("trims title and description on the returned story", () => {
    const story = validate(baseStory({ title: "  Trim me  ", description: "  also me  " }));
    expect(story.title).toBe("Trim me");
    expect(story.description).toBe("also me");
  });
});

describe("validateStory — suggestedCriteria", () => {
  test("omitted -> undefined", () => {
    const story = validate(baseStory());
    expect(story.suggestedCriteria).toBeUndefined();
  });

  test("rejects a non-array value", () =>
    throwsSchemaError(baseStory({ suggestedCriteria: "nope" }), /suggestedCriteria must be an array/));

  test("empty array is stripped to undefined", () => {
    const story = validate(baseStory({ suggestedCriteria: [] }));
    expect(story.suggestedCriteria).toBeUndefined();
  });

  test("coerces {criterion, rationale} objects to plain strings", () => {
    const story = validate(
      baseStory({
        suggestedCriteria: ["plain", { criterion: "extracted", rationale: "because" }],
      }),
    );
    expect(story.suggestedCriteria).toEqual(["plain", "extracted"]);
  });

  test("rejects an entry that is neither a string nor a {criterion} object", () =>
    throwsSchemaError(baseStory({ suggestedCriteria: [42] }), /suggestedCriteria\[0\] must be a string/));
});

describe("validateStory — complexity", () => {
  test("rejects missing complexity", () =>
    throwsSchemaError(baseStory({ complexity: undefined }), /missing complexity/));

  test("reads from top-level complexity when routing.complexity is absent", () => {
    const story = validate(baseStory({ complexity: "MEDIUM" }));
    assertDefined(story.routing, "story.routing");
    expect(story.routing.complexity).toBe("medium");
  });

  test("prefers routing.complexity over top-level complexity", () => {
    const story = validate(baseStory({ complexity: "simple", routing: { complexity: "expert" } }));
    assertDefined(story.routing, "story.routing");
    expect(story.routing.complexity).toBe("expert");
  });

  test("rejects a non-string complexity", () =>
    throwsSchemaError(baseStory({ complexity: 3 }), /routing.complexity must be a string/));

  test("rejects an invalid complexity value", () =>
    throwsSchemaError(baseStory({ complexity: "trivial" }), /routing.complexity "trivial" is invalid/));
});

describe("validateStory — testStrategy / noTestJustification (BUG-26)", () => {
  test("defaults to test-after when routing.testStrategy is absent", () => {
    const story = validate(baseStory());
    assertDefined(story.routing, "story.routing");
    expect(story.routing.testStrategy).toBe("test-after");
  });

  test("requires noTestJustification when testStrategy is no-test", () =>
    throwsSchemaError(
      baseStory({ routing: { complexity: "simple", testStrategy: "no-test" } }),
      /noTestJustification is required/,
    ));

  test("rejects a blank noTestJustification when testStrategy is no-test", () =>
    throwsSchemaError(
      baseStory({
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "   " },
      }),
      /noTestJustification is required/,
    ));

  test("accepts no-test with a justification present", () => {
    const story = validate(
      baseStory({
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "config-only change" },
      }),
    );
    assertDefined(story.routing, "story.routing");
    expect(story.routing.testStrategy).toBe("no-test");
    expect(story.routing.noTestJustification).toBe("config-only change");
  });

  test("auto-downgrades to no-test when the justification text signals absent tests", () => {
    const story = validate(
      baseStory({
        routing: {
          complexity: "simple",
          testStrategy: "test-after",
          noTestJustification: "This story cannot be tested automatically.",
        },
      }),
    );
    assertDefined(story.routing, "story.routing");
    expect(story.routing.testStrategy).toBe("no-test");
  });

  test("does NOT downgrade when the justification text has no no-test signal (BUG-26)", () => {
    const story = validate(
      baseStory({
        routing: {
          complexity: "simple",
          testStrategy: "test-after",
          noTestJustification: "Straightforward refactor, unrelated note.",
        },
      }),
    );
    assertDefined(story.routing, "story.routing");
    expect(story.routing.testStrategy).toBe("test-after");
    expect(story.routing.noTestJustification).toBe("Straightforward refactor, unrelated note.");
  });

  test("omits noTestJustification from routing when absent", () => {
    const story = validate(baseStory());
    assertDefined(story.routing, "story.routing");
    expect(story.routing.noTestJustification).toBeUndefined();
  });
});

describe("validateStory — dependencies", () => {
  test("defaults to an empty array", () => {
    const story = validate(baseStory());
    expect(story.dependencies).toEqual([]);
  });

  test("normalizes and dedupes dependency ids", () => {
    const story = validate(baseStory({ dependencies: ["US002", "US-002"] }), new Set(["US-001", "US-002"]));
    expect(story.dependencies).toEqual(["US-002"]);
  });

  test("rejects a non-string dependency entry", () =>
    throwsSchemaError(baseStory({ dependencies: [42] }), /dependencies\[0\] must be a string/));

  test("rejects a dependency referencing an unknown id", () =>
    throwsSchemaError(baseStory({ dependencies: ["US-999"] }), /references unknown story ID "US-999"/));
});

describe("validateStory — tags", () => {
  test("defaults to an empty array", () => {
    const story = validate(baseStory());
    expect(story.tags).toEqual([]);
  });

  test("passes through string tags", () => {
    const story = validate(baseStory({ tags: ["a", "b"] }));
    expect(story.tags).toEqual(["a", "b"]);
  });

  test("rejects a non-string tag entry", () =>
    throwsSchemaError(baseStory({ tags: ["ok", 7] }), /tags\[1\] must be a string \(got number\)/));
});

describe("validateStory — workdir", () => {
  test("omitted -> undefined", () => {
    const story = validate(baseStory());
    expect(story.workdir).toBeUndefined();
  });

  test("rejects a non-string workdir", () => throwsSchemaError(baseStory({ workdir: 1 }), /workdir must be a string/));

  test("rejects an absolute workdir", () =>
    throwsSchemaError(baseStory({ workdir: "/etc" }), /workdir must be relative/));

  test("rejects a workdir containing '..'", () =>
    throwsSchemaError(baseStory({ workdir: "../escape" }), /workdir must not contain '\.\.'/));

  test("accepts a relative workdir", () => {
    const story = validate(baseStory({ workdir: "packages/app" }));
    expect(story.workdir).toBe("packages/app");
  });
});

describe("validateStory — contextFiles", () => {
  test("omitted or empty -> omitted from the result", () => {
    const story = validate(baseStory());
    expect(story.contextFiles).toBeUndefined();
  });

  test("accepts plain string entries, skipping blanks", () => {
    const story = validate(baseStory({ contextFiles: ["src/a.ts", "  ", "src/b.ts"] }));
    expect(story.contextFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("accepts {path, factId} object entries", () => {
    const story = validate(baseStory({ contextFiles: [{ path: "src/a.ts", factId: "F1" }] }));
    expect(story.contextFiles).toEqual([{ path: "src/a.ts", factId: "F1" }]);
  });

  test("drops factId when not a non-empty string", () => {
    const story = validate(baseStory({ contextFiles: [{ path: "src/a.ts", factId: "" }] }));
    expect(story.contextFiles).toEqual([{ path: "src/a.ts" }]);
  });

  test("rejects an absolute string entry", () =>
    throwsSchemaError(baseStory({ contextFiles: ["/abs.ts"] }), /must be relative \(no absolute paths\)/));

  test("rejects a string entry containing '..'", () =>
    throwsSchemaError(baseStory({ contextFiles: ["../escape.ts"] }), /must not contain '\.\.'/));

  test("rejects an absolute object-path entry", () =>
    throwsSchemaError(baseStory({ contextFiles: [{ path: "/abs.ts" }] }), /must be relative \(no absolute paths\)/));

  test("silently filters non-string, non-object entries", () => {
    const story = validate(baseStory({ contextFiles: [42, null, "src/a.ts"] }));
    expect(story.contextFiles).toEqual(["src/a.ts"]);
  });
});

describe("validateStory — expectedFiles", () => {
  test("omitted or empty -> omitted from the result", () => {
    const story = validate(baseStory());
    expect(story.expectedFiles).toBeUndefined();
  });

  test("trims and keeps relative paths, skips blanks and non-strings", () => {
    const story = validate(baseStory({ expectedFiles: ["  src/new.ts  ", "", 5] }));
    expect(story.expectedFiles).toEqual(["src/new.ts"]);
  });

  test("rejects an absolute expectedFiles entry", () =>
    throwsSchemaError(baseStory({ expectedFiles: ["/abs.ts"] }), /must be relative \(no absolute paths\)/));

  test("rejects an expectedFiles entry containing '..'", () =>
    throwsSchemaError(baseStory({ expectedFiles: ["../escape.ts"] }), /must not contain '\.\.'/));
});

describe("validateStory — modifiedFiles", () => {
  test("omitted or empty -> omitted from the result", () => {
    const story = validate(baseStory());
    expect(story.modifiedFiles).toBeUndefined();
  });

  test("keeps {path, reason} entries, defaulting reason to empty string", () => {
    const story = validate(
      baseStory({
        modifiedFiles: [{ path: "src/a.ts", reason: "touch it" }, { path: "src/b.ts" }],
      }),
    );
    expect(story.modifiedFiles).toEqual([
      { path: "src/a.ts", reason: "touch it" },
      { path: "src/b.ts", reason: "" },
    ]);
  });

  test("silently filters non-object entries and blank paths", () => {
    const story = validate(baseStory({ modifiedFiles: ["nope", { path: "  " }, { path: "src/a.ts" }] }));
    expect(story.modifiedFiles).toEqual([{ path: "src/a.ts", reason: "" }]);
  });

  test("rejects an absolute modifiedFiles path", () =>
    throwsSchemaError(baseStory({ modifiedFiles: [{ path: "/abs.ts" }] }), /must be relative \(no absolute paths\)/));

  test("rejects a modifiedFiles path containing '..'", () =>
    throwsSchemaError(baseStory({ modifiedFiles: [{ path: "../escape.ts" }] }), /must not contain '\.\.'/));
});

describe("validateStory — verifiedBy", () => {
  test("omitted -> undefined", () => {
    const story = validate(baseStory());
    expect(story.verifiedBy).toBeUndefined();
  });

  test("accepts a valid kind and defaults anchor/factIds", () => {
    const story = validate(baseStory({ verifiedBy: { kind: "test" } }));
    expect(story.verifiedBy).toEqual({ kind: "test", anchor: "", factIds: [] });
  });

  test("keeps anchor and filters non-string factIds", () => {
    const story = validate(baseStory({ verifiedBy: { kind: "symbol", anchor: "Foo.bar", factIds: ["F1", 2, "F2"] } }));
    expect(story.verifiedBy).toEqual({ kind: "symbol", anchor: "Foo.bar", factIds: ["F1", "F2"] });
  });

  test("rejects an invalid kind", () =>
    throwsSchemaError(baseStory({ verifiedBy: { kind: "bogus" } }), /verifiedBy.kind "bogus" is invalid/));
});

describe("validateStory — intent", () => {
  test("omitted -> undefined", () => {
    const story = validate(baseStory());
    expect(story.intent).toBeUndefined();
  });

  test("passes through a boolean", () => {
    expect(validate(baseStory({ intent: true })).intent).toBe(true);
    expect(validate(baseStory({ intent: false })).intent).toBe(false);
  });

  test("a non-boolean value is dropped to undefined", () => {
    const story = validate(baseStory({ intent: "yes" }));
    expect(story.intent).toBeUndefined();
  });
});

describe("validateStory — routing.reasoning / agentProfileId", () => {
  test("falls back to a default reasoning string when absent", () => {
    const story = validate(baseStory());
    assertDefined(story.routing, "story.routing");
    expect(story.routing.reasoning).toBe("validated from LLM output");
  });

  test("trims a provided reasoning string", () => {
    const story = validate(baseStory({ routing: { complexity: "simple", reasoning: "  because X  " } }));
    assertDefined(story.routing, "story.routing");
    expect(story.routing.reasoning).toBe("because X");
  });

  test("omits agentProfileId when blank", () => {
    const story = validate(baseStory({ routing: { complexity: "simple", agentProfileId: "   " } }));
    assertDefined(story.routing, "story.routing");
    expect(story.routing.agentProfileId).toBeUndefined();
  });
});

describe("validateStory — forced runtime state", () => {
  test("always forces status/passes/attempts/escalations regardless of raw input", () => {
    const story = validate(baseStory({ status: "passed", passes: true, attempts: 9, escalations: ["x"] }));
    expect(story.status).toBe("pending");
    expect(story.passes).toBe(false);
    expect(story.attempts).toBe(0);
    expect(story.escalations).toEqual([]);
  });
});
