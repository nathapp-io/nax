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
import { testWriterOp } from "@/operations/write-test";

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

describe("testWriterOp tools", () => {
  test("can create test files and compile-only stubs", () => {
    const tools = resolveDeclaredTools(testWriterOp);

    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
  });

  test("can run the tests it wrote, to prove they fail on an assertion", () => {
    // The role requires distinguishing an ASSERTION failure from an import or
    // compile error. A test-writer that cannot execute cannot tell them apart.
    expect(resolveDeclaredTools(testWriterOp)).toContain("RunCommand");
  });

  test("can commit its own RED state so the implementer's beforeRef is a clean boundary", () => {
    expect(resolveDeclaredTools(testWriterOp)).toContain("GitCommit");
  });
});
