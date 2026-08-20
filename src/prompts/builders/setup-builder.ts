import type { PackageFacts, RepoAnalysis } from "@/cli/setup-types";
import type { ComposeInput } from "../compose";

function formatPackageFacts(pkg: PackageFacts): string {
  const lines = [`  Package: ${pkg.relativeDir || "(root)"}`];
  if (pkg.testFramework) lines.push(`    Test framework: ${pkg.testFramework}`);
  if (pkg.testFilePatterns.length > 0) {
    lines.push(`    Test patterns: ${pkg.testFilePatterns.slice(0, 4).join(", ")}`);
  }
  if (pkg.missingScripts.length > 0) {
    lines.push(`    Missing scripts: ${pkg.missingScripts.join(", ")}`);
  } else {
    lines.push("    Missing scripts: (none — all canonical scripts present)");
  }
  return lines.join("\n");
}

export class SetupPromptBuilder {
  build(analysis: RepoAnalysis): ComposeInput {
    const isMonoRepo = analysis.shape === "mono";
    const packageFacts = analysis.packages.map(formatPackageFacts).join("\n\n");

    return {
      role: {
        id: "setup-role",
        content:
          "You are an expert nax configuration generator. Generate a valid nax config JSON based on the repository analysis provided. Only reference scripts that actually exist — any script listed under 'Missing scripts' must NOT appear in quality.commands.",
        overridable: false,
      },
      task: {
        id: "setup-task",
        content: [
          `Generate a nax configuration for this ${isMonoRepo ? "monorepo" : "single-package"} repository.`,
          "",
          "Repository facts:",
          `- Shape: ${analysis.shape}`,
          `- Package manager: ${analysis.pmRunPrefix}`,
          `- DLX runner: ${analysis.pmDlx}`,
          `- Orchestrator: ${analysis.orchestrator}`,
          "",
          "Per-package facts:",
          packageFacts,
          "",
          "IMPORTANT: A script listed under 'Missing scripts' does NOT exist in that package's package.json.",
          "Do NOT include commands for missing scripts in quality.commands.",
          "",
          isMonoRepo
            ? 'Respond with a JSON code block: { "config": <root NaxConfig>, "monoConfigs": [{ "relativeDir": "<pkg>", "config": <partial NaxConfig> }] }'
            : 'Respond with a JSON code block: { "config": <NaxConfig> }',
        ].join("\n"),
        overridable: false,
      },
    };
  }
}
