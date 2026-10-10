import type { Finding } from "@/findings/types";
import type { UserStory } from "@/prd";

export interface NbfWorthCheckPromptInput {
  readonly story: UserStory;
  readonly diff: string;
  readonly findings: readonly Finding[];
  readonly pendingStories: readonly {
    readonly id: string;
    readonly title: string;
    readonly acceptanceCriteria: readonly string[];
  }[];
}

const ROLE =
  "You are checking which code-review findings are worth fixing before this story merges. You do not fix anything. Read code with the tools if you need to check whether a path is reachable.";

const RUBRIC = `## How to judge
Answer "fix" when the finding describes, for the code as it is now:
- wrong behaviour, a crash, data loss or a security problem that can actually happen; or
- a test that cannot catch the bug it claims to cover; or
- a break of a written project rule you can point to in the repo's rules or context files.
Answer "skip" when the finding:
- only matters if the code changes later or is used in a way it is not used now; or
- is only about comments, documentation, naming, log wording, exports or style, and no written rule requires it; or
- is already covered by a pending story listed above (name the story in the reason).
When you are unsure, answer "fix".`;

const REPLY = `## Reply
Reply with only this JSON object, one entry per finding:
{"verdicts":[{"index":1,"verdict":"fix","reason":"<one line>"}]}`;

function renderFinding(finding: Finding, index: number): string[] {
  const location = finding.file
    ? `${finding.file}${finding.line == null ? "" : `:${finding.line}`}`
    : "(no file)";
  const lines = [`${index + 1}. [${finding.severity}/${finding.category}] ${location} — ${finding.message}`];
  if (finding.suggestion != null && finding.suggestion !== "") {
    lines.push(`   Suggested fix: ${finding.suggestion}`);
  }
  return lines;
}

/** Build the read-only worth-check prompt for non-blocking-fix findings. */
export function buildNbfWorthCheckPrompt(input: NbfWorthCheckPromptInput): string {
  const { story, diff, findings, pendingStories } = input;
  const sections = [
    ROLE,
    `## Story\n${story.id}: ${story.title}\n${story.description}\n${story.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
  ];
  if (pendingStories.length > 0) {
    sections.push(
      `## Pending stories in this feature\n${pendingStories
        .map(
          (pending) =>
            `${pending.id}: ${pending.title}${pending.acceptanceCriteria.length > 0 ? `\n${pending.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}` : ""}`,
        )
        .join("\n")}`,
    );
  }
  sections.push(
    `## Story diff\n${diff === "" ? "(diff unavailable — judge from the code)" : `\`\`\`diff\n${diff}\n\`\`\``}`,
  );
  sections.push(`## Findings\n${findings.flatMap(renderFinding).join("\n")}`);
  sections.push(RUBRIC, REPLY);
  return sections.join("\n\n");
}
