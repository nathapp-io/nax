/**
 * Apply test-edit declarations emitted by the implementer rectification agent
 * to findings, re-tagging source→test on valid prd_contract declarations and
 * reporting rejected declarations as diagnostics.
 *
 * Rejected declarations are NOT injected into the findings stream. The findings
 * stream is the fix cycle's work queue: every entry must be claimable by some
 * FixStrategy's `appliesTo`, or the cycle exits "no-strategy" and fails an
 * otherwise-green story (#1327). A rejected declaration carries no work — the
 * enforcement has already happened by the time it is reported (an invalid quote
 * means the finding was not re-tagged; invalid mock files are stripped from the
 * handoff before the test-writer sees them). Callers log these instead.
 *
 * Pure function — never mutates inputs, never logs.
 */
import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";
import { validatePrdQuote } from "./test-edit-declaration";
import type { TestEditDeclaration } from "./test-edit-declaration";

/** Why a declaration was rejected. */
export type DeclarationDiagnosticReason = "prd_quote_mismatch" | "mock_structure_invalid_files";

/**
 * A rejected declaration, reported for logging rather than fixing.
 *
 * Diagnostics describe a *declaration* the implementer made, not a defect in
 * the code — there is nothing for a fix strategy to act on.
 */
export interface DeclarationDiagnostic {
  reason: DeclarationDiagnosticReason;
  /** The declaration's primary file. */
  file: string;
  /** Human-readable explanation, suitable as a log message. */
  detail: string;
}

/** Result of applying declarations: re-tagged findings plus rejection diagnostics. */
export interface TestEditDeclarationResult {
  /** The findings, with valid prd_contract re-tags applied. Never appended to. */
  findings: Finding[];
  /** Declarations that failed validation. Empty when everything validated. */
  diagnostics: DeclarationDiagnostic[];
}

/**
 * Apply declarations to the findings array.
 *
 * @param findings - Current findings from the fix cycle.
 * @param declarations - Parsed TEST_EDIT_REASON declarations from the implementer.
 * @param story - The user story (used to validate prd_contract quotes).
 * @param invalidMockStructure - Mock-structure declarations that failed file/pattern validation.
 * @returns Re-tagged findings and diagnostics for any rejected declaration.
 */
export function applyTestEditDeclarations(
  findings: Finding[],
  declarations: TestEditDeclaration[],
  story: UserStory,
  invalidMockStructure?: TestEditDeclaration[],
): TestEditDeclarationResult {
  let result: Finding[] = [...findings];
  const diagnostics: DeclarationDiagnostic[] = [];

  for (const d of declarations) {
    if (d.reason === "prd_contract") {
      const prdQuote = d.prdQuote ?? "";
      const valid = validatePrdQuote(prdQuote, story);

      if (valid) {
        // Re-tag matching findings: same file, fixTarget was "source" OR finding
        // is a test-runner failed-test with no fixTarget (AC4: failing-test findings
        // carry no fixTarget but are re-tag-eligible when source === "test-runner").
        result = result.map((f) => {
          const eligible =
            f.file === d.file && (f.fixTarget === "source" || (f.fixTarget == null && f.source === "test-runner"));
          if (eligible) {
            return {
              ...f,
              fixTarget: "test" as const,
              meta: {
                ...f.meta,
                prdContractDeclaration: d,
              },
            };
          }
          return f;
        });
      } else {
        // Rejection is already enforced above: without a valid quote the
        // findings for this file keep their original fixTarget.
        diagnostics.push({
          reason: "prd_quote_mismatch",
          file: d.file,
          detail: `PRD quote not found verbatim in story text for file: ${d.file}`,
        });
      }
    }
    // lint_only and sibling_scope: passthrough — no changes to findings
  }

  // Invalid mock_structure declarations are stripped from the handoff by the
  // caller before the test-writer consumes it; report them for visibility.
  for (const d of invalidMockStructure ?? []) {
    const fileList = (d.files ?? [d.file]).join(", ");
    diagnostics.push({
      reason: "mock_structure_invalid_files",
      file: d.file,
      detail: `Mock structure handoff references file that does not exist or is not a test file: ${fileList}`,
    });
  }

  return { findings: result, diagnostics };
}
