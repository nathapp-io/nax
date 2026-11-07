/**
 * Who may ever hold Bash (spec §4 US-004's ceiling).
 *
 * Declaration is the CEILING, not a grant: every op below still gets zero Bash
 * unless a human wrote a `Bash(...)` allow rule (spec R4). The reviewer ops
 * that also declared Bash (nax#2500, sandboxed with their tree changes
 * reverted) were deleted with C1 wave B2b-2; the rows that remain are the ops
 * that still exist.
 */
import { describe, expect, test } from "bun:test";
import {
  fullSuiteRectifyOp,
  implementerOp,
  implementerRectifyOp,
  planInteractiveOp,
  rectifyOp,
  testWriterOp,
  testWriterRectifyOp,
  verifierOp,
} from "@/operations";

// The verifier is imported to be pinned NEGATIVE (see the ruling in this task's
// header), not because it holds Bash.

describe("ops that may hold Bash", () => {
  test.each([
    ["implementer", implementerOp],
    ["write-test", testWriterOp],
    ["rectify", rectifyOp],
    ["autofix-implementer", implementerRectifyOp],
    ["autofix-test-writer", testWriterRectifyOp],
    ["full-suite-rectify", fullSuiteRectifyOp],
  ] as const)("%s declares Bash", (_name, op) => {
    expect(op.tools).toContain("Bash");
  });
});

describe("ops that must never hold Bash", () => {
  test.each([
    ["plan", planInteractiveOp],
    // The verifier judges the implementer's work. It already cannot install
    // (no `Exec` — see test/unit/operations/op-tool-declarations.test.ts), and
    // a Bash rule covering `bun add *` would hand back exactly that ability.
    // Ruled out by the user on 2026-09-14, overriding the spec's US-004 list.
    ["verifier", verifierOp],
  ] as const)("%s does not declare Bash", (_name, op) => {
    expect(op.tools ?? []).not.toContain("Bash");
  });
});
