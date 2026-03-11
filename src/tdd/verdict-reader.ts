/**
 * Verdict file reading, validation, and coercion
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../logger";
import type { VerifierVerdict } from "./verdict";

/** File name written by the verifier agent */
export const VERDICT_FILE = ".nax-verifier-verdict.json";

/**
 * Validate that a parsed object has the required fields for a VerifierVerdict.
 * Returns true if the object appears to be a valid verdict.
 */
export function isValidVerdict(obj: unknown): obj is VerifierVerdict {
  if (!obj || typeof obj !== "object") return false;
  const v = obj as Record<string, unknown>;

  // Required top-level fields
  if (v.version !== 1) return false;
  if (typeof v.approved !== "boolean") return false;

  // tests sub-object
  if (!v.tests || typeof v.tests !== "object") return false;
  const tests = v.tests as Record<string, unknown>;
  if (typeof tests.allPassing !== "boolean") return false;
  if (typeof tests.passCount !== "number") return false;
  if (typeof tests.failCount !== "number") return false;

  // testModifications sub-object
  if (!v.testModifications || typeof v.testModifications !== "object") return false;
  const mods = v.testModifications as Record<string, unknown>;
  if (typeof mods.detected !== "boolean") return false;
  if (!Array.isArray(mods.files)) return false;
  if (typeof mods.legitimate !== "boolean") return false;
  if (typeof mods.reasoning !== "string") return false;

  // acceptanceCriteria sub-object
  if (!v.acceptanceCriteria || typeof v.acceptanceCriteria !== "object") return false;
  const ac = v.acceptanceCriteria as Record<string, unknown>;
  if (typeof ac.allMet !== "boolean") return false;
  if (!Array.isArray(ac.criteria)) return false;

  // quality sub-object
  if (!v.quality || typeof v.quality !== "object") return false;
  const quality = v.quality as Record<string, unknown>;
  if (!["good", "acceptable", "poor"].includes(quality.rating as string)) return false;
  if (!Array.isArray(quality.issues)) return false;

  // fixes and reasoning
  if (!Array.isArray(v.fixes)) return false;
  if (typeof v.reasoning !== "string") return false;

  return true;
}

/**
 * Coerce a free-form verdict object into the expected VerifierVerdict schema.
 * Maps common agent-improvised patterns (verdict:"PASS", verification_summary, etc.)
 * to the structured format. Returns null if too malformed to coerce.
 */
export function coerceVerdict(obj: Record<string, unknown>): VerifierVerdict | null {
  try {
    // Determine approval status
    const verdictStr = String(obj.verdict ?? "").toUpperCase();
    const approved =
      verdictStr === "PASS" ||
      verdictStr === "APPROVED" ||
      verdictStr.startsWith("VERIFIED") ||
      verdictStr.includes("ALL ACCEPTANCE CRITERIA MET") ||
      obj.approved === true;

    // Parse test results from verification_summary or top-level
    let passCount = 0;
    let failCount = 0;
    let allPassing = approved;
    const summary = obj.verification_summary as Record<string, unknown> | undefined;
    if (summary?.test_results && typeof summary.test_results === "string") {
      // Parse "45/45 PASS" or "42/45 PASS" patterns
      const match = (summary.test_results as string).match(/(\d+)\/(\d+)/);
      if (match) {
        passCount = Number.parseInt(match[1], 10);
        const total = Number.parseInt(match[2], 10);
        failCount = total - passCount;
        allPassing = failCount === 0;
      }
    }
    // Also check top-level tests object (partial schema compliance)
    if (obj.tests && typeof obj.tests === "object") {
      const t = obj.tests as Record<string, unknown>;
      if (typeof t.passCount === "number") passCount = t.passCount;
      if (typeof t.failCount === "number") failCount = t.failCount;
      if (typeof t.allPassing === "boolean") allPassing = t.allPassing;
    }

    // Parse acceptance criteria from acceptance_criteria_review or acceptanceCriteria
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
    // Also check top-level acceptanceCriteria
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
    // Parse summary AC count like "4/4 SATISFIED"
    if (criteria.length === 0 && summary?.acceptance_criteria && typeof summary.acceptance_criteria === "string") {
      const acMatch = (summary.acceptance_criteria as string).match(/(\d+)\/(\d+)/);
      if (acMatch) {
        const met = Number.parseInt(acMatch[1], 10);
        const total = Number.parseInt(acMatch[2], 10);
        allMet = met === total;
      }
    }

    // Parse quality
    let rating: "good" | "acceptable" | "poor" = "acceptable";
    const qualityStr = summary?.code_quality
      ? String(summary.code_quality).toLowerCase()
      : obj.quality && typeof obj.quality === "object"
        ? String((obj.quality as Record<string, unknown>).rating ?? "acceptable").toLowerCase()
        : "acceptable";
    if (qualityStr === "high" || qualityStr === "good") rating = "good";
    else if (qualityStr === "low" || qualityStr === "poor") rating = "poor";

    // Build coerced verdict
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

/**
 * Read the verifier verdict file from the workdir.
 *
 * Returns the parsed VerifierVerdict when the file exists and is valid.
 * Attempts tolerant coercion if the file doesn't match the strict schema.
 * Returns null if:
 * - File does not exist
 * - File is not valid JSON
 * - Required fields are missing and coercion fails
 *
 * Never throws.
 */
export async function readVerdict(workdir: string): Promise<VerifierVerdict | null> {
  const logger = getLogger();
  const verdictPath = path.join(workdir, VERDICT_FILE);

  try {
    const file = Bun.file(verdictPath);
    const exists = await file.exists();
    if (!exists) {
      return null;
    }

    // Read as text first so we can log raw content on parse failure
    let rawText: string;
    try {
      rawText = await file.text();
    } catch (readErr) {
      logger.warn("tdd", "Failed to read verifier verdict file", {
        path: verdictPath,
        error: String(readErr),
      });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      logger.warn("tdd", "Verifier verdict file is not valid JSON — ignoring", {
        path: verdictPath,
        error: String(parseErr),
        rawContent: rawText.slice(0, 1000),
      });
      return null;
    }

    if (isValidVerdict(parsed)) {
      return parsed;
    }

    // Strict validation failed — attempt tolerant coercion
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const coerced = coerceVerdict(parsed as Record<string, unknown>);
      if (coerced) {
        logger.info("tdd", "Coerced free-form verdict to structured format", {
          path: verdictPath,
          approved: coerced.approved,
          passCount: coerced.tests.passCount,
          failCount: coerced.tests.failCount,
        });
        return coerced;
      }
    }

    logger.warn("tdd", "Verifier verdict file missing required fields and coercion failed — ignoring", {
      path: verdictPath,
      content: JSON.stringify(parsed).slice(0, 500),
    });
    return null;
  } catch (err) {
    logger.warn("tdd", "Failed to read verifier verdict file — ignoring", {
      path: verdictPath,
      error: String(err),
    });
    return null;
  }
}

/**
 * Delete the verifier verdict file from the workdir.
 * Ignores all errors (file may not exist, permissions, etc.).
 */
export async function cleanupVerdict(workdir: string): Promise<void> {
  const verdictPath = path.join(workdir, VERDICT_FILE);
  try {
    await unlink(verdictPath);
  } catch {
    // Intentionally ignored — file may not exist or already be deleted
  }
}
