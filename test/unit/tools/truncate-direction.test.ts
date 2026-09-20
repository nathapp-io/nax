/**
 * US-001 AC14–AC15: `truncationDirectionFor` tool-name lookup.
 *
 * The shared `truncateForModel` consults `truncationDirectionFor` so the
 * session's `after_tool` policy can decide which lines to keep without
 * asking each tool. Subprocess-style tools (Bash, RunCommand, Exec) keep
 * the start AND the end so an error from a long-running command stays
 * readable. Read-style tools (Read, Grep, Git, ScratchpadRead) keep the
 * start, and any unrecognised name defaults to "head" — failing closed
 * to the simpler direction.
 */

import { describe, expect, test } from "bun:test";
import { truncationDirectionFor } from "@/tools";

describe("AC14: Bash, RunCommand, and Exec map to tail-with-first-line", () => {
  test.each(["Bash", "RunCommand", "Exec"] as const)(
    "truncationDirectionFor('%s') === 'tail-with-first-line'",
    (name) => {
      expect(truncationDirectionFor(name)).toBe("tail-with-first-line");
    },
  );
});

describe("AC15: Read, Grep, Git, ScratchpadRead, and unrecognised names map to head", () => {
  test.each(["Read", "Grep", "Git", "ScratchpadRead"] as const)("truncationDirectionFor('%s') === 'head'", (name) => {
    expect(truncationDirectionFor(name)).toBe("head");
  });

  test("an unrecognised tool name falls through to 'head'", () => {
    expect(truncationDirectionFor("NotARealTool")).toBe("head");
    // Empty string is the most adversarial "unrecognised" input — a tool
    // registry should never feed one, but a literal "" must still resolve
    // to the safe default rather than throw.
    expect(truncationDirectionFor("")).toBe("head");
  });
});
