import type { SourceRoot } from "@/analyze";

/**
 * Build source roots section markdown for planning- and grounding-style prompts.
 * Renders discovered source roots with their language, framework, and test runner.
 * When no roots are provided, renders a single entry for the root directory.
 */
export function buildSourceRootsSection(roots: SourceRoot[]): string {
  const sections: string[] = [];

  sections.push("## Source Roots\n");
  sections.push("You have Read, Grep, and Glob tools — explore on demand. Cite findings as `path:line`.");
  sections.push("Budget: aim for ≤ 10 file reads per story.\n");

  if (roots.length === 0) {
    sections.push("- .  (unknown, framework: —, tests: —)");
  } else {
    for (const root of roots) {
      const language = root.language ?? "unknown";
      const framework = root.framework || "—";
      const testRunner = root.testRunner || "—";
      sections.push(`- ${root.path}  (${language}, framework: ${framework}, tests: ${testRunner})`);
    }
  }

  return sections.join("\n");
}
