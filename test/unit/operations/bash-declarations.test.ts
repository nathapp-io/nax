/**
 * Who may ever hold Bash (spec §4 US-004's ceiling).
 *
 * Declaration is the CEILING, not a grant: every op below still gets zero Bash
 * unless a human wrote a `Bash(...)` allow rule (spec R4). Review ops are
 * excluded in v1 — a reviewer that can run arbitrary commands is no longer
 * judging the work from the outside.
 */
import { describe, expect, test } from "bun:test";
import {
  acceptanceFixSourceOp,
  acceptanceFixTestOp,
  adversarialReviewOp,
  finishFixOp,
  fullSuiteRectifyOp,
  implementerOp,
  implementerRectifyOp,
  planDebaterOp,
  planInteractiveOp,
  rectifyOp,
  semanticReviewOp,
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
    ["acceptance-fix-source", acceptanceFixSourceOp],
    ["acceptance-fix-test", acceptanceFixTestOp],
    ["finish-fix", finishFixOp],
    ["full-suite-rectify", fullSuiteRectifyOp],
  ] as const)("%s declares Bash", (_name, op) => {
    expect(op.tools).toContain("Bash");
  });
});

describe("ops that must never hold Bash", () => {
  test.each([
    ["adversarial-review", adversarialReviewOp],
    ["semantic-review", semanticReviewOp],
    ["debate-plan", planDebaterOp],
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
