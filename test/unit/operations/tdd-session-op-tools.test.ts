/**
 * Tool declarations for the TDD session ops.
 *
 * Asserted through resolveDeclaredTools rather than by reading `op.tools`
 * directly, so the test exercises the same path dispatch does -- an op that
 * omits the field resolves to DEFAULT_CODING_TOOLS, and reading the literal
 * would hide that.
 */

import { describe, expect, test } from "bun:test";
import { resolveDeclaredTools } from "@/operations/types";
import { verifierOp } from "@/operations/verify";

describe("verifierOp tools", () => {
  test("can run the story's scoped tests", () => {
    expect(resolveDeclaredTools(verifierOp)).toContain("RunCommand");
  });

  test("can diff against the pre-implementer ref to check test-file tampering", () => {
    expect(resolveDeclaredTools(verifierOp)).toContain("Git");
  });

  test("cannot repair what it is judging", () => {
    const tools = resolveDeclaredTools(verifierOp);

    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("GitCommit");
  });
});
