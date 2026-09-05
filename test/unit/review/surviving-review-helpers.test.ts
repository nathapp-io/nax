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
    await expect(
      substantiateAdversarialFindings({ findings, workdir: "/tmp", storyId: "US-1", blockingThreshold: "error" }),
    ).resolves.toEqual(findings);
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
    });
  });
});
