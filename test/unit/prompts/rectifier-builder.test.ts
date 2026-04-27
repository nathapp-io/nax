/**
 * Tests for RectifierPromptBuilder
 *
 * Covers snapshot stability + structural contract for the two active triggers:
 *   tdd-suite-failure — implementer fixes regressions after full-suite gate
 *   verify-failure    — post-verify rectification loop (autofix)
 */

import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../src/prd";
import { RectifierPromptBuilder } from "../../../src/prompts";
import type { FailureRecord, RectifierTrigger } from "../../../src/prompts";

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

const TEST_CMD = "bun test test/unit/gateway/";
const CONTEXT = "# Project Context\n\nThis project uses Bun 1.3+.";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildMinimal(trigger: RectifierTrigger): Promise<string> {
  return RectifierPromptBuilder.for(trigger).story(STORY).conventions().build();
}

// ─── Snapshot stability ───────────────────────────────────────────────────────

describe("RectifierPromptBuilder — snapshot stability", () => {
  const TRIGGERS: ("tdd-suite-failure" | "verify-failure")[] = [
    "tdd-suite-failure",
    "verify-failure",
  ];

  for (const trigger of TRIGGERS) {
    test(`minimal build — ${trigger}`, async () => {
      const result = await buildMinimal(trigger);
      expect(result).toMatchSnapshot();
    });
  }
});

// ─── Structural contract: fluent API ─────────────────────────────────────────

describe("RectifierPromptBuilder — fluent API", () => {
  test(".story() is chainable", () => {
    const builder = RectifierPromptBuilder.for("verify-failure").story(STORY);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".priorFailures() is chainable", () => {
    const builder = RectifierPromptBuilder.for("tdd-suite-failure").story(STORY).priorFailures(FAILURES);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".testCommand() is chainable", () => {
    const builder = RectifierPromptBuilder.for("verify-failure").story(STORY).testCommand(TEST_CMD);
    expect(builder).toBeInstanceOf(RectifierPromptBuilder);
  });

  test(".build() returns a Promise<string>", async () => {
    const p = RectifierPromptBuilder.for("verify-failure").story(STORY).conventions().build();
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
});

// ─── Structural contract: prior failures section ─────────────────────────────

describe("RectifierPromptBuilder — prior failures section", () => {
  test("includes failure messages", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .story(STORY)
      .priorFailures(FAILURES)
      .conventions()
      .build();
    for (const f of FAILURES) {
      expect(result).toContain(f.message);
    }
  });

  test("includes failure output when present", async () => {
    const result = await RectifierPromptBuilder.for("tdd-suite-failure")
      .story(STORY)
      .priorFailures(FAILURES)
      .conventions()
      .build();
    expect(result).toContain("at test/unit/gateway/rate-limiter.test.ts:34");
  });

  test("empty failures list produces no prior-failures section", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .story(STORY)
      .priorFailures([])
      .conventions()
      .build();
    expect(result).not.toContain("PRIOR FAILURES");
  });
});

// ─── Structural contract: test command section ───────────────────────────────

describe("RectifierPromptBuilder — test command section", () => {
  test("includes test command when provided", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .story(STORY)
      .testCommand(TEST_CMD)
      .conventions()
      .build();
    expect(result).toContain(TEST_CMD);
  });
});

// ─── Structural contract: constitution + context ─────────────────────────────

describe("RectifierPromptBuilder — constitution and context", () => {
  test("includes context when provided", async () => {
    const result = await RectifierPromptBuilder.for("verify-failure")
      .context(CONTEXT)
      .story(STORY)
      .conventions()
      .build();
    expect(result).toContain("Project Context");
  });
});
