import type { SkillResource } from "@/resources";

export const MAX_SKILLS_INDEX_ENTRIES = 150;
const MAX_SKILL_DESCRIPTION_LENGTH = 200;

/** One-line, bounded description for a skills or agents index entry. */
export function cleanIndexDescription(text: string): string {
  // Preserve whitespace separators before removing remaining C0/C1 controls.
  return text
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ +/g, " ")
    .slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

/** Advertise available skills without inlining their bodies. */
export function buildSkillsInstructions(entries: readonly { qualifiedName: string; description: string }[]): string {
  const lines = [
    "When a skill matches a task, call nax-skills__load with the skill name before acting on the task. Load the skill's references files with nax-skills__load and file.",
  ];
  for (const entry of entries.slice(0, MAX_SKILLS_INDEX_ENTRIES)) {
    lines.push(`- ${entry.qualifiedName}: ${cleanIndexDescription(entry.description)}`);
  }
  if (entries.length > MAX_SKILLS_INDEX_ENTRIES) {
    lines.push(`- ... and ${entries.length - MAX_SKILLS_INDEX_ENTRIES} more`);
  }
  return lines.join("\n");
}

/** Frame an explicitly invoked skill and keep user arguments outside its body. */
export function buildSkillInvocationMessage({ skill, args }: { skill: SkillResource; args: string }): string {
  const block = [
    `<skill name="${skill.qualifiedName}" location="${skill.path}">`,
    `References are relative to ${skill.baseDir}; load them with nax-skills__load and file.`,
    skill.body,
    "</skill>",
  ].join("\n");
  return args ? `${block}\n\n${args}` : block;
}

/** Substitute command arguments as text only; never execute shell lines. */
export function buildCommandMessage(template: string, rest: string): string {
  const trimmed = rest.trim();
  const args = trimmed.split(/\s+/);
  let hasPlaceholder = false;
  const message = template.replace(/\$ARGUMENTS|\$[1-9]/g, (placeholder) => {
    hasPlaceholder = true;
    return placeholder === "$ARGUMENTS" ? trimmed : (args[Number(placeholder.slice(1)) - 1] ?? "");
  });
  return !hasPlaceholder && trimmed ? `${message}\n\nARGUMENTS: ${trimmed}` : message;
}
