/**
 * Verdict coercion — convert free-form verdicts to structured format
 */

import type { VerifierVerdict } from "./verdict";

/**
 * Coerce a free-form verdict object into the expected VerifierVerdict schema.
 * Maps common agent-improvised patterns (verdict:"PASS", verification_summary, etc.)
 * to the structured format. Returns null if too malformed to coerce.
 */
export function coerceVerdict(obj: Record<string, unknown>): VerifierVerdict | null {
  try {
    const verdictStr = String(obj.verdict ?? "").toUpperCase();
    const approved =
      verdictStr === "PASS" ||
      verdictStr === "APPROVED" ||
      verdictStr.startsWith("VERIFIED") ||
      verdictStr.includes("ALL ACCEPTANCE CRITERIA MET") ||
      obj.approved === true;

    let passCount = 0;
    let failCount = 0;
    let allPassing = approved;
    const summary = obj.verification_summary as Record<string, unknown> | undefined;
    if (summary?.test_results && typeof summary.test_results === "string") {
      const match = (summary.test_results as string).match(/(\d+)\/(\d+)/);
      if (match) {
        passCount = Number.parseInt(match[1], 10);
        const total = Number.parseInt(match[2], 10);
        failCount = total - passCount;
        allPassing = failCount === 0;
      }
    }
    if (obj.tests && typeof obj.tests === "object") {
      const t = obj.tests as Record<string, unknown>;
      if (typeof t.passCount === "number") passCount = t.passCount;
      if (typeof t.failCount === "number") failCount = t.failCount;
      if (typeof t.allPassing === "boolean") allPassing = t.allPassing;
    }

    const criteria: Array<{ criterion: string; met: boolean; note?: string }> = [];
    let allMet = approved;
    const acReview = obj.acceptance_criteria_review as Record<string, unknown> | undefined;
    if (acReview) {
      for (const [key, val] of Object.entries(acReview)) {
        if (key.startsWith("criterion") && val && typeof val === "object") {
          const c = val as Record<string, unknown>;
          const met = String(c.status ?? "").toUpperCase() === "SATISFIED" || c.met === true;
          criteria.push({
            criterion: String(c.name ?? c.criterion ?? key),
            met,
            note: c.evidence ? String(c.evidence).slice(0, 200) : undefined,
          });
          if (!met) allMet = false;
        }
      }
    }
    if (obj.acceptanceCriteria && typeof obj.acceptanceCriteria === "object") {
      const ac = obj.acceptanceCriteria as Record<string, unknown>;
      if (typeof ac.allMet === "boolean") allMet = ac.allMet;
      if (Array.isArray(ac.criteria)) {
        for (const c of ac.criteria) {
          if (c && typeof c === "object") {
            criteria.push(c as { criterion: string; met: boolean; note?: string });
          }
        }
      }
    }
    if (criteria.length === 0 && summary?.acceptance_criteria && typeof summary.acceptance_criteria === "string") {
      const acMatch = (summary.acceptance_criteria as string).match(/(\d+)\/(\d+)/);
      if (acMatch) {
        const met = Number.parseInt(acMatch[1], 10);
        const total = Number.parseInt(acMatch[2], 10);
        allMet = met === total;
      }
    }

    let rating: "good" | "acceptable" | "poor" = "acceptable";
    const qualityStr = summary?.code_quality
      ? String(summary.code_quality).toLowerCase()
      : obj.quality && typeof obj.quality === "object"
        ? String((obj.quality as Record<string, unknown>).rating ?? "acceptable").toLowerCase()
        : "acceptable";
    if (qualityStr === "high" || qualityStr === "good") rating = "good";
    else if (qualityStr === "low" || qualityStr === "poor") rating = "poor";

    return {
      version: 1,
      approved,
      tests: { allPassing, passCount, failCount },
      testModifications: {
        detected: false,
        files: [],
        legitimate: true,
        reasoning: "Not assessed in free-form verdict",
      },
      acceptanceCriteria: { allMet, criteria },
      quality: { rating, issues: [] },
      fixes: Array.isArray(obj.fixes) ? (obj.fixes as string[]) : [],
      reasoning:
        typeof obj.reasoning === "string"
          ? obj.reasoning
          : typeof obj.overall_status === "string"
            ? (obj.overall_status as string)
            : summary?.overall_status
              ? String(summary.overall_status)
              : `Coerced from free-form verdict: ${verdictStr}`,
    };
  } catch {
    return null;
  }
}
