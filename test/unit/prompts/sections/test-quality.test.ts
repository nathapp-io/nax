/**
 * Tests for buildTestQualitySection — the adversarial test-gap pre-brief
 * injected into test-authoring role prompts (July 2026 audit, recommendation #1).
 *
 * test-gap was 67% of adversarial blocking findings in July 2026; this section
 * moves the reviewer's audit lenses into the prompts of the roles that author
 * tests, so the knowledge arrives before the tests are written instead of one
 * review round + one rectification round later.
 */

import { describe, expect, test } from "bun:test";
import { buildTestQualitySection } from "@/prompts/sections/test-quality";

const TEST_AUTHORING_ROLES = ["test-writer", "single-session", "tdd-simple", "batch"] as const;

describe("buildTestQualitySection — test-authoring roles", () => {
  test.each([...TEST_AUTHORING_ROLES])("returns the pre-brief for %s", (role) => {
    const section = buildTestQualitySection(role);
    expect(section).not.toBe("");
    expect(section).toContain("# Review-Proof Tests");
  });

  test.each([...TEST_AUTHORING_ROLES])("%s pre-brief names the adversarial reviewer as the gate", (role) => {
    const section = buildTestQualitySection(role);
    // The section must explain WHY (an adversarial reviewer audits with these
    // exact lenses) — motivation is what makes the model comply.
    expect(section.toLowerCase()).toContain("adversarial");
    expect(section).toContain("test-gap");
  });

  test("pre-brief bans source-inspection tests", () => {
    const section = buildTestQualitySection("test-writer");
    // The dominant July failure: tests that assert a pattern exists in a file
    // instead of invoking the code. The ban must be explicit.
    expect(section).toContain("source-inspection");
    expect(section).toMatch(/invoke|execute|call/i);
  });

  test("pre-brief bans placeholder and tautological tests", () => {
    const section = buildTestQualitySection("test-writer");
    expect(section).toContain("expect(true).toBe(true)");
    expect(section).toMatch(/\.skip|todo/);
  });

  test("pre-brief requires per-AC runtime coverage and exported-symbol coverage", () => {
    const section = buildTestQualitySection("test-writer");
    expect(section).toMatch(/every (acceptance criterion|AC)/i);
    expect(section).toMatch(/export/i);
  });

  test("pre-brief covers boundary and error-path lenses", () => {
    const section = buildTestQualitySection("test-writer");
    expect(section).toMatch(/error path/i);
    expect(section).toMatch(/empty|null|zero/i);
  });
});

describe("buildTestQualitySection — implementer lite variant fills coverage gaps", () => {
  test("implementer with lite variant receives the pre-brief", () => {
    const section = buildTestQualitySection("implementer", "lite");
    expect(section).toContain("# Review-Proof Tests");
  });

  test("implementer standard variant does not author tests — no section", () => {
    expect(buildTestQualitySection("implementer", "standard")).toBe("");
    expect(buildTestQualitySection("implementer")).toBe("");
  });
});

describe("buildTestQualitySection — non-authoring roles get nothing", () => {
  test.each(["verifier", "no-test"] as const)("returns empty string for %s", (role) => {
    expect(buildTestQualitySection(role)).toBe("");
  });
});

describe("buildTestQualitySection — story ID pinning", () => {
  test("pins the story ID in test names when provided", () => {
    const section = buildTestQualitySection("test-writer", undefined, "US-004");
    // July 2026: 598 convention findings were sibling-copy story IDs
    // (test_us009_* inside US-004). The section pins the real ID.
    expect(section).toContain("US-004");
  });

  test("omits the story-ID line when no story ID is given", () => {
    const section = buildTestQualitySection("test-writer");
    expect(section).not.toContain("THIS story's ID");
  });
});

describe("buildTestQualitySection — size budget", () => {
  test("stays under 1600 characters — this is a token-saving change, not a token sink", () => {
    const section = buildTestQualitySection("test-writer", undefined, "US-001");
    expect(section.length).toBeLessThan(1600);
  });
});
