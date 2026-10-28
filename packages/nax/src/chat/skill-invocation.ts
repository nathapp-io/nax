/** The fields stored inside a skill invocation envelope, without a transcript discriminator. */
interface SkillInvocation {
  readonly name: string;
  readonly args: string;
  readonly body: string;
}

const SKILL_HEADER = /^<skill name="([^"]+)"\s/;
const SKILL_CLOSE = "\n</skill>";
const SKILL_ARGS_DELIMITER = `${SKILL_CLOSE}\n\n`;

/** Inverse of buildSkillInvocationMessage; preserve the body and trim only user arguments. */
export function parseSkillInvocation(content: string): SkillInvocation | undefined {
  const name = SKILL_HEADER.exec(content)?.[1];
  if (name === undefined) return undefined;
  const withoutArgs = content.endsWith(SKILL_CLOSE);
  const delimiter = withoutArgs ? SKILL_CLOSE : SKILL_ARGS_DELIMITER;
  const close = content.lastIndexOf(delimiter);
  const headerEnd = content.indexOf("\n");
  const referencesEnd = content.indexOf("\n", headerEnd + 1);
  if (headerEnd < 0 || referencesEnd < 0 || close < referencesEnd + 1) return undefined;
  return {
    name,
    args: withoutArgs ? "" : content.slice(close + delimiter.length).trim(),
    body: content.slice(referencesEnd + 1, close),
  };
}
