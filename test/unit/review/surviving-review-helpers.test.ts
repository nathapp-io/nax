import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { extractRepromptInfo, withRepromptMarker } from "@/operations/adversarial-reprompt-marker";
import {
  hasCorroboratedInspectionTrail,
  hasInspectionTrail,
  substantiateAdversarialFindings,
} from "@/review/finding-filters";
import { formatFindings, parseLLMResponse, sanitizeRefModeFindings } from "@/review/semantic-helpers";

describe("adversarial reprompt markers", () => {
  test("adds and extracts valid telemetry while leaving non-JSON output unchanged", () => {
    const marked = withRepromptMarker('{"passed":true}', {
      dropCount: 1,
      outcome: "recovered-blocking",
      costUsd: 0.02,
    });
    expect(extractRepromptInfo(JSON.parse(marked))).toEqual({
      dropCount: 1,
      outcome: "recovered-blocking",
      costUsd: 0.02,
    });
    expect(withRepromptMarker("not json", { dropCount: 0, outcome: "parse-failed", costUsd: 0 })).toBe("not json");
    expect(extractRepromptInfo({ _repromptInfo: { dropCount: "one" } })).toBeUndefined();
  });
});

describe("semantic review helpers", () => {
  test("parses normalized findings, formats them, and downgrades unverified ref findings", () => {
    const parsed = parseLLMResponse(
      '{"passed":false,"findings":[{"severity":"warning","file":"src/a.ts","line":4,"issue":"Missing from diff","suggestion":"inspect source"}]}',
    );
    const findings = parsed?.findings ?? [];
    expect(findings[0]?.severity).toBe("warning");
    expect(formatFindings(findings)).toContain("src/a.ts:4");
    expect(sanitizeRefModeFindings(findings, "ref", "warning")[0]?.severity).toBe("unverifiable");
    expect(sanitizeRefModeFindings(findings, "embedded")).toBe(findings);
  });
});

describe("finding filters", () => {
  test("uses tool evidence when available and substantiates advisory findings without I/O", async () => {
    expect(hasInspectionTrail({ inspectedFiles: ["src/a.ts"] })).toBe(true);
    expect(hasInspectionTrail({ inspectedFiles: [""] })).toBe(false);
    expect(hasCorroboratedInspectionTrail({ inspectedFiles: ["src/a.ts"] }, { advertised: 1, called: [] })).toBe(false);
    expect(hasCorroboratedInspectionTrail({ inspectedFiles: [] }, { advertised: 1, called: ["Read"] })).toBe(true);
    const findings = [
      {
        severity: "info" as const,
        category: "input",
        file: "src/a.ts",
        line: 1,
        issue: "note",
        suggestion: "consider",
      },
    ];
    const [stamped] = await substantiateAdversarialFindings({
      findings,
      workdir: "/tmp",
      storyId: "US-1",
      blockingThreshold: "error",
    });
    // Non-blocking findings keep their severity — the evidence check is now
    // recorded, not acted on (#1910). This finding has no `verifiedBy`, so the
    // check reports "missing-observed".
    expect(stamped?.severity).toBe("info");
    expect(stamped?.evidence?.status).toBe("missing-observed");
  });

  test("downgrades a blocking finding whose quoted source no longer matches", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"));
      writeFileSync(join(workdir, "src", "a.ts"), "export const current = true;\n");
      const [finding] = await substantiateAdversarialFindings({
        findings: [
          {
            severity: "error",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "stale evidence",
            suggestion: "refresh it",
            verifiedBy: { file: "src/a.ts", line: 1, observed: "export const old = true;" },
          },
        ],
        workdir,
        storyId: "US-1",
        blockingThreshold: "error",
      });
      expect(finding?.severity).toBe("unverifiable");
      expect(finding?.evidence?.status).toBe("unmatched");
    });
  });

  test("non-blocking finding with matching evidence keeps its severity and is stamped 'matched'", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"));
      writeFileSync(join(workdir, "src", "a.ts"), "export const current = true;\n");
      const [finding] = await substantiateAdversarialFindings({
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "a warning with grounded evidence",
            suggestion: "n/a",
            verifiedBy: { file: "src/a.ts", line: 1, observed: "export const current = true;" },
          },
        ],
        workdir,
        storyId: "US-1",
        blockingThreshold: "error",
      });
      expect(finding?.severity).toBe("warning");
      expect(finding?.evidence?.status).toBe("matched");
    });
  });

  test("non-blocking finding whose quoted evidence does not match is recorded but NOT downgraded", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"));
      writeFileSync(join(workdir, "src", "a.ts"), "export const current = true;\n");
      const [finding] = await substantiateAdversarialFindings({
        findings: [
          {
            severity: "info",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "an info finding with stale evidence",
            suggestion: "n/a",
            verifiedBy: { file: "src/a.ts", line: 1, observed: "export const old = true;" },
          },
        ],
        workdir,
        storyId: "US-1",
        blockingThreshold: "error",
      });
      // The whole point of #1910: non-blocking findings are never downgraded,
      // even when their evidence is unmatched — only recorded.
      expect(finding?.severity).toBe("info");
      expect(finding?.evidence?.status).toBe("unmatched");
    });
  });

  test("non-blocking finding whose cited file does not exist is stamped 'unreadable'", async () => {
    await withTempDir(async (workdir) => {
      const [finding] = await substantiateAdversarialFindings({
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/does-not-exist.ts",
            line: 1,
            issue: "cites a missing file",
            suggestion: "n/a",
            verifiedBy: { file: "src/does-not-exist.ts", line: 1, observed: "whatever" },
          },
        ],
        workdir,
        storyId: "US-1",
        blockingThreshold: "error",
      });
      expect(finding?.severity).toBe("warning");
      expect(finding?.evidence?.status).toBe("unreadable");
    });
  });

  test("blocking finding with matching evidence stays 'error' and is stamped 'matched'", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"));
      writeFileSync(join(workdir, "src", "a.ts"), "export const current = true;\n");
      const [finding] = await substantiateAdversarialFindings({
        findings: [
          {
            severity: "error",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "a blocking finding with grounded evidence",
            suggestion: "n/a",
            verifiedBy: { file: "src/a.ts", line: 1, observed: "export const current = true;" },
          },
        ],
        workdir,
        storyId: "US-1",
        blockingThreshold: "error",
      });
      expect(finding?.severity).toBe("error");
      expect(finding?.evidence?.status).toBe("matched");
    });
  });
});
