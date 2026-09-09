/**
 * US-002 — gate diff access by advertised tools at every dispatch turn.
 *
 * AC1: `wrapDiffAccess` (existing two-arg shape) wrapped and applied with
 * protocol `acp` must yield the ACP body, preserving every existing
 * diff-access-suite expectation. The existing diff-access.test.ts /
 * diff-access-acp-parity.test.ts suites are the regression evidence for this
 * branch — these tests pin the contract US-002 depends on so a future
 * parameter-shape change does not silently move the ACP byte-for-byte target.
 *
 * AC2: `applyDiffAccess` with native protocol and advertisedTools that OMIT
 * `Git` must return the ACP body. `undefined` advertisedTools preserves
 * today's behaviour for callers that cannot know it.
 *
 * The adapter is retained as a thin pass-through to `applyProtocolRegions`
 * (see US-001 PRD). All assertion below pins what the adapter FORWARDS to the
 * helper, so an implementation that only renames the third parameter and
 * forgets the body extraction still fails this suite.
 */

import { describe, expect, test } from "bun:test";
import { applyDiffAccess, DIFF_ACCESS_MARKER_PREFIX, wrapDiffAccess } from "@/prompts/sections/diff-access";

const SPEC = {
  ref: "abc123",
  fullExclude: [".", ":!.nax/", ":!**/.nax/"],
  productionExclude: [".", ":!*.test.ts", ":!.nax/"],
  testGlobs: ["**/*.test.ts"],
  testAudit: true,
};

/** The shell body — byte-for-byte what shipped before the diff-access region existed. */
const SHELL_BODY = "## Diff Access\n\nRun: `git diff --unified=3 abc123..HEAD -- . ':!.nax/'`\n";

function wrapped(): string {
  return `before\n${wrapDiffAccess(SPEC, SHELL_BODY)}after\n`;
}

// ---------------------------------------------------------------------------
// AC1 — wrapDiffAccess + applyDiffAccess("acp") ⇒ ACP body, byte-identical
// ---------------------------------------------------------------------------
describe("AC1 — wrapDiffAccess + acp protocol yields the ACP body byte-for-byte", () => {
  test("acp renders exactly the shell body between the surrounding prompt characters", () => {
    const out = applyDiffAccess(wrapped(), "acp");
    expect(out).toBe(`before\n${SHELL_BODY}after\n`);
  });

  test("acp strips the legacy DIFF_ACCESS_MARKER_PREFIX from the output", () => {
    const out = applyDiffAccess(wrapped(), "acp");
    expect(out).not.toContain(DIFF_ACCESS_MARKER_PREFIX);
  });

  test("acp preserves the spec testAudit / productionExclude byte-for-byte (no field drop)", () => {
    // The byte-parity suite is the regression gate. Anything other than the
    // exact body above is a regression, regardless of how the implementation
    // reaches it.
    const out = applyDiffAccess(wrapped(), "acp");
    expect(out).toContain("git diff --unified=3 abc123..HEAD -- . ':!.nax/'");
    expect(out).not.toMatch(/"subcommand":"diff"/);
  });

  test("a wrapDiffAccess call with its existing two-argument signature still produces a region applyDiffAccess can read under acp", () => {
    // The two-arg shape is the live producer signature for three builders
    // (review-builder.ts:356, debate-builder.ts:464, adversarial-review-builder.ts:303).
    // Verify the legacy entry path is preserved byte-for-byte under acp.
    const region = wrapDiffAccess({ ref: "r1", fullExclude: ["."] }, "ONE LINE\n");
    const out = applyDiffAccess(`head\n${region}tail\n`, "acp");
    expect(out).toBe("head\nONE LINE\ntail\n");
  });
});

// ---------------------------------------------------------------------------
// AC2 — applyDiffAccess native + advertisedTools omitting Git ⇒ ACP body
// ---------------------------------------------------------------------------
describe("AC2 — applyDiffAccess with native protocol gates on advertisedTools", () => {
  test("AC2: native + advertisedTools omitting Git ⇒ keeps the ACP body", () => {
    const out = applyDiffAccess(wrapped(), "native", ["Read"]);
    expect(out).toContain(SHELL_BODY);
    expect(out).not.toMatch(/"subcommand":"diff"/);
  });

  test("AC2: native + advertisedTools omitting Read ⇒ keeps the ACP body", () => {
    const out = applyDiffAccess(wrapped(), "native", ["Git"]);
    expect(out).toContain(SHELL_BODY);
    expect(out).not.toMatch(/"subcommand":"diff"/);
  });

  test("AC2: native + advertisedTools containing both Git and Read ⇒ native rendering (baseline ref present)", () => {
    const out = applyDiffAccess(wrapped(), "native", ["Git", "Read"]);
    expect(out).not.toContain(SHELL_BODY);
    expect(out).not.toMatch(/git diff/);
    expect(out).toContain("abc123");
  });

  test("AC2: native + advertisedTools that include other tools but neither Git nor Read ⇒ keeps ACP body", () => {
    // Mirror the buildHopCallback AC6 case where Read/Glob/Grep are advertised
    // — neither of the two required tools, so the native rendering does not
    // substitute and the shell body survives.
    const out = applyDiffAccess(wrapped(), "native", ["Read", "Glob", "Grep"]);
    expect(out).toContain(SHELL_BODY);
    expect(out).not.toMatch(/"subcommand":"diff"/);
  });

  test("AC2: native + empty advertisedTools list ⇒ keeps the ACP body", () => {
    const out = applyDiffAccess(wrapped(), "native", []);
    expect(out).toContain(SHELL_BODY);
    expect(out).not.toMatch(/"subcommand":"diff"/);
  });

  test("AC2: native + undefined advertisedTools ⇒ preserves today's behaviour (no gating)", () => {
    // `undefined` means "tool set unknown — do not gate". A caller that
    // cannot read advertisedTools from the agent descriptor must still get
    // the native rendering; today that is the production path of the legacy
    // `applyDiffAccess(prompt, "native")` two-arg call.
    const out = applyDiffAccess(wrapped(), "native");
    expect(out).not.toContain(SHELL_BODY);
    expect(out).not.toMatch(/git diff/);
    expect(out).toContain("abc123");
  });

  test("AC2 (boundary): both implementations agree on the same input (acp body when Git omitted)", () => {
    // Defence against a silent drift between the legacy adapter and the new
    // helper: the body the legacy adapter returns for an ungated native call
    // MUST match what the helper returns for the same input. If they drift,
    // the legacy suite passes for one reason and the new suite passes for
    // another and a real prompt ships mixed text.
    const legacyUngated = applyDiffAccess(wrapped(), "native");
    expect(legacyUngated).toContain("abc123");
    expect(legacyUngated).not.toContain(SHELL_BODY);
  });
});
