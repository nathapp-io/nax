import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { GuardrailRole } from "@/prompts/sections";
import { buildNaxArtifactsSection } from "@/prompts/sections";

// AC-1: buildNaxArtifactsSection for test-writer mentions .nax/ immutability
// AC-2: returns non-null for test-writer
// AC-3: returns non-null for implementer
// AC-4: returns non-null for verifier
// AC-5: a test under .nax/ is not a reason to skip writing source-tree tests
// AC-6: a source-tree test is not a reason to remove a test under .nax/

describe("buildNaxArtifactsSection", () => {
  describe("test-writer role", () => {
    test("returns non-null string", () => {
      const result = buildNaxArtifactsSection("test-writer");
      expect(result).not.toBeNull();
      assertDefined(result, "result");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("mentions .nax/ files must never be moved, renamed, or deleted", () => {
      const result = buildNaxArtifactsSection("test-writer") as string;
      // The exact phrasing per AC-1: "files under `.nax/` must never be moved, renamed, or deleted".
      expect(result).toContain(".nax/");
      expect(result.toLowerCase()).toContain("moved");
      expect(result.toLowerCase()).toContain("renamed");
      expect(result.toLowerCase()).toContain("deleted");
    });

    test("states that a .nax/ test is not a reason to skip source-tree tests", () => {
      const result = buildNaxArtifactsSection("test-writer") as string;
      // AC-5
      expect(result.toLowerCase()).toContain(".nax/");
      expect(result.toLowerCase()).toMatch(/not.+reason.+skip.+source/);
    });

    test("states that a source-tree test is not a reason to remove a .nax/ test", () => {
      const result = buildNaxArtifactsSection("test-writer") as string;
      // AC-6
      expect(result.toLowerCase()).toMatch(/source.+test.+not.+reason.+remove.+\.nax\//);
    });
  });

  describe("implementer role", () => {
    test("returns non-null string", () => {
      const result = buildNaxArtifactsSection("implementer");
      expect(result).not.toBeNull();
      assertDefined(result, "result");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("verifier role", () => {
    test("returns non-null string", () => {
      const result = buildNaxArtifactsSection("verifier");
      expect(result).not.toBeNull();
      assertDefined(result, "result");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("verifier also sees the immutability text (AC-4 / story deviation)", () => {
      const result = buildNaxArtifactsSection("verifier") as string;
      expect(result).toContain(".nax/");
      expect(result.toLowerCase()).toMatch(/never.+moved.+renamed.+deleted|moved.+renamed.+or.+deleted/);
    });
  });

  describe("shared content across all roles", () => {
    const roles: GuardrailRole[] = ["test-writer", "implementer", "verifier"];

    test.each(roles)('role="%s": states a .nax/ test is not a reason to skip source-tree tests', (role) => {
      const result = buildNaxArtifactsSection(role) as string;
      expect(result.toLowerCase()).toMatch(/not.+reason.+skip/);
    });

    test.each(roles)('role="%s": states a source-tree test is not a reason to remove a .nax/ test', (role) => {
      const result = buildNaxArtifactsSection(role) as string;
      expect(result.toLowerCase()).toMatch(/not.+reason.+remove/);
    });

    test.each(roles)('role="%s": mentions immutability of .nax/ artifacts', (role) => {
      const result = buildNaxArtifactsSection(role) as string;
      // Per AC-1: a sentence about files under .nax/ never being moved/renamed/deleted.
      const lower = result.toLowerCase();
      const hasMoved = lower.includes("moved");
      const hasRenamed = lower.includes("renamed");
      const hasDeleted = lower.includes("deleted");
      expect(hasMoved && hasRenamed && hasDeleted).toBe(true);
    });
  });

  // ─── US-005 — the scratchpad is the one carve-out from .nax/ immutability ───

  describe("US-005 — scratchpad exception", () => {
    // AC-1: names `.nax/scratchpad/` as an exception
    test("implementer: names .nax/scratchpad/ as an exception", () => {
      const result = buildNaxArtifactsSection("implementer") as string;
      expect(result).toContain(".nax/scratchpad/");
      expect(result.toLowerCase()).toContain("exception");
    });

    // AC-1: still states files under `.nax/` must never be moved, renamed, or deleted
    test("implementer: still states files under .nax/ must never be moved, renamed, or deleted", () => {
      const result = buildNaxArtifactsSection("implementer") as string;
      expect(result.toLowerCase()).toContain("must never be moved, renamed, or deleted");
    });

    // AC-2: standard and lite variants return identical text
    test("standard and lite variants return identical text for every role", () => {
      const roles: GuardrailRole[] = ["test-writer", "implementer", "verifier"];
      for (const role of roles) {
        expect(buildNaxArtifactsSection(role, "lite", "lite")).toEqual(
          buildNaxArtifactsSection(role, "standard", "strict"),
        );
        expect(buildNaxArtifactsSection(role, "standard")).toEqual(buildNaxArtifactsSection(role, "lite"));
      }
    });
  });

  // ─── US-001 — PRD ownership told to the agent ───

  describe("US-001 — PRD ownership paragraph", () => {
    // AC8: the paragraph must tell the agent nax owns the PRD update, so a
    // `git status` "modified" reading is expected and must not be reverted.
    const flattened = () => buildNaxArtifactsSection("implementer").replace(/\s+/g, " ").toLowerCase();

    test("AC8: names the PRD path and says nax updates it itself during a run", () => {
      const text = flattened();
      expect(text).toContain(".nax/features/<feature>/prd.json");
      expect(text).toContain("nax updates");
      expect(text).toContain("during a run");
    });

    test("AC8: says it shows as modified so the agent must not diff or revert it", () => {
      const text = flattened();
      expect(text).toContain("shows as modified");
      expect(text).toContain("do not diff or revert");
    });

    test("AC8: points the agent at the `Read` tool for its contents", () => {
      const text = flattened();
      expect(text).toContain("`read` tool");
    });

    test("AC8: warns that shell commands naming it may be refused", () => {
      expect(flattened()).toContain("refused");
    });
  });

  // ─── US-004 — config-read hint for the project's declared commands ───
  //
  // The paragraph is appended only when the caller says the root config is
  // readable. It points the agent at `.nax/config.json` (`quality.commands`)
  // and at the per-package override file, so a command lookup is one `Read`
  // instead of a refused read plus a guess.

  describe("US-004 — config-read hint", () => {
    // AC1
    test("AC1: configReadable:true names the per-package mono config path", () => {
      const result = buildNaxArtifactsSection("implementer", undefined, undefined, { configReadable: true });
      expect(result).toContain(".nax/mono/<package>/config.json");
    });

    // AC1
    test("AC1: configReadable:true names the quality.commands key", () => {
      const result = buildNaxArtifactsSection("implementer", undefined, undefined, { configReadable: true });
      expect(result).toContain("quality.commands");
    });

    // AC1 boundary — the hint is appended, it does not replace the baseline text.
    test("AC1 boundary: configReadable:true keeps the baseline immutability text", () => {
      const baseline = buildNaxArtifactsSection("implementer");
      const hinted = buildNaxArtifactsSection("implementer", undefined, undefined, { configReadable: true });
      expect(hinted).toContain("do not diff or revert it");
      expect(hinted.length).toBeGreaterThan(baseline.length);
    });

    // AC2
    test("AC2: omitting options returns the same string as configReadable:false", () => {
      expect(buildNaxArtifactsSection("implementer")).toEqual(
        buildNaxArtifactsSection("implementer", undefined, undefined, { configReadable: false }),
      );
    });

    // AC2
    test("AC2: the baseline text omits quality.commands", () => {
      const result = buildNaxArtifactsSection("implementer");
      expect(result).not.toContain("quality.commands");
      expect(result).not.toContain(".nax/mono/<package>/config.json");
    });

    // AC2 boundary — an explicitly empty options object is "not true" too.
    test("AC2 boundary: an empty options object returns the baseline text", () => {
      expect(buildNaxArtifactsSection("implementer", undefined, undefined, {})).toEqual(
        buildNaxArtifactsSection("implementer"),
      );
    });
  });

  describe("purity", () => {
    test("returns same output for same inputs (test-writer)", () => {
      const a = buildNaxArtifactsSection("test-writer");
      const b = buildNaxArtifactsSection("test-writer");
      expect(a).toEqual(b);
    });

    test("returns same output for same inputs (implementer)", () => {
      const a = buildNaxArtifactsSection("implementer");
      const b = buildNaxArtifactsSection("implementer");
      expect(a).toEqual(b);
    });

    test("returns same output for same inputs (verifier)", () => {
      const a = buildNaxArtifactsSection("verifier");
      const b = buildNaxArtifactsSection("verifier");
      expect(a).toEqual(b);
    });
  });
});
