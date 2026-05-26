/**
 * Apply test-edit declarations emitted by the implementer rectification agent
 * to findings, re-tagging source→test on valid prd_contract declarations and
 * appending advisory findings for invalid quotes or invalid mock-structure refs.
 *
 * Pure function — never mutates inputs.
 */
import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";
import { validatePrdQuote } from "./test-edit-declaration";
import type { TestEditDeclaration } from "./test-edit-declaration";

/**
 * Apply declarations to the findings array.
 *
 * @param findings - Current findings from the fix cycle.
 * @param declarations - Parsed TEST_EDIT_REASON declarations from the implementer.
 * @param story - The user story (used to validate prd_contract quotes).
 * @param invalidMockStructure - Mock-structure declarations that failed file/pattern validation.
 * @returns New findings array with re-tags and advisory findings applied.
 */
export function applyTestEditDeclarations(
  findings: Finding[],
  declarations: TestEditDeclaration[],
  story: UserStory,
  invalidMockStructure?: TestEditDeclaration[],
): Finding[] {
  let result: Finding[] = [...findings];
  const advisories: Finding[] = [];

  for (const d of declarations) {
    if (d.reason === "prd_contract") {
      const prdQuote = d.prdQuote ?? "";
      const valid = validatePrdQuote(prdQuote, story);

      if (valid) {
        // Re-tag matching findings: same file, fixTarget was "source" → "test"
        result = result.map((f) => {
          if (f.file === d.file && f.fixTarget === "source") {
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
        advisories.push({
          source: "autofix",
          severity: "warning",
          category: "prd_quote_mismatch",
          message: `PRD quote not found verbatim in story text for file: ${d.file}`,
          file: d.file,
          fixTarget: "source",
        });
      }
    }
    // lint_only and sibling_scope: passthrough — no changes to findings
  }

  // Advisory findings for invalid mock_structure declarations
  if (invalidMockStructure && invalidMockStructure.length > 0) {
    for (const d of invalidMockStructure) {
      const fileList = (d.files ?? [d.file]).join(", ");
      advisories.push({
        source: "autofix",
        severity: "warning",
        category: "mock_structure_invalid_files",
        message: `Mock structure handoff references file that does not exist or is not a test file: ${fileList}`,
        fixTarget: "source",
      });
    }
  }

  return [...result, ...advisories];
}
