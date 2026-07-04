import { describe, expect, test } from "bun:test";
import { mergePackageConfig } from "@/config/merge";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import {
  triageFlakyFindings,
  NULL_QUARANTINE_MEMO,
} from "@/verification";
import type { FlakeTriageInput } from "@/verification";
import type { Finding } from "@/findings";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRootConfig(flakeOverrides: {
  enabled: boolean;
  maxProbesPerGate: number;
  probeTimeoutSeconds: number;
  probeRuns: number;
}): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      flakeDetection: {
        enabled: flakeOverrides.enabled,
        maxProbesPerGate: flakeOverrides.maxProbesPerGate,
        probeTimeoutSeconds: flakeOverrides.probeTimeoutSeconds,
        probeRuns: flakeOverrides.probeRuns,
      },
    },
  };
}

function makeTriageInput(findings: Finding[], enabled = true): FlakeTriageInput {
  return {
    findings,
    diff: { changedTestFiles: [], mappedTestFiles: [] },
    flakeDetection: {
      enabled,
      probeRuns: 2,
      maxProbesPerGate: 5,
      probeTimeoutSeconds: 60,
    },
    baseCommand: "bun test",
    cwd: "/tmp/test",
    framework: "bun",
    quarantineMemo: NULL_QUARANTINE_MEMO,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: mergePackageConfig deep-merges execution.flakeDetection", () => {
  test("AC-1: package probeRuns override takes precedence while root fields are preserved", () => {
    const root = makeRootConfig({
      enabled: true,
      maxProbesPerGate: 3,
      probeTimeoutSeconds: 30,
      probeRuns: 1,
    });

    const packageOverride: Partial<NaxConfig> = {
      execution: {
        ...({} as NaxConfig["execution"]),
        flakeDetection: {
          probeRuns: 5,
        } as NaxConfig["execution"]["flakeDetection"],
      },
    };

    const merged = mergePackageConfig(root, packageOverride);

    expect(merged.execution.flakeDetection.enabled).toBe(true);
    expect(merged.execution.flakeDetection.maxProbesPerGate).toBe(3);
    expect(merged.execution.flakeDetection.probeTimeoutSeconds).toBe(30);
    expect(merged.execution.flakeDetection.probeRuns).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: triageFlakyFindings passes through non-failed-test and non-probeable findings unchanged", () => {
  test("AC-2: findings with category !== 'failed-test' retain their category and source", async () => {
    const nonFailedTestFindings: Finding[] = [
      {
        source: "lint",
        tool: "biome",
        severity: "error",
        category: "lint-error",
        rule: "noUnusedVars",
        file: "/pkg/src/index.ts",
        message: "Unused variable 'x'",
        fixTarget: "source",
      },
      {
        source: "typecheck",
        tool: "tsc",
        severity: "error",
        category: "type-error",
        rule: "TS2345",
        file: "/pkg/src/utils.ts",
        message: "Type mismatch",
        fixTarget: "source",
      },
      {
        source: "semantic-review",
        severity: "warning",
        category: "missing-impl",
        rule: "missing-null-check",
        file: "/pkg/src/parser.ts",
        message: "Potential null dereference",
        fixTarget: "source",
      },
    ];

    const input = makeTriageInput(nonFailedTestFindings);
    const result = await triageFlakyFindings(input);

    expect(result.findings).toHaveLength(nonFailedTestFindings.length);

    for (let i = 0; i < nonFailedTestFindings.length; i++) {
      expect(result.findings[i].category).toBe(nonFailedTestFindings[i].category);
      expect(result.findings[i].source).toBe(nonFailedTestFindings[i].source);
    }
  });

  test("AC-2: findings with non-test sources (lint, typecheck, security) are passed through with identical source", async () => {
    const nonTestSourceFindings: Finding[] = [
      {
        source: "lint",
        tool: "biome",
        severity: "error",
        category: "style-violation",
        rule: "noDoubleEquals",
        file: "/pkg/src/check.ts",
        message: "Use === instead of ==",
        fixTarget: "source",
      },
      {
        source: "typecheck",
        tool: "tsc",
        severity: "error",
        category: "type-error",
        rule: "TS2339",
        file: "/pkg/src/model.ts",
        message: "Property does not exist on type",
        fixTarget: "source",
      },
      {
        source: "plugin",
        tool: "security-scanner",
        severity: "critical",
        category: "security-vulnerability",
        rule: "sql-injection",
        file: "/pkg/src/db.ts",
        message: "Unparameterized query",
        fixTarget: "source",
      },
    ];

    const input = makeTriageInput(nonTestSourceFindings);
    const result = await triageFlakyFindings(input);

    expect(result.findings).toHaveLength(nonTestSourceFindings.length);

    for (let i = 0; i < nonTestSourceFindings.length; i++) {
      expect(result.findings[i].source).toBe(nonTestSourceFindings[i].source);
      expect(result.findings[i].category).toBe(nonTestSourceFindings[i].category);
    }
  });
});