import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy } from "@/tools";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;

describe("rawBashRefusal", () => {
  test("raw + refusal: every Bash call is denied with the exact reason", () => {
    const root = makeTempDir("raw-refusal-");
    try {
      const policy = compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, {
        bashApproval: "raw",
        rawBashRefusal: "sandbox unavailable (x): raw bash requires the sandbox",
      });
      const v = policy.check("Bash", BASH_SCOPE, { command: "echo hi" });
      expect(v.allowed).toBe(false);
      if (!v.allowed) {
        expect(v.reason).toBe("sandbox unavailable (x): raw bash requires the sandbox");
        expect(v.breach).toBe(false);
      }
    } finally {
      cleanupTempDir(root);
    }
  });

  test("raw without a refusal is unchanged (allowed)", () => {
    const root = makeTempDir("raw-refusal-");
    try {
      const policy = compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { bashApproval: "raw" });
      expect(policy.check("Bash", BASH_SCOPE, { command: "echo hi" }).allowed).toBe(true);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("gated ignores the refusal (gated/escalate run unwrapped, spec S5)", () => {
    const root = makeTempDir("raw-refusal-");
    try {
      const policy = compileToolPolicy([{ tool: "Bash", patterns: ["echo *"] }], root, {
        bashApproval: "gated",
        rawBashRefusal: "sandbox unavailable",
      });
      expect(policy.check("Bash", BASH_SCOPE, { command: "echo hi" }).allowed).toBe(true);
    } finally {
      cleanupTempDir(root);
    }
  });
});
