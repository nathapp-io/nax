import type { CommandRunResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";

const COMMAND_SHELL_RE = /!`([^`\n]+)`/g;

type CommandShellResult = { text: string } | { failed: { command: string; reason: string } };

/** Expand only the original template; neither command output nor arguments are scanned. */
export async function runCommandShellLines(
  text: string,
  run: (command: string) => Promise<CommandRunResult>,
): Promise<CommandShellResult> {
  const parts: string[] = [];
  let offset = 0;
  for (const match of text.matchAll(COMMAND_SHELL_RE)) {
    const command = match[1];
    try {
      const result = await run(command);
      if (result.isError) return { failed: { command, reason: result.content.split("\n")[0] } };
      parts.push(text.slice(offset, match.index), result.content);
      offset = match.index + match[0].length;
    } catch (error) {
      return { failed: { command, reason: errorMessage(error) } };
    }
  }
  parts.push(text.slice(offset));
  return { text: parts.join("") };
}
