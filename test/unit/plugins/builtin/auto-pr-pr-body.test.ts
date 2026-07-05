/**
 * Auto-PR Plugin — PR Body Builder Tests
 *
 * Tests for buildTitle and buildBody pure functions.
 * Mirrors acceptance criteria US-002 §Body.
 */

import { describe, expect, test } from "bun:test";
import { buildBody, buildTitle } from "../../../../src/plugins/builtin/auto-pr/pr-body";
import type { PrBodyContext } from "../../../../src/plugins/builtin/auto-pr/pr-body";
import type { UserStory } from "../../../../src/prd/types";

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeStory(id: string, title: string, acceptanceCriteria: string[]): UserStory {
  return {
    id,
    title,
    description: "",
    acceptanceCriteria,
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeContext(overrides: Partial<PrBodyContext> = {}): PrBodyContext {
  return {
    feature: "auto-pr-plugin",
    totalCost: 0.42,
    totalDurationMs: 192_000,
    prdPath: ".nax/features/auto-pr-plugin/prd.json",
    storySummary: { completed: 4, failed: 0, skipped: 0, paused: 0 },
    stories: [
      makeStory("US-001", "Config foundation", ["a", "b", "c", "d"]),
      makeStory("US-002", "Build helpers", ["x"]),
    ],
    pluginConfig: {},
    logger: noopLogger,
    ...overrides,
  };
}

describe("buildTitle", () => {
  test("AC1 — returns 'feat: <feature>' for context feature", () => {
    const ctx = makeContext({ feature: "auto-pr-plugin" });
    expect(buildTitle(ctx)).toBe("feat: auto-pr-plugin");
  });

  test("uses the exact feature name passed in context", () => {
    const ctx = makeContext({ feature: "billing-receipts" });
    expect(buildTitle(ctx)).toBe("feat: billing-receipts");
  });
});

describe("buildBody (null template)", () => {
  test("AC2 — includes a review-pending banner referencing nax-finish", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, null);
    expect(body).toContain("nax-finish");
    expect(body).toMatch(/review\s+pending/i);
  });

  test("AC3 — story table has exactly ctx.stories.length rows", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, null);

    const tableLines = body.split("\n").filter((line) => line.startsWith("| US-"));
    expect(tableLines.length).toBe(ctx.stories.length);
  });

  test("AC4 — reports completed as passed and skipped count from storySummary", () => {
    const ctx = makeContext({
      storySummary: { completed: 3, failed: 0, skipped: 1, paused: 0 },
    });
    const body = buildBody(ctx, null);

    expect(body).toContain("3 passed");
    expect(body).toContain("1 skipped");
  });

  test("AC6 — contains no '---' template separator when template is null", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, null);

    expect(body).not.toMatch(/^---\s*$/m);
  });

  test("run summary includes feature, cost, duration, and PRD path", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, null);

    expect(body).toContain("auto-pr-plugin");
    expect(body).toContain("$0.42");
    expect(body).toContain("3m 12s");
    expect(body).toContain(".nax/features/auto-pr-plugin/prd.json");
  });
});

describe("buildBody (with template)", () => {
  test("AC5 — ends with the template text verbatim preceded by '---' separator", () => {
    const ctx = makeContext();
    const template = "## Checklist\n- [ ] x";

    const body = buildBody(ctx, template);

    expect(body).toContain("---\n## Checklist\n- [ ] x");
    expect(body.endsWith(template)).toBe(true);
  });

  test("table rows render story id, title, and AC count when template present", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, "## T");

    expect(body).toContain("| US-001 | Config foundation | 4 |");
    expect(body).toContain("| US-002 | Build helpers | 1 |");
  });
});
