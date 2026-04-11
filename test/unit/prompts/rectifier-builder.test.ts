/**
 * Tests for RectifierPromptBuilder (Phase 5)
 *
 * Covers snapshot stability + structural contract for all 4 triggers:
 *   tdd-test-failure  — implementer fixes failing tests written by test-writer
 *   tdd-suite-failure — implementer fixes regressions after full-suite gate
 *   verify-failure    — post-verify rectification loop (autofix)
 *   review-findings   — review surfaced critical findings; rectifier addresses them
 */

import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../src/prd";
import { RectifierPromptBuilder } from "../../../src/prompts";
import type { FailureRecord, ReviewFinding, RectifierTrigger } from "../../../src/prompts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY: UserStory = {
  id: "US-042",
  title: "Add rate limiter to API gateway",
  description: "Implement per-client rate limiting on the API gateway.",
  acceptanceCriteria: [
    "Requests over the limit receive a 429 response",
    "Rate limit resets after the configured window",
  ],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 2,
};

const FAILURES: FailureRecord[] = [
  {
    test: "returns 429 when rate limit exceeded",
    file: "test/unit/gateway/rate-limiter.test.ts",
    message: "Expected 429, received 200",
    output: "at test/unit/gateway/rate-limiter.test.ts:34",
  },
  {
    test: "resets counter after window expires",
    file: "test/unit/gateway/rate-limiter.test.ts",
    message: "Expected counter to be 0, received 3",
  },
];

const FINDINGS: ReviewFinding[] = [
  {
    ruleId: "no-op-reset",
    severity: "critical",
    file: "src/gateway/rate-limiter.ts",
    line: 42,
    message: "Counter is never decremented — window reset is a no-op",
  },
  {
    ruleId: "non-atomic-increment",
    severity: "error",
    file: "src/gateway/rate-limiter.ts",
    line: 67,
    message: "Race condition: counter increment is not atomic",
  },
];

const TEST_CMD = "bun test test/unit/gateway/";
const CONSTITUTION = "You are a senior engineer. Fix only what is broken.";
const CONTEXT = "# Project Context\n\nThis project uses Bun 1.3+.";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildMinimal(trigger: RectifierTrigger): Promise<string> {
  return RectifierPromptBuilder.for(trigger).story(STORY).task().build();
}

// ─── Snapshot stability ───────────────────────────────────────────────────────

describe("RectifierPromptBuilder — snapshot stability", () => {
  const TRIGGERS: RectifierTrigger[] = [
    "tdd-test-failure",
    "tdd-suite-failure",
    "verify-failure",
    "review-findings",
  ];

  for (const trigger of TRIGGERS) {
    test(`minimal build — ${trigger}`, async () => {
      const result = await buildMinimal(trigger);
      expect(result).toMatchSnapshot();
    });
  }

  test("tdd-test-failure — full build with failures and test command", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      .constitution(CONSTITUTION)
      .context(CONTEXT)
      .story(STORY)
      .priorFailures(FAILURES)
      .testCommand(TEST_CMD)
      .isolation("strict")
      .conventions()
      .task()
      .build();
    expect(result).toMatchSnapshot();
  });

  test("review-findings — full build with findings", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      .constitution(CONSTITUTION)
      .context(CONTEXT)
      .story(STORY)
      .findings(FINDINGS)
      .isolation()
      .conventions()
      .task()
      .build();
    expect(result).toMatchSnapshot();
  });
});

// ─── Structural contract: fluent API ─────────────────────────────────────────

describe("RectifierPromptBuilder — fluent API", () => {
  test("RectifierPromptBuilder.for() returns a RectifierPromptBuilder", () => {
    const builder = RectifierPromptBuilder.for("tdd-test-failure");
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".story() is chainable", () => {
    const builder = RectifierPromptBuilder.for("verify-failure").story(STORY);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".priorFailures() is chainable", () => {
    const builder = RectifierPromptBuilder.for("tdd-suite-failure").story(STORY).priorFailures(FAILURES);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".findings() is chainable", () => {
    const builder = RectifierPromptBuilder.for("review-findings").story(STORY).findings(FINDINGS);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".testCommand() is chainable", () => {
    const builder = RectifierPromptBuilder.for("verify-failure").story(STORY).testCommand(TEST_CMD);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".task() is chainable", () => {
    const builder = RectifierPromptBuilder.for("tdd-test-failure").story(STORY).task();
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".build() returns a Promise<string>", async () => {
    const p = RectifierPromptBuilder.for("verify-failure").story(STORY).task().build();
    expect(p).toBeInstanceOf(Promise);
    expect(typeof (await p)).toBe("string");
  });
});

// ─── Structural contract: story section ──────────────────────────────────────

describe("RectifierPromptBuilder — story section", () => {
  test("includes story title", async () => {
    const result = await buildMinimal("tdd-suite-failure");
    expect(result).toContain(STORY.title);
  });

  test("includes story description", async () => {
    const result = await buildMinimal("verify-failure");
    expect(result).toContain(STORY.description);
  });

  test("includes acceptance criteria", async () => {
    const result = await buildMinimal("review-findings");
    for (const ac of STORY.acceptanceCriteria) {
      expect(result).toContain(ac);
    }
  });
});

// ─── Structural contract: prior failures section ─────────────────────────────

describe("RectifierPromptBuilder — prior failures section", () => {
  test("includes failure test names", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      .story(STORY)
      .priorFailures(FAILURES)
      .task()
      .build();
    for (const f of FAILURES) {
      expect(result).toContain(f.test!);
    }
  });

  test("includes failure messages", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .story(STORY)
      .priorFailures(FAILURES)
      .task()
      .build();
    for (const f of FAILURES) {
      expect(result).toContain(f.message);
    }
  });

  test("includes failure output when present", async () => {
    const result = await RectifierPromptBuilder.for("tdd-suite-failure")
      .story(STORY)
      .priorFailures(FAILURES)
      .task()
      .build();
    expect(result).toContain("at test/unit/gateway/rate-limiter.test.ts:34");
  });

  test("empty failures list produces no prior-failures section", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .story(STORY)
      .priorFailures([])
      .task()
      .build();
    expect(result).not.toContain("PRIOR FAILURES");
  });
});

// ─── Structural contract: findings section ───────────────────────────────────

describe("RectifierPromptBuilder — findings section", () => {
  test("includes finding descriptions", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      .story(STORY)
      .findings(FINDINGS)
      .task()
      .build();
    for (const f of FINDINGS) {
      expect(result).toContain(f.message);
    }
  });

  test("includes finding file paths", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      .story(STORY)
      .findings(FINDINGS)
      .task()
      .build();
    for (const f of FINDINGS) {
      expect(result).toContain(f.file);
    }
  });

  test("includes finding severities", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      .story(STORY)
      .findings(FINDINGS)
      .task()
      .build();
    expect(result).toContain("CRITICAL");
    expect(result).toContain("ERROR");
  });

  test("empty findings list produces no findings section", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      .story(STORY)
      .findings([])
      .task()
      .build();
    expect(result).not.toContain("REVIEW FINDINGS");
  });
});

// ─── Structural contract: test command section ───────────────────────────────

describe("RectifierPromptBuilder — test command section", () => {
  test("includes test command when provided", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .story(STORY)
      .testCommand(TEST_CMD)
      .task()
      .build();
    expect(result).toContain(TEST_CMD);
  });

  test("omits test command section when undefined", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      .story(STORY)
      .testCommand(undefined)
      .task()
      .build();
    expect(result).not.toContain("TEST COMMAND");
  });

  test("omits test command section when empty string", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      .story(STORY)
      .testCommand("")
      .task()
      .build();
    expect(result).not.toContain("TEST COMMAND");
  });
});

// ─── Structural contract: task section per trigger ───────────────────────────

describe("RectifierPromptBuilder — task section per trigger", () => {
  test("tdd-test-failure: instructs not to modify test files", async () => {
    const result = await buildMinimal("tdd-test-failure");
    expect(result).toContain("Rectification Required");
    expect(result).toContain("Do NOT modify test files");
  });

  test("tdd-suite-failure: instructs not to loosen assertions", async () => {
    const result = await buildMinimal("tdd-suite-failure");
    expect(result).toContain("Rectification Required");
    expect(result).toContain("loosening test assertions");
  });

  test("verify-failure: instructs to run the test command to verify fixes", async () => {
    const result = await buildMinimal("verify-failure");
    expect(result).toContain("Rectification Required");
    expect(result).toContain("verification step failed");
  });

  test("review-findings: instructs to verify findings before acting", async () => {
    const result = await buildMinimal("review-findings");
    expect(result).toContain("Rectification Required");
    expect(result).toContain("reviewer may have flagged false positives");
  });

  test("each trigger produces a distinct task section", async () => {
    const results = await Promise.all([
      buildMinimal("tdd-test-failure"),
      buildMinimal("tdd-suite-failure"),
      buildMinimal("verify-failure"),
      buildMinimal("review-findings"),
    ]);
    const unique = new Set(results);
    expect(unique.size).toBe(4);
  });
});

// ─── Structural contract: constitution + context ─────────────────────────────

describe("RectifierPromptBuilder — constitution and context", () => {
  test("includes constitution when provided", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      .constitution(CONSTITUTION)
      .story(STORY)
      .task()
      .build();
    expect(result).toContain(CONSTITUTION);
  });

  test("includes context when provided", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .context(CONTEXT)
      .story(STORY)
      .task()
      .build();
    expect(result).toContain("Project Context");
  });

  test("omits constitution section when undefined", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      .constitution(undefined)
      .story(STORY)
      .task()
      .build();
    expect(result).not.toContain("CONSTITUTION");
  });
});
