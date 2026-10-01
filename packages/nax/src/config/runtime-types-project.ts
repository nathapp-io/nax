/**
 * Project profile types.
 *
 * Split out of `runtime-types.ts`, which is over the file-size limit.
 */

/** Project profile — language and tooling metadata for language-aware features (US-001) */
export interface ProjectProfile {
  language?: "typescript" | "javascript" | "go" | "rust" | "python" | "ruby" | "java" | "kotlin" | "php";
  type?: string;
  testFramework?: string;
  lintTool?: string;
}
