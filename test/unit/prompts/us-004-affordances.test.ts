/**
 * US-004 — Render scoped and full-suite test instructions through affordances.
 *
 * The isolation section's test-filter example and the rectifier's per-failing-file
 * and full-suite command blocks are wrapped in `run-test` / `run-check` protocol
 * regions. The dispatch seam (`applyProtocolRegions`) substitutes the native
 * rendering when `RunCommand` is advertised, otherwise keeps the ACP body.
 *
 * ACs:
 *   AC1 — isolation + acp: shell example + full-suite warning preserved verbatim.
 *   AC2 — isolation + native + advertised RunCommand + scoped key: RunCommand call
 *         with values.files, no shell command.
 *   AC3 — isolation + no testCommand: "scope each run to the files you changed",
 *         no region emitted.
 *   AC4 — rectifier per-failing-file + native + advertised RunCommand: one
 *         RunCommand call per failing file with that file in values.files.
 *   AC5 — rectifier full-suite + native + advertised RunCommand: names declared
 *         key `test`.
 *   AC6 — rectifier full-suite + acp: names the same shell command string the
 *         verifier replays.
 *   AC7 — rectifier + native without advertised RunCommand: shell strings.
 *
 * Markers carry a per-process nonce; every wrapped region is constructed via
 * the production `wrapAffordance` so the cross-entry seam (US-002) is
 * exercised end-to-end.
 */
import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { Finding } from "@/findings/types";
import { RectifierPromptBuilder } from "@/prompts";
import { buildIsolationSection } from "@/prompts/sections/isolation";
import {
  applyProtocolRegions,
  PROTOCOL_REGION_MARKER_PREFIX,
  unwrapProtocolRegions,
} from "@/prompts/sections/protocol-region";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY = makeStory({
  id: "US-004",
  title: "Affordance rendering story",
  description: "Render test instructions through affordances.",
  acceptanceCriteria: ["AC1 — wrap isolation example", "AC2 — dispatch substitutes the tool call"],
});

const TEST_CMD = "bun test test/unit/";

const SCOPED_TEMPLATE = "CI=1 AGENT=1 bun test --timeout=60000 {{files}}";

const FINDINGS: Finding[] = [
  {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "alpha passes",
    file: "test/unit/alpha.test.ts",
    message: "AssertionError: expected 1 to be 2",
  },
  {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "beta passes",
    file: "test/unit/beta.test.ts",
    message: "AssertionError: expected 3 to be 4",
  },
];

// ─── AC1 — isolation under acp preserves the shell example + warning verbatim ──

describe("US-004 AC1 — isolation under acp", () => {
  test("renders the existing shell example including the surrounding full-suite warning sentence", () => {
    const wrapped = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");
    const out = applyProtocolRegions(wrapped, { protocol: "acp" });

    // The shell example is preserved verbatim.
    expect(out).toContain("`bun test <path/to/test-file>`");
    // The surrounding full-suite warning is preserved verbatim.
    expect(out).toContain("NEVER run the full test suite without a filter");
    expect(out).toContain("full suite output will flood your context window and cause failures");
    // No marker survives dispatch.
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(out).not.toContain("<!--nax:");
  });
});

// ─── AC2 — isolation + native + RunCommand advertised + scoped key → RunCommand call

describe("US-004 AC2 — isolation native with advertised RunCommand and scoped key", () => {
  test("renders a RunCommand call with values.files and no shell command", () => {
    const wrapped = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");
    const out = applyProtocolRegions(wrapped, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });

    // The RunCommand call is emitted with values.files and the declared key.
    expect(out).toContain('RunCommand {"command": "testScoped", "values": {"files": "<path/to/test-file>"}}');
    // The shell example does not survive dispatch — the native path replaces it
    // with the tool call.
    expect(out).not.toContain("`bun test <path/to/test-file>`");
    // No marker survives dispatch.
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  test("the full-suite warning sentence is preserved verbatim under native dispatch", () => {
    // The wrap must NOT cover the "NEVER run the full test suite without a filter"
    // sentence — the regional grammar replaces the wrapped body wholesale, so a
    // region around the whole sentence would drop the guardrail under native
    // dispatch and hand the agent a `RunCommand` call without a file filter.
    // The example is the only affordance-rendered
    // segment; the surrounding prose is plain text in both transports.
    const wrapped = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");
    const out = applyProtocolRegions(wrapped, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });

    expect(out).toContain("NEVER run the full test suite without a filter");
    expect(out).toContain("full suite output will flood your context window and cause failures");
  });
});

// ─── AC3 — isolation with no configured test command emits the existing wording
// and no region

describe("US-004 AC3 — isolation with no configured test command", () => {
  test("renders the existing 'scope each run to the files you changed' wording and emits no region", () => {
    const result = buildIsolationSection("test-writer", "strict");

    // The fallback text is preserved.
    expect(result).toContain("scope each run to the files you changed");
    // No shell example.
    expect(result).not.toContain("bun test");
    // No marker.
    expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(result).not.toContain("<!--nax:");

    // And under acp / native, the result is unchanged (no region to substitute).
    expect(applyProtocolRegions(result, { protocol: "acp" })).toBe(result);
    expect(applyProtocolRegions(result, { protocol: "native" })).toBe(result);
  });

  test("even when a scoped key is supplied, the no-test-command case still emits no region", () => {
    // The affordance wrapping only fires when BOTH a configured test command AND
    // a declared scoped key are present — AC3 is the no-command fallback path.
    const result = buildIsolationSection("test-writer", "strict", undefined, "testScoped");

    expect(result).toContain("scope each run to the files you changed");
    expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(result).not.toContain("<!--nax:");
  });
});

// ─── AC4 — rectifier per-failing-file block + native + RunCommand → one call per file
//
// The producer under test is `failingTestRectification` — the ONE the
// `fullSuiteRectifyOp` dispatches (full-suite-rectify-op.ts:71). The other two
// rectifier prompt producers on this builder (`escalated`, `regressionFailure`)
// have no production call site, so threading affordance parameters through them
// would render regions no dispatch ever sees; the ACs are pinned against the
// reachable path instead.

describe("US-004 AC4 — rectifier per-failing-file block under native + RunCommand", () => {
  test("renders one RunCommand call per failing file with that file in values.files", () => {
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
      testCommandScopeCommandName: "test",
      testScopedTemplate: SCOPED_TEMPLATE,
      fileScopeCommandName: "testScoped",
    });

    const out = applyProtocolRegions(prompt, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });

    // One call per failing file.
    expect(out).toContain('RunCommand {"command": "testScoped", "values": {"files": "test/unit/alpha.test.ts"}}');
    expect(out).toContain('RunCommand {"command": "testScoped", "values": {"files": "test/unit/beta.test.ts"}}');
    // No raw scoped template survives — every entry was substituted.
    expect(out).not.toContain("{{files}}");
    // No marker survives dispatch.
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
});

// ─── AC5 — rectifier full-suite block + native + RunCommand → names declared key test

describe("US-004 AC5 — rectifier full-suite block under native + RunCommand", () => {
  test('names the declared key `test` (RunCommand {"command": "test"})', () => {
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
      testCommandScopeCommandName: "test",
    });

    const out = applyProtocolRegions(prompt, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });

    // The full-suite block renders a RunCommand call naming the declared key.
    expect(out).toContain('RunCommand {"command": "test"}');
    // No marker survives dispatch.
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
});

// ─── AC6 — rectifier full-suite block + acp → names the shell command the verifier replays

describe("US-004 AC6 — rectifier full-suite block under acp", () => {
  test("names the same command string the verifier replays", () => {
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
      testCommandScopeCommandName: "test",
    });

    const out = applyProtocolRegions(prompt, { protocol: "acp" });

    // The exact shell command string is preserved under ACP — the verifier
    // replays the same string, so the prompt must show what the verifier will run.
    expect(out).toContain("`bun test test/unit/`");
    // No marker survives dispatch.
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  // AC6 says the block names "the same command string the verifier replays".
  // The rendered body is the `quality.commands.test` slot verbatim — that slot
  // IS the full suite by definition (acceptance-helpers.ts:21-23), and the
  // full-suite rectification cycle replays the full suite. The override/scoped
  // fallback chain in `resolveAcceptanceFixTarget` belongs to the ACCEPTANCE
  // fix cycle, which re-runs one acceptance test rather than the suite, so it
  // is deliberately not consulted here. This pins that equality so the parity
  // is checked rather than assumed.
  test("the rendered body is the configured full-suite slot verbatim", () => {
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
      testCommandScopeCommandName: "test",
    });

    const acp = applyProtocolRegions(prompt, { protocol: "acp" });
    const block = acp.slice(acp.indexOf("# TEST COMMAND"));

    expect(block.split("\n").find((line) => line.startsWith("`"))).toBe(`\`${TEST_CMD}\``);
  });
});

// ─── AC7 — rectifier blocks under native without advertised RunCommand → shell strings

describe("US-004 AC7 — rectifier blocks under native without advertised RunCommand", () => {
  test("full-suite block renders the shell command string that ships today", () => {
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
      testCommandScopeCommandName: "test",
    });

    // Native dispatch WITHOUT RunCommand advertised — gating keeps the ACP body.
    const out = applyProtocolRegions(prompt, {
      protocol: "native",
      advertisedTools: new Set(["Read"]),
    });

    // The shell command string is kept; no RunCommand call appears.
    expect(out).toContain("`bun test test/unit/`");
    // No tool-call form survives dispatch.
    expect(out).not.toMatch(/\bRunCommand\s*\{/);
    // No marker survives dispatch.
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  test("per-failing-file block renders the shell command strings that ship today", () => {
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
      testCommandScopeCommandName: "test",
      testScopedTemplate: SCOPED_TEMPLATE,
      fileScopeCommandName: "testScoped",
    });

    const out = applyProtocolRegions(prompt, {
      protocol: "native",
      advertisedTools: new Set(["Read"]),
    });

    // The per-file shell commands are kept; no RunCommand call appears.
    expect(out).toContain("test/unit/alpha.test.ts");
    expect(out).toContain("test/unit/beta.test.ts");
    expect(out).not.toMatch(/\bRunCommand\s*\{/);
    expect(out).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });

  test("without a declared command key the full-suite block emits no region at all", () => {
    // The wrapping fires only when the caller supplies the declared key; without
    // it, today's plain-text command section is what the dispatch sees.
    const prompt = RectifierPromptBuilder.failingTestRectification(FINDINGS, STORY, {
      testCommand: TEST_CMD,
    });

    expect(prompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    // The plain shell command section is byte-for-byte what ships today.
    expect(prompt).toContain("# TEST COMMAND");
    expect(prompt).toContain("`bun test test/unit/`");
  });
});

// ─── Cross-cutting seam checks ───────────────────────────────────────────────
//
// These pin the contract that sections emit markers a single substitution call
// can read; that the seam holds across ACP / native / no-tool; that the
// persistence seam (unwrap) recovers the pre-wrap text; and that the existing
// unrelated-isolation fallback (#543) is unchanged when no scoped key is passed.

describe("US-004 cross-cutting seam", () => {
  test("isolation + scoped key: the wrapping is contained in the test filter rule, not the header", () => {
    const result = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");

    // The marker must be inside the test filter rule, not the role header.
    expect(result).toContain("<!--nax:");
    expect(result.indexOf("isolation scope: Only create or modify files in the test/ directory")).toBeLessThan(
      result.indexOf(PROTOCOL_REGION_MARKER_PREFIX),
    );
  });

  test("isolation without scoped key: no region emitted, regardless of testCommand", () => {
    const withCmd = buildIsolationSection("test-writer", "strict", "bun test");
    const withCmdLite = buildIsolationSection("implementer", "lite", "bun test");
    const withCmdVerifier = buildIsolationSection("verifier", undefined, "bun test");
    const withCmdSingle = buildIsolationSection("single-session", undefined, "bun test");

    for (const result of [withCmd, withCmdLite, withCmdVerifier, withCmdSingle]) {
      expect(result).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    }
  });

  test("unwrapProtocolRegions returns the prompt without any marker for a wrapped isolation prompt", () => {
    const wrapped = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");
    const unwrapped = unwrapProtocolRegions(wrapped);

    expect(unwrapped).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(unwrapped).toContain("`bun test <path/to/test-file>`");
    expect(unwrapped).toContain("NEVER run the full test suite without a filter");
  });

  test("idempotence: applying twice under acp equals applying once under acp", () => {
    const wrapped = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");
    const first = applyProtocolRegions(wrapped, { protocol: "acp" });
    const second = applyProtocolRegions(first, { protocol: "acp" });

    expect(second).toBe(first);
  });

  test("idempotence: applying twice under native with RunCommand equals applying once", () => {
    const wrapped = buildIsolationSection("test-writer", "strict", "bun test", "testScoped");
    const first = applyProtocolRegions(wrapped, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });
    const second = applyProtocolRegions(first, {
      protocol: "native",
      advertisedTools: new Set(["RunCommand"]),
    });

    expect(second).toBe(first);
  });
});
