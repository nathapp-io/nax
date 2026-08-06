/**
 * The "What changed" narrative (#1477).
 *
 * Every guarantee here is on a pure function. The acp node that produces the
 * model text cannot be executed in tests (acpx is not a test harness), so the
 * degradation chain has to be reachable without it — that is why
 * `resolveNarrative` exists as a separate function rather than as flow wiring.
 */
import { describe, expect, test } from "bun:test";
import {
  NARRATIVE_MAX_CHARS,
  buildNarrativePrompt,
  parseNarrative,
  readSpecSummary,
  resolveNarrative,
} from "@flows/nax-finish/narrative";

describe("resolveNarrative", () => {
  test("prefers the agent's text over the spec summary", () => {
    expect(resolveNarrative("model prose", "spec prose")).toBe("model prose");
  });

  test("falls back to the spec summary when the agent produced nothing", () => {
    expect(resolveNarrative(undefined, "spec prose")).toBe("spec prose");
  });

  test("treats whitespace-only agent text as nothing", () => {
    expect(resolveNarrative("   \n  ", "spec prose")).toBe("spec prose");
  });

  test("returns undefined when neither source has content", () => {
    expect(resolveNarrative(undefined, null)).toBeUndefined();
    expect(resolveNarrative("  ", "   ")).toBeUndefined();
  });

  test("truncates an over-long narrative rather than rendering it whole", () => {
    const huge = "x".repeat(NARRATIVE_MAX_CHARS + 500);
    const resolved = resolveNarrative(huge, null) as string;
    expect(resolved.length).toBe(NARRATIVE_MAX_CHARS);
    expect(resolved.endsWith("…")).toBe(true);
  });
});

describe("parseNarrative", () => {
  test("trims the reply", () => {
    expect(parseNarrative("  prose  \n")).toBe("prose");
  });

  test("never throws on an empty reply — a throw would fail the flow", () => {
    expect(parseNarrative("")).toBe("");
  });
});

describe("readSpecSummary", () => {
  const readerFor = (files: Record<string, string>) => async (p: string) => files[p] ?? null;

  test("extracts a '## Summary' section up to the next heading", async () => {
    const spec = "# SPEC: thing\n\n## Summary\n\nIt does a thing.\n\n## Motivation\n\nBecause.\n";
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": spec }))).toBe("It does a thing.");
  });

  test("accepts '## Overview' — the older spec shape in this repo", async () => {
    const spec = "# Feature: plugin-001\n\n## Overview\n\nOlder shape.\n\n## Design\n\nx\n";
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": spec }))).toBe("Older shape.");
  });

  test("reads a summary that runs to end of file", async () => {
    const spec = "# T\n\n## Summary\n\nLast section.\n";
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": spec }))).toBe("Last section.");
  });

  test("returns null when the heading is absent", async () => {
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": "# T\n\n## Design\n\nx\n" }))).toBeNull();
  });

  test("returns null for an empty summary body", async () => {
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": "## Summary\n\n## Next\n" }))).toBeNull();
  });

  test("returns null when the spec file is missing or the path is unset", async () => {
    expect(await readSpecSummary("/nope.md", readerFor({}))).toBeNull();
    expect(await readSpecSummary(undefined, readerFor({}))).toBeNull();
  });

  test("returns null rather than throwing when the reader throws", async () => {
    const throwing = async () => {
      throw new Error("EACCES");
    };
    expect(await readSpecSummary("/s.md", throwing)).toBeNull();
  });
});

describe("buildNarrativePrompt", () => {
  test("names the diff range the agent must read", () => {
    expect(buildNarrativePrompt({ base: "origin/main" })).toContain("git diff origin/main...HEAD");
  });

  test("declares every deterministic section off-limits", () => {
    // #1477: the model restating artifact-derived sections is how the two
    // halves of the body drift apart. This is the enforceable form of that
    // requirement — an assertion on the builder's output, not a grep of source.
    const prompt = buildNarrativePrompt({ base: "main" });
    for (const forbidden of ["Stories table", "Verification", "Review rounds", "Out of scope"]) {
      expect(prompt).toContain(forbidden);
    }
    expect(prompt).toContain("Do NOT restate");
  });

  test("states the length budget", () => {
    expect(buildNarrativePrompt({ base: "main" })).toContain(String(NARRATIVE_MAX_CHARS));
  });
});
