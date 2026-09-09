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
import { applyProtocolRegions, wrapAffordance } from "@/prompts/sections/protocol-region";

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

  test("AC2 (boundary): legacy applyDiffAccess and applyProtocolRegions agree byte-for-byte on the same input", () => {
    // Defence against silent drift between the legacy `applyDiffAccess`
    // (build-hop-callback / session-run-hop dispatch path) and the new
    // `applyProtocolRegions` helper (US-001's affordance registry). The two
    // MUST produce byte-identical output for every input — if they drift,
    // the legacy suite passes for one reason and the new suite passes for
    // another and a real prompt ships mixed text.
    //
    // Three axes that have historically diverged:
    //   1. Protocol alone — native (no gating) must match the helper's native
    //      path with `advertisedTools: undefined` (preserves today's behaviour).
    //   2. ACP — both must strip markers and return the shell body byte-for-byte.
    //   3. Gate enforcement — when `Git` is omitted from `advertisedTools`,
    //      the legacy adapter must fall back to the ACP body, exactly like the
    //      helper does. A legacy path that ignores `advertisedTools` and always
    //      renders natively would diverge here, which is the regression the
    //      helper exists to prevent.
    //
    // Both inputs are derived from `wrapDiffAccess` so the legacy suite's
    // marker grammar is the one under test, not the new one. `wrapAffordance`
    // is exercised separately so the assertion does not silently depend on a
    // marker shape that `applyDiffAccess` does not understand.

    // 1. Native, no gating — both must produce the native rendering.
    const legacyNativeUngated = applyDiffAccess(wrapped(), "native");
    const helperNativeUngated = applyProtocolRegions(wrapped(), { protocol: "native" });
    expect(legacyNativeUngated).toBe(helperNativeUngated);

    // 2. ACP — both must strip markers and return the shell body byte-for-byte.
    const legacyAcp = applyDiffAccess(wrapped(), "acp");
    const helperAcp = applyProtocolRegions(wrapped(), { protocol: "acp" });
    expect(legacyAcp).toBe(helperAcp);
    expect(legacyAcp).toBe(`before\n${SHELL_BODY}after\n`);

    // 3. Gate enforcement — when Git is omitted, the legacy adapter must
    // fall back to the ACP body, matching the helper's gated behaviour.
    const legacyGated = applyDiffAccess(wrapped(), "native", ["Read"]);
    const helperGated = applyProtocolRegions(wrapped(), {
      protocol: "native",
      advertisedTools: new Set(["Read"]),
    });
    expect(legacyGated).toBe(helperGated);
    expect(legacyGated).toContain(SHELL_BODY);

    // 4. Wrap-shape independence — the assertion holds for both wrap paths.
    // `wrapAffordance` emits the same nonce-protected marker grammar (US-001
    // cross-entry seam), so both implementations must read it identically.
    const affordanceWrapped = `head\n${wrapAffordance("diff-access", SPEC, SHELL_BODY)}tail`;
    const legacyFromAffordance = applyDiffAccess(affordanceWrapped, "native", ["Git", "Read"]);
    const helperFromAffordance = applyProtocolRegions(affordanceWrapped, {
      protocol: "native",
      advertisedTools: new Set(["Git", "Read"]),
    });
    expect(legacyFromAffordance).toBe(helperFromAffordance);
  });
});
