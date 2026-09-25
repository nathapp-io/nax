import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { pinRootOnlyKeys, pinRootOnlyKeysRaw } from "@/config";

const root = makeNaxConfig({ execution: { bashApproval: "escalate", approvalTimeout: 120_000 } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("pinRootOnlyKeys", () => {
  test("takes the four keys from root and leaves permissions alone", () => {
    const pkg = makeNaxConfig({
      execution: {
        bashApproval: "raw",
        approvalTimeout: 60_000,
        sandbox: { enabled: true },
        permissions: { run: { bashApproval: "gated", allowedTools: ["Bash(ls *)"] } },
      },
    });
    const out = pinRootOnlyKeys(pkg, root);
    expect(out.execution.bashApproval).toBe("escalate");
    expect(out.execution.approvalTimeout).toBe(120_000);
    expect(out.execution.sandbox).toEqual(root.execution.sandbox);
    expect(out.execution.permissions).toEqual(pkg.execution.permissions);
  });
});

describe("pinRootOnlyKeysRaw", () => {
  test("warns once per differing key, naming the package", () => {
    const warnings: string[] = [];
    const raw = { execution: { ...root.execution, bashApproval: "raw", commandSafety: { shadow: {} } } };
    const out = pinRootOnlyKeysRaw(raw, root, "packages/api", (m) => warnings.push(m));
    const execution = isRecord(out.execution) ? out.execution : {};
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("execution.bashApproval is root-only (ADR-031)");
    expect(warnings[0]).toContain('"packages/api"');
    expect(execution.bashApproval).toBe("escalate");
    expect("commandSafety" in execution).toBe(false);
  });

  test("no warning when the values equal root's", () => {
    const warnings: string[] = [];
    pinRootOnlyKeysRaw({ execution: { ...root.execution } }, root, "packages/api", (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });
});
