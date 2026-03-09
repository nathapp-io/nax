/**
 * Codebase context section builder.
 *
 * Builds a prompt section from scanCodebase output.
 */

import type { CodebaseScan } from "../../analyze/types";

export function buildCodebaseSection(scan: CodebaseScan): string {
  const deps = Object.entries(scan.dependencies)
    .slice(0, 15)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return [
    "# Codebase Context",
    "",
    "**File Tree:**",
    scan.fileTree,
    "",
    "**Dependencies:**",
    deps || "  (none)",
    "",
    `**Test Patterns:** ${scan.testPatterns.join(", ")}`,
  ].join("\n");
}
