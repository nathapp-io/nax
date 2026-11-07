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

const FILE_MUTATING_OPS = [
  ["implementer", implementerOp],
  ["autofix-implementer", implementerRectifyOp],
  ["autofix-test-writer", testWriterRectifyOp],
  ["write-test", testWriterOp],
  ["rectify", rectifyOp],
  ["full-suite-rectify", fullSuiteRectifyOp],
] as const;

describe("file-mutating ops declare Delete and Git", () => {
  test.each(FILE_MUTATING_OPS)("%s declares Delete", (_name, op) => {
    expect(op.tools).toContain("Delete");
  });

  test.each(FILE_MUTATING_OPS)("%s declares Git", (_name, op) => {
    expect(op.tools).toContain("Git");
  });

  test.each(FILE_MUTATING_OPS)("%s still declares Write and Edit", (_name, op) => {
    expect(op.tools).toContain("Write");
    expect(op.tools).toContain("Edit");
  });
});

describe("read-only ops gain neither", () => {
  test.each([
    ["verifier", verifierOp],
    ["plan", planInteractiveOp],
  ] as const)("%s does not declare Delete", (_name, op) => {
    expect(op.tools ?? []).not.toContain("Delete");
  });
});
