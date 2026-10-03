/**
 * resolveBashApproval: per-stage mode wins over the global mode, which wins
 * over the schema default (ADR-030). Pure function, so no config is built.
 */

import { describe, expect, test } from "bun:test";
import { BashApprovalModeSchema, DEFAULT_BASH_APPROVAL_MODE, resolveBashApproval } from "#src/config/bash-approval";

describe("resolveBashApproval", () => {
  test("the per-stage mode wins over the global mode", () => {
    expect(resolveBashApproval("raw", "gated")).toBe("gated");
  });

  test("the global mode applies when the stage sets none", () => {
    expect(resolveBashApproval("escalate", undefined)).toBe("escalate");
  });

  test("the default applies when neither is set", () => {
    expect(resolveBashApproval(undefined, undefined)).toBe(DEFAULT_BASH_APPROVAL_MODE);
  });

  test("the default is raw and is a member of the schema", () => {
    expect(DEFAULT_BASH_APPROVAL_MODE).toBe("raw");
    expect(BashApprovalModeSchema.options).toContain(DEFAULT_BASH_APPROVAL_MODE);
  });
});
