/**
 * The "What changed" narrative (#1477).
 *
 * Every guarantee here is on a pure function. The op's reply cannot be
 * produced in tests (no live agent in the loop), so the degradation chain has
 * to be reachable without one — that is why `resolveNarrative` exists as a
 * separate function rather than folded into `parse`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime } from "@test/helpers";
import type { FinishNarrativeInput } from "@/operations";
import { finishNarrativeOp } from "@/operations";
import {
  NARRATIVE_MAX_CHARS,
  buildNarrativePrompt,
  parseNarrative,
  parseNarrativeNode,
  readSpecSummary,
  resolveNarrative,
} from "@/operations";

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

  test("never throws on a non-string reply", () => {
    expect(parseNarrative(undefined as unknown as string)).toBe(""); // test-ratchet-allow: as-unknown-as
  });

  test("keeps only what the sentinel wraps", () => {
    const reply = "Let me read the diff first.\n<narrative>\nAdds a detector.\n</narrative>\n";
    expect(parseNarrative(reply)).toBe("Adds a detector.");
  });

  test("preserves prose that would not survive a JSON contract", () => {
    // Backticks, quotes and hard newlines are why this node uses a sentinel
    // rather than the JSON the sibling review nodes use.
    const prose = 'Wires `detect_schema_drift()` in.\n\nIt returns "ok" per {table, op} pair.';
    expect(parseNarrative(`<narrative>${prose}</narrative>`)).toBe(prose);
  });

  test("takes the last opening tag, so narrating the tag does not win", () => {
    const reply = "I will wrap it in <narrative> tags.\n<narrative>Real prose.</narrative>";
    expect(parseNarrative(reply)).toBe("Real prose.");
  });

  test("recovers prose when the closing tag is missing", () => {
    expect(parseNarrative("chatter\n<narrative>Adds a detector.")).toBe("Adds a detector.");
  });

  test("strips leaked preamble and a bold heading when the sentinel is absent", () => {
    // The exact shape observed on a downstream PR: acpx concatenates every
    // agent message chunk of the turn, so between-tool-call narration lands in
    // `parse`'s input with no separator at all.
    const reply = [
      "Now I have a clear picture. Let me check the remaining acceptance test",
      'briefly, then write the PR body.I have enough context to write the "What changed" prose.',
      "",
      "**What changed**",
      "",
      "Adds a shared schema-drift detector.",
    ].join("\n");
    expect(parseNarrative(reply)).toBe("Adds a shared schema-drift detector.");
  });

  test("strips a markdown heading form too", () => {
    expect(parseNarrative("Thinking out loud.\n\n## What changed\n\nAdds a gate.")).toBe("Adds a gate.");
  });

  test("returns the trimmed reply when no anchor is present at all", () => {
    // Tier 3: preamble we cannot locate beats dropping the narrative entirely.
    expect(parseNarrative("Adds a gate to readyz.")).toBe("Adds a gate to readyz.");
  });

  test("returns empty when the agent wrote a heading and nothing else", () => {
    // Empty routes `resolveNarrative` to the spec summary rather than
    // rendering a bare heading.
    expect(parseNarrative("**What changed**")).toBe("");
  });

  test("falls through to the heading strip when the sentinel is empty", () => {
    expect(parseNarrative("chatter\n**What changed**\n<narrative>  </narrative>")).toBe("");
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

  test("asks for the sentinel the parser anchors on", () => {
    // The prompt and `parseNarrative` have to agree on the delimiter; nothing
    // else ties them together, and a silent drift here reinstates the leak.
    const prompt = buildNarrativePrompt({ base: "main" });
    expect(prompt).toContain("<narrative>");
    expect(prompt).toContain("</narrative>");
  });

  test("asks for a conventional-commit title in its own sentinel", () => {
    const prompt = buildNarrativePrompt({ base: "main" });
    expect(prompt).toContain("<title>");
    expect(prompt).toContain("</title>");
    expect(prompt).toContain("conventional-commit");
  });
});

describe("parseNarrativeNode", () => {
  test("splits a well-formed reply into title and prose", () => {
    const reply = "<title>fix: repair the gate</title>\n<narrative>Adds a detector.</narrative>";
    expect(parseNarrativeNode(reply)).toEqual({ title: "fix: repair the gate", narrative: "Adds a detector." });
  });

  test("keeps the title block out of the prose when the narrative sentinel is missing", () => {
    // Tier 2: without this the `<title>` block would be rendered as part of
    // the "What changed" section.
    const out = parseNarrativeNode("<title>fix: repair the gate</title>\n\nAdds a detector.");
    expect(out.title).toBe("fix: repair the gate");
    expect(out.narrative).toBe("Adds a detector.");
    expect(out.narrative).not.toContain("<title>");
  });

  test("returns prose with no title when the model omitted the title block", () => {
    expect(parseNarrativeNode("<narrative>Adds a detector.</narrative>")).toEqual({
      title: undefined,
      narrative: "Adds a detector.",
    });
  });

  test("returns a title with empty prose rather than throwing", () => {
    // A title alone is still worth amending the PR for.
    const out = parseNarrativeNode("<title>fix: repair the gate</title>");
    expect(out.title).toBe("fix: repair the gate");
    expect(out.narrative).toBe("");
  });

  test("never throws on junk", () => {
    expect(parseNarrativeNode("")).toEqual({ title: undefined, narrative: "" });
    expect(parseNarrativeNode(undefined as unknown as string)).toEqual({ title: undefined, narrative: "" }); // test-ratchet-allow: as-unknown-as
  });

  test("yields an empty, falsy narrative — not the raw title tag — when no narrative anchor is present", () => {
    // A reply carrying no `<narrative>` tags and no "What changed" heading —
    // only the title sentinel. Without `TITLE_BLOCK_RE` stripping the title
    // block wholesale, the tier-3 bare-trim fallback would leak the raw,
    // unparsed `<title>...</title>` markup into the "What changed" section.
    // The (future) PR body logic treats an empty string as "no narrative
    // available" and falls back to the spec summary, so it must see a
    // genuinely empty value here, never the raw tag text.
    const out = parseNarrativeNode("<title>fix: repair the gate</title>");
    expect(out.narrative).toBeFalsy();
    expect(out.narrative).toBe("");
    expect(out.narrative).not.toContain("<title>");
  });
});

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// `op.config` is declared as `ConfigSelector<C> | readonly (keyof NaxConfig)[]`
// on OperationBase; this op only ever uses the selector form, so the narrowing
// is safe — the same pattern the sibling finish op tests use.
function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(finishNarrativeOp.config as ConfigSelector<FinishConfig>) };
}

const NARRATIVE_INPUT: FinishNarrativeInput = { base: "origin/main" };

describe("finishNarrativeOp shape", () => {
  test("timeoutMs prefers the input, else execution.sessionTimeoutSeconds", () => {
    // finish.timeouts.stepMs defaults to null, so an input with no timeoutMs is
    // the common case and must still be bounded.
    const ctx = makeCtx();
    expect(finishNarrativeOp.timeoutMs?.({ ...NARRATIVE_INPUT, timeoutMs: 777 }, ctx)).toBe(777);
    expect(finishNarrativeOp.timeoutMs?.(NARRATIVE_INPUT, ctx)).toBe(ctx.config.execution.sessionTimeoutSeconds * 1000);
  });
});
