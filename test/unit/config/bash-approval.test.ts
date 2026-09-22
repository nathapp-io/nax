import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { BashApprovalModeSchema, DEFAULT_BASH_APPROVAL_MODE } from "@/config/bash-approval";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { resolvePermissions } from "@/config/permissions";
import { NaxConfigSchema } from "@/config/schemas";

describe("BashApprovalModeSchema", () => {
  test("accepts the three modes", () => {
    for (const mode of ["raw", "gated", "escalate"] as const) {
      expect(BashApprovalModeSchema.parse(mode)).toBe(mode);
    }
  });

  test("rejects a profile name, which is a different axis", () => {
    expect(() => BashApprovalModeSchema.parse("unrestricted")).toThrow();
  });

  test("the default is raw", () => {
    expect(DEFAULT_BASH_APPROVAL_MODE).toBe("raw");
  });
});

describe("config defaulting (BUG-20)", () => {
  test("an empty config carries the default", () => {
    expect(NaxConfigSchema.parse({}).execution.bashApproval).toBe("raw");
  });

  test("a PARTIAL execution object still carries the default", () => {
    // This is the BUG-20 shape: a hand-written default literal in schemas.ts
    // that omits the key leaves it undefined here.
    //
    // NaxConfigSchema rejects a bare partial execution object (required fields
    // have no field-level defaults), so this seeds the merged base the loader
    // itself starts from (loader.ts structuredClone(DEFAULT_CONFIG) +
    // deepMergeConfig) and overrides one unrelated key.
    const parsed = NaxConfigSchema.parse({
      execution: { ...DEFAULT_CONFIG.execution, maxIterations: 3 },
    });
    expect(parsed.execution.bashApproval).toBe("raw");
  });

  test("an explicit value survives", () => {
    const parsed = NaxConfigSchema.parse({
      execution: { ...DEFAULT_CONFIG.execution, bashApproval: "gated" },
    });
    expect(parsed.execution.bashApproval).toBe("gated");
  });

  test("a per-stage override parses", () => {
    const parsed = NaxConfigSchema.parse({
      execution: {
        ...DEFAULT_CONFIG.execution,
        permissions: { run: { bashApproval: "escalate" } },
      },
    });
    expect(parsed.execution.permissions?.run?.bashApproval).toBe("escalate");
  });

  test("an invalid per-stage value is rejected", () => {
    expect(() =>
      NaxConfigSchema.parse({
        execution: {
          ...DEFAULT_CONFIG.execution,
          permissions: { run: { bashApproval: "nope" } },
        },
      }),
    ).toThrow();
  });
});

describe("resolvePermissions bashApproval", () => {
  test("defaults to raw with no config", () => {
    expect(resolvePermissions(makeNaxConfig({}), "run").bashApproval).toBe("raw");
  });

  test("honours the global setting", () => {
    const cfg = makeNaxConfig({ execution: { bashApproval: "gated" } });
    expect(resolvePermissions(cfg, "run").bashApproval).toBe("gated");
  });

  test("a per-stage override beats the global setting", () => {
    const cfg = makeNaxConfig({
      execution: { bashApproval: "gated", permissions: { run: { bashApproval: "escalate" } } },
    });
    expect(resolvePermissions(cfg, "run").bashApproval).toBe("escalate");
  });

  test("a per-stage override applies only to its own stage", () => {
    const cfg = makeNaxConfig({
      execution: { bashApproval: "gated", permissions: { run: { bashApproval: "raw" } } },
    });
    expect(resolvePermissions(cfg, "verify").bashApproval).toBe("gated");
  });

  test("resolves for every profile, not just scoped", () => {
    for (const permissionProfile of ["unrestricted", "safe", "scoped"] as const) {
      const cfg = makeNaxConfig({ execution: { permissionProfile, bashApproval: "escalate" } });
      expect(resolvePermissions(cfg, "run").bashApproval).toBe("escalate");
    }
  });
});
