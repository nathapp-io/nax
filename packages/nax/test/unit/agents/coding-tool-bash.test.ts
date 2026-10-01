import { describe, expect, test } from "bun:test";
import { resolveBashSupport } from "@/agents/coding-tool-bash";
import { createBashTool } from "@/tools";

/**
 * `resolveBashSupport` (extracted from coding-tool-support.ts) and the
 * ADR-030 / F3 mode-aware Bash description it feeds into `createBashTool`.
 *
 * The deny suite (test/integration/permissions/bash-deny-suite.test.ts)
 * covers this module's behaviour end-to-end through `buildCodingToolSupport`;
 * these tests isolate the pure resolver and the description text directly.
 */
describe("resolveBashSupport", () => {
  test("declared Bash + gated: no synthetic grant, description patterns are the human grant's", () => {
    const resolution = resolveBashSupport({
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["bun test *"] }],
      bashApproval: "gated",
    });
    expect(resolution.allowBash).toBe(true);
    expect(resolution.effectiveGrants).toEqual([{ tool: "Bash", patterns: ["bun test *"] }]);
    expect(resolution.bashDescriptionPatterns).toEqual(["bun test *"]);
  });

  test("declared Bash + raw + no human Bash grant: a synthetic Bash(*) grant is appended", () => {
    const resolution = resolveBashSupport({
      declared: ["Bash"],
      grants: [{ tool: "Read", patterns: ["*"] }],
      bashApproval: "raw",
    });
    expect(resolution.allowBash).toBe(true);
    expect(resolution.effectiveGrants).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Bash", patterns: ["*"] },
    ]);
    // The EFFECTIVE (post-synthetic) grant, not an empty pre-synthetic one --
    // this is the F3 fix's own precondition: without it, the description
    // would still see no Bash grant at all.
    expect(resolution.bashDescriptionPatterns).toEqual(["*"]);
  });

  test("declared Bash + raw + an EXISTING human Bash grant: no synthetic grant is appended", () => {
    const resolution = resolveBashSupport({
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["bun test *"] }],
      bashApproval: "raw",
    });
    expect(resolution.effectiveGrants).toEqual([{ tool: "Bash", patterns: ["bun test *"] }]);
    expect(resolution.bashDescriptionPatterns).toEqual(["bun test *"]);
  });

  test("Bash not declared: no synthetic grant under any mode, allowBash is false", () => {
    for (const bashApproval of ["raw", "gated", "escalate"] as const) {
      const resolution = resolveBashSupport({ declared: ["Read"], grants: [], bashApproval });
      expect(resolution.allowBash).toBe(false);
      expect(resolution.effectiveGrants).toEqual([]);
    }
  });

  test("declared Bash + escalate: behaves like gated -- no synthetic grant", () => {
    const resolution = resolveBashSupport({ declared: ["Bash"], grants: [], bashApproval: "escalate" });
    expect(resolution.effectiveGrants).toEqual([]);
    expect(resolution.bashDescriptionPatterns).toEqual([]);
  });
});

/**
 * ADR-030 / F3: the description must reflect what THIS mode actually does.
 * Before this fix, `raw` shipped the `gated` text verbatim -- claiming
 * substitutions, here-documents and out-of-root paths were refused, when
 * `commandBranch` (src/tools/policy-command-branch.ts) dispatches `raw` to
 * `screenRawBashCommand` and returns before it ever reads a deny/ask rule.
 */
describe("createBashTool -- bashApproval-aware description", () => {
  test("gated (the default) keeps the conservative text unchanged (regression pin)", () => {
    const description = createBashTool({ patterns: ["bun test *"] }).description;
    expect(description).toContain("bun test *; anything else is refused");
    expect(description).toContain("cannot be analysed");
    expect(description).toContain("must stay inside the repository root");
  });

  test("raw states the truth: substitutions, redirects and subshells all work, and paths are not contained", () => {
    const description = createBashTool({ patterns: ["bun test *"], bashApproval: "raw" }).description;
    expect(description).not.toContain("no command forms are granted");
    expect(description).not.toContain("cannot be analysed");
    expect(description).not.toContain("must stay inside the repository root");
    expect(description).toContain("raw mode");
    expect(description.toLowerCase()).toContain("command substitution");
    expect(description.toLowerCase()).toContain("here-document");
    expect(description.toLowerCase()).toContain("subshell");
    expect(description).toContain("NOT consulted");
    expect(description).toContain("NOT contained");
  });

  test("raw names the protected-path screen as advisory, not a boundary", () => {
    const description = createBashTool({ bashApproval: "raw" }).description;
    expect(description).toContain(".nax/config.json");
    expect(description).toContain(".nax/features/**/prd.json");
    expect(description).toContain("advisory");
    expect(description).toContain("exact file paths");
    expect(description).toContain("directory");
    expect(description).toContain("sh -c");
  });

  test("escalate with no reachable human is byte-identical to gated (no promise of a human it cannot keep)", () => {
    const opts = { patterns: ["git *"] } as const;
    const gated = createBashTool({ ...opts, bashApproval: "gated" }).description;
    expect(createBashTool({ ...opts, bashApproval: "escalate" }).description).toBe(gated);
    expect(createBashTool({ ...opts, bashApproval: "escalate", humanApproval: false }).description).toBe(gated);
  });

  test("escalate with a reachable human says unadjudicable commands go to a human, not that they are refused", () => {
    const description = createBashTool({
      patterns: ["git *"],
      bashApproval: "escalate",
      humanApproval: true,
    }).description;
    expect(description).toContain("Granted command forms: git *");
    expect(description).not.toContain("anything else is refused");
    expect(description).toContain("sent to a human for approval");
    expect(description).toContain("prefer the granted forms");
    // Accurate to today's evaluation order (US-001): the deny matcher and the
    // payload checks run first for granted and ungranted commands alike -- over
    // the lexable prefix of a refused command -- and an approved command runs
    // exactly as written.
    expect(description).toContain("exactly as written");
    expect(description).toContain("refused without asking");
    expect(description).toContain("inside the repository root");
    expect(description).not.toContain("never escalate");
  });

  test("humanApproval changes nothing under gated or raw", () => {
    const opts = { patterns: ["git *"] } as const;
    for (const bashApproval of ["gated", "raw"] as const) {
      expect(createBashTool({ ...opts, bashApproval, humanApproval: true }).description).toBe(
        createBashTool({ ...opts, bashApproval }).description,
      );
    }
  });

  test("an omitted bashApproval matches gated (the safe default)", () => {
    const opts = { patterns: ["git *"] } as const;
    const omitted = createBashTool(opts).description;
    const gated = createBashTool({ ...opts, bashApproval: "gated" }).description;
    expect(omitted).toBe(gated);
  });
});
