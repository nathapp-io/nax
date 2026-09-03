/**
 * The tool-audit ledger has to say WHICH session made a call.
 *
 * Three TDD roles run inside one story and all write to the same
 * `<outputDir>/tool-audit/<feature>/` directory. Named by story alone, the
 * ledger cannot answer "did the verifier run a command" -- which is the exact
 * evidence ADR-029's parity claims rest on.
 */

import { describe, expect, test } from "bun:test";
import { buildLedgerSessionName } from "@/agents/coding-tool-support";

describe("buildLedgerSessionName", () => {
  test("distinguishes two roles within one story", () => {
    const writer = buildLedgerSessionName({ storyId: "US-001", sessionRole: "test-writer" });
    const verifier = buildLedgerSessionName({ storyId: "US-001", sessionRole: "verifier" });

    expect(writer).not.toBe(verifier);
    expect(writer).toBe("US-001-test-writer");
  });

  test("falls back to the story when no role is supplied", () => {
    expect(buildLedgerSessionName({ storyId: "US-001" })).toBe("US-001");
  });

  test("falls back to the feature when there is no story", () => {
    expect(buildLedgerSessionName({ featureName: "my-feature" })).toBe("my-feature");
  });

  test("names an unattached session rather than producing an empty string", () => {
    expect(buildLedgerSessionName({})).toBe("unattached");
  });
});
