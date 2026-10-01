/**
 * Auto-PR Plugin — PR Body Builder Tests
 *
 * Tests for buildTitle and buildBody pure functions.
 * Mirrors acceptance criteria US-002 §Body.
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { PrBodyContext } from "@/plugins/builtin/auto-pr/pr-body";
import { buildBody, buildTitle } from "@/plugins/builtin/auto-pr/pr-body";

function makeContext(overrides: Partial<PrBodyContext> = {}): PrBodyContext {
  return {
    feature: "auto-pr-plugin",
    totalDurationMs: 192_000,
    prdPath: ".nax/features/auto-pr-plugin/prd.json",
    storySummary: { completed: 4, failed: 0, skipped: 0 },
    stories: [
      makeStory({ id: "US-001", title: "Config foundation", acceptanceCriteria: ["a", "b", "c", "d"] }),
      makeStory({ id: "US-002", title: "Build helpers", acceptanceCriteria: ["x"] }),
    ],
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
      storySummary: { completed: 3, failed: 0, skipped: 1 },
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

  test("run summary includes feature, duration, and PRD path", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, null);

    expect(body).toContain("auto-pr-plugin");
    expect(body).not.toContain("Cost:");
    expect(body).toContain("3m 12s");
    expect(body).toContain(".nax/features/auto-pr-plugin/prd.json");
  });
});

describe("buildBody (with template)", () => {
  // Supersedes the original AC5 ("ends with the template verbatim, preceded by
  // a `---` separator"). Appending an unfilled template below filled content is
  // the nax#1504 defect; the template is now merged, by the same
  // `mergeTemplate` the nax-finish body uses.
  test("AC5 — drops a template section it cannot fill instead of appending it blank", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, "## Checklist\n- [ ] x");

    expect(body).not.toContain("## Checklist");
    expect(body).not.toContain("- [ ] x");
    expect(body).toContain("| US-001 | Config foundation | 4 |");
  });

  test("AC5 — fills a template heading it can match, using the template's own wording", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, "## How\n\n<!-- key details -->");

    expect(body).toContain("## How");
    expect(body).not.toContain("## Run summary");
    expect(body).not.toContain("<!--");
    expect(body).toContain("| US-001 | Config foundation | 4 |");
  });

  test("keeps the review-pending banner leading the body when a template merges in", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, "## How\n\n<!-- x -->");

    expect(body.startsWith("> Auto-opened by nax")).toBe(true);
  });

  test("table rows render story id, title, and AC count when template present", () => {
    const ctx = makeContext();
    const body = buildBody(ctx, "## T");

    expect(body).toContain("| US-001 | Config foundation | 4 |");
    expect(body).toContain("| US-002 | Build helpers | 1 |");
  });
});

describe("buildBody edge cases", () => {
  test("clamps negative totalDurationMs to zero instead of rendering negative minutes", () => {
    const ctx = makeContext({ totalDurationMs: -1000 });
    const body = buildBody(ctx, null);

    expect(body).not.toMatch(/-\d+m/);
    expect(body).toContain("0m 00s");
  });

  test("escapes pipe characters in story id and title to keep table row intact", () => {
    const ctx = makeContext({
      stories: [makeStory({ id: "US|x", title: "Title|y", acceptanceCriteria: ["a"] })],
    });
    const body = buildBody(ctx, null);

    expect(body).toContain("US\\|x");
    expect(body).toContain("Title\\|y");
  });

  test("flattens newlines in title to a single line per row", () => {
    const ctx = makeContext({
      stories: [makeStory({ id: "US-099", title: "Line1\nLine2", acceptanceCriteria: ["a"] })],
    });
    const body = buildBody(ctx, null);

    const row = body.split("\n").find((line) => line.startsWith("| US-099"));
    expect(row).toBeDefined();
    expect(row).not.toContain("Line1\nLine2");
    expect(row).toContain("Line1 Line2");
  });
});
